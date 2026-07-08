import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { finalizeEvent, getPublicKey, nip19, Relay, type EventTemplate } from "nostr-tools";
import { WebSocketServer, type RawData } from "ws";
import {
  envFlag as readEnvFlag,
  envList as readEnvList,
  normalizeHost as normalizeConfiguredHost,
  normalizeRelayUrl,
  readJsonResponse as readHttpJsonResponse,
  summarizeHttpError,
  uniqueRelays,
  uniqueSorted as uniqueSortedValues,
  withTimeout as withPromiseTimeout,
} from "./src/utils.js";
import { verifyPow as verifyEventPow } from "./src/pow.js";
import { createXClient } from "./src/x-client.js";
import {
  createConfessPostcardRenderer,
  isSafeConfessPostcardImageUrl,
} from "./src/confess-postcard-renderer.js";
import { createModerationService } from "./src/moderation.js";
import { createFeedSnapshotService } from "./src/feed-snapshot-service.js";
import { registerHttpRoutes } from "./src/http-routes.js";
import { createRelayGateway } from "./src/relay-gateway.js";
import { createHttpAccess } from "./src/http-access.js";
import type {
  ConfessStatus,
  ConfessXStatus,
  HttpError,
  PublicConfessXMirror,
  RelayInfo,
  RelayRecentActivity,
  RelayStats,
  WiredAccountStatus,
} from "./src/contracts/api.js";
import type { NostrEvent } from "./src/contracts/nostr.js";
import type {
  ConfessPostRecord,
  ConfessStore,
  ConfessXCustomEmoji,
  ConfessXMirror,
  WiredAccountPostRecord,
  WiredAccountStore,
} from "./src/contracts/stores.js";
import {
  isNostrEvent,
  isNostrProofEvent,
  parseConfessStore,
  parseWiredAccountStore,
} from "./src/contracts/validation.js";

type NostrProofEvent = Omit<NostrEvent, "sig"> & { sig?: string };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

const port = Number(process.env.PORT || 3000);
const backendUrl = process.env.RELAY_BACKEND_URL || "ws://relay:7777";
const minPow = Number(process.env.RELAY_MIN_POW || 16);
const dataDir = process.env.WIRED_DATA_DIR || path.join(appRoot, "data");
const publicDir = path.join(appRoot, "public");
const snapshotCacheFile =
  process.env.FEED_SNAPSHOT_CACHE_FILE || path.join(dataDir, "feed-bootstrap.json");
const moderationStoreFile =
  process.env.WIRED_MODERATION_STORE || path.join(dataDir, "moderation.json");
const confessStoreFile =
  process.env.CONFESS_STORE_FILE || path.join(dataDir, "confess.json");
const wiredAccountStoreFile =
  process.env.WIRED_ACCOUNT_STORE_FILE || path.join(dataDir, "wired-account.json");
const refreshSeconds = Number(process.env.FEED_SNAPSHOT_REFRESH_SECONDS || 300);
const snapshotAgeHours = Number(process.env.FEED_SNAPSHOT_AGE_HOURS || 24);
const snapshotTimeoutMs = Number(process.env.FEED_SNAPSHOT_TIMEOUT_MS || 20_000);
const snapshotReplyLimit = Math.max(1, Number(process.env.FEED_SNAPSHOT_REPLY_LIMIT || 500));
const replyFetchDepth = Math.max(
  0,
  Math.min(Number(process.env.FEED_SNAPSHOT_REPLY_DEPTH || 2), 2),
);

const powRelays = readEnvList("POW_RELAYS", [
  "wss://relay.wiredsignal.online",
  "wss://powrelay.xyz",
  "wss://pow.relays.land",
]);
const enrichmentRelays = readEnvList("ENRICHMENT_RELAYS", [
  "wss://relay.wiredsignal.online",
  "wss://relay.damus.io",
  "wss://offchain.pub",
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://nostr.wine",
  "wss://relay.snort.social",
]);
const threadRelays = [...new Set([backendUrl, ...powRelays, ...enrichmentRelays])];
const confessRelays = readEnvList("CONFESS_RELAYS", [backendUrl, ...threadRelays]);
const wiredAccountRelays = readEnvList("WIRED_ACCOUNT_RELAYS", confessRelays);
const confessDailyLimit = Math.max(1, Number(process.env.CONFESS_DAILY_LIMIT || 6));
const confessBasePow = Math.max(minPow, Number(process.env.CONFESS_MIN_POW || minPow));
const wiredAccountMinPow = Math.max(
  minPow,
  Number(process.env.WIRED_ACCOUNT_MIN_POW || process.env.CONFESS_MIN_POW || minPow) || minPow,
);
const confessMaxPow = Math.max(confessBasePow, Number(process.env.CONFESS_MAX_POW || 28));
const confessContentMaxLength = Math.max(
  1,
  Number(process.env.CONFESS_CONTENT_MAX_LENGTH || 2000),
);
const wiredAccountContentMaxLength = Math.max(
  1,
  Number(process.env.WIRED_ACCOUNT_CONTENT_MAX_LENGTH || confessContentMaxLength) ||
    confessContentMaxLength,
);
const confessPublishTimeoutMs = Math.max(
  1000,
  Number(process.env.CONFESS_PUBLISH_TIMEOUT_MS || 8000),
);
const wiredAccountPublishTimeoutMs = Math.max(
  1000,
  Number(process.env.WIRED_ACCOUNT_PUBLISH_TIMEOUT_MS || confessPublishTimeoutMs) ||
    confessPublishTimeoutMs,
);
const confessXRetrySeconds = Math.max(30, Number(process.env.CONFESS_X_RETRY_SECONDS || 300));
const confessXMaxAttempts = Math.max(1, Number(process.env.CONFESS_X_MAX_ATTEMPTS || 6));
const confessXPostTimeoutMs = Math.max(
  1000,
  Number(process.env.CONFESS_X_POST_TIMEOUT_MS || 8000),
);
const confessXMaxLength = Math.max(
  1,
  Math.min(280, Number(process.env.CONFESS_X_MAX_LENGTH || 260)),
);
const confessXThreadBaseUrl = String(
  process.env.CONFESS_X_THREAD_BASE_URL || "https://wiredsignal.online/thread",
)
  .trim()
  .replace(/\/+$/, "");
