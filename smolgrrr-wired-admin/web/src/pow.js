import { getEventHash } from "nostr-tools";

export function countLeadingZeroBits(hex) {
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

export function eventPow(event) {
  if (!event || typeof event !== "object" || typeof event.id !== "string") {
    return 0;
  }
  return countLeadingZeroBits(event.id);
}

export function verifyPow(event, requiredPow) {
  if (!event || typeof event !== "object") {
    return { ok: false, reason: "invalid event", pow: 0 };
  }

  let hash;
  try {
    hash = getEventHash(event);
  } catch {
    return { ok: false, reason: "invalid event hash", pow: 0 };
  }

  if (hash !== event.id) {
    return {
      ok: false,
      reason: "event id does not match event hash",
      pow: countLeadingZeroBits(hash),
    };
  }

  const pow = countLeadingZeroBits(hash);
  const nonceTag = Array.isArray(event.tags)
    ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === "nonce")
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
