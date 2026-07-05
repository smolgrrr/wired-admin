import { getEventHash, type Event } from "nostr-tools";

export type PowResult = {
  ok: boolean;
  reason: string;
  pow: number;
};

export function countLeadingZeroBits(hex: string): number {
  let count = 0;
  for (const char of hex) {
    const nibble = Number.parseInt(char, 16);
    if (Number.isNaN(nibble)) return 0;
    if (nibble === 0) {
      count += 4;
      continue;
    }
    return count + Math.clz32(nibble) - 28;
  }
  return count;
}

export function eventPow(event: unknown): number {
  const candidate = event as Partial<Event> | null;
  if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string") {
    return 0;
  }
  return countLeadingZeroBits(candidate.id);
}

export function verifyPow(event: unknown, requiredPow: number): PowResult {
  if (!event || typeof event !== "object") {
    return { ok: false, reason: "invalid event", pow: 0 };
  }

  let hash;
  try {
    hash = getEventHash(event as Event);
  } catch {
    return { ok: false, reason: "invalid event hash", pow: 0 };
  }

  const candidate = event as Partial<Event>;
  if (hash !== candidate.id) {
    return {
      ok: false,
      reason: "event id does not match event hash",
      pow: countLeadingZeroBits(hash),
    };
  }

  const pow = countLeadingZeroBits(hash);
  const nonceTag = Array.isArray(candidate.tags)
    ? candidate.tags.find((tag) => Array.isArray(tag) && tag[0] === "nonce")
    : undefined;
  const claimedTarget = Number.parseInt(nonceTag?.[2] || "", 10);

  if (!nonceTag || Number.isNaN(claimedTarget)) {
    return { ok: false, reason: "missing nonce tag", pow };
  }

  if (claimedTarget < requiredPow) {
    return {
      ok: false,
      reason: `nonce target ${claimedTarget} is below ${requiredPow}`,
      pow,
    };
  }

  if (pow < requiredPow) {
    return { ok: false, reason: `proof ${pow} is below ${requiredPow}`, pow };
  }

  return { ok: true, reason: "", pow };
}
