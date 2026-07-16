import { RELAY_EVIDENCE_LIMITS } from "../contracts/relay-workflow-evidence.js";
import {
  RELAY_WORKFLOW_STATUS_LIMITS,
  type RelayWorkflowStatusEnvelope,
} from "../contracts/relay-workflow-status.js";
import type { RelayWorkflowCollector } from "./relay-workflow-collector.js";

export type WorkflowStatusSink = (
  envelope: RelayWorkflowStatusEnvelope,
) => Promise<void>;

type ExporterOptions = {
  enabled?: boolean;
  schedule?: (task: () => void) => void;
  sinkTimeoutMs?: number;
};

export class RelayWorkflowStatusExporter {
  private readonly queue: RelayWorkflowStatusEnvelope[] = [];
  private readonly schedule: (task: () => void) => void;
  private readonly sinkTimeoutMs: number;
  private scheduled = false;
  private flushing = false;
  private dropped = 0;
  readonly enabled: boolean;

  constructor(
    private readonly sink: WorkflowStatusSink,
    {
      enabled = true,
      schedule = (task) => { setTimeout(task, 0).unref(); },
      sinkTimeoutMs = 5_000,
    }: ExporterOptions = {},
  ) {
    this.enabled = enabled;
    this.schedule = schedule;
    this.sinkTimeoutMs = Math.max(1, sinkTimeoutMs);
  }

  get status(): { enabled: boolean; pending: number; dropped: number } {
    return { enabled: this.enabled, pending: this.queue.length, dropped: this.dropped };
  }

  enqueue(envelope: RelayWorkflowStatusEnvelope): void {
    if (!this.enabled) return;
    if (this.queue.length >= RELAY_WORKFLOW_STATUS_LIMITS.queuedEnvelopes) {
      this.queue.shift();
      this.recordDrop();
    }
    this.queue.push(structuredClone(envelope));
    this.scheduleFlush();
  }

  recordDrop(count = 1): void {
    this.dropped = Math.min(RELAY_EVIDENCE_LIMITS.count, this.dropped + count);
  }

  private scheduleFlush(): void {
    if (this.scheduled || this.flushing) return;
    this.scheduled = true;
    try {
      this.schedule(() => {
        this.scheduled = false;
        void this.flush();
      });
    } catch {
      this.scheduled = false;
      this.recordDrop(this.queue.splice(0).length);
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const envelope = this.queue.shift();
        if (!envelope) continue;
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.sink(envelope),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => { reject(new Error("workflow status sink timed out")); },
                this.sinkTimeoutMs,
              );
              timeout.unref();
            }),
          ]);
        } catch {
          this.recordDrop();
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) this.scheduleFlush();
    }
  }
}

type AdapterOptions = {
  enabled?: boolean;
  flushIntervalMs?: number;
  now?: () => number;
  setTimer?: (task: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
};

export class AdminRelayWorkflowStatusAdapter {
  private timer: NodeJS.Timeout | undefined;
  private readonly enabled: boolean;
  private readonly flushIntervalMs: number;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<AdapterOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<AdapterOptions["clearTimer"]>;

  constructor(
    private readonly collector: RelayWorkflowCollector,
    private readonly exporter: RelayWorkflowStatusExporter,
    {
      enabled = true,
      flushIntervalMs = 30_000,
      now = Date.now,
      setTimer = (task, delayMs) => setTimeout(task, delayMs),
      clearTimer = (timer) => clearTimeout(timer),
    }: AdapterOptions = {},
  ) {
    this.enabled = enabled;
    this.flushIntervalMs = flushIntervalMs;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
  }

  schedule(): void {
    if (!this.enabled || this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.flushNow();
    }, this.flushIntervalMs);
    this.timer.unref();
  }

  flushNow(): void {
    if (!this.enabled) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const aggregates = this.collector.drain();
    if (aggregates.length === 0) return;
    const collectedAt = this.now();
    let chunk: typeof aggregates = [];
    for (const aggregate of aggregates) {
      const candidate = [...chunk, aggregate];
      const envelope: RelayWorkflowStatusEnvelope = {
        schemaVersion: 1,
        source: "wired-admin",
        collectedAt,
        aggregates: candidate,
        correlations: [],
      };
      if (candidate.length <= RELAY_WORKFLOW_STATUS_LIMITS.aggregatesPerEnvelope &&
        Buffer.byteLength(JSON.stringify(envelope), "utf8") <=
          RELAY_WORKFLOW_STATUS_LIMITS.envelopeBytes) {
        chunk = candidate;
        continue;
      }
      if (chunk.length > 0) this.exporter.enqueue({ ...envelope, aggregates: chunk });
      const single = { ...envelope, aggregates: [aggregate] };
      if (Buffer.byteLength(JSON.stringify(single), "utf8") <=
        RELAY_WORKFLOW_STATUS_LIMITS.envelopeBytes) {
        chunk = [aggregate];
      } else {
        chunk = [];
        this.exporter.recordDrop();
      }
    }
    if (chunk.length > 0) {
      this.exporter.enqueue({
        schemaVersion: 1,
        source: "wired-admin",
        collectedAt,
        aggregates: chunk,
        correlations: [],
      });
    }
  }
}

type AdminSinkOptions = {
  endpoint: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function createAdminWorkflowStatusSink({
  endpoint,
  token,
  fetchImpl = fetch,
  timeoutMs = 5_000,
}: AdminSinkOptions): WorkflowStatusSink {
  return async (envelope) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    if (!response.ok) throw new Error(`workflow status ingest failed: ${response.status}`);
  };
}

export function adminWorkflowStatusExportEnabled(
  env: NodeJS.ProcessEnv = process.env,
  sample = Math.random(),
): boolean {
  if (String(env.RELAY_WORKFLOW_STATUS_EXPORT_ENABLED ?? "").trim().toLowerCase() !== "true") {
    return false;
  }
  if (!String(env.RELAY_WORKFLOW_STATUS_ENDPOINT ?? "").trim() ||
    !String(env.WORKFLOW_STATUS_ADMIN_TOKEN ?? "").trim()) return false;
  const parsed = Number(env.RELAY_WORKFLOW_STATUS_EXPORT_PERCENT ?? 0);
  const percentage = Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
  return sample >= 0 && sample < percentage / 100;
}
