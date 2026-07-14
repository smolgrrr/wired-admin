import crypto from "node:crypto";

export type EncryptedAddress = {
  keyVersion: number;
  payoutKey: string;
  ciphertext: string;
  iv: string;
  tag: string;
};

export class AddressVault {
  readonly #encryptionKeys = new Map<number, Buffer>();
  readonly #currentEncryptionKey: Buffer;
  readonly #fingerprintKey: Buffer;
  readonly #keyVersion: number;

  constructor(
    key: Uint8Array,
    keyVersion = 1,
    decryptionKeys: Record<number, Uint8Array> = {},
  ) {
    if (key.byteLength !== 32) throw new Error("revenue encryption key must be 32 bytes");
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      throw new Error("revenue encryption key version must be a positive integer");
    }
    this.#keyVersion = keyVersion;
    for (const [rawVersion, historicalKey] of Object.entries(decryptionKeys)) {
      const version = Number(rawVersion);
      if (!Number.isSafeInteger(version) || version < 1 || historicalKey.byteLength !== 32) {
        throw new Error("historical revenue encryption keys must be versioned 32-byte keys");
      }
      this.#encryptionKeys.set(version, Buffer.from(historicalKey));
    }
    this.#currentEncryptionKey = Buffer.from(key);
    this.#encryptionKeys.set(keyVersion, this.#currentEncryptionKey);
    const fingerprintVersion = Math.min(...this.#encryptionKeys.keys());
    const fingerprintSource = this.#encryptionKeys.get(fingerprintVersion);
    if (!fingerprintSource) throw new Error("revenue fingerprint key is unavailable");
    this.#fingerprintKey = crypto
      .createHmac("sha256", fingerprintSource)
      .update("wired-revenue-payout-fingerprint-v1")
      .digest();
  }

  get keyVersion(): number {
    return this.#keyVersion;
  }

  hasKeyVersion(version: number): boolean {
    return this.#encryptionKeys.has(version);
  }

  encrypt(address: string): EncryptedAddress {
    const normalized = address.trim().toLowerCase();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#currentEncryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
    return {
      keyVersion: this.#keyVersion,
      payoutKey: crypto.createHmac("sha256", this.#fingerprintKey).update(normalized).digest("hex"),
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(input: { keyVersion: number; ciphertext: string; iv: string; tag: string }): string {
    const encryptionKey = this.#encryptionKeys.get(input.keyVersion);
    if (!encryptionKey) {
      throw new Error(`revenue encryption key version ${input.keyVersion} is unavailable`);
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      encryptionKey,
      Buffer.from(input.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(input.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
