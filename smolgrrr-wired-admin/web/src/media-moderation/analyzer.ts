import sharp from "sharp";
import type { MediaAnalyzer, MediaAnalysisSignal } from "./contracts.js";
import { fetchRemoteMedia, type FetchedMedia } from "./fetcher.js";
import { differenceHash, hammingDistance, sha256 } from "./hashing.js";
import type { LocalMediaClassifier } from "./local-classifier.js";
import { extractRepresentativeVideoFrames } from "./video-frames.js";

type TransientAnalyzerOptions = {
  fetcher?: (url: string) => Promise<FetchedMedia>;
  classifier: LocalMediaClassifier;
  exactBlockHashes?: Iterable<string>;
  perceptualBlockHashes?: Iterable<string>;
  perceptualDistance?: number;
  blockThreshold?: number;
  reviewThreshold?: number;
  extractVideoFrames?: (bytes: Uint8Array) => Promise<Buffer[]>;
};

export function createTransientMediaAnalyzer({
  fetcher = fetchRemoteMedia,
  classifier,
  exactBlockHashes = [],
  perceptualBlockHashes = [],
  perceptualDistance = 4,
  blockThreshold = 0.92,
  reviewThreshold = 0.65,
  extractVideoFrames = extractRepresentativeVideoFrames,
}: TransientAnalyzerOptions): MediaAnalyzer {
  const exactBlocks = new Set([...exactBlockHashes].map((value) => value.toLowerCase()));
  const perceptualBlocks = [...perceptualBlockHashes].map((value) => value.toLowerCase());

  function policyResult(
    contentHash: string,
    perceptualHash: string,
    signals: MediaAnalysisSignal[],
  ) {
    const explicit = signals.filter(
      (signal) => signal.category === "Porn" || signal.category === "Hentai",
    );
    const highestExplicit = Math.max(0, ...explicit.map((signal) => signal.confidence));
    const sexy = signals.find((signal) => signal.category === "Sexy")?.confidence ?? 0;
    if (highestExplicit >= blockThreshold) {
      return {
        sha256: contentHash,
        perceptualHash,
        signals,
        status: "review-required" as const,
        reason: "model_high_confidence_review",
      };
    }
    if (highestExplicit >= reviewThreshold || sexy >= reviewThreshold) {
      return {
        sha256: contentHash,
        perceptualHash,
        signals,
        status: "review-required" as const,
        reason: "model_review_threshold",
      };
    }
    return {
      sha256: contentHash,
      perceptualHash,
      signals,
      status: "allowed" as const,
      reason: "policy_allowed",
    };
  }

  function aggregateSignals(frames: MediaAnalysisSignal[][]): MediaAnalysisSignal[] {
    const highest = new Map<string, MediaAnalysisSignal>();
    for (const frame of frames) {
      for (const signal of frame) {
        const current = highest.get(signal.category);
        if (!current || signal.confidence > current.confidence) {
          highest.set(signal.category, signal);
        }
      }
    }
    return [...highest.values()];
  }

  async function analyze({
    mediaType,
    url,
    claimedHash,
    lookupVerifiedHash,
  }: Parameters<MediaAnalyzer["analyze"]>[0]) {
    const fetched = await fetcher(url);
    const contentHash = sha256(fetched.bytes);
    let frames: Buffer[];
    if (mediaType === "image") {
      const metadata = await sharp(fetched.bytes, {
        failOn: "error",
        limitInputPixels: 40_000_000,
      }).metadata();
      if (
        !metadata.format ||
        !["jpeg", "png", "webp", "gif", "avif"].includes(metadata.format)
      ) {
        throw new Error("unsupported image format");
      }
      frames =
        (metadata.pages ?? 1) > 1
          ? await extractVideoFrames(fetched.bytes)
          : [fetched.bytes];
    } else {
      frames = await extractVideoFrames(fetched.bytes);
    }
    const frameHashes = await Promise.all(frames.map(differenceHash));
    const perceptualHash = frameHashes[0] ?? "0000000000000000";
    if (claimedHash && claimedHash.toLowerCase() !== contentHash) {
      return {
        sha256: contentHash,
        perceptualHash,
        signals: [] as MediaAnalysisSignal[],
        status: "review-required" as const,
        reason: "claimed_hash_mismatch",
      };
    }
    if (exactBlocks.has(contentHash)) {
      return {
        sha256: contentHash,
        perceptualHash,
        signals: [{ category: "blocked-hash", confidence: 1, source: "exact-hash" as const }],
        status: "blocked" as const,
        reason: "exact_hash_block",
      };
    }
    const perceptualMatch = perceptualBlocks.find((blocked) =>
      frameHashes.some(
        (frameHash) => hammingDistance(blocked, frameHash) <= perceptualDistance,
      ),
    );
    if (perceptualMatch) {
      return {
        sha256: contentHash,
        perceptualHash,
        signals: [{
          category: "similar-blocked-media",
          confidence: 1,
          source: "perceptual-hash" as const,
          match: perceptualMatch,
        }],
        status: "blocked" as const,
        reason: "perceptual_hash_block",
      };
    }

    const cached = await lookupVerifiedHash?.(contentHash);
    if (cached) return cached;

    const signals = aggregateSignals(
      await Promise.all(frames.map((frame) => classifier.classify(frame))),
    );
    return policyResult(contentHash, perceptualHash, signals);
  }

  return {
    version: classifier.version,
    analyze,
    ...(classifier.close ? { close: classifier.close } : {}),
  };
}
