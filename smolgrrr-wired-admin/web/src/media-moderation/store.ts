import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  MediaAnalysisSignal,
  MediaVerdictStatus,
  ModeratedMediaType,
} from "./contracts.js";

export type StoredMediaVerdict = {
  eventId: string;
  url: string;
  mediaType: ModeratedMediaType;
  status: Exclude<MediaVerdictStatus, "pending" | "stale">;
  reason: string;
  checkedAt: number;
  expiresAt: number;
  detectorVersion: string;
  sha256?: string;
  perceptualHash?: string;
  signals: MediaAnalysisSignal[];
};

export type StoredMediaJob = {
  id: string;
  eventId: string;
  url: string;
  mediaType: ModeratedMediaType;
  claimedHash?: string;
  createdAt: number;
  attempts: number;
};

export type MediaOverride = {
  id: string;
  targetType: "sha256" | "url";
  target: string;
  decision: "allowed" | "blocked";
  createdAt: number;
  moderator: string;
  note?: string;
};

export type MediaAuditEntry = {
  id: string;
  at: number;
  actor: string;
  action: "override_created" | "override_removed" | "rescan_requested";
  targetType: "sha256" | "url";
  target: string;
  detail?: string;
};

type MediaModerationStoreData = {
  version: 1;
  verdictsByUrl: Record<string, StoredMediaVerdict>;
  verdictsByHash: Record<string, StoredMediaVerdict>;
  jobs: StoredMediaJob[];
  overrides: MediaOverride[];
  audit: MediaAuditEntry[];
};

function emptyStore(): MediaModerationStoreData {
  return {
    version: 1,
    verdictsByUrl: {},
    verdictsByHash: {},
    jobs: [],
    overrides: [],
    audit: [],
  };
}

function isStoredVerdict(value: unknown): value is StoredMediaVerdict {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StoredMediaVerdict>;
  return (
    typeof candidate.eventId === "string" &&
    typeof candidate.url === "string" &&
    (candidate.mediaType === "image" || candidate.mediaType === "video") &&
    typeof candidate.status === "string" &&
    typeof candidate.reason === "string" &&
    typeof candidate.checkedAt === "number" &&
    typeof candidate.expiresAt === "number" &&
    typeof candidate.detectorVersion === "string" &&
    Array.isArray(candidate.signals)
  );
}

function parseStore(value: unknown): MediaModerationStoreData | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<MediaModerationStoreData>;
  if (
    candidate.version !== 1 ||
    !candidate.verdictsByUrl ||
    !candidate.verdictsByHash ||
    !Array.isArray(candidate.jobs)
  ) {
    return null;
  }
  if (!Object.values(candidate.verdictsByUrl).every(isStoredVerdict)) return null;
  if (!Object.values(candidate.verdictsByHash).every(isStoredVerdict)) return null;
  return {
    ...(candidate as MediaModerationStoreData),
    overrides: Array.isArray(candidate.overrides) ? candidate.overrides : [],
    audit: Array.isArray(candidate.audit) ? candidate.audit : [],
  };
}

