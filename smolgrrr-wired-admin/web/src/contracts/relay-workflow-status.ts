import type { RelayWorkflowAggregate } from "../evidence/relay-workflow-collector.js";

export const RELAY_WORKFLOW_STATUS_SCHEMA_VERSION = 1 as const;

export const RELAY_WORKFLOW_STATUS_SOURCES = [
  "wired-browser",
  "wired-server",
  "wired-admin",
] as const;

export const RELAY_WORKFLOW_STATUS_LIMITS = {
  aggregatesPerEnvelope: 100,
  correlationsPerEnvelope: 1,
  envelopeBytes: 32_768,
  queuedEnvelopes: 100,
  rowsPerSourcePerDay: 1_000,
  requestsPerSourcePerMinute: 60,
  previewKeysPerDay: 1_000,
  retentionMs: 14 * 24 * 60 * 60 * 1_000,
} as const;

export type RelayWorkflowStatusEnvelope = {
  schemaVersion: typeof RELAY_WORKFLOW_STATUS_SCHEMA_VERSION;
  source: (typeof RELAY_WORKFLOW_STATUS_SOURCES)[number];
  collectedAt: number;
  aggregates: RelayWorkflowAggregate[];
  correlations: [];
};
