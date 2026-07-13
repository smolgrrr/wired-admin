import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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
  } finally {
    ledger.close();
    await rm(directory, { recursive: true, force: true });
  }
});
