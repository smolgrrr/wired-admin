import type { NostrEvent, Pubkey, RelayHintsRecord, RelayUrl } from "./nostr.js";
import type {
  ConfessStore,
  ConfessXMirror,
  ModerationAction,
  WiredAccountStore,
} from "./stores.js";

export type ProfileSummary = {
  name?: string;
  displayName?: string;
  picture?: string;
};

export type ProcessedFeedEvent = {
  postEvent: NostrEvent;
  replies: NostrEvent[];
  relayHints?: RelayUrl[];
  threadReplyCount: number;
  rootWork: number;
  replyWork: number;
  totalWork: number;
  rankingReplyCount: number;
};

export type FeedBootstrapProcessedEvent = {
  postEventId: string;
  replyIds: string[];
  relayHints?: RelayUrl[];
  threadReplyCount: number;
  rootWork: number;
  replyWork: number;
  totalWork: number;
  rankingReplyCount: number;
};

export type FeedBootstrapScoring = {
  ageHours: number;
  minPow: number;
  replyDepth: number;
  sort: "totalWork";
};

export type FeedBootstrapSnapshot = {
  fetchedAt: number;
  processedEvents: FeedBootstrapProcessedEvent[];
  eventsById: Record<string, NostrEvent>;
  relayHintsByEventId: RelayHintsRecord;
  profiles: Record<Pubkey, ProfileSummary>;
  scoring: FeedBootstrapScoring;
};

export type ModerationManifest = {
  updatedAt: number;
  blockedEventIds: string[];
  blockedThreadRoots: string[];
  blockedMediaUrls: string[];
  blockedDomains: string[];
  blockedContentFingerprints: string[];
};

export type ModerationActionsResponse = {
  actions: ModerationAction[];
};

export type ModerationActionResponse = {
  action: ModerationAction;
};

export type MediaModerationAdminState = {
  status: {
    mode: "off" | "shadow" | "enforce";
    policyVersion: string;
    detectorVersion: string;
    queueDepth: number;
    activeImages: number;
    activeVideos: number;
    batchLatencyP95Ms: number | null;
    scanLatencyP95Ms: number | null;
    imageScanLatencyP95Ms: number | null;
    videoScanLatencyP95Ms: number | null;
    queueAgeMs: number;
    overrideCount: number;
    cacheHits: number;
    completed: number;
    blocked: number;
    errors: number;
  };
  jobs: Array<{
    id: string;
    eventId: string;
    url: string;
    mediaType: "image" | "video";
    createdAt: number;
  }>;
  verdicts: Array<{
    eventId: string;
    url: string;
    mediaType: "image" | "video";
    status: string;
    reason: string;
    checkedAt: number;
    sha256?: string;
    perceptualHash?: string;
  }>;
  overrides: Array<{
    id: string;
    targetType: "sha256" | "url";
    target: string;
    decision: "allowed" | "blocked";
    createdAt: number;
    moderator: string;
    note?: string;
  }>;
  audit: Array<{
    id: string;
    at: number;
    actor: string;
    action: string;
    targetType: "sha256" | "url";
    target: string;
    detail?: string;
  }>;
};

export type ConfessStatus = {
  configured: boolean;
  pubkey: string;
  day: string;
  count: number;
  limit: number;
  remaining: number;
  minimumPow: number;
  closed: boolean;
  nextResetAt: string;
};

export type ConfessXStatus = {
  enabled: boolean;
  dryRun: boolean;
  configured: boolean;
  authMode: string;
  accountHandle: string | null;
  postMode: "image";
  threadCardUri?: string | null;
  image: {
    width: number;
    height: number;
    template: string;
    maxBytes?: number;
  };
};

export type PublicConfessXMirror = {
  status: ConfessXMirror["status"];
  reason?: string;
  tweetId?: string;
  replyTweetId?: string;
  threadUrl?: string;
  threadCardUri?: string;
  postMode?: ConfessXMirror["postMode"];
  imageHash?: string;
  imageBytes?: number;
  retryable?: boolean;
  attempts?: number;
  nextAttemptAt?: number | null;
  accountHandle?: string;
};

export type CreateConfessionResponse = {
  ok: true;
  event: NostrEvent;
  count: number;
  acceptedRelays: string[];
  remaining: number;
  minimumPow: number;
  nextResetAt: string;
  xMirror: PublicConfessXMirror;
};

export type WiredAccountStatus = {
  configured: boolean;
  pubkey: string;
  minimumPow: number;
  relays: string[];
  maxContentLength: number;
};

export type CreateWiredAccountPostResponse = {
  ok: true;
  event: NostrEvent;
  acceptedRelays: string[];
  minimumPow: number;
  revenueEnrolled?: boolean;
};

export type RelayInfo = {
  name: string;
  description: string;
  pubkey?: string;
  contact?: string;
  icon?: string;
  supported_nips: number[];
  software: string;
  version: string;
  limitation: {
    auth_required: boolean;
    payment_required: boolean;
    min_pow_difficulty: number;
  };
};

export type RelayRecentActivity = {
  at: number;
  type: string;
  detail: unknown;
};

export type RelayStats = {
  startedAt: number;
  backendUrl: string;
  minPow: number;
  activeClients: number;
  totalConnections: number;
  clientMessages: number;
  backendMessages: number;
  publishAttempts: number;
  acceptedPublishes: number;
  powRejectedPublishes: number;
  backendRejectedPublishes: number;
  malformedMessages: number;
  reqMessages: number;
  closeMessages: number;
  lastBackendOpenAt: number | null;
  lastBackendErrorAt: number | null;
  recent: RelayRecentActivity[];
};

export type FeedSnapshotStatus = {
  fetchedAt: number | null;
  postCount: number;
  eventCount: number;
  relayHintCount: number;
  profileCount: number;
  refreshing: boolean;
  lastRefreshError: string | null;
  refreshSeconds: number;
  ageHours: number;
  timeoutMs: number;
  powRelays: string[];
  enrichmentRelays: string[];
  cacheFile: string;
};

export type StatusResponse = RelayStats & {
  uptimeSeconds: number;
  relayInfo: RelayInfo;
  snapshot: FeedSnapshotStatus;
  confess: ConfessStatus & {
    storeFile: string;
    relays: string[];
    linkedPubkey: string | null;
    xMirror: Record<string, unknown>;
  };
  wiredAccount: WiredAccountStatus & {
    storeFile: string;
    count: number;
  };
  moderation: {
    actionCount: number;
    manifest: ModerationManifest;
    storeFile: string;
  };
  generatedAt: number;
  instanceId: string;
};

export type HttpError = Error & {
  statusCode?: number;
  pow?: number;
};

export type ConfessStatusFromStore = (store: ConfessStore, now?: number) => ConfessStatus;
export type WiredAccountStatusFromStore = (
  store: WiredAccountStore,
  now?: number,
) => WiredAccountStatus & { count: number };
