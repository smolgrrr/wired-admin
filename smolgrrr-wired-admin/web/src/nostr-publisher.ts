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

const workflowCollector = new RelayWorkflowCollector();
const workflowDispatcher = new RelayWorkflowEvidenceDispatcher(workflowCollector);

export function getServerRelayWorkflowEvidence() {
  return workflowCollector.snapshot();
}

export function getServerRelayWorkflowEvidenceStatus() {
  return workflowDispatcher.status;
}

type PublishSettlement = {
  acceptedUrl?: string;
  closed: number;
  connectFailed: number;
  explicitRejection: number;
  opened: number;
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
    evidenceDispatcher = workflowDispatcher,
    ownerRetries = 0,
    workflowOwner = "wired-admin.server.wired-account-publish",
  } = options;
  const targets = uniqueRelays(relayUrls);
  const startedAt = evidenceDispatcher ? performance.now() : 0;
  const settlements = await Promise.all(
    targets.map(async (url): Promise<PublishSettlement> => {
      const pendingRelay = connectRelay(url);
      let relay: RelayConnection;
      try {
        relay = await withTimeout(pendingRelay, timeoutMs, url);
      } catch (error) {
        void pendingRelay.then((lateRelay) => {
          try {
            lateRelay.close();
          } catch {
            // Relay already closed.
          }
        }, () => {});
        return {
          closed: 0,
          connectFailed: timedOut(error) ? 0 : 1,
          explicitRejection: 0,
          opened: 0,
          timedOut: timedOut(error) ? 1 : 0,
        };
      }
      try {
        await withTimeout(relay.publish(event), timeoutMs, url);
        return {
          acceptedUrl: normalizeRelayUrl(relay.url || url),
          closed: 0,
          connectFailed: 0,
          explicitRejection: 0,
          opened: 1,
          timedOut: 0,
        };
      } catch (error) {
        return {
          closed: timedOut(error) || relay.connected !== false ? 0 : 1,
          connectFailed: 0,
          explicitRejection: timedOut(error) || relay.connected === false ? 0 : 1,
          opened: 1,
          timedOut: timedOut(error) ? 1 : 0,
        };
      } finally {
        try {
          relay.close();
        } catch {
          // Relay already closed.
        }
      }
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
      closed: settlements.reduce((sum, result) => sum + result.closed, 0),
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
      workflowOwner,
    };
    evidenceDispatcher.defer(() => {
      const confirmedFrames = primitive.accepted + primitive.explicitRejections;
      evidenceDispatcher.record({
        schemaVersion: 1,
        workflowOwner: primitive.workflowOwner,
        operation: "publish",
        outcome: relayWorkflowOutcome({
          targets: primitive.targets,
          successfulTargets: primitive.accepted,
          timedOut: primitive.timedOut,
          cancelled: 0,
        }),
        work: { attempts: 1, targets: primitive.targets },
        connections: {
          opened: primitive.opened,
          closed: primitive.opened,
          reused: 0,
          lateClosed: 0,
        },
        relay: {
          requestsSent: 0,
          eventsPublished: confirmedFrames,
          eventsReceived: 0,
          requestBytes: 0,
          eventBytesSent: Math.min(
            RELAY_EVIDENCE_LIMITS.bytes,
            primitive.eventFrameBytes * confirmedFrames,
          ),
          eventBytesReceived: 0,
        },
        results: { unique: 0, duplicates: 0, coalescedOperations: 0 },
        terminal: {
          eose: 0,
          closed: primitive.closed,
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
  }

  return accepted;
}
