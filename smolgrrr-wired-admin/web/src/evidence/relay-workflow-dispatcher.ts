import { RELAY_EVIDENCE_LIMITS } from "../contracts/relay-workflow-evidence.js";
import type { RelayWorkflowEvidence } from "../contracts/relay-workflow-evidence.js";
import type { RelayWorkflowEvidenceRecorder } from "./relay-workflow-collector.js";

const MAX_PENDING_EVIDENCE_TASKS = 100;

export class RelayWorkflowEvidenceDispatcher {
  private readonly tasks: Array<() => void> = [];
  private flushScheduled = false;
  private dropped = 0;

  constructor(
    private readonly recorder: RelayWorkflowEvidenceRecorder,
    private readonly schedule: (task: () => void) => void =
      (task) => { setTimeout(task, 0); },
  ) {}

  get status(): { pending: number; dropped: number } {
    return { pending: this.tasks.length, dropped: this.dropped };
  }

  defer(task: () => void): void {
    if (this.tasks.length >= MAX_PENDING_EVIDENCE_TASKS) {
      this.tasks.shift();
      this.incrementDropped();
    }
    this.tasks.push(task);
    if (this.flushScheduled) return;

    this.flushScheduled = true;
    try {
      this.schedule(() => {
        this.flushScheduled = false;
        const pending = this.tasks.splice(0);
        pending.forEach((pendingTask) => {
          try {
            pendingTask();
          } catch {
            this.incrementDropped();
          }
        });
      });
    } catch {
      this.flushScheduled = false;
      this.incrementDropped(this.tasks.splice(0).length);
    }
  }

  record(evidence: unknown): void {
    this.recorder.record(evidence);
  }

  recordLateConnectionClosed(
    key: Pick<RelayWorkflowEvidence, "workflowOwner" | "operation" | "outcome">,
  ): void {
    this.recorder.recordLateConnectionClosed?.(key);
  }

  private incrementDropped(count = 1): void {
    this.dropped = Math.min(
      RELAY_EVIDENCE_LIMITS.count,
      this.dropped + count,
    );
  }
}
