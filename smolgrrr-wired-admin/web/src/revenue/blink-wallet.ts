import type {
  RevenueWallet,
  WalletInvoice,
  WalletPayment,
  WalletPaymentLookup,
} from "./wallet.js";

type BlinkWalletOptions = {
  endpoint: string;
  apiKey: string;
  walletId: string;
  accountId?: string;
  fetchImplementation?: typeof fetch;
};

type BlinkError = { message?: string };
type BlinkInvoice = {
  externalId?: string;
  paymentHash: string;
  paymentRequest?: string;
  paymentStatus: "PENDING" | "PAID" | "EXPIRED";
  satoshis: number;
};
type BlinkTransaction = {
  id: string;
  direction: "SEND" | "RECEIVE";
  settlementAmount: number;
  settlementFee: number;
  status: "SUCCESS" | "PENDING" | "FAILURE";
};
type BlinkWalletRecord = {
  id: string;
  invoices?: {
    edges?: Array<{ cursor: string; node: BlinkInvoice }>;
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  } | null;
  invoiceByPaymentHash?: BlinkInvoice;
  transactionsByPaymentRequest?: BlinkTransaction[];
};

const INVOICE_FIELDS = `
  externalId
  paymentHash
  paymentRequest
  paymentStatus
  ... on LnInvoice { satoshis }
`;

const TRANSACTION_FIELDS = `
  id
  direction
  settlementAmount
  settlementFee
  status
`;

export class BlinkWallet implements RevenueWallet {
  readonly backend = "blink";
  readonly #endpoint: string;
  readonly #apiKey: string;
  readonly #walletId: string;
  readonly #accountId: string | undefined;
  readonly #fetch: typeof fetch;