const confessXThreadRelays = readEnvList("CONFESS_X_THREAD_RELAYS", [
  "wss://relay.wiredsignal.online",
]);
const confessXImageWidth = Math.max(
  600,
  Math.min(2400, Number(process.env.CONFESS_X_IMAGE_WIDTH || 1200)),
);
const confessXImageHeight = Math.max(
  315,
  Math.min(2400, Number(process.env.CONFESS_X_IMAGE_HEIGHT || 675)),
);
const confessXImageMaxBytes = Math.max(
  100_000,
  Math.min(5_000_000, Number(process.env.CONFESS_X_IMAGE_MAX_BYTES || 4_500_000)),
);
const confessXImageTemplate = String(
  process.env.CONFESS_X_IMAGE_TEMPLATE || "postcard-v1",
)
  .trim()
  .toLowerCase();
const confessXProfileImageTimeoutMs = Math.max(
  1000,
  Number(process.env.CONFESS_X_PROFILE_IMAGE_TIMEOUT_MS || 4000),
);
const confessXProfileImageMaxBytes = Math.max(
  10_000,
  Math.min(2_000_000, Number(process.env.CONFESS_X_PROFILE_IMAGE_MAX_BYTES || 1_000_000)),
);
const confessXEmojiImageTimeoutMs = Math.max(
  1000,
  Number(process.env.CONFESS_X_EMOJI_IMAGE_TIMEOUT_MS || confessXProfileImageTimeoutMs),
);
const confessXEmojiImageMaxBytes = Math.max(
  10_000,
  Math.min(1_000_000, Number(process.env.CONFESS_X_EMOJI_IMAGE_MAX_BYTES || 500_000)),
);
const confessXConfig = {
  enabled: readEnvFlag("CONFESS_X_ENABLED", false),
  dryRun: readEnvFlag("CONFESS_X_DRY_RUN", true),
  oauth1ApiKey: String(process.env.CONFESS_X_OAUTH1_API_KEY || "").trim(),
  oauth1ApiSecret: String(process.env.CONFESS_X_OAUTH1_API_SECRET || "").trim(),
  oauth1AccessToken: String(process.env.CONFESS_X_OAUTH1_ACCESS_TOKEN || "").trim(),
  oauth1AccessSecret: String(process.env.CONFESS_X_OAUTH1_ACCESS_SECRET || "").trim(),
  accountHandle: String(process.env.CONFESS_X_ACCOUNT_HANDLE || "").trim().replace(/^@/, ""),
  postPrefix: String(process.env.CONFESS_X_POST_PREFIX || "").trim(),
  postSuffix: String(process.env.CONFESS_X_POST_SUFFIX || "").trim(),
  safetyMode: String(process.env.CONFESS_X_SAFETY_MODE || "strict").trim().toLowerCase(),
};
const confessXClient = createXClient(confessXConfig, confessXPostTimeoutMs);
const moderation = createModerationService(moderationStoreFile);
const feedSnapshot = createFeedSnapshotService({
  cacheFile: snapshotCacheFile,
  refreshSeconds,
  ageHours: snapshotAgeHours,
  timeoutMs: snapshotTimeoutMs,
  replyLimit: snapshotReplyLimit,
  replyFetchDepth,
  minPow,
  powRelays,
  enrichmentRelays,
  threadRelays,
  moderation,
});
const publicHostPatterns = readEnvList("PUBLIC_HOSTS", []).map(normalizeConfiguredHost).filter(Boolean);

const relayInfo: RelayInfo = {
  name: process.env.RELAY_NAME || "Wired Admin",
  description:
    process.env.RELAY_DESCRIPTION ||
    "A Wired proof-of-work Nostr relay backed by strfry.",
  supported_nips: [1, 9, 11, 13, 15, 20, 22, 33, 40],
  software:
    process.env.RELAY_SOFTWARE ||
    "https://github.com/smolgrrr/wired-admin",
  version: process.env.RELAY_VERSION || "0.2.10",
  limitation: {
    auth_required: false,
    payment_required: false,
    min_pow_difficulty: minPow,
  },
};
if (process.env.RELAY_PUBKEY) relayInfo.pubkey = process.env.RELAY_PUBKEY;
if (process.env.RELAY_CONTACT) relayInfo.contact = process.env.RELAY_CONTACT;
if (process.env.RELAY_ICON) relayInfo.icon = process.env.RELAY_ICON;

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; connect-src 'self'; img-src 'self' https: data:; style-src 'self'; font-src 'self'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
};
const httpAccess = createHttpAccess({ publicHostPatterns, securityHeaders });

const stats: RelayStats = {
  startedAt: Date.now(),
  backendUrl,
  minPow,
  activeClients: 0,
  totalConnections: 0,
  clientMessages: 0,
  backendMessages: 0,
  publishAttempts: 0,
  acceptedPublishes: 0,
  powRejectedPublishes: 0,
  backendRejectedPublishes: 0,
  malformedMessages: 0,
  reqMessages: 0,
  closeMessages: 0,
  lastBackendOpenAt: null,
  lastBackendErrorAt: null,
  recent: [],
};

let confessLedgerQueue: Promise<unknown> = Promise.resolve();
let wiredAccountStoreQueue: Promise<unknown> = Promise.resolve();
let confessXMirrorTimer: NodeJS.Timeout | null = null;
const confessXMirrorInFlight = new Set<string>();

function addRecent(type: string, detail: unknown): void {
  stats.recent.unshift({
    at: Date.now(),
    type,
    detail,
  });
  stats.recent = stats.recent.slice(0, 50);
}

const handleClientConnection = createRelayGateway({
  backendUrl,
  minPow,
  stats,
  addRecent,
});

function utcDayKey(timeMs = Date.now()): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

function nextUtcReset(day: string): Date {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000);
}

async function readConfessStore(): Promise<ConfessStore> {
  try {
    const parsed = JSON.parse(await readFile(confessStoreFile, "utf8"));
    const store = parseConfessStore(parsed);
    if (store) return store;
  } catch {
    // Missing or malformed stores are treated as empty.
  }
  return { version: 1, posts: [] };
}

