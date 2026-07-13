import type { RevenueWallet, WalletInvoice, WalletPayment } from "./wallet.js";

type LnbitsWalletOptions = {
  endpoint: string;
  invoiceKey: string;
  adminKey: string;
  webhookUrl?: string;
  fetchImplementation?: typeof fetch;
};

type LnbitsPayment = {
  payment_hash?: string;
  payment_request?: string;
  checking_id?: string;
  paid?: boolean;
  pending?: boolean;
  amount?: number;
  fee?: number;
  detail?: string;
};

export class LnbitsWallet implements RevenueWallet {
  readonly backend = "lnbits";
  readonly #endpoint: string;
  readonly #invoiceKey: string;
  readonly #adminKey: string;
  readonly #fetch: typeof fetch;
  readonly #webhookUrl: string | undefined;
  readonly #invoiceAmounts = new Map<string, number>();
  readonly #paymentAmounts = new Map<string, number>();

  constructor(options: LnbitsWalletOptions) {
    this.#endpoint = options.endpoint.trim().replace(/\/+$/, "");
    this.#invoiceKey = options.invoiceKey.trim();
    this.#adminKey = options.adminKey.trim();
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#webhookUrl = options.webhookUrl;
    if (!this.#endpoint.startsWith("https://")) throw new Error("LNbits endpoint must use HTTPS");
    if (!this.#invoiceKey || !this.#adminKey) throw new Error("LNbits invoice and admin keys are required");
  }

  async createInvoice(input: {
    amountMsat: number;
    descriptionHash: string;
    idempotencyKey: string;
  }): Promise<WalletInvoice> {
    if (!Number.isSafeInteger(input.amountMsat) || input.amountMsat <= 0 || input.amountMsat % 1_000 !== 0) {
      throw new Error("LNbits invoices require a whole-satoshi millisatoshi amount");
    }
    const existing = await this.#findByExternalId(input.idempotencyKey, this.#invoiceKey);
    if (existing?.payment_hash && existing.payment_request) {
      this.#invoiceAmounts.set(existing.payment_hash, input.amountMsat);
      return {
        paymentHash: existing.payment_hash,
        invoice: existing.payment_request,
        amountMsat: input.amountMsat,
        status: existing.paid ? "settled" : "pending",
      };
    }
    const value = await this.#request("/api/v1/payments", this.#invoiceKey, {
      method: "POST",
      body: {
        out: false,
        amount: input.amountMsat / 1_000,
        memo: "",
        description_hash: input.descriptionHash,
        external_id: input.idempotencyKey,
        ...(this.#webhookUrl ? { webhook: this.#webhookUrl } : {}),
      },
    });
    if (!value.payment_hash || !value.payment_request) throw new Error("LNbits did not return an invoice");
    this.#invoiceAmounts.set(value.payment_hash, input.amountMsat);
    return {
      paymentHash: value.payment_hash,
      invoice: value.payment_request,
      amountMsat: input.amountMsat,
      status: "pending",
    };
  }

  async lookupInvoice(paymentHash: string): Promise<Omit<WalletInvoice, "invoice">> {
    const value = await this.#request(`/api/v1/payments/${encodeURIComponent(paymentHash)}`, this.#invoiceKey);
    const amountMsat = this.#invoiceAmounts.get(paymentHash) ?? Math.abs(Number(value.amount || 0));
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) throw new Error("LNbits invoice amount is missing");
    return {
      paymentHash,
      amountMsat,
      status: value.paid ? "settled" : "pending",
      ...(value.paid ? { settledAt: Date.now() } : {}),
    };
  }

  async payInvoice(input: {
    invoice: string;
    idempotencyKey: string;
    amountMsat: number;
  }): Promise<WalletPayment> {
    const value = await this.#request("/api/v1/payments", this.#adminKey, {
      method: "POST",
      body: {
        out: true,
        bolt11: input.invoice,
        extra: { wired_idempotency_key: input.idempotencyKey },
        external_id: input.idempotencyKey,
      },
    });
    const paymentId = value.checking_id || value.payment_hash;
    if (!paymentId) throw new Error("LNbits did not return an outgoing payment identity");
    this.#paymentAmounts.set(paymentId, input.amountMsat);
    return {
      paymentId,
      status: value.pending ? "pending" : "succeeded",
      amountMsat: input.amountMsat,
      feeMsat: Math.abs(Number(value.fee || 0)),
    };
  }

  async estimateFeeMsat(invoice: string): Promise<number> {
    const response = await this.#fetch(
      `${this.#endpoint}/api/v1/payments/fee-reserve?invoice=${encodeURIComponent(invoice)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
    );
    const value = await response.json().catch(() => null) as { fee_reserve?: number } | null;
    const feeMsat = Number(value?.fee_reserve);
    if (!response.ok || !Number.isSafeInteger(feeMsat) || feeMsat < 0) {
      throw new Error("LNbits fee reserve quote is unavailable");
    }
    return feeMsat;
  }

  async lookupPayment(paymentId: string, expectedAmountMsat?: number): Promise<WalletPayment> {
    let value: LnbitsPayment;
    const byExternalId = await this.#findByExternalId(paymentId, this.#adminKey);
    if (byExternalId) {
      value = byExternalId;
    } else {
      const response = await this.#fetch(`${this.#endpoint}/api/v1/payments/${encodeURIComponent(paymentId)}`, {
        headers: { Accept: "application/json", "X-Api-Key": this.#adminKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        return {
          paymentId,
          status: "failed",
          amountMsat: expectedAmountMsat || 0,
          failureReason: "payment not found",
        };
      }
      const parsed = await response.json().catch(() => null) as LnbitsPayment | null;
      if (!response.ok || !parsed) throw new Error(`LNbits request failed with HTTP ${response.status}`);
      value = parsed;
    }
    const amountMsat = this.#paymentAmounts.get(paymentId)
      ?? expectedAmountMsat
      ?? Math.abs(Number(value.amount || 0));
    if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) throw new Error("LNbits payment amount is missing");
    return {
      paymentId,
      status: value.paid ? "succeeded" : value.pending ? "pending" : "failed",
      amountMsat,
      feeMsat: Math.abs(Number(value.fee || 0)),
      ...(!value.paid && !value.pending && value.detail ? { failureReason: value.detail } : {}),
    };
  }

  async #findByExternalId(externalId: string, key: string): Promise<LnbitsPayment | null> {
    const response = await this.#fetch(
      `${this.#endpoint}/api/v1/payments?external_id=${encodeURIComponent(externalId)}`,
      {
        headers: { Accept: "application/json", "X-Api-Key": key },
        signal: AbortSignal.timeout(15_000),
      },
    );
    const matches = await response.json().catch(() => null) as LnbitsPayment[] | null;
    if (!response.ok || !Array.isArray(matches)) {
      throw new Error(`LNbits request failed with HTTP ${response.status}`);
    }
    return matches[0] || null;
  }

  async #request(
    pathname: string,
    key: string,
    options: { method?: string; body?: Record<string, unknown> } = {},
  ): Promise<LnbitsPayment> {
    const response = await this.#fetch(`${this.#endpoint}${pathname}`, {
      method: options.method || "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": key,
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const value = await response.json().catch(() => null) as LnbitsPayment | null;
    if (!response.ok || !value) {
      throw new Error(`LNbits request failed with HTTP ${response.status}`);
    }
    return value;
  }
}
