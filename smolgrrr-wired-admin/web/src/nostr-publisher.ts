import { Relay, type Event } from "nostr-tools";
import {
  normalizeRelayUrl,
  uniqueRelays,
  uniqueSorted,
  withTimeout,
} from "./utils.js";
import {
  RELAY_EVIDENCE_LIMITS,
  relayAcceptedCountBucket,
  relayWorkflowOutcome,
  type RelayWorkflowEvidence,
} from "./contracts/relay-workflow-evidence.js";
import { RelayWorkflowCollector } from "./evidence/relay-workflow-collector.js";
import { RelayWorkflowEvidenceDispatcher } from "./evidence/relay-workflow-dispatcher.js";
import {
  AdminRelayWorkflowStatusAdapter,
  RelayWorkflowStatusExporter,
  adminWorkflowStatusExportEnabled,
  createAdminWorkflowStatusSink,
} from "./evidence/relay-workflow-exporter.js";

type RelayConnection = Pick<
  Awaited<ReturnType<typeof Relay.connect>>,
  "close" | "publish" | "url"
> & { connected?: boolean };

export type RelayConnector = (url: string) => Promise<RelayConnection>;

export type PublishNostrEventOptions = {
  connectRelay?: RelayConnector;
  evidenceDispatcher?: RelayWorkflowEvidenceDispatcher | null;
  ownerRetries?: number;
  workflowOwner?: Extract<
    RelayWorkflowEvidence["workflowOwner"],
    `wired-admin.${string}`
  >;
};

let scheduleWorkflowStatusExport = () => {};
const workflowCollector = new RelayWorkflowCollector({
  onChange: () => { scheduleWorkflowStatusExport(); },
});
const workflowDispatcher = new RelayWorkflowEvidenceDispatcher(workflowCollector);
const workflowStatusExportEnabled = adminWorkflowStatusExportEnabled();
const workflowStatusExporter = new RelayWorkflowStatusExporter(
  createAdminWorkflowStatusSink({
    endpoint: String(process.env.RELAY_WORKFLOW_STATUS_ENDPOINT ?? "").trim(),
    token: String(process.env.WORKFLOW_STATUS_ADMIN_TOKEN ?? "").trim(),
  }),
  { enabled: workflowStatusExportEnabled },
);
const workflowStatusAdapter = new AdminRelayWorkflowStatusAdapter(
  workflowCollector,
  workflowStatusExporter,
  { enabled: workflowStatusExportEnabled },
);
scheduleWorkflowStatusExport = () => { workflowStatusAdapter.schedule(); };

export function getServerRelayWorkflowEvidence() {
  return workflowCollector.snapshot();
}

export function getServerRelayWorkflowEvidenceStatus() {
  return {
    ...workflowDispatcher.status,
    enabled: serverRelayWorkflowEvidenceEnabled(),
    export: workflowStatusExporter.status,
  };
}

export function flushServerRelayWorkflowStatus(): void {
  workflowStatusAdapter.flushNow();
}

export function serverRelayWorkflowEvidenceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = String(env.RELAY_WORKFLOW_EVIDENCE_ENABLED ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false", "off"].includes(configured);
}

type PublishSettlement = {
  acceptedUrl?: string;
  connectionClosed: number;
  connectFailed: number;
  explicitRejection: number;
  opened: number;
  terminalClosed: number;
  timedOut: number;
};

function timedOut(error: unknown): boolean {
  return error instanceof Error && error.message.endsWith(" timed out");
}

