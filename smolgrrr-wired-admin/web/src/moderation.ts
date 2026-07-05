import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeUrl, uniqueSorted } from "./utils.js";
import type { ModerationManifest } from "./contracts/api.js";
import type { NostrEvent } from "./contracts/nostr.js";
import type {
  ModerationAction,
  ModerationActionInput,
  ModerationActionKind,
  ModerationReason,
  ModerationStore,
} from "./contracts/stores.js";
import { isNostrEvent, parseModerationStore } from "./contracts/validation.js";

const emptyModerationManifest = {
  updatedAt: 0,
  blockedEventIds: [],
  blockedThreadRoots: [],
  blockedMediaUrls: [],
  blockedDomains: [],
  blockedContentFingerprints: [],
};

const httpUrlPattern = /https?:\/\/[^\s<>"')\]]+/gi;
const mediaExtensionPattern =
  /\.(?:jpe?g|png|gif|webp|mp4|webm|mov|mp3|wav|ogg|m4a)(?:\?|$)/i;

function imetaUrls(event: NostrEvent): string[] {
  return (event.tags || [])
    .filter((tag) => tag[0] === "imeta")
    .flatMap((tag) =>
      tag
        .slice(1)
        .filter((part) => part.startsWith("url "))
        .map((part) => part.slice("url ".length).trim()),
    );
}

function eventUrls(event: NostrEvent): string[] {
  const contentUrls = [...String(event.content || "").matchAll(httpUrlPattern)].map(
    (match) => match[0],
  );
  return uniqueSorted([...contentUrls, ...imetaUrls(event)].map(normalizeUrl));
}

function domainFromUrl(value: string): string | null {
  const normalized = normalizeUrl(value);
  if (!normalized) return null;
  try {
    return new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function mediaUrlsFromEvent(event: NostrEvent): string[] {
  return uniqueSorted(eventUrls(event).filter((url) => mediaExtensionPattern.test(url)));
}

function parsedRepostEvent(event: NostrEvent): NostrEvent | null {
  if (event.kind !== 6) return null;
  try {
    const parsed = JSON.parse(event.content);
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.pubkey !== "string" ||
      typeof parsed.content !== "string" ||
      !Array.isArray(parsed.tags) ||
      typeof parsed.created_at !== "number" ||
      typeof parsed.kind !== "number" ||
      typeof parsed.sig !== "string"
    ) {
      return null;
    }
    return isNostrEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function visibleEventVariants(event: NostrEvent): NostrEvent[] {
  const repost = parsedRepostEvent(event);
  return repost ? [event, repost] : [event];
}

function rootReferences(event: NostrEvent): string[] {
  return (event.tags || [])
    .filter((tag): tag is [string, string, ...string[]] => tag[0] === "e" && Boolean(tag[1]))
    .map((tag) => tag[1]);
}

function normalizeContentForFingerprint(content: unknown): string {
  return String(content || "")
    .replace(httpUrlPattern, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function contentFingerprint(content: unknown): string {
  const normalized = normalizeContentForFingerprint(content);
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizeModerationValue(kind: ModerationActionKind, value: unknown): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) return null;

  if (kind === "block_domain") {
    return (
      trimmed
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .split("/")[0] || ""
        .trim()
        .toLowerCase() || null
    );
  }

  if (kind === "block_media_url") {
    return normalizeUrl(trimmed);
  }

  if (kind === "block_content_fingerprint") {
    return trimmed.startsWith("fnv1a:") ? trimmed : contentFingerprint(trimmed);
  }

  return trimmed.toLowerCase();
}

export type ModerationService = ReturnType<typeof createModerationService>;

export function createModerationService(storeFile: string) {
  async function readStore(): Promise<ModerationStore> {
    try {
      const parsed = JSON.parse(await readFile(storeFile, "utf8"));
      const store = parseModerationStore(parsed);
      if (store) return store;
    } catch {
      // Missing or malformed stores are treated as empty.
    }
    return { version: 1, actions: [] };
  }

  async function writeStore(data: ModerationStore): Promise<void> {
    await mkdir(path.dirname(storeFile), { recursive: true });
    const temp = `${storeFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temp, storeFile);
  }

  async function getActions(): Promise<ModerationAction[]> {
    const store = await readStore();
    return [...store.actions].sort((a, b) => b.createdAt - a.createdAt);
  }

  function manifestFromActions(actions: ModerationAction[]): ModerationManifest {
    if (actions.length === 0) return emptyModerationManifest;

    const blockedEventIds = new Set<string>();
    const blockedThreadRoots = new Set<string>();
    const blockedMediaUrls = new Set<string>();
    const blockedDomains = new Set<string>();
    const blockedContentFingerprints = new Set<string>();

    for (const action of actions) {
      const normalized = normalizeModerationValue(action.kind, action.value);
      if (!normalized) continue;
      if (action.kind === "block_event") blockedEventIds.add(normalized);
      if (action.kind === "block_thread") {
        blockedEventIds.add(normalized);
        blockedThreadRoots.add(normalized);
      }
      if (action.kind === "block_media_url") blockedMediaUrls.add(normalized);
      if (action.kind === "block_domain") blockedDomains.add(normalized);
      if (action.kind === "block_content_fingerprint") {
        blockedContentFingerprints.add(normalized);
      }
    }

    return {
      updatedAt: actions.reduce((latest, action) => Math.max(latest, action.createdAt), 0),
      blockedEventIds: uniqueSorted(blockedEventIds),
      blockedThreadRoots: uniqueSorted(blockedThreadRoots),
      blockedMediaUrls: uniqueSorted(blockedMediaUrls),
      blockedDomains: uniqueSorted(blockedDomains),
      blockedContentFingerprints: uniqueSorted(blockedContentFingerprints),
    };
  }

  async function getManifest() {
    return manifestFromActions((await readStore()).actions);
  }

  async function createAction(input: ModerationActionInput): Promise<ModerationAction> {
    const actionKinds = new Set<ModerationActionKind>([
      "block_event",
      "block_thread",
      "block_media_url",
      "block_domain",
      "block_content_fingerprint",
    ]);
    const reasons = new Set<ModerationReason>(["illegal", "spam", "abuse", "manual"]);

    if (!actionKinds.has(input.kind)) throw new Error("invalid action kind");
    if (!reasons.has(input.reason)) throw new Error("invalid reason");

    const normalizedValue = normalizeModerationValue(input.kind, input.value);
    if (!normalizedValue) throw new Error("invalid moderation value");

    const store = await readStore();
    const action: ModerationAction = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      kind: input.kind,
      value: normalizedValue,
      reason: input.reason,
      createdAt: Date.now(),
      moderator: input.moderator?.trim() || "local-admin",
    };
    const note = input.note?.trim();
    if (note) action.note = note;
    store.actions.push(action);
    await writeStore(store);
    return action;
  }

  async function deleteAction(id: string): Promise<ModerationAction> {
    const store = await readStore();
    const index = store.actions.findIndex((action) => action.id === id);
    if (index === -1) throw new Error("moderation action not found");

    const [action] = store.actions.splice(index, 1);
    if (!action) throw new Error("moderation action not found");
    await writeStore(store);
    return action;
  }

  function isEventModerated(event: NostrEvent, manifest: ModerationManifest): boolean {
    const variants = visibleEventVariants(event);
    const blockedEventIds = new Set(manifest.blockedEventIds);
    if (variants.some((variant) => blockedEventIds.has(variant.id.toLowerCase()))) {
      return true;
    }

    const blockedThreadRoots = new Set(manifest.blockedThreadRoots);
    if (
      variants.some((variant) =>
        rootReferences(variant).some((id) => blockedThreadRoots.has(id.toLowerCase())),
      )
    ) {
      return true;
    }

    const blockedMediaUrls = new Set(manifest.blockedMediaUrls);
    if (
      variants.some((variant) =>
        mediaUrlsFromEvent(variant).some((url) => blockedMediaUrls.has(url)),
      )
    ) {
      return true;
    }

    const blockedDomains = new Set(manifest.blockedDomains);
    if (
      variants.some((variant) =>
        eventUrls(variant)
          .map(domainFromUrl)
          .some((domain) => domain && blockedDomains.has(domain)),
      )
    ) {
      return true;
    }

    const blockedContentFingerprints = new Set(manifest.blockedContentFingerprints);
    return variants.some((variant) =>
      blockedContentFingerprints.has(contentFingerprint(variant.content)),
    );
  }

  return {
    createAction,
    deleteAction,
    getActions,
    getManifest,
    isEventModerated,
    manifestFromActions,
  };
}
