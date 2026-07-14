import type { NostrEvent } from "../contracts/nostr.js";

export type MediaModerationMode = "off" | "shadow" | "enforce";
export type ModeratedMediaType = "image" | "video";
export type MediaVerdictStatus =
  | "allowed"
  | "blocked"
  | "pending"
  | "review-required"
  | "unavailable"
  | "stale";

export type MediaVerdictRequest = {
  requestId: string;
  event: NostrEvent;
  mediaType: ModeratedMediaType;
  url: string;
  claimedHash?: string;
};

export type MediaVerdict = {
  requestId: string;
  eventId: string;
  url: string;
  mediaType: ModeratedMediaType;
  status: MediaVerdictStatus;
  reason: string;
  expiresAt: number | null;
  sha256?: string;
  perceptualHash?: string;
  checkedAt?: number;
  detectorVersion?: string;
};

export type MediaVerdictBatchResponse = {
  mode: MediaModerationMode;
  policyVersion: string;
  verdicts: MediaVerdict[];
};

export type MediaAnalysisSignal = {
  category: string;
  confidence: number;
  source: "model" | "exact-hash" | "perceptual-hash" | "file";
  match?: string;
};

export type MediaAnalysisResult = {
  sha256: string;
  perceptualHash: string;
  signals: MediaAnalysisSignal[];
  status: Exclude<MediaVerdictStatus, "pending" | "stale">;
  reason: string;
};

export type MediaAnalyzer = {
  version: string;
  analyze(input: {
    eventId: string;
    mediaType: ModeratedMediaType;
    url: string;
    claimedHash?: string;
    lookupVerifiedHash?: (
      sha256: string,
    ) => Promise<MediaAnalysisResult | null> | MediaAnalysisResult | null;
  }): Promise<MediaAnalysisResult>;
  close?: () => Promise<void> | void;
};
