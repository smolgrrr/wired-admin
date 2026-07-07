import type { FeedBootstrapSnapshot } from "./api.js";
import type { NostrEvent } from "./nostr.js";
import type { ConfessStore, ModerationActionInput, ModerationStore } from "./stores.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isNostrEvent(value: unknown): value is NostrEvent {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.pubkey === "string" &&
    typeof value.content === "string" &&
    typeof value.created_at === "number" &&
    typeof value.kind === "number" &&
    typeof value.sig === "string" &&
    Array.isArray(value.tags) &&
    value.tags.every(isStringArray)
  );
}

export function parseFeedBootstrapSnapshot(value: unknown): FeedBootstrapSnapshot | null {
  if (!isRecord(value)) return null;
  if (typeof value.fetchedAt !== "number") return null;
  if (!Array.isArray(value.processedEvents)) return null;
  if (
    !value.processedEvents.every((event) =>
      isRecord(event) &&
      typeof event.postEventId === "string" &&
      isStringArray(event.replyIds) &&
      (event.relayHints === undefined || isStringArray(event.relayHints)) &&
      typeof event.threadReplyCount === "number" &&
      typeof event.rootWork === "number" &&
      typeof event.replyWork === "number" &&
      typeof event.totalWork === "number" &&
      typeof event.rankingReplyCount === "number"
    )
  ) {
    return null;
  }
  if (!isRecord(value.eventsById)) return null;
  if (!Object.values(value.eventsById).every(isNostrEvent)) return null;
  if (!isRecord(value.relayHintsByEventId)) return null;
  if (!Object.values(value.relayHintsByEventId).every(isStringArray)) return null;
  if (!isRecord(value.profiles)) return null;
  if (!isRecord(value.scoring)) return null;
  if (typeof value.scoring.ageHours !== "number") return null;
  if (typeof value.scoring.minPow !== "number") return null;
  if (typeof value.scoring.replyDepth !== "number") return null;
  if (value.scoring.sort !== "totalWork") return null;
  return value as FeedBootstrapSnapshot;
}

export function parseModerationStore(value: unknown): ModerationStore | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.actions)) return null;
  return value as ModerationStore;
}

export function parseConfessStore(value: unknown): ConfessStore | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.posts)) return null;
  return value as ConfessStore;
}

export function parseModerationActionInput(value: unknown): ModerationActionInput {
  if (!isRecord(value)) throw new Error("invalid moderation action");
  const input: ModerationActionInput = {
    kind: String(value.kind || "") as ModerationActionInput["kind"],
    value: String(value.value || ""),
    reason: String(value.reason || "") as ModerationActionInput["reason"],
  };
  if (typeof value.note === "string") input.note = value.note;
  if (typeof value.moderator === "string") input.moderator = value.moderator;
  return input;
}