async function writeConfessStore(data: ConfessStore): Promise<void> {
  await mkdir(path.dirname(confessStoreFile), { recursive: true });
  const temp = `${confessStoreFile}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temp, confessStoreFile);
}

async function readWiredAccountStore(): Promise<WiredAccountStore> {
  try {
    const parsed = JSON.parse(await readFile(wiredAccountStoreFile, "utf8"));
    const store = parseWiredAccountStore(parsed);
    if (store) return store;
  } catch {
    // Missing or malformed stores are treated as empty.
  }
  return { version: 1, posts: [] };
}

async function writeWiredAccountStore(data: WiredAccountStore): Promise<void> {
  await mkdir(path.dirname(wiredAccountStoreFile), { recursive: true });
  const temp = `${wiredAccountStoreFile}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(temp, wiredAccountStoreFile);
}

function todaysConfessPosts(store: ConfessStore, now = Date.now()): ConfessPostRecord[] {
  const day = utcDayKey(now);
  return store.posts
    .filter((post) => post.day === day)
    .sort((a, b) => a.createdAt - b.createdAt);
}

function adjustedConfessPow(posts: ConfessPostRecord[], now = Date.now()): number {
  if (posts.length >= confessDailyLimit) return confessMaxPow;
  if (posts.length === 0) return confessBasePow;

  const day = utcDayKey(now);
  const dayStartSeconds = Date.parse(`${day}T00:00:00.000Z`) / 1000;
  const nowSeconds = now / 1000;
  const targetSpacing = (24 * 60 * 60) / confessDailyLimit;
  const elapsed = Math.max(60, nowSeconds - dayStartSeconds);
  const expectedPosts = Math.max(0.25, elapsed / targetSpacing);
  const scheduleRatio = posts.length / expectedPosts;

  let intervalRatio = scheduleRatio;
  if (posts.length > 1) {
    const first = (posts[0]?.createdAt ?? now) / 1000;
    const last = (posts[posts.length - 1]?.createdAt ?? now) / 1000;
    const actualSpacing = Math.max(60, (last - first) / (posts.length - 1));
    intervalRatio = targetSpacing / actualSpacing;
  }

  const ratio = Math.max(scheduleRatio, intervalRatio);
  const adjustment = ratio > 1 ? Math.ceil(Math.log2(ratio)) : 0;
  const scarcityAdjustment = posts.length >= confessDailyLimit - 1 ? 1 : 0;
  return Math.min(confessMaxPow, confessBasePow + adjustment + scarcityAdjustment);
}

function confessStatusFromStore(store: ConfessStore, now = Date.now()): ConfessStatus {
  const day = utcDayKey(now);
  const posts = todaysConfessPosts(store, now);
  const count = posts.length;
  const remaining = Math.max(0, confessDailyLimit - count);
  const secretKey = parseConfessSecretKey();
  return {
    configured: Boolean(secretKey),
    pubkey: secretKey ? getPublicKey(secretKey) : "",
    day,
    count,
    limit: confessDailyLimit,
    remaining,
    minimumPow: adjustedConfessPow(posts, now),
    closed: remaining === 0,
    nextResetAt: nextUtcReset(day).toISOString(),
  };
}

function wiredAccountStatusFromStore(store: WiredAccountStore): WiredAccountStatus & {
  count: number;
} {
  const secretKey = parseWiredAccountSecretKey();
  return {
    configured: Boolean(secretKey),
    pubkey: secretKey ? getPublicKey(secretKey) : "",
    minimumPow: wiredAccountMinPow,
    relays: wiredAccountRelays,
    maxContentLength: wiredAccountContentMaxLength,
    count: store.posts.length,
  };
}

function withConfessLedgerLock<T>(task: () => Promise<T>): Promise<T> {
  const run = confessLedgerQueue.then(task, task);
  confessLedgerQueue = run.catch(() => {});
  return run;
}

