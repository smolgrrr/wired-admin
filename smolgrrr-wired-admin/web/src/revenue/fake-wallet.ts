import crypto from "node:crypto";
import type { RevenueWallet, WalletInvoice, WalletPayment } from "./wallet.js";
import { LnbitsWallet } from "./lnbits-wallet.js";

type FakeInvoice = WalletInvoice & { settledAt?: number };

export class FakeWallet implements RevenueWallet {
  readonly backend = "fake";
  readonly #invoices = new Map<string, FakeInvoice>();
  readonly #payments = new Map<string, WalletPayment>();
  #invoiceSequence = 0;
  #settlementSequence = 0;

  async createInvoice(input: { amountMsat: number; descriptionHash: string }): Promise<WalletInvoice> {
    if (!Number.isSafeInteger(input.amountMsat) || input.amountMsat <= 0) {
      throw new Error("invoice amount must be positive integer millisatoshis");
    }
    if (!/^[0-9a-f]{64}$/i.test(input.descriptionHash)) {
      throw new Error("description hash must be 32-byte hex");
    }
    this.#invoiceSequence += 1;
    const paymentHash = crypto
      .createHash("sha256")
      .update(`${this.#invoiceSequence}:${input.amountMsat}:${input.descriptionHash}`)
      .digest("hex");
    const invoice: FakeInvoice = {
      paymentHash,
      invoice: `lnbc${Math.ceil(input.amountMsat / 1000)}n1fake${paymentHash}`,
      amountMsat: input.amountMsat,
      status: "pending",
    };
    this.#invoices.set(paymentHash, invoice);
    return { ...invoice };
  }

  async lookupInvoice(paymentHash: string): Promise<Omit<WalletInvoice, "invoice">> {
    const invoice = this.#invoices.get(paymentHash);
    if (!invoice) throw new Error("invoice not found");
    const result: Omit<WalletInvoice, "invoice"> = {
      paymentHash: invoice.paymentHash,
      amountMsat: invoice.amountMsat,
      status: invoice.status,
    };
    if (invoice.settledAt !== undefined) result.settledAt = invoice.settledAt;
    return result;
  }

  async settleInvoice(paymentHash: string): Promise<void> {
    const invoice = this.#invoices.get(paymentHash);
    if (!invoice) throw new Error("invoice not found");
    if (invoice.status === "settled") return;
    this.#settlementSequence += 1;
    invoice.status = "settled";
    invoice.settledAt = this.#settlementSequence;
  }

  async payInvoice(input: {
    invoice: string;
    idempotencyKey: string;
    amountMsat: number;
  }): Promise<WalletPayment> {
    const existing = this.#payments.get(input.idempotencyKey);
    if (existing) return { ...existing };
    if (!Number.isSafeInteger(input.amountMsat) || input.amountMsat <= 0) {
      throw new Error("payment amount must be positive integer millisatoshis");
    }
    const payment: WalletPayment = {
      paymentId: `fake-payment:${input.idempotencyKey}`,
      status: "succeeded",
      amountMsat: input.amountMsat,
      feeMsat: 0,
    };
    this.#payments.set(input.idempotencyKey, payment);
    return { ...payment };
  }

  async lookupPayment(paymentId: string): Promise<WalletPayment> {
    const payment = this.#payments.get(paymentId) ?? Array.from(this.#payments.values()).find(
      (candidate) => candidate.paymentId === paymentId,
    );
    if (!payment) throw new Error("payment not found");
    return { ...payment };
  }
}

export function createWalletFromConfig(input: {
  backend: string;
  nodeEnv: string;
  allowFakeInProduction?: boolean;
  lnbitsEndpoint?: string;
  lnbitsInvoiceKey?: string;
  lnbitsAdminKey?: string;
}): RevenueWallet {
  if (input.backend === "lnbits") {
    return new LnbitsWallet({
      endpoint: input.lnbitsEndpoint || "",
      invoiceKey: input.lnbitsInvoiceKey || "",
      adminKey: input.lnbitsAdminKey || "",
    });
  }
  if (input.backend === "fake") {
    if (input.nodeEnv === "production" && !input.allowFakeInProduction) {
      throw new Error("FakeWallet is disabled in production; configure a managed wallet backend");
    }
    return new FakeWallet();
  }
  throw new Error(`unsupported revenue wallet backend: ${input.backend}`);
}
