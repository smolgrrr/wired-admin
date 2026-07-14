import type {
  RevenueWallet,
  WalletInvoice,
  WalletPayment,
  WalletPaymentLookup,
} from "./wallet.js";
import type {
  CreateLightningInvoiceParams,
  NetworkType,
  PayLightningInvoiceParams,
} from "@buildonspark/spark-sdk";
import {
  CurrencyUnit,
  LightningReceiveRequestStatus,
  LightningSendRequestStatus,
  SparkUserRequestType,
  type CurrencyAmount,
  type LightningReceiveRequest,
  type LightningSendRequest,
  type SparkWalletUserToUserRequestsConnection,
} from "@buildonspark/spark-sdk/types";

type SparkNetwork = Extract<NetworkType, "MAINNET" | "REGTEST" | "SIGNET" | "TESTNET">;

type SparkClient = {
  createLightningInvoice(input: CreateLightningInvoiceParams): Promise<LightningReceiveRequest>;
  getLightningReceiveRequest(id: string): Promise<LightningReceiveRequest | null>;
  getLightningSendFeeEstimate(input: { encodedInvoice: string }): Promise<number>;
  payLightningInvoice(input: PayLightningInvoiceParams): Promise<LightningSendRequest | unknown>;
  getLightningSendRequest(id: string): Promise<LightningSendRequest | null>;
  getUserRequests(input: {
    first: number;
    after?: string;
    types: SparkUserRequestType[];
  }): Promise<SparkWalletUserToUserRequestsConnection | null>;
};

type SparkWalletOptions = {
  mnemonic: string;
  network?: SparkNetwork;
  accountNumber?: number;
  maxFeeSats?: number;
  clientFactory?: () => Promise<SparkClient>;
};

type InvoiceIntent = {
  amountMsat: number;
  descriptionHash: string;
  result: Promise<WalletInvoice>;
};

const RECEIVE_SETTLED = new Set([
  LightningReceiveRequestStatus.LIGHTNING_PAYMENT_RECEIVED,
  LightningReceiveRequestStatus.PAYMENT_PREIMAGE_RECOVERED,
  LightningReceiveRequestStatus.TRANSFER_COMPLETED,
]);

const SEND_SUCCEEDED = new Set([
  LightningSendRequestStatus.LIGHTNING_PAYMENT_SUCCEEDED,
  LightningSendRequestStatus.PREIMAGE_PROVIDED,
  LightningSendRequestStatus.TRANSFER_COMPLETED,
  LightningSendRequestStatus.USER_SWAP_RETURNED,
]);

const SEND_FAILED = new Set([
  LightningSendRequestStatus.USER_TRANSFER_VALIDATION_FAILED,
  LightningSendRequestStatus.LIGHTNING_PAYMENT_FAILED,
  LightningSendRequestStatus.PREIMAGE_PROVIDING_FAILED,
  LightningSendRequestStatus.TRANSFER_FAILED,
  LightningSendRequestStatus.USER_SWAP_RETURN_FAILED,
]);

export class SparkWallet implements RevenueWallet {
  readonly backend = "spark";
  readonly #mnemonic: string;
  readonly #network: NonNullable<SparkWalletOptions["network"]>;
  readonly #accountNumber: number;
  readonly #maxFeeSats: number;
  readonly #clientFactory: () => Promise<SparkClient>;
  readonly #invoiceIntents = new Map<string, InvoiceIntent>();
  readonly #receiveRequestIds = new Map<string, string>();
  #clientPromise: Promise<SparkClient> | null = null;

