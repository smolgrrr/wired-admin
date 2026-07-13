import crypto from "node:crypto";

export type EncryptedAddress = {
  payoutKey: string;
  ciphertext: string;
  iv: string;
  tag: string;
};

export class AddressVault {
  readonly #encryptionKey: Buffer;
  readonly #fingerprintKey: Buffer;

  constructor(key: Uint8Array) {
    if (key.byteLength !== 32) throw new Error("revenue encryption key must be 32 bytes");
    this.#encryptionKey = Buffer.from(key);
    this.#fingerprintKey = crypto
      .createHmac("sha256", this.#encryptionKey)
      .update("wired-revenue-payout-fingerprint-v1")
      .digest();
  }

  encrypt(address: string): EncryptedAddress {
    const normalized = address.trim().toLowerCase();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
    return {
      payoutKey: crypto.createHmac("sha256", this.#fingerprintKey).update(normalized).digest("hex"),
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(input: { ciphertext: string; iv: string; tag: string }): string {
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
