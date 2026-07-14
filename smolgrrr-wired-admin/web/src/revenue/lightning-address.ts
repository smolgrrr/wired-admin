export type LightningAddressMetadata = {
  address: string;
  callback: string;
  minSendableMsat: number;
  maxSendableMsat: number;
};

export interface LightningAddressResolver {
  validate(address: string): Promise<LightningAddressMetadata>;
  requestInvoice(address: string, amountMsat: number): Promise<string>;
}

export function parseLightningAddress(address: string): {
  address: string;
  username: string;
  domain: string;
} {
  const normalized = String(address || "").trim().toLowerCase();
  const match = /^([^\s@]{1,64})@([a-z0-9.-]{1,253})$/i.exec(normalized);
  if (!match?.[1] || !match[2] || match[2].startsWith(".") || match[2].endsWith(".")) {
    throw new Error("invalid Lightning address");
  }
  return { address: normalized, username: match[1], domain: match[2] };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const value = await response.json().catch(() => null);
  if (!response.ok || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Lightning address provider returned HTTP ${response.status}`);
  }
  return value as Record<string, unknown>;
}

export class HttpLightningAddressResolver implements LightningAddressResolver {
  readonly #fetch: typeof fetch;

  constructor(fetchImplementation: typeof fetch = fetch) {
    this.#fetch = fetchImplementation;
  }

  async validate(address: string): Promise<LightningAddressMetadata> {
    const parsed = parseLightningAddress(address);
    const response = await this.#fetch(
      `https://${parsed.domain}/.well-known/lnurlp/${encodeURIComponent(parsed.username)}`,
      { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8_000) },
    );
    const value = await readJson(response);
    if (value.status === "ERROR") throw new Error("Lightning address provider rejected the address");
    const callback = String(value.callback || "");
    const minSendableMsat = Number(value.minSendable);
    const maxSendableMsat = Number(value.maxSendable);
    const callbackUrl = new URL(callback);
    if (callbackUrl.protocol !== "https:") throw new Error("Lightning address callback must use HTTPS");
    if (!Number.isSafeInteger(minSendableMsat) || minSendableMsat <= 0) {
      throw new Error("Lightning address minimum is invalid");
    }
    if (!Number.isSafeInteger(maxSendableMsat) || maxSendableMsat < minSendableMsat) {
      throw new Error("Lightning address maximum is invalid");
    }
    return {
      address: parsed.address,
      callback: callbackUrl.toString(),
      minSendableMsat,
      maxSendableMsat,
    };
  }

  async requestInvoice(address: string, amountMsat: number): Promise<string> {
    const metadata = await this.validate(address);
    if (amountMsat < metadata.minSendableMsat || amountMsat > metadata.maxSendableMsat) {
      throw new Error("payout amount is outside destination bounds");
    }
    const callback = new URL(metadata.callback);
    callback.searchParams.set("amount", String(amountMsat));
    const value = await readJson(await this.#fetch(callback, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    }));
    if (value.status === "ERROR" || typeof value.pr !== "string" || !value.pr) {
      throw new Error("Lightning address provider did not return an invoice");
    }
    return value.pr;
  }
}

export class StagingLightningAddressResolver implements LightningAddressResolver {
  readonly #http: HttpLightningAddressResolver;

  constructor(fetchImplementation: typeof fetch = fetch) {
    this.#http = new HttpLightningAddressResolver(fetchImplementation);
  }

  async validate(address: string): Promise<LightningAddressMetadata> {
    const parsed = parseLightningAddress(address);
    if (!parsed.domain.endsWith(".invalid")) return this.#http.validate(parsed.address);
    return {
      address: parsed.address,
      callback: "https://fake.invalid/lnurl",
      minSendableMsat: 1_000,
      maxSendableMsat: 100_000_000_000,
    };
  }

  async requestInvoice(address: string, amountMsat: number): Promise<string> {
    const metadata = await this.validate(address);
    if (!metadata.address.endsWith(".invalid")) return this.#http.requestInvoice(address, amountMsat);
    return `fake-invoice:${metadata.address}:${amountMsat}`;
  }
}