function withWiredAccountStoreLock<T>(task: () => Promise<T>): Promise<T> {
  const run = wiredAccountStoreQueue.then(task, task);
  wiredAccountStoreQueue = run.catch(() => {});
  return run;
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error("expected 32-byte hex private key");
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function parseNostrSecretKey(rawValue: unknown): Uint8Array | null {
  const raw = String(rawValue || "").trim();
  if (!raw) return null;

  try {
    if (raw.startsWith("nsec1")) {
      const decoded = nip19.decode(raw);
      if (decoded.type !== "nsec" || !(decoded.data instanceof Uint8Array)) return null;
      return decoded.data;
    }
    return hexToBytes(raw);
  } catch {
    return null;
  }
}

function parseConfessSecretKey(): Uint8Array | null {
  return parseNostrSecretKey(process.env.CONFESS_NOSTR_SECRET_KEY);
}

function parseWiredAccountSecretKey(): Uint8Array | null {
  return parseNostrSecretKey(
    process.env.WIRED_NOSTR_SECRET_KEY || process.env.CONFESS_NOSTR_SECRET_KEY,
  );
}

const disallowedConfessContentPattern =
  /\b(?:(?:https?|wss?|ftp|ipfs):\/\/|(?:magnet|nostr):|www\.)[^\s<>"')\]]+|\b[a-z0-9.-]+\.(?:app|band|biz|blog|cloud|co|com|dev|fm|gg|info|io|is|land|link|lol|me|media|net|news|online|onion|org|site|social|to|tv|wine|xyz)(?:\/[^\s<>"')\]]*)?|\b[^\s<>"')\]]+\.(?:avif|gif|jpe?g|m4a|mov|mp3|mp4|ogg|png|svg|wav|webm|webp)(?:\?[^\s<>"')\]]*)?/i;

function hasDisallowedConfessContent(content: unknown): boolean {
  return disallowedConfessContentPattern.test(String(content || ""));
}

type ConfessAdmissionResult =
  | { ok: true; reason: ""; pow: number }
  | { ok: false; reason: string; pow: number };

function validateConfessAdmission(
  event: NostrEvent,
  requiredPow: number,
  confessPubkey: string,
): ConfessAdmissionResult {
  const result = verifyEventPow(event, requiredPow);
  if (!result.ok) return { ok: false, reason: result.reason, pow: result.pow };

  if (event.pubkey !== confessPubkey) {
    return { ok: false, reason: "confess proof pubkey does not match account", pow: result.pow };
  }

  if (event.kind !== 1) {
    return { ok: false, reason: "confess proof must be kind 1", pow: result.pow };
  }

  const content = String(event.content || "").trim();
  if (!content) {
    return { ok: false, reason: "empty confession", pow: result.pow };
  }

  if (hasDisallowedConfessContent(content)) {
    return { ok: false, reason: "links and media are not allowed", pow: result.pow };
  }

  if (content.length > confessContentMaxLength) {
    return {
      ok: false,
      reason: `confession exceeds ${confessContentMaxLength} characters`,
      pow: result.pow,
    };
  }

  return { ok: true, reason: "", pow: result.pow };
}

function validateWiredAccountAdmission(
  event: NostrProofEvent,
  requiredPow: number,
  wiredAccountPubkey: string,
): ConfessAdmissionResult {
  const result = verifyEventPow(event, requiredPow);
  if (!result.ok) return { ok: false, reason: result.reason, pow: result.pow };

  if (event.pubkey !== wiredAccountPubkey) {
    return { ok: false, reason: "proof pubkey does not match Wired account", pow: result.pow };
  }

  if (event.kind !== 1) {
    return { ok: false, reason: "proof must be kind 1", pow: result.pow };
  }

  const nonceTag = event.tags.find((tag) => tag[0] === "nonce");
  if (
    !nonceTag ||
    !/^\d+$/.test(nonceTag[1] || "") ||
    !/^\d+$/.test(nonceTag[2] || "")
  ) {
    return { ok: false, reason: "invalid nonce tag", pow: result.pow };
  }

  const claimedTarget = Number.parseInt(nonceTag[2] || "", 10);
  if (claimedTarget < requiredPow) {
    return {
      ok: false,
      reason: `nonce target ${claimedTarget} is below ${requiredPow}`,
      pow: result.pow,
    };
  }

  const content = String(event.content || "");
  if (!content.trim()) {
    return { ok: false, reason: "empty post", pow: result.pow };
  }

  if (content.length > wiredAccountContentMaxLength) {
    return {
      ok: false,
      reason: `post exceeds ${wiredAccountContentMaxLength} characters`,
      pow: result.pow,
    };
  }

  return { ok: true, reason: "", pow: result.pow };
}

function buildSignedAccountEvent(
  admissionEvent: NostrProofEvent,
  secretKey: Uint8Array,
  { trimContent = false }: { trimContent?: boolean } = {},
): NostrEvent {
  const template: EventTemplate = {
    kind: admissionEvent.kind,
    content: trimContent ? admissionEvent.content.trim() : admissionEvent.content,
    tags: admissionEvent.tags,
    created_at: admissionEvent.created_at,
  };
  return finalizeEvent(template, secretKey);
}

function buildConfessionEvent(admissionEvent: NostrEvent, secretKey: Uint8Array): NostrEvent {
  return buildSignedAccountEvent(admissionEvent, secretKey, { trimContent: true });
}

async function publishNostrEvent(
  event: NostrEvent,
  relays: string[],
  timeoutMs: number,
): Promise<string[]> {
  const results = await Promise.allSettled(
    relays.map(async (url) => {
      const relay = await withPromiseTimeout(Relay.connect(url), timeoutMs, url);
      try {
        await withPromiseTimeout(relay.publish(event), timeoutMs, url);
        return normalizeRelayUrl(relay.url || url);
      } finally {
        try {
          relay.close();
        } catch {
          // Relay already closed.
        }
      }
    }),
  );

  return uniqueSortedValues(
    results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value),
  );
}

async function publishConfessionEvent(event: NostrEvent): Promise<string[]> {
  return publishNostrEvent(event, confessRelays, confessPublishTimeoutMs);
}

async function publishWiredAccountEvent(event: NostrEvent): Promise<string[]> {
  return publishNostrEvent(event, wiredAccountRelays, wiredAccountPublishTimeoutMs);
}

function confessXConfigured(): boolean {
  return Boolean(confessXConfig.dryRun || confessXClient.configured());
}

function confessXOAuth1Configured(): boolean {
  return confessXClient.configured();
}

function confessXAuthMode(): string {
  return confessXClient.authMode();
}

function normalizeConfessXText(content: unknown): string {
  return String(content || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hashConfessXText(text: string): string {
  return crypto.createHash("sha256").update(normalizeConfessXText(text)).digest("hex");
}

function joinConfessXText(parts: unknown[]): string {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function buildConfessXPostText(content: unknown): string {
  return joinConfessXText([
    confessXConfig.postPrefix,
    String(content || "").trim(),
    confessXConfig.postSuffix,
  ]);
}

function buildConfessXTweetText(): string {
  return "";
}

type ConfessPostcardRenderer = ReturnType<typeof createConfessPostcardRenderer>;
let confessPostcardRenderer: ConfessPostcardRenderer | null = null;

async function renderConfessXImage({
  text,
  eventId,
  pubkey,
  customEmojis,
}: {
  text: string;
  eventId: string;
  pubkey: string;
  customEmojis?: ConfessXCustomEmoji[];
}) {
  confessPostcardRenderer ??= createConfessPostcardRenderer({
    image: {
      width: confessXImageWidth,
      height: confessXImageHeight,
      maxBytes: confessXImageMaxBytes,
      template: confessXImageTemplate,
    },
    profileImage: {
      timeoutMs: confessXProfileImageTimeoutMs,
      maxBytes: confessXProfileImageMaxBytes,
    },
    customEmojiImage: {
      timeoutMs: confessXEmojiImageTimeoutMs,
      maxBytes: confessXEmojiImageMaxBytes,
      limitInputPixels: 1024 * 1024,
      outputSize: 128,
    },
    fetchProfileMetadata: feedSnapshot.fetchProfileMetadata,
  });
  return confessPostcardRenderer.render({
    text,
    eventId,
    pubkey,
    ...(customEmojis ? { customEmojis } : {}),
  });
}

const xMentionPattern = /(^|[^a-z0-9_])@[a-z0-9_]{1,15}\b/i;
const xHashtagPattern = /(^|[^a-z0-9_])#[\p{L}\p{N}_]+/iu;
const xCashtagPattern = /(^|[^a-z0-9_])\$[a-z]{1,8}\b/i;
const xEmailPattern = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const xPhonePattern = /\b(?:\+?\d[\s().-]*){10,}\b/;
const xPaymentCardPattern = /\b(?:\d[ -]*?){13,19}\b/;
const xStreetAddressPattern =
  /\b\d{1,6}\s+[a-z0-9.'-]+(?:\s+[a-z0-9.'-]+){0,5}\s+(?:street|st|avenue|ave|road|rd|drive|dr|lane|ln|boulevard|blvd|court|ct|way|place|pl)\b/i;
const xThreatPattern =
  /\b(?:kys|kill\s+(?:yourself|you|him|her|them|all)|murder\s+(?:you|him|her|them)|shoot\s+(?:you|him|her|them)|stab\s+(?:you|him|her|them)|bomb\s+(?:you|him|her|them|the)|beat\s+(?:you|him|her|them)\s+up)\b/i;
const xSelfHarmEncouragementPattern =
  /\b(?:you should\s+(?:die|end it|hurt yourself)|go\s+(?:die|kill yourself)|how to\s+(?:kill yourself|self harm))\b/i;
const xHarassmentPattern =
  /\b(?:doxx?|swat|worthless|subhuman|vermin|degenerate|predator|rapist|groomer)\b/i;
const xHatefulTargetPattern =
  /\b(?:all|every)\s+(?:women|men|jews|muslims|christians|black people|white people|asians|immigrants|disabled people|gay people|trans people)\s+(?:are|should|must|deserve)\b/i;
const xSexualMinorPattern =
  /\b(?:minor|child|kid|teen|underage|schoolgirl|schoolboy)\b.{0,40}\b(?:sex|nude|porn|explicit|hookup)\b/i;
const xScamPattern =
  /\b(?:send\s+crypto|seed phrase|private key|guaranteed\s+(?:profit|returns)|double your money|pump and dump|buy followers)\b/i;

type ConfessXSafetyResult =
  | { ok: true; reason: ""; textHash: string }
  | { ok: false; reason: string };

function validateConfessXSafety(
  text: string,
  store: ConfessStore,
  eventId: string,
): ConfessXSafetyResult {
  const content = String(text || "").trim();
  if (!content) return { ok: false, reason: "empty X post" };
  if (content.length > confessXMaxLength) {
    return { ok: false, reason: `X post exceeds ${confessXMaxLength} characters` };
  }
  if (hasDisallowedConfessContent(content)) {
    return { ok: false, reason: "links and media are not allowed on X mirror" };
  }
  if (xMentionPattern.test(content)) return { ok: false, reason: "X mentions are not allowed" };
  if (xHashtagPattern.test(content)) return { ok: false, reason: "X hashtags are not allowed" };
  if (xCashtagPattern.test(content)) return { ok: false, reason: "X cashtags are not allowed" };
  if (
    xEmailPattern.test(content) ||
    xPhonePattern.test(content) ||
    xPaymentCardPattern.test(content) ||
    xStreetAddressPattern.test(content)
  ) {
    return { ok: false, reason: "possible private information" };
  }
  if (xThreatPattern.test(content)) return { ok: false, reason: "possible violent threat" };
  if (xSelfHarmEncouragementPattern.test(content)) {
    return { ok: false, reason: "possible self-harm encouragement" };
  }
  if (confessXConfig.safetyMode === "strict") {
    if (xHarassmentPattern.test(content)) {
      return { ok: false, reason: "possible targeted harassment" };
    }
    if (xHatefulTargetPattern.test(content)) {
      return { ok: false, reason: "possible hateful conduct" };
    }
    if (xSexualMinorPattern.test(content)) {
      return { ok: false, reason: "possible sexual minor content" };
    }
    if (xScamPattern.test(content)) return { ok: false, reason: "possible scam content" };
  }

  const textHash = hashConfessXText(content);
  const duplicate = (store.posts || []).some(
    (post) => post.eventId !== eventId && post.xMirror?.textHash === textHash,
  );
  if (duplicate) return { ok: false, reason: "duplicate X mirror text" };

  return { ok: true, reason: "", textHash };
}

const confessXEmojiShortcodePattern = /^[^\s:]{1,64}$/u;

function customEmojisForConfessXMirror(event: NostrEvent, text: string): ConfessXCustomEmoji[] {
  const result = new Map<string, ConfessXCustomEmoji>();

  for (const tag of event.tags || []) {
    if (tag[0] !== "emoji" || !tag[1] || !tag[2]) continue;

    const shortcode = tag[1].trim();
    const url = tag[2].trim();
    if (!confessXEmojiShortcodePattern.test(shortcode)) continue;
    if (!text.includes(`:${shortcode}:`)) continue;
    if (!isSafeConfessPostcardImageUrl(url)) continue;
    if (result.has(shortcode)) continue;

    result.set(shortcode, { shortcode, url: new URL(url).toString() });
    if (result.size >= 32) break;
  }

  return Array.from(result.values());
}

function initialConfessXMirror(event: NostrEvent, store: ConfessStore): ConfessXMirror {
  const now = Date.now();
  const text = buildConfessXPostText(event.content);
  const customEmojis = customEmojisForConfessXMirror(event, text);
  const base = {
    enabled: confessXConfig.enabled,
    dryRun: confessXConfig.dryRun,
    postMode: "image" as const,
    accountHandle: confessXConfig.accountHandle || null,
    threadUrl: confessXThreadUrl(event.id, event.pubkey),
    updatedAt: now,
  };

  if (!confessXConfig.enabled) {
    return { ...base, status: "disabled", reason: "X mirror disabled" };
  }

  if (!confessXConfigured()) {
    return { ...base, status: "failed", reason: "X mirror is not configured", retryable: false };
  }

  const safety = validateConfessXSafety(text, store, event.id);
  if (!safety.ok) {
    return {
      ...base,
      status: "blocked",
      reason: safety.reason,
      retryable: false,
      textLength: text.length,
    };
  }

  return {
    ...base,
    status: "pending",
    reason: "",
    retryable: true,
    attempts: 0,
    nextAttemptAt: now,
    text,
    pubkey: event.pubkey,
    textHash: safety.textHash,
    textLength: text.length,
    imageTemplate: confessXImageTemplate,
    ...(customEmojis.length > 0 ? { customEmojis } : {}),
  };
}

function nextConfessXAttemptAt(attempts: number): number {
  const delay = confessXRetrySeconds * 1000 * 2 ** Math.max(0, attempts - 1);
  return Date.now() + Math.min(delay, 24 * 60 * 60 * 1000);
}

function failedConfessXMirror(
  existing: Partial<ConfessXMirror> | undefined,
  reason: string,
  retryable: boolean,
  patch: Partial<ConfessXMirror> = {},
): ConfessXMirror {
  const attempts = Number(existing?.attempts || 0) + 1;
  const canRetry = Boolean(retryable && attempts < confessXMaxAttempts);
  const base: ConfessXMirror = {
    enabled: confessXConfig.enabled,
    dryRun: confessXConfig.dryRun,
    postMode: "image",
    accountHandle: confessXConfig.accountHandle || null,
    threadUrl: existing?.threadUrl || "",
    updatedAt: Date.now(),
    status: "failed",
    reason,
  };
  return {
    ...base,
    ...existing,
    ...patch,
    status: "failed",
    reason,
    retryable: canRetry,
    attempts,
    nextAttemptAt: canRetry ? nextConfessXAttemptAt(attempts) : null,
    updatedAt: Date.now(),
  };
}

function confessXThreadRef(eventId: string, pubkey = ""): string {
  if (!/^[0-9a-f]{64}$/i.test(String(eventId || ""))) return String(eventId || "");

  const pointer: { id: string; relays: string[]; author?: string } = {
    id: eventId,
    relays: uniqueRelays(confessXThreadRelays),
  };
  if (/^[0-9a-f]{64}$/i.test(String(pubkey || ""))) pointer.author = pubkey;
  return nip19.neventEncode(pointer);
}

function confessXThreadUrl(eventId: string, pubkey = ""): string {
  return `${confessXThreadBaseUrl}/${encodeURIComponent(confessXThreadRef(eventId, pubkey))}`;
}

function buildConfessXThreadReplyText(eventId: string, pubkey = ""): string {
  return `thread: ${confessXThreadUrl(eventId, pubkey)}`;
}

type XApiPayload = {
  data?: {
    id?: string;
  };
};

type ImageRenderError = Error & {
  imageHash?: string;
  imageBytes?: number;
};

async function postConfessXText(
  text: string,
  existingMirror: ConfessXMirror,
  eventId: string,
): Promise<ConfessXMirror> {
  if (confessXConfig.dryRun) {
    const dryRunPatch: Partial<ConfessXMirror> = {};
    try {
      const rendered = await renderConfessXImage({
        text,
        eventId,
        pubkey: existingMirror?.pubkey || "",
        ...(existingMirror?.customEmojis ? { customEmojis: existingMirror.customEmojis } : {}),
      });
      dryRunPatch.imageHash = rendered.imageHash;
      dryRunPatch.imageBytes = rendered.imageBytes;
      dryRunPatch.imageWidth = rendered.width;
      dryRunPatch.imageHeight = rendered.height;
      dryRunPatch.imageTemplate = rendered.template;
    } catch (error) {
      dryRunPatch.reason =
        error instanceof Error ? `X dry-run image render failed: ${error.message}` : "X dry-run image render failed";
    }
    return {
      ...existingMirror,
      ...dryRunPatch,
      status: "dry_run",
      reason: dryRunPatch.reason || "X dry-run mode",
      retryable: false,
      attempts: Number(existingMirror?.attempts || 0) + 1,
      nextAttemptAt: null,
      threadUrl: eventId ? confessXThreadUrl(eventId, existingMirror?.pubkey) : existingMirror?.threadUrl,
      postedAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  if (!confessXOAuth1Configured()) {
    return failedConfessXMirror(existingMirror, "X OAuth1 credentials are not configured", false);
  }

  let mediaId = existingMirror?.mediaId || null;
  let imagePatch: Partial<ConfessXMirror> = {};
  if (!mediaId) {
    try {
      const rendered = await renderConfessXImage({
        text,
        eventId,
        pubkey: existingMirror?.pubkey || "",
        ...(existingMirror?.customEmojis ? { customEmojis: existingMirror.customEmojis } : {}),
      });
      imagePatch = {
        imageHash: rendered.imageHash,
        imageBytes: rendered.imageBytes,
        imageWidth: rendered.width,
        imageHeight: rendered.height,
        imageTemplate: rendered.template,
      };
      const uploadResponse = await confessXClient.uploadImage(rendered.buffer);
      const uploadPayload = (await readHttpJsonResponse(uploadResponse)) as XApiPayload | null;
      if (!uploadResponse.ok || !uploadPayload?.data?.id) {
        const reason = `X media upload failed (${uploadResponse.status}): ${summarizeHttpError(uploadPayload)}`;
        const retryable = uploadResponse.status === 429 || uploadResponse.status >= 500;
        return failedConfessXMirror(existingMirror, reason, retryable, imagePatch);
      }
      mediaId = uploadPayload.data.id;
      imagePatch.mediaId = mediaId;
      imagePatch.mediaUploadedAt = Date.now();
    } catch (error) {
      const reason =
        error instanceof Error ? `X image render/upload failed: ${error.message}` : "X image render/upload failed";
      const renderError = error as Partial<ImageRenderError>;
      const failurePatch: Partial<ConfessXMirror> = { ...imagePatch };
      const imageHash = renderError.imageHash || imagePatch.imageHash;
      if (imageHash) failurePatch.imageHash = imageHash;
      const imageBytes = renderError.imageBytes || imagePatch.imageBytes;
      if (typeof imageBytes === "number") failurePatch.imageBytes = imageBytes;
      return failedConfessXMirror(existingMirror, reason, true, failurePatch);
    }
  }

  let tweetId = existingMirror?.tweetId || null;
  let postedAt = existingMirror?.postedAt || null;
  if (!tweetId) {
    const response = await confessXClient.postTweet({
      text: buildConfessXTweetText(),
      mediaIds: mediaId ? [mediaId] : [],
    });
    const payload = (await readHttpJsonResponse(response)) as XApiPayload | null;
    if (!response.ok || !payload?.data?.id) {
      const reason = `X post failed (${response.status}): ${summarizeHttpError(payload)}`;
      const retryable = response.status === 429 || response.status >= 500;
      return failedConfessXMirror(existingMirror, reason, retryable, imagePatch);
    }
    tweetId = payload.data.id;
    postedAt = Date.now();
  }

  const threadReplyText = buildConfessXThreadReplyText(eventId, existingMirror?.pubkey);
  const replyResponse = await confessXClient.postTweet({
    text: threadReplyText,
    inReplyToTweetId: tweetId,
  });
  const replyPayload = (await readHttpJsonResponse(replyResponse)) as XApiPayload | null;
  if (replyResponse.ok && replyPayload?.data?.id) {
    const postedMirror: ConfessXMirror = {
      ...existingMirror,
      ...imagePatch,
      status: "posted",
      reason: "",
      retryable: false,
      attempts: Number(existingMirror?.attempts || 0) + 1,
      postMode: "image",
      tweetId,
      replyTweetId: replyPayload.data.id,
      threadUrl: confessXThreadUrl(eventId, existingMirror?.pubkey),
      nextAttemptAt: null,
      postedAt,
      repliedAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (mediaId) postedMirror.mediaId = mediaId;
    return postedMirror;
  }

  const reason = `X thread reply failed (${replyResponse.status}): ${summarizeHttpError(replyPayload)}`;
  const retryable = replyResponse.status === 429 || replyResponse.status >= 500;
  const failedReplyPatch: Partial<ConfessXMirror> = {
    ...imagePatch,
    postMode: "image",
    tweetId,
    threadUrl: confessXThreadUrl(eventId, existingMirror?.pubkey),
    postedAt,
  };
  if (mediaId) failedReplyPatch.mediaId = mediaId;
  return failedConfessXMirror(existingMirror, reason, retryable, failedReplyPatch);
}

async function updateConfessXMirror(
  eventId: string,
  updater: (current: ConfessXMirror | undefined) => Promise<ConfessXMirror> | ConfessXMirror,
): Promise<ConfessXMirror | null> {
  return withConfessLedgerLock(async () => {
    const store = await readConfessStore();
    const post = store.posts.find((candidate) => candidate.eventId === eventId);
    if (!post) return null;
    post.xMirror = await updater(post.xMirror);
    await writeConfessStore(store);
    return post.xMirror;
  });
}

async function processConfessXMirror(
  eventId: string,
  mirror: ConfessXMirror | undefined,
): Promise<ConfessXMirror | null | undefined> {
  if (!mirror || !["pending", "failed"].includes(mirror.status)) return mirror;
  if (!mirror.retryable || Number(mirror.nextAttemptAt || 0) > Date.now()) return mirror;
  if (!mirror.text) {
    return updateConfessXMirror(eventId, (current) =>
      failedConfessXMirror(current, "X mirror text is missing", false),
    );
  }
  if (confessXMirrorInFlight.has(eventId)) return mirror;

  confessXMirrorInFlight.add(eventId);
  try {
    const nextMirror = await postConfessXText(mirror.text, mirror, eventId);
    await updateConfessXMirror(eventId, () => nextMirror);
    return nextMirror;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "X mirror failed";
    return updateConfessXMirror(eventId, (current) => failedConfessXMirror(current, reason, true));
  } finally {
    confessXMirrorInFlight.delete(eventId);
  }
}

function scheduleConfessXMirror(eventId: string, mirror: ConfessXMirror | undefined): void {
  if (!confessXConfig.enabled) return;
  if (!mirror || !["pending", "failed"].includes(mirror.status)) return;
  const timer = setTimeout(() => {
    void processConfessXMirror(eventId, mirror).catch((error) => {
      console.error(error instanceof Error ? error.message : "X mirror failed");
    });
  }, 0);
  timer.unref();
}

async function processPendingConfessXMirrors(): Promise<void> {
  if (!confessXConfig.enabled) return;
  const store = await readConfessStore();
  const duePosts = (store.posts || []).filter(
    (post) =>
      post.eventId &&
      (post.xMirror?.status === "pending" || post.xMirror?.status === "failed") &&
      post.xMirror?.retryable !== false &&
      Number(post.xMirror?.nextAttemptAt || 0) <= Date.now(),
  );
  for (const post of duePosts) {
    await processConfessXMirror(post.eventId, post.xMirror);
  }
}

function confessXStatusFromStore(store: ConfessStore): ConfessXStatus & {
  safetyMode: string;
  maxLength: number;
  retrySeconds: number;
  maxAttempts: number;
  threadBaseUrl: string;
  counts: Record<ConfessXMirror["status"], number>;
} {
  const counts = {
    disabled: 0,
    pending: 0,
    posted: 0,
    blocked: 0,
    failed: 0,
    dry_run: 0,
  };
  for (const post of store.posts || []) {
    const status = post.xMirror?.status;
    if (status && Object.hasOwn(counts, status)) counts[status] += 1;
  }
  return {
    enabled: confessXConfig.enabled,
    dryRun: confessXConfig.dryRun,
    configured: confessXConfigured(),
    authMode: confessXAuthMode(),
    accountHandle: confessXConfig.accountHandle || null,
    postMode: "image",
    safetyMode: confessXConfig.safetyMode,
    maxLength: confessXMaxLength,
    image: {
      width: confessXImageWidth,
      height: confessXImageHeight,
      template: confessXImageTemplate,
      maxBytes: confessXImageMaxBytes,
    },
    retrySeconds: confessXRetrySeconds,
    maxAttempts: confessXMaxAttempts,
    threadBaseUrl: confessXThreadBaseUrl,
    counts,
  };
}

function publicConfessXMirror(mirror: ConfessXMirror | undefined): PublicConfessXMirror {
  if (!mirror) return { status: "disabled" };
  const result: PublicConfessXMirror = {
    status: mirror.status,
  };
  if (mirror.reason) result.reason = mirror.reason;
  if (mirror.tweetId) result.tweetId = mirror.tweetId;
  if (mirror.replyTweetId) result.replyTweetId = mirror.replyTweetId;
  if (mirror.threadUrl) result.threadUrl = mirror.threadUrl;
  if (mirror.postMode) result.postMode = mirror.postMode;
  if (mirror.imageHash) result.imageHash = mirror.imageHash;
  if (typeof mirror.imageBytes === "number") result.imageBytes = mirror.imageBytes;
  if (typeof mirror.retryable === "boolean") result.retryable = mirror.retryable;
  if (typeof mirror.attempts === "number") result.attempts = mirror.attempts;
  if (mirror.nextAttemptAt !== undefined) result.nextAttemptAt = mirror.nextAttemptAt;
  if (mirror.accountHandle) result.accountHandle = mirror.accountHandle;
  return result;
}

async function createWiredAccountPost(admissionEvent: unknown) {
  const secretKey = parseWiredAccountSecretKey();
  if (!secretKey) {
    const error: HttpError = new Error("Wired account is not configured");
    error.statusCode = 503;
    throw error;
  }

  if (!isNostrProofEvent(admissionEvent)) {
    const error: HttpError = new Error("invalid Wired account proof event");
    error.statusCode = 400;
    throw error;
  }

  return withWiredAccountStoreLock(async () => {
    const store = await readWiredAccountStore();
    const wiredAccountPubkey = getPublicKey(secretKey);
    const proof = validateWiredAccountAdmission(
      admissionEvent,
      wiredAccountMinPow,
      wiredAccountPubkey,
    );
    if (!proof.ok) {
      const error: HttpError = new Error(proof.reason);
      error.statusCode = 400;
      error.pow = proof.pow;
      throw error;
    }

    if (store.posts.some((post) => post.proofId === admissionEvent.id)) {
      const error: HttpError = new Error("Wired account proof has already been used");
      error.statusCode = 409;
      throw error;
    }

    const event = buildSignedAccountEvent(admissionEvent, secretKey);
    if (event.id !== admissionEvent.id) {
      const error: HttpError = new Error("signed event id does not match proof event id");
      error.statusCode = 400;
      throw error;
    }

    if (store.posts.some((post) => post.eventId === event.id)) {
      const error: HttpError = new Error("Wired account event has already been published");
      error.statusCode = 409;
      throw error;
    }

    const acceptedRelays = await publishWiredAccountEvent(event);
    if (acceptedRelays.length === 0) {
      const error: HttpError = new Error("no relay accepted the Wired account post");
      error.statusCode = 502;
      throw error;
    }

    const record: WiredAccountPostRecord = {
      day: utcDayKey(),
      eventId: event.id,
      proofId: admissionEvent.id,
      pow: proof.pow,
      createdAt: Date.now(),
      pubkey: event.pubkey,
      contentLength: event.content.length,
      acceptedRelays,
      relays: wiredAccountRelays,
    };
    store.posts.push(record);
    await writeWiredAccountStore(store);

    return {
      event,
      acceptedRelays,
      minimumPow: wiredAccountMinPow,
    };
  });
}

async function createConfession(admissionEvent: unknown) {
  const secretKey = parseConfessSecretKey();
  if (!secretKey) {
    const error: HttpError = new Error("confess account is not configured");
    error.statusCode = 503;
    throw error;
  }

  if (!isNostrEvent(admissionEvent)) {
    const error: HttpError = new Error("invalid confession proof event");
    error.statusCode = 400;
    throw error;
  }

  const result = await withConfessLedgerLock(async () => {
    const store = await readConfessStore();
    const status = confessStatusFromStore(store);

    if (status.closed) {
      const error: HttpError = new Error("daily confess cap reached");
      error.statusCode = 429;
      throw error;
    }

    if (store.posts.some((post) => post.proofId === admissionEvent?.id)) {
      const error: HttpError = new Error("confess proof has already been used");
      error.statusCode = 409;
      throw error;
    }

    const confessPubkey = getPublicKey(secretKey);
    const proof = validateConfessAdmission(admissionEvent, status.minimumPow, confessPubkey);
    if (!proof.ok) {
      const error: HttpError = new Error(proof.reason);
      error.statusCode = 400;
      error.pow = proof.pow;
      throw error;
    }

    const event = buildConfessionEvent(admissionEvent, secretKey);
    const acceptedRelays = await publishConfessionEvent(event);
    if (acceptedRelays.length === 0) {
      const error: HttpError = new Error("no relay accepted the confession");
      error.statusCode = 502;
      throw error;
    }

    store.posts.push({
      day: status.day,
      eventId: event.id,
      proofId: admissionEvent.id,
      pow: proof.pow,
      createdAt: Date.now(),
      acceptedRelays,
      xMirror: initialConfessXMirror(event, store),
    });
    await writeConfessStore(store);

    const nextStatus = confessStatusFromStore(store);
    const post = store.posts.find((candidate) => candidate.eventId === event.id);
    return {
      event,
      acceptedRelays,
      count: nextStatus.count,
      remaining: nextStatus.remaining,
      minimumPow: nextStatus.minimumPow,
      nextResetAt: nextStatus.nextResetAt,
      xMirror: post?.xMirror,
    };
  });

  scheduleConfessXMirror(result.event.id, result.xMirror);
  return {
    ...result,
    xMirror: publicConfessXMirror(result.xMirror),
  };
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.disable("x-powered-by");
app.use(express.json({ limit: "128kb" }));
app.use(httpAccess.middleware);

registerHttpRoutes(app, {
  backendUrl,
  buildConfessXPostText,
  confessContentMaxLength,
  confessRelays,
  confessStatusFromStore,
  confessStoreFile,
  confessXAuthMode,
  confessXConfig,
  confessXConfigured,
  confessXImageHeight,
  confessXImageTemplate,
  confessXImageWidth,
  confessXStatusFromStore,
  createConfession,
  createWiredAccountPost,
  feedSnapshot,
  isAdminAuthorized: httpAccess.isAdminAuthorized,
  isCronAuthorized: httpAccess.isCronAuthorized,
  moderation,
  moderationStoreFile,
  parseConfessSecretKey,
  publicDir,
  readConfessStore,
  readWiredAccountStore,
  relayInfo,
  renderConfessXImage,
  stats,
  wiredAccountStatusFromStore,
  wiredAccountStoreFile,
});

server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/" && url.pathname !== "/relay") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    handleClientConnection(ws);
  });
});

await mkdir(dataDir, { recursive: true });
await feedSnapshot.loadFromDisk();

server.listen(port, "0.0.0.0", () => {
  console.log(`Wired Admin gateway listening on ${port}`);
  console.log(`Proxying Nostr traffic to ${backendUrl}`);
  console.log(`Feed snapshot cache: ${snapshotCacheFile}`);
});

void feedSnapshot.refresh().catch(() => {
  if (!feedSnapshot.current()) console.error(feedSnapshot.lastRefreshError() || "initial refresh failed");
});

if (refreshSeconds > 0) {
  setInterval(() => {
    void feedSnapshot.refresh().catch(() => {
      console.error(feedSnapshot.lastRefreshError() || "scheduled refresh failed");
    });
  }, refreshSeconds * 1000).unref();
}

if (confessXConfig.enabled) {
  void processPendingConfessXMirrors().catch((error) => {
    console.error(error instanceof Error ? error.message : "initial X mirror retry failed");
  });
  confessXMirrorTimer = setInterval(() => {
    void processPendingConfessXMirrors().catch((error) => {
      console.error(error instanceof Error ? error.message : "scheduled X mirror retry failed");
    });
  }, confessXRetrySeconds * 1000);
  confessXMirrorTimer.unref();
}
