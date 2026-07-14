import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { RevenueLedger } from "./ledger.js";

test("a settled zap is conserved with Wired-favouring 70/30 rounding exactly once", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-ledger-"));
  const ledger = new RevenueLedger(path.join(directory, "revenue.sqlite"));

  try {
    const first = ledger.creditSettledZap({
      settlementId: "fake:settlement:1",
      eventId: "a".repeat(64),
      payoutKey: "creator-address-snapshot",
      amountMsat: 10_001,
    });
    const duplicate = ledger.creditSettledZap({
      settlementId: "fake:settlement:1",
      eventId: "a".repeat(64),
      payoutKey: "creator-address-snapshot",
      amountMsat: 10_001,
    });

    assert.deepEqual(first, {
      credited: true,
      creatorMsat: 7_000,
      wiredMsat: 3_001,
    });
    assert.deepEqual(duplicate, {
      credited: false,
      creatorMsat: 7_000,
      wiredMsat: 3_001,
    });
    assert.deepEqual(ledger.balanceFor("creator-address-snapshot"), {
      availableMsat: 7_000,
      reservedMsat: 0,
      paidMsat: 0,
    });
    assert.equal(ledger.wiredRevenueMsat(), 3_001);
    assert.equal(ledger.totalLedgerMsat(), 10_001);
    ledger.createEnrollment({
      enrollmentId: "enrollment-backup",
      eventId: "b".repeat(64),
      event: {
        id: "b".repeat(64),
        pubkey: "c".repeat(64),
        created_at: 1,
        kind: 1,
        tags: [],
        content: "backup",
        sig: "d".repeat(128),
      },
      postingPath: "browser",
      payoutKey: "creator-address-snapshot",
      addressCiphertext: "encrypted-address",
      addressIv: "iv",
      addressTag: "tag",
      addressKeyVersion: 1,
      state: "active",
    });
    ledger.createInvoice({
      paymentHash: "e".repeat(64),
      zapRequestId: "f".repeat(64),
      eventId: "b".repeat(64),
      rawZapRequest: "{}",
      amountMsat: 1_000,
      invoice: "invoice-backup",
      descriptionHash: "1".repeat(64),
      state: "pending",
      receipt: null,
      receiptPublished: false,
    });
    ledger.reservePayout({
      payoutId: "payout-crash-recovery",
      payoutKey: "creator-address-snapshot",
      amountMsat: 1_000,
      invoice: "payout-invoice",
    });
    ledger.markPayoutAmbiguous({
      payoutId: "payout-crash-recovery",
      providerPaymentId: "provider-payout-id",
      reason: "response lost",
      nextAttemptAt: 0,
    });
    ledger.deferPayout({
      payoutKey: "deferred-creator",
      reason: "destination minimum is higher than balance",
      nextAttemptAt: 0,
    });
    const backupFile = path.join(directory, "backups", "revenue.sqlite");
    ledger.backupTo(backupFile);
    const restored = new RevenueLedger(backupFile);
    try {
      assert.deepEqual(restored.balanceFor("creator-address-snapshot"), {
        availableMsat: 6_000,
        reservedMsat: 1_000,
        paidMsat: 0,
      });
      assert.equal(restored.totalLedgerMsat(), 10_001);
      assert.equal(restored.enrollmentForEvent("b".repeat(64))?.addressCiphertext, "encrypted-address");
      assert.equal(restored.pendingInvoices()[0]?.invoice, "invoice-backup");
      assert.ok(restored.duePayouts().some((payout) => payout.payoutId === "payout-crash-recovery"));
      assert.ok(restored.duePayouts().some((payout) => payout.state === "deferred"));
    } finally {
      restored.close();
    }
  } finally {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an existing unversioned enrollment schema migrates to encryption key version 1", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-migration-"));
  const databaseFile = path.join(directory, "revenue.sqlite");
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`
    CREATE TABLE revenue_enrollments (
      enrollment_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      event_json TEXT NOT NULL,
      posting_path TEXT NOT NULL,
      payout_key TEXT NOT NULL,
      address_ciphertext TEXT NOT NULL,
      address_iv TEXT NOT NULL,
      address_tag TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      activated_at INTEGER
    ) STRICT;
  `);
  legacy.close();

  const ledger = new RevenueLedger(databaseFile);
  try {
    const migrated = new DatabaseSync(databaseFile, { readOnly: true });
    const columns = migrated.prepare("PRAGMA table_info(revenue_enrollments)").all() as Array<{
      name: string;
    }>;
    migrated.close();
    assert.ok(columns.some((column) => column.name === "address_key_version"));
  } finally {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a finalized provider fee can correct an already completed payout without breaking conservation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-final-fee-"));
  const ledger = new RevenueLedger(path.join(directory, "revenue.sqlite"));

  try {
    ledger.creditSettledZap({
      settlementId: "spark:settlement:1",
      eventId: "a".repeat(64),
      payoutKey: "creator-address-snapshot",
      amountMsat: 21_000,
    });
    ledger.reservePayout({
      payoutId: "spark-payout-1",
      payoutKey: "creator-address-snapshot",
      amountMsat: 14_000,
      invoice: "lnbc14creator",
    });
    ledger.completePayout({
      payoutId: "spark-payout-1",
      providerPaymentId: "spark-send-1",
      feeMsat: 0,
    });

    const corrected = ledger.reconcileSucceededPayoutFee({
      payoutId: "spark-payout-1",
      providerPaymentId: "spark-send-1",
      feeMsat: 2_000,
    });

    assert.equal(corrected.feeMsat, 2_000);
    assert.equal(ledger.wiredRevenueMsat(), 4_300);
    assert.equal(ledger.totalLedgerMsat(), 19_000);
    assert.equal(ledger.accountingDivergenceMsat(), 0);
    assert.equal(ledger.reconcileSucceededPayoutFee({
      payoutId: "spark-payout-1",
      providerPaymentId: "spark-send-1",
      feeMsat: 2_000,
    }).feeMsat, 2_000);
  } finally {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invoice creation leases are exclusive across processes and recover after expiry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-intent-"));
  const databaseFile = path.join(directory, "revenue.sqlite");
  const first = new RevenueLedger(databaseFile);
  const second = new RevenueLedger(databaseFile);
  const input = {
    zapRequestId: "a".repeat(64),
    eventId: "b".repeat(64),
    amountMsat: 10_000,
    descriptionHash: "c".repeat(64),
    now: 1_000,
    leaseMs: 120_000,
  };

  try {
    assert.equal(first.claimInvoiceCreation(input), true);
    assert.equal(second.claimInvoiceCreation(input), false);
    assert.equal(second.claimInvoiceCreation({ ...input, now: 121_001 }), true);
  } finally {
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});
