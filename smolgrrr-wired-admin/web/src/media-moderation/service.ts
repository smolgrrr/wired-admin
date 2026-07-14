import { verifyEvent } from "nostr-tools";
import type { ModerationService } from "../moderation.js";
import { verifyPow } from "../pow.js";
import { normalizeUrl } from "../utils.js";
import type {
  MediaAnalyzer,
  MediaModerationMode,
  MediaVerdict,
  MediaVerdictBatchResponse,
  MediaVerdictRequest,
} from "./contracts.js";
import {
  createMediaModerationStore,
  type StoredMediaJob,
  type StoredMediaVerdict,
} from "./store.js";

const POLICY_VERSION = "wired-media-v1";
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

function eventUrls(event: MediaVerdictRequest["event"]): Set<string> {
  const values = [...String(event.content || "").matchAll(HTTP_URL_PATTERN)].map(
    (match) => match[0],
  );
  for (const tag of event.tags || []) {
    if (tag[0] !== "imeta") continue;
    for (const part of tag.slice(1)) {
      if (part.startsWith("url ")) values.push(part.slice(4).trim());
    }
  }
  return new Set(values.map(normalizeUrl).filter(Boolean));
}

function domainFromUrl(value: string): string {
  return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
}

export function createMediaModerationService({
  analyzer,
  mode,
  moderation,
  storeFile,
  minimumEventPow = 0,
}: {
  analyzer: MediaAnalyzer;
  mode: MediaModerationMode;
  moderation: ModerationService;
  storeFile: string;
  minimumEventPow?: number;
}) {
  const store = createMediaModerationStore(storeFile);
  const queuedJobs: StoredMediaJob[] = [];
  const activeJobs = new Set<Promise<void>>();
  const queuedJobIds = new Set<string>();
  let activeImages = 0;
  let activeVideos = 0;
  const imageConcurrency = 10;
  const videoConcurrency = 2;
  const scanDurations: number[] = [];
  const imageScanDurations: number[] = [];
  const videoScanDurations: number[] = [];
  const batchDurations: number[] = [];
  const metrics = {
    batches: 0,
    requestedAttachments: 0,
    cacheHits: 0,
    completed: 0,
    blocked: 0,
    errors: 0,
  };
  let closed = false;
  const ready = store.load().then(() => {
    for (const job of store.jobs()) queueExistingJob(job);
  });

  function jobId(url: string): string {
    return url;
  }

  function verdictFromStored(
    item: MediaVerdictRequest,
    stored: StoredMediaVerdict,
  ): MediaVerdict {
    const override = store.findOverride(stored.url, stored.sha256);
    const claimedHashMismatch = Boolean(
      !override &&
      stored.sha256 &&
      item.claimedHash &&
      item.claimedHash.toLowerCase() !== stored.sha256.toLowerCase(),
    );
    return {
      requestId: item.requestId,
      eventId: item.event.id,
      url: stored.url,
      mediaType: stored.mediaType,
      status: claimedHashMismatch
        ? "review-required"
        : override?.decision ?? stored.status,
      reason: claimedHashMismatch
        ? "claimed_hash_mismatch"
        : override
        ? override.decision === "allowed"
          ? "admin_allow_override"
          : "admin_block_override"
        : stored.reason,
      expiresAt: stored.expiresAt,
      checkedAt: stored.checkedAt,
      detectorVersion: stored.detectorVersion,
      ...(stored.sha256 ? { sha256: stored.sha256 } : {}),
      ...(stored.perceptualHash ? { perceptualHash: stored.perceptualHash } : {}),
    };
  }

  function queueExistingJob(job: StoredMediaJob): void {
    if (queuedJobIds.has(job.id)) return;
    queuedJobIds.add(job.id);
    queuedJobs.push(job);
    queueMicrotask(pump);
  }

  async function enqueue(item: MediaVerdictRequest, url: string): Promise<void> {
    const id = jobId(url);
    if (queuedJobIds.has(id)) return;
    const job: StoredMediaJob = {
      id,
      eventId: item.event.id,
      url,
      mediaType: item.mediaType,
      createdAt: Date.now(),
      attempts: 0,
    };
    queuedJobIds.add(id);
    await store.putJob(job);
    queuedJobs.push(job);
    queueMicrotask(pump);
  }

  async function runJob(job: StoredMediaJob): Promise<void> {
    const checkedAt = Date.now();
    try {
      const result = await analyzer.analyze({
        eventId: job.eventId,
        mediaType: job.mediaType,
        url: job.url,
        lookupVerifiedHash(hash) {
          const override = store.findOverride(job.url, hash);
          if (override) {
            return {
              sha256: hash,
              perceptualHash: "0000000000000000",
              signals: [],
              status: override.decision,
              reason: override.decision === "allowed"
                ? "admin_allow_override"
                : "admin_block_override",
            };
          }
          const cached = store.getByHash(hash);
          if (
            !cached ||
            cached.expiresAt <= Date.now() ||
            cached.detectorVersion !== analyzer.version
          ) {
            return null;
          }
          metrics.cacheHits += 1;
          return {
            sha256: hash,
            perceptualHash: cached.perceptualHash || "0000000000000000",
            signals: cached.signals,
            status: cached.status,
            reason: cached.reason,
          };
        },
      });
      await store.completeJob(job.id, {
        eventId: job.eventId,
        url: job.url,
        mediaType: job.mediaType,
        status: result.status,
        reason: result.reason,
        checkedAt,
        expiresAt: checkedAt + 15 * 60 * 1000,
        detectorVersion: analyzer.version,
        sha256: result.sha256,
        perceptualHash: result.perceptualHash,
        signals: result.signals,
      });
      metrics.completed += 1;
      if (result.status === "blocked") metrics.blocked += 1;
    } catch (error) {
      await store.completeJob(job.id, {
        eventId: job.eventId,
        url: job.url,
        mediaType: job.mediaType,
        status: "unavailable",
        reason: error instanceof Error ? "analysis_error" : "analysis_unavailable",
        checkedAt,
        expiresAt: checkedAt + 15_000,
        detectorVersion: analyzer.version,
        signals: [],
      });
      metrics.errors += 1;
    } finally {
      scanDurations.push(Date.now() - checkedAt);
      if (scanDurations.length > 200) scanDurations.shift();
      const mediaDurations = job.mediaType === "video"
        ? videoScanDurations
        : imageScanDurations;
      mediaDurations.push(Date.now() - checkedAt);
      if (mediaDurations.length > 200) mediaDurations.shift();
      queuedJobIds.delete(job.id);
    }
  }

  function pump(): void {
    if (closed) return;
    while (queuedJobs.length > 0) {
      const index = queuedJobs.findIndex((job) =>
        job.mediaType === "video"
          ? activeVideos < videoConcurrency
          : activeImages < imageConcurrency,
      );
      if (index < 0) break;
      const [job] = queuedJobs.splice(index, 1);
      if (!job) continue;
      if (job.mediaType === "video") activeVideos += 1;
      else activeImages += 1;
      const work = runJob(job).finally(() => {
        activeJobs.delete(work);
        if (job.mediaType === "video") activeVideos -= 1;
        else activeImages -= 1;
        pump();
      });
      activeJobs.add(work);
    }
  }

  async function verdictFor(item: MediaVerdictRequest): Promise<MediaVerdict> {
    const url = normalizeUrl(item.url);
    if (
      !url ||
      !item.requestId ||
      (item.mediaType !== "image" && item.mediaType !== "video") ||
      !verifyEvent(item.event) ||
      (minimumEventPow > 0 && !verifyPow(item.event, minimumEventPow).ok) ||
      !eventUrls(item.event).has(url)
    ) {
      return {
        requestId: String(item.requestId || ""),
        eventId: String(item.event?.id || ""),
        url: url || String(item.url || ""),
        mediaType: item.mediaType,
        status: "unavailable",
        reason: "invalid_request",
        expiresAt: null,
      };
    }

    if (mode === "off") {
      return {
        requestId: item.requestId,
        eventId: item.event.id,
        url,
        mediaType: item.mediaType,
        status: "allowed",
        reason: "moderation_disabled",
        expiresAt: null,
      };
    }

    const manifest = await moderation.getManifest();
    if (manifest.blockedMediaUrls.includes(url)) {
      return {
        requestId: item.requestId,
        eventId: item.event.id,
        url,
        mediaType: item.mediaType,
        status: "blocked",
        reason: "manual_url_block",
        expiresAt: null,
      };
    }
    if (manifest.blockedDomains.includes(domainFromUrl(url))) {
      return {
        requestId: item.requestId,
        eventId: item.event.id,
        url,
        mediaType: item.mediaType,
        status: "blocked",
        reason: "manual_domain_block",
        expiresAt: null,
      };
    }

    const urlOverride = store.findOverride(url);
    if (urlOverride) {
      return {
        requestId: item.requestId,
        eventId: item.event.id,
        url,
        mediaType: item.mediaType,
        status: urlOverride.decision,
        reason: urlOverride.decision === "allowed"
          ? "admin_allow_override"
          : "admin_block_override",
        expiresAt: null,
      };
    }

    const now = Date.now();
    const stored = store.getByUrl(url);
    if (stored && stored.expiresAt > now) {
      metrics.cacheHits += 1;
      return verdictFromStored(item, stored);
    }

    await enqueue(item, url);
    return {
      requestId: item.requestId,
      eventId: item.event.id,
      url,
      mediaType: item.mediaType,
      status: "pending",
      reason: "analysis_queued",
      expiresAt: null,
    };
  }

  async function getVerdicts(
    items: MediaVerdictRequest[],
  ): Promise<MediaVerdictBatchResponse> {
    await ready;
    const startedAt = Date.now();
    metrics.batches += 1;
    metrics.requestedAttachments += items.length;
    try {
      return {
        mode,
        policyVersion: POLICY_VERSION,
        verdicts: await Promise.all(items.map(verdictFor)),
      };
    } finally {
      batchDurations.push(Date.now() - startedAt);
      if (batchDurations.length > 500) batchDurations.shift();
    }
  }

  async function close(): Promise<void> {
    await ready;
    closed = true;
    // Jobs not yet started remain in the persistent store and are recovered on restart.
    queuedJobs.length = 0;
    await Promise.allSettled([...activeJobs]);
    await analyzer.close?.();
    await store.close();
  }

  async function createOverride(input: {
    targetType: "sha256" | "url";
    target: string;
    decision: "allowed" | "blocked";
    moderator?: string;
    note?: string;
  }) {
    await ready;
    const target =
      input.targetType === "url" ? normalizeUrl(input.target) : input.target.toLowerCase();
    if (!target) throw new Error("invalid override target");
    if (input.targetType === "sha256" && !/^[0-9a-f]{64}$/.test(target)) {
      throw new Error("invalid SHA-256 override target");
    }
    if (input.decision !== "allowed" && input.decision !== "blocked") {
      throw new Error("invalid override decision");
    }
    return store.createOverride({
      targetType: input.targetType,
      target,
      decision: input.decision,
      moderator: input.moderator?.trim() || "local-admin",
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    });
  }

  async function getAudit() {
    await ready;
    return store.auditEntries();
  }

  async function getOverrides() {
    await ready;
    return store.overrides();
  }

  async function adminState() {
    await ready;
    return {
      status: status(),
      verdicts: store.verdicts(),
      jobs: store.jobs(),
      overrides: store.overrides(),
      audit: store.auditEntries(),
    };
  }

  function status() {
    const p95 = (values: number[]): number | null => {
      const sorted = [...values].sort((left, right) => left - right);
      const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
      return sorted[index] ?? null;
    };
    const oldestJobAt = store.jobs().reduce(
      (oldest, job) => Math.min(oldest, job.createdAt),
      Number.POSITIVE_INFINITY,
    );
    return {
      mode,
      policyVersion: POLICY_VERSION,
      detectorVersion: analyzer.version,
      queueDepth: queuedJobs.length,
      activeImages,
      activeVideos,
      imageConcurrency,
      videoConcurrency,
      batchLatencyP95Ms: p95(batchDurations),
      scanLatencyP95Ms: p95(scanDurations),
      imageScanLatencyP95Ms: p95(imageScanDurations),
      videoScanLatencyP95Ms: p95(videoScanDurations),
      queueAgeMs: Number.isFinite(oldestJobAt) ? Date.now() - oldestJobAt : 0,
      overrideCount: store.overrides().length,
      enforcementAttachments:
        mode === "enforce" ? metrics.requestedAttachments : 0,
      ...metrics,
    };
  }

  async function removeOverride(id: string, actor?: string) {
    await ready;
    return store.removeOverride(id, actor?.trim() || "local-admin");
  }

  async function rescan(urlValue: string, actor?: string): Promise<void> {
    await ready;
    const url = normalizeUrl(urlValue);
    if (!url) throw new Error("invalid rescan URL");
    const job = await store.prepareRescan(url, actor?.trim() || "local-admin");
    queueExistingJob(job);
  }

  async function waitForIdle(timeoutMs = 5_000): Promise<boolean> {
    await ready;
    const deadline = Date.now() + timeoutMs;
    while (queuedJobs.length > 0 || activeJobs.size > 0) {
      if (Date.now() >= deadline) return false;
      if (activeJobs.size > 0) {
        await Promise.race([
          Promise.all([...activeJobs]),
          new Promise((resolve) => setTimeout(resolve, 10)),
        ]);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    return true;
  }

  return {
    close,
    adminState,
    createOverride,
    getAudit,
    getOverrides,
    getVerdicts,
    removeOverride,
    rescan,
    status,
    waitForIdle,
  };
}

export type MediaModerationService = ReturnType<typeof createMediaModerationService>;
