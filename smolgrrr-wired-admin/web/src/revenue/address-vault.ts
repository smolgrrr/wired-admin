import crypto from "node:crypto";

export type EncryptedAddress = {
  keyVersion: number;
  payoutKey: string;
  ciphertext: string;
  iv: string;
  tag: string;
};

export class AddressVault {
  readonly #encryptionKey: Buffer;
  readonly #fingerprintKey: Buffer;
  readonly #keyVersion: number;

  constructor(key: Uint8Array, keyVersion = 1) {
    if (key.byteLength !== 32) throw new Error("revenue encryption key must be 32 bytes");
    if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) {
      throw new Error("revenue encryption key version must be a positive integer");
    }
    this.#encryptionKey = Buffer.from(key);
    this.#keyVersion = keyVersion;
    this.#fingerprintKey = crypto
      .createHmac("sha256", this.#encryptionKey)
      .update("wired-revenue-payout-fingerprint-v1")
      .digest();
  }

  get keyVersion(): number {
    return this.#keyVersion;
  }

  encrypt(address: string): EncryptedAddress {
    const normalized = address.trim().toLowerCase();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
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
    if (input.keyVersion !== this.#keyVersion) {
      throw new Error(`revenue encryption key version ${input.keyVersion} is unavailable`);
    }
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.#encryptionKey,
      Buffer.from(input.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(input.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }
}
