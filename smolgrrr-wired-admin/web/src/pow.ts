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

function nonceTarget(event: Partial<Event>): number | null {
  const nonceTag = Array.isArray(event.tags)
    ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === "nonce")
    : undefined;
  const claimedTarget = Number.parseInt(nonceTag?.[2] || "", 10);
  return nonceTag && !Number.isNaN(claimedTarget) ? claimedTarget : null;
}

export function eventPow(event: unknown): number {
  const candidate = event as Partial<Event> | null;
  if (!candidate || typeof candidate !== "object") {
    return 0;
  }

  let hash;
  try {
    hash = getEventHash(candidate as Event);
  } catch {
    return 0;
  }

  const claimedTarget = nonceTarget(candidate);
  if (claimedTarget === null) return 0;

  return Math.min(countLeadingZeroBits(hash), claimedTarget);
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
  const claimedTarget = nonceTarget(candidate);
  const effectivePow =
    claimedTarget === null ? 0 : Math.min(countLeadingZeroBits(hash), claimedTarget);

  if (hash !== candidate.id) {
    return {
      ok: false,
      reason: "event id does not match event hash",
      pow: effectivePow,
    };
  }

  const pow = countLeadingZeroBits(hash);

  if (claimedTarget === null) {
    return { ok: false, reason: "missing nonce tag", pow: 0 };
  }

  if (claimedTarget < requiredPow) {
    return {
      ok: false,
      reason: `nonce target ${claimedTarget} is below ${requiredPow}`,
      pow: effectivePow,
    };
  }

  if (pow < requiredPow) {
    return { ok: false, reason: `proof ${pow} is below ${requiredPow}`, pow: effectivePow };
  }

  return { ok: true, reason: "", pow: effectivePow };
}