  constructor(options: SparkWalletOptions) {
    this.#mnemonic = options.mnemonic.trim();
    this.#network = options.network ?? "MAINNET";
    this.#accountNumber = options.accountNumber ?? (this.#network === "REGTEST" ? 0 : 1);
    this.#maxFeeSats = options.maxFeeSats ?? 5;
    if (!this.#mnemonic) throw new Error("Spark wallet mnemonic is required");
    if (!Number.isSafeInteger(this.#accountNumber) || this.#accountNumber < 0) {
      throw new Error("Spark account number must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.#maxFeeSats) || this.#maxFeeSats < 0) {
      throw new Error("Spark maximum fee must be a non-negative whole-satoshi amount");
    }
    this.#clientFactory = options.clientFactory ?? (() => this.#initializeClient());
  }

  async createInvoice(input: {
    amountMsat: number;
    descriptionHash: string;
    idempotencyKey: string;
  }): Promise<WalletInvoice> {
    this.#requireWholeSats(input.amountMsat, "Spark invoices");
    if (!/^[0-9a-f]{64}$/.test(input.descriptionHash)) {
      throw new Error("Spark description hash must be 32-byte lowercase hex");
    }
    const existing = this.#invoiceIntents.get(input.idempotencyKey);
    if (existing) {
      if (existing.amountMsat !== input.amountMsat || existing.descriptionHash !== input.descriptionHash) {
        throw new Error("Spark idempotency key already belongs to a conflicting invoice");
      }
      return existing.result;
    }

    const result = this.#createInvoice(input);
    this.#invoiceIntents.set(input.idempotencyKey, {
      amountMsat: input.amountMsat,
      descriptionHash: input.descriptionHash,
      result,
    });
    try {
      return await result;
    } catch (error) {
      this.#invoiceIntents.delete(input.idempotencyKey);
      throw error;
    }
  }

  async lookupInvoice(paymentHash: string): Promise<Omit<WalletInvoice, "invoice">> {
    let request: LightningReceiveRequest | null = null;
    const requestId = this.#receiveRequestIds.get(paymentHash);
    if (requestId) request = await (await this.#client()).getLightningReceiveRequest(requestId);
    request ??= await this.#findReceiveRequest(paymentHash);
    if (!request) throw new Error("Spark invoice not found");
    if (request.invoice.paymentHash !== paymentHash) {
      throw new Error("Spark returned an unexpected invoice payment hash");
    }
    this.#receiveRequestIds.set(paymentHash, request.id);
    const amountMsat = this.#currencyToMsat(request.invoice.amount, "invoice amount");
    const status = this.#receiveStatus(request);
    return {
      paymentHash,
      amountMsat,
      status,
      ...(status === "settled" ? { settledAt: Date.now() } : {}),
    };
  }

  async estimateFeeMsat(invoice: string): Promise<number> {
    const feeSats = await (await this.#client()).getLightningSendFeeEstimate({
      encodedInvoice: invoice,
    });
    if (!Number.isFinite(feeSats) || feeSats < 0) {
      throw new Error("Spark fee quote is unavailable");
    }
    const feeMsat = Math.ceil(feeSats * 1_000);
    if (!Number.isSafeInteger(feeMsat)) throw new Error("Spark fee quote is too large");
    return feeMsat;
  }

  async payInvoice(input: {
    invoice: string;
    idempotencyKey: string;
    amountMsat: number;
  }): Promise<WalletPayment> {
    this.#requireWholeSats(input.amountMsat, "Spark payments");
    const existing = await this.lookupPayment({
      paymentId: input.idempotencyKey,
      expectedAmountMsat: input.amountMsat,
      invoice: input.invoice,
    });
    if (existing.status !== "not_found") return existing;

    const result = await (await this.#client()).payLightningInvoice({
      invoice: input.invoice,
      maxFeeSats: this.#maxFeeSats,
      preferSpark: false,
      idempotencyKey: input.idempotencyKey,
    });
    if (!this.#isSendRequest(result)) {
      throw new Error("Spark did not return a Lightning send request");
    }
    return this.#toWalletPayment(result, input.amountMsat, input.invoice);
  }

  async lookupPayment(input: WalletPaymentLookup): Promise<WalletPayment> {
    const client = await this.#client();
    let request = await client.getLightningSendRequest(input.paymentId).catch(() => null);
    request ??= await this.#findSendRequest(input.paymentId, input.invoice);
    if (!request) {
      return {
        paymentId: input.paymentId,
        status: "not_found",
        amountMsat: input.expectedAmountMsat || 0,
      };
    }
    return this.#toWalletPayment(request, input.expectedAmountMsat, input.invoice);
  }

