import crypto from "node:crypto";
import sharp from "sharp";

export function sha256(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

export async function differenceHash(bytes: Uint8Array): Promise<string> {
  const pixels = await sharp(bytes, { failOn: "error", limitInputPixels: 40_000_000 })
    .rotate()
    .resize(9, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();
  let hash = 0n;
  for (let row = 0; row < 8; row += 1) {
    for (let column = 0; column < 8; column += 1) {
      hash <<= 1n;
      const left = pixels[row * 9 + column] ?? 0;
      const right = pixels[row * 9 + column + 1] ?? 0;
      if (left > right) hash |= 1n;
    }
  }
  return hash.toString(16).padStart(16, "0");
}

export function hammingDistance(left: string, right: string): number {
  if (!/^[0-9a-f]{16}$/i.test(left) || !/^[0-9a-f]{16}$/i.test(right)) return 64;
  let bits = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (bits > 0n) {
    distance += Number(bits & 1n);
    bits >>= 1n;
  }
  return distance;
}
