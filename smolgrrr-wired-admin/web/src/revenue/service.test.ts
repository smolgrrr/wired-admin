import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type EventTemplate,
} from "nostr-tools";
import { FakeWallet } from "./fake-wallet.js";
import { RevenueService } from "./service.js";
import type { RevenueWallet, WalletPayment } from "./wallet.js";

test("an invalid minimum payout configuration safely defaults to 14 sats", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-config-"));
  const service = new RevenueService({
    databaseFile: path.join(directory, "revenue.sqlite"),
    encryptionKey: Buffer.alloc(32, 6),
    recipientSecretKey: generateSecretKey(),
    relayUrl: "wss://staging.wiredsignal.online",
    callbackUrl: "https://staging.wiredsignal.online/api/revenue/zap",
    wallet: new FakeWallet(),
    minimumPayoutMsat: Number.NaN,
    publishReceipt: async () => [],
  });

  try {
    assert.equal(service.operatorStatus().controls.minimumPayoutMsat, 14_000);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an enrolled event receives one settled NIP-57 zap and one public receipt", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-service-"));
  const wallet = new FakeWallet();
  const recipientSecret = generateSecretKey();
  const recipientPubkey = getPublicKey(recipientSecret);
  const relayUrl = "wss://staging.wiredsignal.online";
  const publishedReceipts: unknown[] = [];
  const publishedReceiptRetries: number[] = [];
  const service = new RevenueService({
    databaseFile: path.join(directory, "revenue.sqlite"),
    encryptionKey: Buffer.alloc(32, 7),
    recipientSecretKey: recipientSecret,
    relayUrl,
    callbackUrl: "https://staging.wiredsignal.online/api/revenue/zap",
    wallet,
    publishReceipt: async (event, ownerRetries) => {
      publishedReceipts.push(event);
      publishedReceiptRetries.push(ownerRetries);
      return publishedReceipts.length === 1 ? [] : [relayUrl];
    },
  });

  try {
    const creatorSecret = generateSecretKey();
    const event = finalizeEvent({
      kind: 1,
      content: "one private payout destination",
      created_at: 1,
      tags: [["zap", recipientPubkey, relayUrl]],
    } satisfies EventTemplate, creatorSecret);
    const address = "creator@example.com";
    const enrollment = service.enrollEvent({ event, address, postingPath: "browser" });
    service.activateEnrollment(enrollment.enrollmentId);

    const zapperSecret = generateSecretKey();
    const zapRequest = finalizeEvent({
      kind: 9734,
      content: "great post",
      created_at: 2,
      tags: [
        ["p", recipientPubkey],
        ["e", event.id],
        ["amount", "10001"],
        ["relays", relayUrl],
      ],
    } satisfies EventTemplate, zapperSecret);
    const rawZapRequest = JSON.stringify(zapRequest);
    const [invoice, concurrentDuplicate] = await Promise.all([
      service.createZapInvoice({
        eventId: event.id,
        amountMsat: 10_001,
        rawZapRequest,
      }),
      service.createZapInvoice({
        eventId: event.id,
        amountMsat: 10_001,
        rawZapRequest,
      }),
    ]);
    assert.deepEqual(concurrentDuplicate, invoice);

    await wallet.settleInvoice(invoice.paymentHash);
    await assert.rejects(
      service.reconcileInvoice(invoice.paymentHash),
      /no relay accepted the zap receipt/,
    );
    const first = await service.reconcileInvoice(invoice.paymentHash);
    const duplicate = await service.reconcileInvoice(invoice.paymentHash);

    assert.equal(first.status, "settled");
    assert.equal(first.creatorMsat, 7_000);
    assert.equal(first.wiredMsat, 3_001);
    assert.deepEqual(duplicate, first);
    assert.equal(publishedReceipts.length, 2);
    assert.deepEqual(publishedReceiptRetries, [0, 1]);
    assert.equal(verifyEvent(first.receipt), true);
    assert.equal(first.receipt.kind, 9735);
    assert.deepEqual(first.receipt.tags.find((tag) => tag[0] === "e"), ["e", event.id]);
    assert.deepEqual(first.receipt.tags.find((tag) => tag[0] === "p"), ["p", recipientPubkey]);
    assert.equal(first.receipt.tags.find((tag) => tag[0] === "description")?.[1], rawZapRequest);
    assert.equal(JSON.stringify(event).includes(address), false);
    assert.equal(JSON.stringify(first.receipt).includes(address), false);
    assert.deepEqual(service.balanceForEvent(event.id), {
      availableMsat: 7_000,
      reservedMsat: 0,
      paidMsat: 0,
    });
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a 21-sat zap immediately pays 14 sats and rounds the remainder to Wired", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-payout-"));
  const wallet = new FakeWallet();
  const recipientSecret = generateSecretKey();
  const recipientPubkey = getPublicKey(recipientSecret);
  const relayUrl = "wss://staging.wiredsignal.online";
  const requestedPayouts: Array<{ address: string; amountMsat: number }> = [];
  let destinationMinimumMsat = 1_000;
  const service = new RevenueService({
    databaseFile: path.join(directory, "revenue.sqlite"),
    encryptionKey: Buffer.alloc(32, 9),
    recipientSecretKey: recipientSecret,
    relayUrl,
    callbackUrl: "https://staging.wiredsignal.online/api/revenue/zap",
    wallet,
    minimumPayoutMsat: 14_000,
    publishReceipt: async () => [relayUrl],
    addressResolver: {
      validate: async (address) => ({
        address,
        callback: "https://wallet.example/lnurl",
        minSendableMsat: destinationMinimumMsat,
        maxSendableMsat: 1_000_000,
      }),
      requestInvoice: async (address, amountMsat) => {
        requestedPayouts.push({ address, amountMsat });
        return `fake-invoice:creator:${amountMsat}`;
      },
    },
  });

  async function settleZap(address: string, grossMsat: number, sequence: number) {
    const creatorSecret = generateSecretKey();
    const event = finalizeEvent({
      kind: 1,
      content: `payout ${sequence}`,
      created_at: 10 + sequence,
      tags: [["zap", recipientPubkey, relayUrl]],
    } satisfies EventTemplate, creatorSecret);
    const enrollment = service.enrollEvent({ event, address, postingPath: "browser" });
    service.activateEnrollment(enrollment.enrollmentId);
    const request = finalizeEvent({
      kind: 9734,
      content: "",
      created_at: 20 + sequence,
      tags: [
        ["p", recipientPubkey],
        ["e", event.id],
        ["amount", String(grossMsat)],
        ["relays", relayUrl],
      ],
    } satisfies EventTemplate, generateSecretKey());
    const invoice = await service.createZapInvoice({
      eventId: event.id,
      amountMsat: grossMsat,
      rawZapRequest: JSON.stringify(request),
    });
    await wallet.settleInvoice(invoice.paymentHash);
    await service.reconcileInvoice(invoice.paymentHash);
    return event;
  }

  try {
    const paidEvent = await settleZap("paid@example.com", 21_000, 1);
    assert.deepEqual(requestedPayouts, [{ address: "paid@example.com", amountMsat: 14_000 }]);
    assert.deepEqual(service.balanceForEvent(paidEvent.id), {
      availableMsat: 0,
      reservedMsat: 0,
      paidMsat: 14_000,
    });
    assert.equal(service.operatorStatus().wiredRevenueMsat, 7_000);

    destinationMinimumMsat = 15_000;
    const deferredEvent = await settleZap("deferred@example.com", 21_000, 2);
    assert.equal(requestedPayouts.length, 1);
    assert.deepEqual(service.balanceForEvent(deferredEvent.id), {
      availableMsat: 14_700,
      reservedMsat: 0,
      paidMsat: 0,
    });
    assert.equal(service.payoutStatusForEvent(deferredEvent.id).state, "deferred");
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciliation pays an eligible balance settled while payouts were disabled", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-disabled-payout-"));
  const databaseFile = path.join(directory, "revenue.sqlite");
  const wallet = new FakeWallet();
  const recipientSecret = generateSecretKey();
  const recipientPubkey = getPublicKey(recipientSecret);
  const relayUrl = "wss://staging.wiredsignal.online";
  const requestedPayouts: Array<{ address: string; amountMsat: number }> = [];
  const addressResolver = {
    validate: async (address: string) => ({
      address,
      callback: "https://wallet.example/lnurl",
      minSendableMsat: 1_000,
      maxSendableMsat: 1_000_000,
    }),
    requestInvoice: async (address: string, amountMsat: number) => {
      requestedPayouts.push({ address, amountMsat });
      return `fake-invoice:creator:${amountMsat}`;
    },
  };
  const options = {
    databaseFile,
    encryptionKey: Buffer.alloc(32, 10),
    recipientSecretKey: recipientSecret,
    relayUrl,
    callbackUrl: "https://staging.wiredsignal.online/api/revenue/zap",
    wallet,
    minimumPayoutMsat: 14_000,
    publishReceipt: async () => [relayUrl],
    addressResolver,
  };
  const disabledService = new RevenueService({ ...options, payoutsEnabled: false });

  try {
    const event = finalizeEvent({
      kind: 1,
      content: "payout after enablement",
      created_at: 30,
      tags: [["zap", recipientPubkey, relayUrl]],
    } satisfies EventTemplate, generateSecretKey());
    const enrollment = disabledService.enrollEvent({
      event,
      address: "creator@example.com",
      postingPath: "browser",
    });
    disabledService.activateEnrollment(enrollment.enrollmentId);
    const request = finalizeEvent({
      kind: 9734,
      content: "",
      created_at: 31,
      tags: [
        ["p", recipientPubkey],
        ["e", event.id],
        ["amount", "21000"],
        ["relays", relayUrl],
      ],
    } satisfies EventTemplate, generateSecretKey());
    const invoice = await disabledService.createZapInvoice({
      eventId: event.id,
      amountMsat: 21_000,
      rawZapRequest: JSON.stringify(request),
    });
    await wallet.settleInvoice(invoice.paymentHash);
    await disabledService.reconcileInvoice(invoice.paymentHash);
    assert.deepEqual(requestedPayouts, []);
    disabledService.close();

    const enabledService = new RevenueService({ ...options, payoutsEnabled: true });
    try {
      await enabledService.reconcileAll();
      assert.deepEqual(requestedPayouts, [
        { address: "creator@example.com", amountMsat: 14_000 },
      ]);
      assert.deepEqual(enabledService.balanceForEvent(event.id), {
        availableMsat: 0,
        reservedMsat: 0,
        paidMsat: 14_000,
      });
      assert.equal(enabledService.operatorStatus().wiredRevenueMsat, 7_000);
    } finally {
      enabledService.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ambiguous outgoing payment stays reserved until provider reconciliation proves success", async () => {
  class TimeoutAfterPaymentWallet implements RevenueWallet {
    readonly backend = "timeout-wallet";
    readonly incoming = new FakeWallet();
    readonly payments = new Map<string, WalletPayment>();

    createInvoice(input: { amountMsat: number; descriptionHash: string; idempotencyKey: string }) {
      return this.incoming.createInvoice(input);
    }

    lookupInvoice(paymentHash: string) {
      return this.incoming.lookupInvoice(paymentHash);
    }

    async estimateFeeMsat() {
      return 4;
    }

    async payInvoice(input: {
      invoice: string;
      idempotencyKey: string;
      amountMsat: number;
    }): Promise<WalletPayment> {
      this.payments.set(input.idempotencyKey, {
        paymentId: input.idempotencyKey,
        status: "succeeded",
        amountMsat: input.amountMsat,
        feeMsat: 4,
      });
      throw new Error("request timed out after dispatch");
    }

    async lookupPayment(input: { paymentId: string; expectedAmountMsat?: number; invoice: string }) {
      const payment = this.payments.get(input.paymentId);
      if (!payment) {
        return {
          paymentId: input.paymentId,
          status: "not_found" as const,
          amountMsat: input.expectedAmountMsat || 0,
        };
      }
      return payment;
    }
  }

  const directory = await mkdtemp(path.join(os.tmpdir(), "wired-revenue-ambiguous-"));
  const wallet = new TimeoutAfterPaymentWallet();
  const recipientSecret = generateSecretKey();
  const recipientPubkey = getPublicKey(recipientSecret);
  const relayUrl = "wss://staging.wiredsignal.online";
  const service = new RevenueService({
    databaseFile: path.join(directory, "revenue.sqlite"),
    encryptionKey: Buffer.alloc(32, 11),
    recipientSecretKey: recipientSecret,
    relayUrl,
    callbackUrl: "https://staging.wiredsignal.online/api/revenue/zap",
    wallet,
    publishReceipt: async () => [relayUrl],
    addressResolver: {
      validate: async (address) => ({
        address,
        callback: "https://wallet.example/lnurl",
        minSendableMsat: 1_000,
        maxSendableMsat: 1_000_000,
      }),
      requestInvoice: async (_address, amountMsat) => `invoice:${amountMsat}`,
    },
  });

  try {
    const event = finalizeEvent({
      kind: 1,
      content: "ambiguous payout",
      created_at: 31,
      tags: [["zap", recipientPubkey, relayUrl]],
    } satisfies EventTemplate, generateSecretKey());
    const enrollment = service.enrollEvent({
      event,
      address: "ambiguous@example.com",
      postingPath: "browser",
    });
    service.activateEnrollment(enrollment.enrollmentId);
    const request = finalizeEvent({
      kind: 9734,
      content: "",
      created_at: 32,
      tags: [
        ["p", recipientPubkey],
        ["e", event.id],
        ["amount", "30000"],
        ["relays", relayUrl],
      ],
    } satisfies EventTemplate, generateSecretKey());
    const invoice = await service.createZapInvoice({
      eventId: event.id,
      amountMsat: 30_000,
      rawZapRequest: JSON.stringify(request),
    });
    await wallet.incoming.settleInvoice(invoice.paymentHash);
    await service.reconcileInvoice(invoice.paymentHash);

    assert.equal(service.payoutStatusForEvent(event.id).state, "ambiguous");
    assert.deepEqual(service.balanceForEvent(event.id), {
      availableMsat: 0,
      reservedMsat: 21_000,
      paidMsat: 0,
    });

    const payout = service.payoutStatusForEvent(event.id);
    const successfulPayment = wallet.payments.values().next().value as WalletPayment;
    wallet.payments.clear();
    await service.reconcileAll(Date.now() + 61_000);
    assert.equal(service.payoutStatusForEvent(event.id).state, "ambiguous");
    assert.equal(service.balanceForEvent(event.id).reservedMsat, 21_000);

    await service.reconcileAll(Date.now() + 2 * 86_400_000);
    assert.equal(service.payoutStatusForEvent(event.id).state, "ambiguous");
    assert.equal(service.balanceForEvent(event.id).reservedMsat, 21_000);

    wallet.payments.set(payout.providerPaymentId as string, successfulPayment);
    await service.reconcileAll(Date.now() + 2 * 86_400_000 + 61_000);
    assert.equal(service.payoutStatusForEvent(event.id).state, "succeeded");
    assert.deepEqual(service.balanceForEvent(event.id), {
      availableMsat: 0,
      reservedMsat: 0,
      paidMsat: 21_000,
    });
    wallet.payments.set(payout.providerPaymentId as string, {
      paymentId: successfulPayment.paymentId,
      status: "succeeded",
      amountMsat: successfulPayment.amountMsat,
    });
    await assert.rejects(
      service.reconcileSucceededPayoutFee(payout.payoutId),
      /provider final payment fee is missing/,
    );
    wallet.payments.set(payout.providerPaymentId as string, {
      ...successfulPayment,
      feeMsat: 2_000,
    });
    const corrected = await service.reconcileSucceededPayoutFee(payout.payoutId);
    assert.equal(corrected.feeMsat, 2_000);
    assert.equal(service.operatorStatus().wiredRevenueMsat, 7_000);
  } finally {
    service.close();
    await rm(directory, { recursive: true, force: true });
  }
});