  constructor(options: BlinkWalletOptions) {
    this.#endpoint = options.endpoint.trim().replace(/\/+$/, "");
    this.#apiKey = options.apiKey.trim();
    this.#walletId = options.walletId.trim();
    this.#accountId = options.accountId?.trim() || undefined;
    this.#fetch = options.fetchImplementation ?? fetch;
    if (!this.#endpoint.startsWith("https://")) throw new Error("Blink endpoint must use HTTPS");
    if (!this.#apiKey || !this.#walletId) throw new Error("Blink API key and wallet ID are required");
  }

  async createInvoice(input: {
    amountMsat: number;
    descriptionHash: string;
    idempotencyKey: string;
  }): Promise<WalletInvoice> {
    this.#requireWholeSats(input.amountMsat, "Blink invoices");
    if (!/^[0-9a-f]{64}$/.test(input.descriptionHash)) {
      throw new Error("Blink description hash must be 32-byte lowercase hex");
    }
    const existing = await this.#findInvoiceByExternalId(input.idempotencyKey);
    if (existing) {
      if (existing.satoshis * 1_000 !== input.amountMsat || !existing.paymentRequest) {
        throw new Error("Blink external ID already belongs to a conflicting invoice");
      }
      return this.#toWalletInvoice(existing);
    }

    const data = await this.#graphql<{
      lnInvoiceCreateOnBehalfOfRecipient: { invoice?: BlinkInvoice | null; errors: BlinkError[] };
    }>(
      "CreateBlinkInvoice",
      `mutation CreateBlinkInvoice($input: LnInvoiceCreateOnBehalfOfRecipientInput!) {
        lnInvoiceCreateOnBehalfOfRecipient(input: $input) {
          invoice { ${INVOICE_FIELDS} }
          errors { message }
        }
      }`,
      {
        input: {
          recipientWalletId: this.#walletId,
          amount: input.amountMsat / 1_000,
          descriptionHash: input.descriptionHash,
          externalId: input.idempotencyKey,
        },
      },
    );
    const payload = data.lnInvoiceCreateOnBehalfOfRecipient;
    this.#requireNoPayloadErrors("invoice creation", payload.errors);
    if (!payload.invoice?.paymentRequest) throw new Error("Blink did not return an invoice");
    return this.#toWalletInvoice(payload.invoice);
  }

  async lookupInvoice(paymentHash: string): Promise<Omit<WalletInvoice, "invoice">> {
    const data = await this.#graphql<{
      me: { defaultAccount: { id: string; wallets: BlinkWalletRecord[] } };
    }>(
      "LookupBlinkInvoice",
      `query LookupBlinkInvoice($paymentHash: PaymentHash!) {
        me {
          defaultAccount {
            id
            wallets {
              id
              ... on BTCWallet {
                invoiceByPaymentHash(paymentHash: $paymentHash) { ${INVOICE_FIELDS} }
              }
            }
          }
        }
      }`,
      { paymentHash },
    );
    const invoice = this.#selectWallet(data).invoiceByPaymentHash;
    if (!invoice) throw new Error("Blink invoice not found");
    const amountMsat = invoice.satoshis * 1_000;
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
      throw new Error("Blink invoice amount is missing");
    }
    const status = this.#invoiceStatus(invoice.paymentStatus);
    return {
      paymentHash: invoice.paymentHash,
      amountMsat,
      status,
      ...(status === "settled" ? { settledAt: Date.now() } : {}),
    };
  }

  async estimateFeeMsat(invoice: string): Promise<number> {
    const data = await this.#graphql<{
      lnInvoiceFeeProbe: { amount?: number | null; errors: BlinkError[] };
    }>(
      "ProbeBlinkFee",
      `mutation ProbeBlinkFee($input: LnInvoiceFeeProbeInput!) {
        lnInvoiceFeeProbe(input: $input) { amount errors { message } }
      }`,
      { input: { walletId: this.#walletId, paymentRequest: invoice } },
    );
    this.#requireNoPayloadErrors("fee probe", data.lnInvoiceFeeProbe.errors);
    const amount = data.lnInvoiceFeeProbe.amount;
    if (!Number.isSafeInteger(amount) || Number(amount) < 0) {
      throw new Error("Blink fee quote is unavailable");
    }
    return Number(amount) * 1_000;
  }

  async payInvoice(input: {
    invoice: string;
    idempotencyKey: string;
    amountMsat: number;
  }): Promise<WalletPayment> {
    this.#requireWholeSats(input.amountMsat, "Blink payments");
    const lookup = {
      paymentId: input.idempotencyKey,
      expectedAmountMsat: input.amountMsat,
      invoice: input.invoice,
    };
    const existing = await this.lookupPayment(lookup);
    if (existing.status !== "not_found") return existing;

    const data = await this.#graphql<{
      lnInvoicePaymentSend: {
        status?: "SUCCESS" | "PENDING" | "FAILURE" | "ALREADY_PAID" | null;
        transaction?: BlinkTransaction | null;
        errors: BlinkError[];
      };
    }>(
      "SendBlinkPayment",
      `mutation SendBlinkPayment($input: LnInvoicePaymentInput!) {
        lnInvoicePaymentSend(input: $input) {
          status
          transaction { ${TRANSACTION_FIELDS} }
          errors { message }
        }
      }`,
      { input: { walletId: this.#walletId, paymentRequest: input.invoice } },
    );
    const payload = data.lnInvoicePaymentSend;
    if (payload.status === "ALREADY_PAID" && !payload.transaction) {
      return this.lookupPayment(lookup);
    }
    if (payload.status === "FAILURE") {
      return {
        paymentId: input.idempotencyKey,
        status: "failed",
        amountMsat: input.amountMsat,
        failureReason: this.#errorMessages(payload.errors) || "Blink payment failed",
      };
    }
    this.#requireNoPayloadErrors("payment", payload.errors);
    if (!payload.transaction) throw new Error("Blink did not return a payment transaction");
    return this.#toWalletPayment(payload.transaction, input.amountMsat);
  }

  async lookupPayment(input: WalletPaymentLookup): Promise<WalletPayment> {
    const data = await this.#graphql<{
      me: { defaultAccount: { id: string; wallets: BlinkWalletRecord[] } };
    }>(
      "LookupBlinkPayment",
      `query LookupBlinkPayment($paymentRequest: LnPaymentRequest!) {
        me {
          defaultAccount {
            id
            wallets {
              id
              transactionsByPaymentRequest(paymentRequest: $paymentRequest) {
                ${TRANSACTION_FIELDS}
              }
            }
          }
        }
      }`,
      { paymentRequest: input.invoice },
    );
    const transactions = this.#selectWallet(data).transactionsByPaymentRequest || [];
    const sent = transactions.filter((candidate) => candidate.direction === "SEND");
    const transaction = sent.find((candidate) => candidate.status === "SUCCESS")
      ?? sent.find((candidate) => candidate.status === "PENDING")
      ?? sent.find((candidate) => candidate.status === "FAILURE");
    if (!transaction) {
      return {
        paymentId: input.paymentId,
        status: "not_found",
        amountMsat: input.expectedAmountMsat || 0,
      };
    }
    return this.#toWalletPayment(transaction, input.expectedAmountMsat);
  }

  async #findInvoiceByExternalId(externalId: string): Promise<BlinkInvoice | null> {
    let after: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const data: {
        me: { defaultAccount: { id: string; wallets: BlinkWalletRecord[] } };
      } = await this.#graphql(
        "FindBlinkInvoiceByExternalId",
        `query FindBlinkInvoiceByExternalId($first: Int!, $after: String) {
          me {
            defaultAccount {
              id
              wallets {
                id
                ... on BTCWallet {
                  invoices(first: $first, after: $after) {
                    edges { cursor node { ${INVOICE_FIELDS} } }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
            }
          }
        }`,
        { first: 100, after },
      );
      const connection: BlinkWalletRecord["invoices"] = this.#selectWallet(data).invoices;
      const match = connection?.edges?.find(({ node }) => node.externalId === externalId)?.node;
      if (match) return match;
      if (!connection?.pageInfo.hasNextPage || !connection.pageInfo.endCursor) return null;
      after = connection.pageInfo.endCursor;
    }
    throw new Error("Blink invoice lookup exceeded the pagination safety limit");
  }

  #selectWallet(data: {
    me: { defaultAccount: { id: string; wallets: BlinkWalletRecord[] } };
  }): BlinkWalletRecord {
    const account = data.me?.defaultAccount;
    if (!account) throw new Error("Blink account is unavailable");
    if (this.#accountId && account.id !== this.#accountId) {
      throw new Error("Blink API key belongs to an unexpected account");
    }
    const wallet = account.wallets.find((candidate) => candidate.id === this.#walletId);
    if (!wallet) throw new Error("Blink wallet is not available to this API key");
    return wallet;
  }

  #toWalletInvoice(invoice: BlinkInvoice): WalletInvoice {
    if (!Number.isSafeInteger(invoice.satoshis) || invoice.satoshis <= 0) {
      throw new Error("Blink invoice amount is missing");
    }
    if (!invoice.paymentRequest) throw new Error("Blink invoice payment request is missing");
    return {
      paymentHash: invoice.paymentHash,
      invoice: invoice.paymentRequest,
      amountMsat: invoice.satoshis * 1_000,
      status: this.#invoiceStatus(invoice.paymentStatus),
      ...(invoice.paymentStatus === "PAID" ? { settledAt: Date.now() } : {}),
    };
  }

  #invoiceStatus(status: BlinkInvoice["paymentStatus"]): WalletInvoice["status"] {
    return status === "PAID" ? "settled" : status === "EXPIRED" ? "expired" : "pending";
  }

  #toWalletPayment(transaction: BlinkTransaction, expectedAmountMsat?: number): WalletPayment {
    const amountMsat = Math.abs(transaction.settlementAmount) * 1_000;
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) {
      throw new Error("Blink payment amount is missing");
    }
    if (expectedAmountMsat !== undefined && amountMsat !== expectedAmountMsat) {
      throw new Error("Blink payment amount does not match the reserved payout");
    }
    return {
      paymentId: transaction.id,
      status: transaction.status === "SUCCESS"
        ? "succeeded"
        : transaction.status === "PENDING"
          ? "pending"
          : "failed",
      amountMsat,
      feeMsat: Math.abs(transaction.settlementFee) * 1_000,
      ...(transaction.status === "FAILURE" ? { failureReason: "Blink payment failed" } : {}),
    };
  }

  #requireWholeSats(amountMsat: number, label: string): void {
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0 || amountMsat % 1_000 !== 0) {
      throw new Error(`${label} require a whole-satoshi millisatoshi amount`);
    }
  }

  #requireNoPayloadErrors(context: string, errors: BlinkError[]): void {
    const message = this.#errorMessages(errors);
    if (message) throw new Error(`Blink ${context} failed: ${message}`);
  }

  #errorMessages(errors: BlinkError[] | undefined): string {
    return (errors || []).map((error) => error.message?.trim()).filter(Boolean).join("; ");
  }

  async #graphql<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-API-KEY": this.#apiKey,
      },
      body: JSON.stringify({ operationName, query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json().catch(() => null) as {
      data?: T;
      errors?: BlinkError[];
    } | null;
    if (!response.ok) throw new Error(`Blink request failed with HTTP ${response.status}`);
    const graphQlErrors = this.#errorMessages(value?.errors);
    if (graphQlErrors) throw new Error(`Blink GraphQL request failed: ${graphQlErrors}`);
    if (!value?.data) throw new Error("Blink returned an empty GraphQL response");
    return value.data;
  }
}