  async #createInvoice(input: {
    amountMsat: number;
    descriptionHash: string;
  }): Promise<WalletInvoice> {
    const request = await (await this.#client()).createLightningInvoice({
      amountSats: input.amountMsat / 1_000,
      descriptionHash: input.descriptionHash,
      includeSparkAddress: false,
      includeSparkInvoice: false,
    });
    const invoice = this.#toWalletInvoice(request);
    if (invoice.amountMsat !== input.amountMsat) {
      throw new Error("Spark invoice amount does not match the request");
    }
    this.#receiveRequestIds.set(invoice.paymentHash, request.id);
    return invoice;
  }

  async #findReceiveRequest(paymentHash: string): Promise<LightningReceiveRequest | null> {
    return this.#findUserRequest(
      SparkUserRequestType.LIGHTNING_RECEIVE,
      (candidate): candidate is LightningReceiveRequest => this.#isReceiveRequest(candidate)
        && candidate.invoice.paymentHash === paymentHash,
    );
  }

  async #findSendRequest(idempotencyKey: string, invoice: string): Promise<LightningSendRequest | null> {
    return this.#findUserRequest(
      SparkUserRequestType.LIGHTNING_SEND,
      (candidate): candidate is LightningSendRequest => this.#isSendRequest(candidate)
        && candidate.idempotencyKey === idempotencyKey
        && candidate.encodedInvoice === invoice,
    );
  }

  async #findUserRequest<T extends LightningReceiveRequest | LightningSendRequest>(
    type: SparkUserRequestType.LIGHTNING_RECEIVE | SparkUserRequestType.LIGHTNING_SEND,
    matches: (candidate: SparkWalletUserToUserRequestsConnection["entities"][number]) => candidate is T,
  ): Promise<T | null> {
    let after: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const connection = await (await this.#client()).getUserRequests({
        first: 100,
        ...(after ? { after } : {}),
        types: [type],
      });
      const found = connection?.entities.find(matches);
      if (found) return found;
      if (!connection?.pageInfo.hasNextPage || !connection.pageInfo.endCursor) return null;
      after = connection.pageInfo.endCursor;
    }
    throw new Error("Spark request lookup exceeded the pagination safety limit");
  }

  #toWalletInvoice(request: LightningReceiveRequest): WalletInvoice {
    const amountMsat = this.#currencyToMsat(request.invoice.amount, "invoice amount");
    const status = this.#receiveStatus(request);
    return {
      paymentHash: request.invoice.paymentHash,
      invoice: request.invoice.encodedInvoice,
      amountMsat,
      status,
      ...(status === "settled" ? { settledAt: Date.now() } : {}),
    };
  }

  #toWalletPayment(
    request: LightningSendRequest,
    expectedAmountMsat: number | undefined,
    expectedInvoice: string,
  ): WalletPayment {
    if (request.encodedInvoice !== expectedInvoice) {
      throw new Error("Spark payment invoice does not match the reserved payout");
    }
    const amountMsat = expectedAmountMsat ?? 0;
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
      throw new Error("Spark payment amount is missing");
    }
    const status = SEND_SUCCEEDED.has(request.status)
      ? "succeeded"
      : SEND_FAILED.has(request.status)
        ? "failed"
        : request.status === LightningSendRequestStatus.FUTURE_VALUE
          ? "unknown"
          : "pending";
    return {
      paymentId: request.id,
      status,
      amountMsat,
      feeMsat: this.#currencyToMsat(request.fee, "payment fee", true),
      ...(status === "failed" ? { failureReason: `Spark payment failed with ${request.status}` } : {}),
    };
  }

  #receiveStatus(request: LightningReceiveRequest): WalletInvoice["status"] {
    if (RECEIVE_SETTLED.has(request.status)) return "settled";
    const expiresAt = Date.parse(request.invoice.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt <= Date.now() ? "expired" : "pending";
  }

  #currencyToMsat(amount: CurrencyAmount, label: string, allowZero = false): number {
    const multiplier = amount.originalUnit === CurrencyUnit.MILLISATOSHI
      ? 1
      : amount.originalUnit === CurrencyUnit.SATOSHI
        ? 1_000
        : amount.originalUnit === CurrencyUnit.BITCOIN
          ? 100_000_000_000
          : Number.NaN;
    const value = amount.originalValue * multiplier;
    if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
      throw new Error(`Spark ${label} is invalid`);
    }
    return value;
  }

  #isReceiveRequest(value: unknown): value is LightningReceiveRequest {
    if (!value || typeof value !== "object") return false;
    const request = value as Partial<LightningReceiveRequest>;
    return typeof request.id === "string"
      && typeof request.status === "string"
      && !!request.invoice
      && typeof request.invoice.paymentHash === "string";
  }

  #isSendRequest(value: unknown): value is LightningSendRequest {
    if (!value || typeof value !== "object") return false;
    const request = value as Partial<LightningSendRequest>;
    return typeof request.id === "string"
      && typeof request.status === "string"
      && typeof request.encodedInvoice === "string"
      && typeof request.idempotencyKey === "string"
      && !!request.fee;
  }

  #requireWholeSats(amountMsat: number, label: string): void {
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0 || amountMsat % 1_000 !== 0) {
      throw new Error(`${label} require a whole-satoshi millisatoshi amount`);
    }
  }

  async #client(): Promise<SparkClient> {
    this.#clientPromise ??= this.#clientFactory();
    return this.#clientPromise;
  }

  async #initializeClient(): Promise<SparkClient> {
    const { SparkWallet: SparkSdkWallet } = await import("@buildonspark/spark-sdk");
    const { wallet } = await SparkSdkWallet.initialize({
      mnemonicOrSeed: this.#mnemonic,
      accountNumber: this.#accountNumber,
      options: { network: this.#network, log: false },
    });
    return {
      createLightningInvoice: (input) => wallet.createLightningInvoice(input),
      getLightningReceiveRequest: (id) => wallet.getLightningReceiveRequest(id),
      getLightningSendFeeEstimate: (input) => wallet.getLightningSendFeeEstimate(input),
      payLightningInvoice: (input) => wallet.payLightningInvoice(input),
      getLightningSendRequest: (id) => wallet.getLightningSendRequest(id),
      getUserRequests: (input) => wallet.getUserRequests(input),
    };
  }
}
