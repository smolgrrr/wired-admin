import type { EventId, Pubkey } from "./nostr.js";

export type ModerationActionKind =
  | "block_event"
  | "block_thread"
  | "block_media_url"
  | "block_domain"
  | "block_content_fingerprint";

export type ModerationReason = "illegal" | "spam" | "abuse" | "manual";

export type ModerationActionInput = {
  kind: ModerationActionKind;
  value: string;
  reason: ModerationReason;
  note?: string;
  moderator?: string;
};

export type ModerationAction = ModerationActionInput & {
  id: string;
  createdAt: number;
  note?: string;
  moderator: string;
};

export type ModerationStore = {
  version: 1;
  actions: ModerationAction[];
};

export type ConfessXMirrorStatus =
  | "disabled"
  | "failed"
  | "blocked"
  | "pending"
  | "dry_run"
  | "posted";

export type ConfessXCustomEmoji = {
  shortcode: string;
  url: string;
};

export type ConfessXMirror = {
  enabled: boolean;
  dryRun: boolean;
  postMode: "image";
  accountHandle: string | null;
  threadUrl: string;
  updatedAt: number;
  status: ConfessXMirrorStatus;
  reason: string;
  retryable?: boolean;
  attempts?: number;
  nextAttemptAt?: number | null;
  text?: string;
  pubkey?: Pubkey;
  customEmojis?: ConfessXCustomEmoji[];
  textHash?: string;
  textLength?: number;
  imageTemplate?: string;
  imageHash?: string;
  imageBytes?: number;
  imageWidth?: number;
  imageHeight?: number;
  mediaId?: string;
  mediaUploadedAt?: number;
  tweetId?: string;
  replyTweetId?: string;
  threadCardUri?: string;
  postedAt?: number | null;
  repliedAt?: number;
};

export type ConfessPostRecord = {
  eventId: EventId;
  proofId: EventId;
  day: string;
  pow: number;
  acceptedRelays: string[];
  createdAt: number;
  pubkey?: Pubkey;
  content?: string;
  relays?: string[];
  xMirror?: ConfessXMirror;
};

export type ConfessStore = {
  version: 1;
  posts: ConfessPostRecord[];
};

export type WiredAccountPostRecord = {
  eventId: EventId;
  proofId: EventId;
  day: string;
  pow: number;
  acceptedRelays: string[];
  createdAt: number;
  pubkey: Pubkey;
  contentLength: number;
  relays?: string[];
};

export type WiredAccountStore = {
  version: 1;
  posts: WiredAccountPostRecord[];
};