export async function publishNostrEvent(
  event: Event,
  relayUrls: string[],
  timeoutMs: number,
  options: PublishNostrEventOptions = {},
): Promise<string[]> {
  const {
    connectRelay = Relay.connect,
    evidenceDispatcher: configuredEvidenceDispatcher,
    ownerRetries = 0,
    workflowOwner = "wired-admin.server.wired-account-publish",
  } = options;
  const evidenceDispatcher = configuredEvidenceDispatcher === undefined
    ? serverRelayWorkflowEvidenceEnabled() ? workflowDispatcher : null
    : configuredEvidenceDispatcher;
  const targets = uniqueRelays(relayUrls);
  const startedAt = evidenceDispatcher ? performance.now() : 0;
  const lateCleanupTasks: Promise<number>[] = [];
  const settlements = await Promise.all(
    targets.map(async (url): Promise<PublishSettlement> => {
      let pendingRelay: Promise<RelayConnection> | undefined;
      let relay: RelayConnection;
      try {
        pendingRelay = connectRelay(url);
        relay = await withTimeout(pendingRelay, timeoutMs, url);
      } catch (error) {
        if (pendingRelay) {
          lateCleanupTasks.push(pendingRelay.then((lateRelay) => {
            try {
              lateRelay.close();
              return 1;
            } catch {
              return 0;
            }
          }, () => 0));
        }
        return {
          connectionClosed: 0,
          connectFailed: timedOut(error) ? 0 : 1,
          explicitRejection: 0,
          opened: 0,
          terminalClosed: 0,
          timedOut: timedOut(error) ? 1 : 0,
        };
      }
      let settlement: PublishSettlement;
      try {
        await withTimeout(relay.publish(event), timeoutMs, url);
        settlement = {
          acceptedUrl: normalizeRelayUrl(relay.url || url),
          connectionClosed: 0,
          connectFailed: 0,
          explicitRejection: 0,
          opened: 1,
          terminalClosed: 0,
          timedOut: 0,
        };
      } catch (error) {
        settlement = {
          connectionClosed: 0,
          connectFailed: 0,
          explicitRejection: timedOut(error) || relay.connected === false ? 0 : 1,
          opened: 1,
          terminalClosed: timedOut(error) || relay.connected !== false ? 0 : 1,
          timedOut: timedOut(error) ? 1 : 0,
        };
      } finally {
        try {
          relay.close();
          settlement!.connectionClosed = 1;
        } catch {
          // Relay already closed.
        }
      }
      return settlement;
    }),
  );

  const accepted = uniqueSorted(settlements.flatMap((result) =>
    result.acceptedUrl ? [result.acceptedUrl] : []
  ));
  if (evidenceDispatcher) {
    const completedAt = performance.now();
    let eventFrameBytes = 0;
    try {
      eventFrameBytes = new TextEncoder().encode(
        JSON.stringify(["EVENT", event]),
      ).byteLength;
    } catch {
      // Byte evidence is optional.
    }
    const primitive = {
      accepted: accepted.length,
      connectionClosed: settlements.reduce(
        (sum, result) => sum + result.connectionClosed,
        0,
      ),
      completionMs: completedAt - startedAt,
      connectFailed: settlements.reduce((sum, result) => sum + result.connectFailed, 0),
      eventFrameBytes,
      explicitRejections: settlements.reduce(
        (sum, result) => sum + result.explicitRejection,
        0,
      ),
      opened: settlements.reduce((sum, result) => sum + result.opened, 0),
      ownerRetries,
      targets: targets.length,
      timedOut: settlements.reduce((sum, result) => sum + result.timedOut, 0),
      terminalClosed: settlements.reduce(
        (sum, result) => sum + result.terminalClosed,
        0,
      ),
      workflowOwner,
    };
    const outcome = relayWorkflowOutcome({
      targets: primitive.targets,
      successfulTargets: primitive.accepted,
      timedOut: primitive.timedOut,
      cancelled: 0,
    });
    evidenceDispatcher.defer(() => {
      evidenceDispatcher.record({
        schemaVersion: 1,
        workflowOwner: primitive.workflowOwner,
        operation: "publish",
        outcome,
        work: { attempts: 1, targets: primitive.targets },
        connections: {
          opened: primitive.opened,
          closed: primitive.connectionClosed,
          reused: 0,
          lateClosed: 0,
        },
        relay: {
          requestsSent: 0,
          // Counts client publish invocations, not frames received by a relay.
          eventsPublished: primitive.opened,
          eventsReceived: 0,
          requestBytes: 0,
          eventBytesSent: Math.min(
            RELAY_EVIDENCE_LIMITS.bytes,
            primitive.eventFrameBytes * primitive.opened,
          ),
          eventBytesReceived: 0,
        },
        results: { unique: 0, duplicates: 0, coalescedOperations: 0 },
        terminal: {
          eose: 0,
          closed: primitive.terminalClosed,
          connectFailed: primitive.connectFailed,
          timedOut: primitive.timedOut,
          cancelled: 0,
        },
        publishing: {
          acceptedCountBucket: relayAcceptedCountBucket(
            primitive.accepted,
            primitive.targets,
          ),
          rejected: primitive.explicitRejections,
          ownerRetries: Math.min(RELAY_EVIDENCE_LIMITS.count, primitive.ownerRetries),
        },
        timingMs: {
          firstResult: null,
          completion: Math.min(
            RELAY_EVIDENCE_LIMITS.durationMs,
            Math.max(0, Math.round(primitive.completionMs)),
          ),
        },
      } satisfies RelayWorkflowEvidence);
    });
    const lateCleanupKey = {
      workflowOwner: primitive.workflowOwner,
      operation: "publish" as const,
      outcome,
    };
    lateCleanupTasks.forEach((task) => {
      void task.then((closed) => {
        if (closed === 0) return;
        evidenceDispatcher.defer(() => {
          evidenceDispatcher.recordLateConnectionClosed(lateCleanupKey);
        });
      });
    });
  }

  return accepted;
}