export function createMediaModerationStore(storeFile: string) {
  let data = emptyStore();
  let writeQueue: Promise<void> = Promise.resolve();

  async function load(): Promise<void> {
    try {
      data = parseStore(JSON.parse(await readFile(storeFile, "utf8"))) ?? emptyStore();
    } catch {
      data = emptyStore();
    }
  }

  function persist(): Promise<void> {
    const snapshot = `${JSON.stringify(data, null, 2)}\n`;
    writeQueue = writeQueue.then(async () => {
      await mkdir(path.dirname(storeFile), { recursive: true });
      const temporaryFile = `${storeFile}.${process.pid}.tmp`;
      await writeFile(temporaryFile, snapshot, "utf8");
      await rename(temporaryFile, storeFile);
    });
    return writeQueue;
  }

  function getByUrl(url: string): StoredMediaVerdict | null {
    return data.verdictsByUrl[url] ?? null;
  }

  function getByHash(hash: string): StoredMediaVerdict | null {
    return data.verdictsByHash[hash.toLowerCase()] ?? null;
  }

  function jobs(): StoredMediaJob[] {
    return [...data.jobs];
  }

  function findOverride(url: string, hash?: string): MediaOverride | null {
    return (
      data.overrides.find(
        (override) =>
          (override.targetType === "sha256" &&
            hash &&
            override.target === hash.toLowerCase()) ||
          (override.targetType === "url" && override.target === url),
      ) ?? null
    );
  }

  function auditEntries(): MediaAuditEntry[] {
    return [...data.audit].sort((left, right) => right.at - left.at);
  }

  function overrides(): MediaOverride[] {
    return [...data.overrides].sort((left, right) => right.createdAt - left.createdAt);
  }

  function verdicts(): StoredMediaVerdict[] {
    return Object.values(data.verdictsByUrl).sort(
      (left, right) => right.checkedAt - left.checkedAt,
    );
  }

  async function createOverride(input: {
    targetType: "sha256" | "url";
    target: string;
    decision: "allowed" | "blocked";
    moderator: string;
    note?: string;
  }): Promise<MediaOverride> {
    const now = Date.now();
    const override: MediaOverride = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      targetType: input.targetType,
      target: input.target,
      decision: input.decision,
      createdAt: now,
      moderator: input.moderator,
      ...(input.note ? { note: input.note } : {}),
    };
    data.overrides = data.overrides.filter(
      (existing) =>
        existing.targetType !== override.targetType || existing.target !== override.target,
    );
    data.overrides.push(override);
    data.audit.push({
      id: `${override.id}-audit`,
      at: now,
      actor: override.moderator,
      action: "override_created",
      targetType: override.targetType,
      target: override.target,
      detail: override.decision,
    });
    await persist();
    return override;
  }

  async function removeOverride(id: string, actor: string): Promise<MediaOverride> {
    const index = data.overrides.findIndex((override) => override.id === id);
    const override = index >= 0 ? data.overrides[index] : undefined;
    if (!override) throw new Error("override not found");
    data.overrides.splice(index, 1);
    data.audit.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      at: Date.now(),
      actor,
      action: "override_removed",
      targetType: override.targetType,
      target: override.target,
    });
    await persist();
    return override;
  }

  async function prepareRescan(url: string, actor: string): Promise<StoredMediaJob> {
    const verdict = data.verdictsByUrl[url];
    if (!verdict) throw new Error("verdict not found");
    delete data.verdictsByUrl[url];
    if (verdict.sha256) delete data.verdictsByHash[verdict.sha256.toLowerCase()];
    const job: StoredMediaJob = {
      id: `${verdict.eventId}:${verdict.url}`,
      eventId: verdict.eventId,
      url: verdict.url,
      mediaType: verdict.mediaType,
      createdAt: Date.now(),
      attempts: 0,
    };
    data.jobs = data.jobs.filter((existing) => existing.id !== job.id);
    data.jobs.push(job);
    data.audit.push({
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      at: Date.now(),
      actor,
      action: "rescan_requested",
      targetType: "url",
      target: url,
    });
    await persist();
    return job;
  }

  async function putJob(job: StoredMediaJob): Promise<void> {
    if (!data.jobs.some((existing) => existing.id === job.id)) data.jobs.push(job);
    await persist();
  }

  async function completeJob(jobId: string, verdict: StoredMediaVerdict): Promise<void> {
    data.jobs = data.jobs.filter((job) => job.id !== jobId);
    data.verdictsByUrl[verdict.url] = verdict;
    if (verdict.sha256) {
      data.verdictsByHash[verdict.sha256.toLowerCase()] = {
        ...verdict,
        expiresAt: verdict.checkedAt + 7 * 24 * 60 * 60 * 1000,
      };
    }
    await persist();
  }

  async function close(): Promise<void> {
    await writeQueue;
  }

  return {
    auditEntries,
    close,
    completeJob,
    createOverride,
    findOverride,
    getByHash,
    getByUrl,
    jobs,
    load,
    overrides,
    prepareRescan,
    putJob,
    removeOverride,
    verdicts,
  };
}
