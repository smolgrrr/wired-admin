import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate } from "nostr-tools";
import { FakeWallet } from "./fake-wallet.js";
import { registerRevenueRoutes } from "./http-routes.js";
import { RevenueService } from "./service.js";

async function responseJson<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

test("public HTTP contract completes the FakeWallet NIP-57 revenue transaction", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-http-"));
  const wallet = new FakeWallet();
  const recipientSecret = generateSecretKey();
  const recipientPubkey = getPublicKey(recipientSecret);
  const relayUrl = "wss://staging.wiredsignal.online";
  const receipts: unknown[] = [];
  const service = new RevenueService({
    databaseFile: path.join(directory, "revenue.sqlite"),
    encryptionKey: Buffer.alloc(32, 13),
    recipientSecretKey: recipientSecret,
    relayUrl,
    callbackUrl: "https://staging.wiredsignal.online/api/revenue/zap",
    wallet,
    publishReceipt: async (event) => {
      receipts.push(event);
      return [relayUrl];
    },
    addressResolver: {
      validate: async (address) => ({
        address: address.toLowerCase(),
        callback: "https://fake.invalid/lnurl",
        minSendableMsat: 1_000,
        maxSendableMsat: 1_000_000,
      }),
      requestInvoice: async (_address, amountMsat) => `fake-outgoing:${amountMsat}`,
    },
  });
  const app = express();
  app.use(express.json());
  let adminAuthorized = true;
  registerRevenueRoutes(app, {
    service,
    fakeWallet: wallet,
    isAdminAuthorized: () => adminAuthorized,
    lnurlUsername: "wired",
    minSendableMsat: 1_000,
    maxSendableMsat: 1_000_000,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const config = await fetch(`${baseUrl}/api/revenue/config`).then(responseJson<{
      recipientPubkey: string;
    }>);
    assert.equal(config.recipientPubkey, recipientPubkey);
    const discovery = await fetch(`${baseUrl}/.well-known/lnurlp/wired`).then(responseJson<{
      allowsNostr: boolean;
      nostrPubkey: string;
    }>);
    assert.equal(discovery.allowsNostr, true);
    assert.equal(discovery.nostrPubkey, recipientPubkey);

    const validation = await fetch(`${baseUrl}/api/revenue/address/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "Creator@Fake.Invalid" }),
    }).then(responseJson<{ address: string }>);
    assert.equal(validation.address, "creator@fake.invalid");

    const event = finalizeEvent({
      kind: 1,
      content: "HTTP tracer bullet",
      created_at: 41,
      tags: [["zap", recipientPubkey, relayUrl]],
    } satisfies EventTemplate, generateSecretKey());
    const enrollment = await fetch(`${baseUrl}/api/revenue/enroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, address: "creator@fake.invalid" }),
    }).then(responseJson<{ enrollmentId: string; state: string }>);
    assert.equal(enrollment.state, "pending");
    await fetch(`${baseUrl}/api/revenue/enroll/${enrollment.enrollmentId}/activate`, { method: "POST" });

    const zapRequest = finalizeEvent({
      kind: 9734,
      content: "",
      created_at: 42,
      tags: [
        ["p", recipientPubkey],
        ["e", event.id],
        ["amount", "10000"],
        ["relays", relayUrl],
      ],
    } satisfies EventTemplate, generateSecretKey());
    const query = new URLSearchParams({ amount: "10000", nostr: JSON.stringify(zapRequest) });
    const invoice = await fetch(`${baseUrl}/api/revenue/zap?${query}`).then(responseJson<{ pr: string }>);
    assert.match(invoice.pr, /^lnbc10n1fake[0-9a-f]{64}$/);
    const oversizedRequest = finalizeEvent({
      kind: 9734,
      content: "",
      created_at: 43,
      tags: [
        ["p", recipientPubkey],
        ["e", event.id],
        ["amount", "1000001"],
        ["relays", relayUrl],
      ],
    } satisfies EventTemplate, generateSecretKey());
    const oversizedQuery = new URLSearchParams({
      amount: "1000001",
      nostr: JSON.stringify(oversizedRequest),
    });
    const oversized = await fetch(`${baseUrl}/api/revenue/zap?${oversizedQuery}`).then(
      responseJson<{ status: string; reason: string }>,
    );
    assert.deepEqual(oversized, {
      status: "ERROR",
      reason: "zap amount is outside the configured LNURL bounds",
    });
    const paymentHash = String(invoice.pr).slice(-64);
    const settlement = await fetch(`${baseUrl}/api/revenue/fake/settle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentHash }),
    }).then(responseJson<{ creatorMsat: number; wiredMsat: number }>);
    assert.equal(settlement.creatorMsat, 7_000);
    assert.equal(settlement.wiredMsat, 3_000);
    assert.equal(receipts.length, 1);

    const webhook = await fetch(`${baseUrl}/api/revenue/wallet/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment_hash: paymentHash }),
    }).then(responseJson<{ ok: boolean }>);
    assert.equal(webhook.ok, true);

    const status = await fetch(`${baseUrl}/api/revenue/operator/status`).then(responseJson<{
      creatorAvailableMsat: number;
      wiredRevenueMsat: number;
    }>);
    assert.equal(status.creatorAvailableMsat, 7_000);
    assert.equal(status.wiredRevenueMsat, 3_000);
    assert.equal(JSON.stringify(status).includes("creator@fake.invalid"), false);

    const missingFeeReconciliation = await fetch(
      `${baseUrl}/api/revenue/operator/payouts/missing/reconcile-fee`,
      { method: "POST" },
    );
    assert.equal(missingFeeReconciliation.status, 400);
    assert.deepEqual(await responseJson(missingFeeReconciliation), { error: "payout not found" });

    adminAuthorized = false;
    const unauthorizedFeeReconciliation = await fetch(
      `${baseUrl}/api/revenue/operator/payouts/missing/reconcile-fee`,
      { method: "POST" },
    );
    assert.equal(unauthorizedFeeReconciliation.status, 401);
    assert.deepEqual(await responseJson(unauthorizedFeeReconciliation), { error: "unauthorized" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
