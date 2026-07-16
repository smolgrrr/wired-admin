import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  RELAY_EVIDENCE_LIMITS,
  RELAY_WORKFLOW_EVIDENCE_SCHEMA,
  isRelayWorkflowEvidence,
  relayAcceptedCountBucket,
  relayWorkflowOutcome,
  type RelayWorkflowEvidence,
} from "../contracts/relay-workflow-evidence.js";

type Corpus = {
  valid: unknown[];
  invalid: unknown[];
  acceptedCountBucketCases: Array<{
    accepted: number;
    targets: number;
    expected: string;
  }>;
  invalidAcceptedCountBucketCases: Array<{
    accepted: number;
    targets: number;
  }>;
  outcomeCases: Array<{
    targets: number;
    successfulTargets: number;
    timedOut: number;
    cancelled: number;
    expected: string;
  }>;
  invalidOutcomeCases: Array<{
    targets: number;
    successfulTargets: number;
    timedOut: number;
    cancelled: number;
  }>;
};

type Manifest = {
  schemaVersion: number;
  canonicalRepository: string;
  canonicalPath: string;
  schemaSha256: string;
  conformanceSha256: string;
};

const contractDirectory = resolve(process.cwd(), "src/contracts");
const readContract = (name: string) =>
  readFileSync(resolve(contractDirectory, name), "utf8");
const schemaSource = readContract("relay-workflow-evidence.v1.schema.json");
const conformanceSource = readContract(
  "relay-workflow-evidence.v1.conformance.json",
);
const schema = JSON.parse(schemaSource);
const corpus = JSON.parse(conformanceSource) as Corpus;
const manifest = JSON.parse(
  readContract("relay-workflow-evidence.v1.manifest.json"),
) as Manifest;
const validateSchema = new Ajv2020({ strict: true }).compile(schema);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

function boundaryVectors(): unknown[] {
  const base = structuredClone(corpus.valid[0]) as RelayWorkflowEvidence;
  const missingKey: Partial<RelayWorkflowEvidence> = structuredClone(base);
  delete missingKey.schemaVersion;

  return [
    missingKey,
    { ...structuredClone(base), outcome: "unknown" },
    { ...structuredClone(base), work: { ...base.work, attempts: -1 } },
    {
      ...structuredClone(base),
      connections: { ...base.connections, opened: 0.5 },
    },
    {
      ...structuredClone(base),
      terminal: {
        ...base.terminal,
        eose: RELAY_EVIDENCE_LIMITS.count + 1,
      },
    },
    {
      ...structuredClone(base),
      relay: {
        ...base.relay,
        requestBytes: RELAY_EVIDENCE_LIMITS.bytes + 1,
      },
    },
    {
      ...structuredClone(base),
      timingMs: {
        ...base.timingMs,
        completion: RELAY_EVIDENCE_LIMITS.durationMs + 1,
      },
    },
    { ...structuredClone(base), work: { ...base.work, extra: 1 } },
  ];
}

test("relay workflow evidence v1 pins canonical artifacts", () => {
  assert.deepEqual({
    schemaVersion: manifest.schemaVersion,
    canonicalRepository: manifest.canonicalRepository,
    canonicalPath: manifest.canonicalPath,
  }, {
    schemaVersion: 1,
    canonicalRepository: "smolgrrr/wired-admin",
    canonicalPath: "smolgrrr-wired-admin/web/src/contracts",
  });
  assert.equal(digest(schemaSource), manifest.schemaSha256);
  assert.equal(digest(conformanceSource), manifest.conformanceSha256);
  assert.deepEqual(RELAY_WORKFLOW_EVIDENCE_SCHEMA, schema);
});

test("relay workflow evidence v1 keeps schema and guard conformant", () => {
  corpus.valid.forEach((envelope) => {
    assert.equal(validateSchema(envelope), true);
    assert.equal(isRelayWorkflowEvidence(envelope), true);
  });
  [...corpus.invalid, ...boundaryVectors()].forEach((envelope) => {
    assert.equal(validateSchema(envelope), false);
    assert.equal(isRelayWorkflowEvidence(envelope), false);
  });
});

test("relay workflow evidence v1 uses deterministic semantics", () => {
  corpus.acceptedCountBucketCases.forEach(({ accepted, targets, expected }) => {
    assert.equal(relayAcceptedCountBucket(accepted, targets), expected);
  });
  corpus.outcomeCases.forEach(({ expected, ...input }) => {
    assert.equal(relayWorkflowOutcome(input), expected);
  });
  corpus.invalidAcceptedCountBucketCases.forEach(({ accepted, targets }) => {
    assert.throws(() => relayAcceptedCountBucket(accepted, targets), RangeError);
  });
  corpus.invalidOutcomeCases.forEach((input) => {
    assert.throws(() => relayWorkflowOutcome(input), RangeError);
  });
});
