import crypto from "node:crypto";
import path from "node:path";
import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type Event,
  type EventTemplate,
} from "nostr-tools";
import { AddressVault } from "./address-vault.js";
import {
  RevenueLedger,
  type CreatorBalance,
  type RevenueEnrollment,
  type RevenueInvoice,
} from "./ledger.js";
import type { RevenueWallet } from "./wallet.js";
import {
  HttpLightningAddressResolver,
  parseLightningAddress,
  type LightningAddressMetadata,
  type LightningAddressResolver,
} from "./lightning-address.js";
import type { RevenuePayout } from "./ledger.js";

type RevenueServiceOptions = {
  databaseFile: string;
  encryptionKey: Uint8Array;
  recipientSecretKey: Uint8Array;
  relayUrl: string;
  callbackUrl: string;
  wallet: RevenueWallet;
  publishReceipt: (event: Event) => Promise<string[]>;
  addressResolver?: LightningAddressResolver;
  enrollmentEnabled?: boolean;
  invoicesEnabled?: boolean;
  payoutsEnabled?: boolean;
  minimumPayoutMsat?: number;
  maxRoutingFeeMsat?: number;
  encryptionKeyVersion?: number;
  historicalEncryptionKeys?: Record<number, Uint8Array>;
  paymentNotFoundGraceMs?: number;
};

type PostingPath = RevenueEnrollment["postingPath"];

export const DEFAULT_MINIMUM_PAYOUT_MSAT = 14_000;

export type ZapInvoiceResult = {
  paymentHash: string;
  invoice: string;
};

export type SettledZapResult = {
  status: "settled";
  creatorMsat: number;
  wiredMsat: number;
  receipt: Event;
};

function parseEvent(raw: string): Event {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("invalid zap request JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("id" in value) ||
    !("sig" in value) ||
    !("tags" in value) ||
    !Array.isArray((value as { tags?: unknown }).tags)
  ) {
    throw new Error("invalid zap request event");
  }
  return value as Event;
}

function oneTag(event: Event, name: string): string[] {
  const tags = event.tags.filter((tag) => tag[0] === name);
  if (tags.length !== 1 || !tags[0]?.[1]) throw new Error(`zap request requires exactly one ${name} tag`);
  return tags[0];
}

export class RevenueService {
  readonly #ledger: RevenueLedger;
  readonly #vault: AddressVault;
  readonly #recipientSecretKey: Uint8Array;
  readonly #recipientPubkey: string;
  readonly #relayUrl: string;
  readonly #callbackUrl: string;
  readonly #wallet: RevenueWallet;
  readonly #publishReceipt: (event: Event) => Promise<string[]>;
  readonly #addressResolver: LightningAddressResolver;
  readonly #enrollmentEnabled: boolean;
  readonly #invoicesEnabled: boolean;
  readonly #payoutsEnabled: boolean;
  readonly #minimumPayoutMsat: number;
  readonly #maxRoutingFeeMsat: number;
  readonly #paymentNotFoundGraceMs: number;
  #invoiceCreationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: RevenueServiceOptions) {
    this.#ledger = new RevenueLedger(options.databaseFile);
    this.#vault = new AddressVault(
      options.encryptionKey,
      options.encryptionKeyVersion,
      options.historicalEncryptionKeys,
    );
    this.#recipientSecretKey = options.recipientSecretKey;
    this.#recipientPubkey = getPublicKey(options.recipientSecretKey);
    this.#relayUrl = options.relayUrl;
    this.#callbackUrl = options.callbackUrl;
    this.#wallet = options.wallet;
    this.#publishReceipt = options.publishReceipt;
    this.#addressResolver = options.addressResolver ?? new HttpLightningAddressResolver();
    this.#enrollmentEnabled = options.enrollmentEnabled ?? true;
    this.#invoicesEnabled = options.invoicesEnabled ?? true;
    this.#payoutsEnabled = options.payoutsEnabled ?? true;
    const configuredMinimumPayoutMsat = options.minimumPayoutMsat ?? DEFAULT_MINIMUM_PAYOUT_MSAT;
    this.#minimumPayoutMsat = Number.isFinite(configuredMinimumPayoutMsat)
      ? Math.max(1_000, Math.floor(configuredMinimumPayoutMsat / 1_000) * 1_000)
      : DEFAULT_MINIMUM_PAYOUT_MSAT;
    this.#maxRoutingFeeMsat = Math.max(0, Math.floor(options.maxRoutingFeeMsat ?? 5_000));
    this.#paymentNotFoundGraceMs = Math.max(
      60_000,
      Math.floor(options.paymentNotFoundGraceMs ?? 86_400_000),
    );
  }

  publicConfig(): {
    enabled: boolean;
    recipientPubkey: string;
    relayUrl: string;
    callbackUrl: string;
    walletBackend: string;
  } {
    return {
      enabled: this.#enrollmentEnabled && this.#invoicesEnabled,
      recipientPubkey: this.#recipientPubkey,
      relayUrl: this.#relayUrl,
      callbackUrl: this.#callbackUrl,
      walletBackend: this.#wallet.backend,
    };
  }

  operatorStatus(): ReturnType<RevenueLedger["status"]> & {
    walletBackend: string;
    controls: {
      enrollmentEnabled: boolean;
      invoicesEnabled: boolean;
      payoutsEnabled: boolean;
      minimumPayoutMsat: number;
    };
    encryptionKeyVersion: number;
    alerts: string[];
  } {
    const status = this.#ledger.status();
    const alerts: string[] = [];
    if ((status.payouts.ambiguous || 0) > 0) alerts.push("ambiguous payouts require provider reconciliation");
    if (status.creatorReservedMsat > 0) alerts.push("creator funds are reserved in active payouts");
    if (status.wiredRevenueMsat < 0) alerts.push("Wired fee balance is negative");
    if (
      status.creatorAvailableMsat >= this.#minimumPayoutMsat &&
      status.wiredRevenueMsat < this.#maxRoutingFeeMsat
    ) {
      alerts.push("Wired fee balance is below the payout routing-fee safety bound");
    }
    if (this.#ledger.accountingDivergenceMsat() !== 0) {
      alerts.push("revenue ledger conservation check failed");
    }
    if (this.#ledger.staleUncertainPayoutCount(Date.now() - this.#paymentNotFoundGraceMs) > 0) {
      alerts.push("stale ambiguous payouts require provider investigation");
    }
    const unavailableKeyVersions = this.#ledger.enrollmentKeyVersions()
      .filter((version) => !this.#vault.hasKeyVersion(version));
    if (unavailableKeyVersions.length > 0) {
      alerts.push(`missing revenue encryption key versions: ${unavailableKeyVersions.join(", ")}`);
    }
    let decryptionFailures = 0;
    for (const enrollment of this.#ledger.activeEnrollments()) {
      try {
        this.#vault.decrypt({
          keyVersion: enrollment.addressKeyVersion,
          ciphertext: enrollment.addressCiphertext,
          iv: enrollment.addressIv,
          tag: enrollment.addressTag,
        });
      } catch {
        decryptionFailures += 1;
      }
    }
    if (decryptionFailures > 0) {
      alerts.push(`${decryptionFailures} payout destination snapshots cannot be decrypted`);
    }
    return {
      walletBackend: this.#wallet.backend,
      controls: {
        enrollmentEnabled: this.#enrollmentEnabled,
        invoicesEnabled: this.#invoicesEnabled,
        payoutsEnabled: this.#payoutsEnabled,
        minimumPayoutMsat: this.#minimumPayoutMsat,
      },
      encryptionKeyVersion: this.#vault.keyVersion,
      alerts,
      ...status,
    };
  }

  enrollEvent(input: {
    event: Event;
    address: string;
    postingPath: PostingPath;
  }): RevenueEnrollment {
    if (!this.#enrollmentEnabled) throw new Error("new revenue enrollment is disabled");
    if (!verifyEvent(input.event)) throw new Error("invalid signed enrollment event");
    if (input.event.kind !== 1) throw new Error("only kind-1 posts can enroll for revenue");
    const zapTags = input.event.tags.filter((tag) => tag[0] === "zap");
    if (
      zapTags.length !== 1 ||
      zapTags[0]?.[1] !== this.#recipientPubkey ||
      zapTags[0]?.[2] !== this.#relayUrl
    ) {
      throw new Error("event must contain exactly one Wired revenue zap tag");
    }
    const address = parseLightningAddress(input.address).address;
    const encrypted = this.#vault.encrypt(address);
    return this.#ledger.createEnrollment({
      enrollmentId: crypto.randomUUID(),
      eventId: input.event.id,
      event: input.event,
      postingPath: input.postingPath,
      payoutKey: encrypted.payoutKey,
      addressCiphertext: encrypted.ciphertext,
      addressIv: encrypted.iv,
      addressTag: encrypted.tag,
      addressKeyVersion: encrypted.keyVersion,
      state: "pending",
    });
  }

  async validateAddress(address: string): Promise<LightningAddressMetadata> {
    return this.#addressResolver.validate(parseLightningAddress(address).address);
  }

  activateEnrollment(enrollmentId: string): RevenueEnrollment {
    return this.#ledger.setEnrollmentState(enrollmentId, "active");
  }

  failEnrollment(enrollmentId: string): RevenueEnrollment {
    return this.#ledger.setEnrollmentState(enrollmentId, "failed");
  }

  async createZapInvoice(input: {
    eventId: string;
    amountMsat: number;
    rawZapRequest: string;
  }): Promise<ZapInvoiceResult> {
    if (!this.#invoicesEnabled) throw new Error("new revenue invoices are disabled");
    if (!Number.isSafeInteger(input.amountMsat) || input.amountMsat < 1_000) {
      throw new Error("zap amount must be at least 1000 millisatoshis");
    }
    const enrollment = this.#ledger.enrollmentForEvent(input.eventId);
    if (!enrollment || enrollment.state !== "active") throw new Error("event is not active for Wired revenue");
    const request = parseEvent(input.rawZapRequest);
    if (!verifyEvent(request) || request.kind !== 9734) throw new Error("invalid signed NIP-57 zap request");
    if (oneTag(request, "p")[1] !== this.#recipientPubkey) throw new Error("zap recipient does not match Wired");
    if (oneTag(request, "e")[1] !== input.eventId) throw new Error("zap target does not match enrollment");
    if (Number(oneTag(request, "amount")[1]) !== input.amountMsat) {
      throw new Error("zap amount tag does not match callback amount");
    }
    const relayTag = oneTag(request, "relays");
    if (
      relayTag.length < 2 ||
      relayTag.slice(1).some((relay) => {
        try {
          const parsed = new URL(relay);
          return parsed.protocol !== "wss:" && parsed.protocol !== "ws:";
        } catch {
          return true;
        }
      })
    ) {
      throw new Error("zap request relays tag is invalid");
    }

    const run = this.#invoiceCreationQueue.then(async () => {
      const existing = this.#ledger.invoiceForZapRequest(request.id);
      if (existing) {
        if (existing.eventId !== input.eventId || existing.amountMsat !== input.amountMsat) {
          throw new Error("zap request already created a conflicting invoice");
        }
        return { paymentHash: existing.paymentHash, invoice: existing.invoice };
      }

      const descriptionHash = crypto.createHash("sha256").update(input.rawZapRequest, "utf8").digest("hex");
      const ownsInvoiceIntent = this.#ledger.claimInvoiceCreation({
        zapRequestId: request.id,
        eventId: input.eventId,
        amountMsat: input.amountMsat,
        descriptionHash,
      });
      if (!ownsInvoiceIntent) {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const completed = this.#ledger.invoiceForZapRequest(request.id);
          if (completed) return { paymentHash: completed.paymentHash, invoice: completed.invoice };
        }
        throw new Error("invoice creation is already in progress; retry shortly");
      }
      const walletInvoice = await this.#wallet.createInvoice({
        amountMsat: input.amountMsat,
        descriptionHash,
        idempotencyKey: request.id,
      });
      const invoice: RevenueInvoice = {
        paymentHash: walletInvoice.paymentHash,
        zapRequestId: request.id,
        eventId: input.eventId,
        rawZapRequest: input.rawZapRequest,
        amountMsat: input.amountMsat,
        invoice: walletInvoice.invoice,
        descriptionHash,
        state: "pending",
        receipt: null,
        receiptPublished: false,
      };
      const stored = this.#ledger.createInvoice(invoice);
      return { paymentHash: stored.paymentHash, invoice: stored.invoice };
    });
    this.#invoiceCreationQueue = run.catch(() => {});
    return run;
  }

  async reconcileInvoice(paymentHash: string): Promise<SettledZapResult> {
    let invoice = this.#ledger.invoiceByPaymentHash(paymentHash);
    if (!invoice) throw new Error("revenue invoice not found");
    const walletInvoice = await this.#wallet.lookupInvoice(paymentHash);
    if (walletInvoice.status !== "settled") throw new Error("revenue invoice is not settled");
    if (walletInvoice.amountMsat !== invoice.amountMsat) throw new Error("wallet settlement amount mismatch");
    const enrollment = this.#ledger.enrollmentForEvent(invoice.eventId);
    if (!enrollment) throw new Error("settled invoice enrollment is missing");

    const split = this.#ledger.creditSettledZap({
      settlementId: `${this.#wallet.backend}:${paymentHash}`,
      eventId: invoice.eventId,
      payoutKey: enrollment.payoutKey,
      amountMsat: walletInvoice.amountMsat,
    });

    if (!invoice.receipt) {
      const zapRequest = parseEvent(invoice.rawZapRequest);
      const receipt = finalizeEvent({
        kind: 9735,
        content: "",
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["p", oneTag(zapRequest, "p")[1] ?? this.#recipientPubkey],
          ["e", invoice.eventId],
          ["bolt11", invoice.invoice],
          ["description", invoice.rawZapRequest],
        ],
      } satisfies EventTemplate, this.#recipientSecretKey);
      invoice = this.#ledger.settleInvoice(paymentHash, receipt);
    }
    if (!invoice.receipt) throw new Error("settled invoice receipt is missing");
    if (!invoice.receiptPublished) {
      const acceptedRelays = await this.#publishReceipt(invoice.receipt);
      if (acceptedRelays.length === 0) throw new Error("no relay accepted the zap receipt");
      invoice = this.#ledger.markReceiptPublished(paymentHash);
    }
    if (!invoice.receipt) throw new Error("settled invoice receipt is missing");
    const result: SettledZapResult = {
      status: "settled",
      creatorMsat: split.creatorMsat,
      wiredMsat: split.wiredMsat,
      receipt: invoice.receipt,
    };
    await this.#attemptPayout(enrollment);
    return result;
  }

  async reconcileAll(now = Date.now()): Promise<{
    settledInvoices: number;
    publishedReceipts: number;
    completedPayouts: number;
    releasedPayouts: number;
    deferredPayouts: number;
    errors: number;
  }> {
    const result = {
      settledInvoices: 0,
      publishedReceipts: 0,
      completedPayouts: 0,
      releasedPayouts: 0,
      deferredPayouts: 0,
      errors: 0,
    };
    for (const invoice of this.#ledger.unpublishedReceipts()) {
      try {
        if (!invoice.receipt) continue;
        const acceptedRelays = await this.#publishReceipt(invoice.receipt);
        if (acceptedRelays.length === 0) throw new Error("no relay accepted the zap receipt");
        this.#ledger.markReceiptPublished(invoice.paymentHash);
        result.publishedReceipts += 1;
      } catch {
        result.errors += 1;
      }
    }
    for (const invoice of this.#ledger.pendingInvoices()) {
      try {
        const walletInvoice = await this.#wallet.lookupInvoice(invoice.paymentHash);
        if (walletInvoice.status === "settled") {
          await this.reconcileInvoice(invoice.paymentHash);
          result.settledInvoices += 1;
        }
      } catch {
        result.errors += 1;
      }
    }
    const consideredPayoutKeys = new Set<string>();
    for (const payout of this.#ledger.duePayouts(now)) {
      consideredPayoutKeys.add(payout.payoutKey);
      try {
        if (payout.state === "attempting" || payout.state === "ambiguous") {
          if (!payout.invoice) throw new Error("reserved payout is missing its payment invoice");
          const payment = await this.#wallet.lookupPayment({
            paymentId: payout.providerPaymentId || payout.payoutId,
            expectedAmountMsat: payout.amountMsat,
            invoice: payout.invoice,
          });
          if (payment.status === "succeeded") {
            this.#ledger.completePayout({
              payoutId: payout.payoutId,
              providerPaymentId: payment.paymentId,
              feeMsat: payment.feeMsat ?? 0,
            });
            result.completedPayouts += 1;
          } else if (payment.status === "not_found") {
            if (now - payout.createdAt < this.#paymentNotFoundGraceMs) {
              this.#ledger.markPayoutAmbiguous({
                payoutId: payout.payoutId,
                providerPaymentId: payout.providerPaymentId || payout.payoutId,
                reason: "provider has not indexed the attempted payment yet",
                nextAttemptAt: now + 60_000,
              });
            } else {
              this.#ledger.releasePayout({
                payoutId: payout.payoutId,
                reason: "provider confirmed payment was not found",
                nextAttemptAt: now + 5 * 60_000,
              });
              result.releasedPayouts += 1;
            }
          } else if (payment.status === "failed") {
            this.#ledger.releasePayout({
              payoutId: payout.payoutId,
              reason: payment.failureReason || "wallet confirmed payment failure",
              nextAttemptAt: now + 5 * 60_000,
            });
            result.releasedPayouts += 1;
          } else {
            this.#ledger.markPayoutAmbiguous({
              payoutId: payout.payoutId,
              providerPaymentId: payment.paymentId,
              reason: "wallet payment outcome remains non-final",
              nextAttemptAt: Date.now() + 60_000,
            });
          }
          continue;
        }
        const enrollment = this.#ledger.enrollmentForPayoutKey(payout.payoutKey);
        if (enrollment && (await this.#attemptPayout(enrollment))) result.deferredPayouts += 1;
      } catch {
        result.errors += 1;
      }
    }
    for (const enrollment of this.#ledger.activeEnrollments()) {
      if (consideredPayoutKeys.has(enrollment.payoutKey)) continue;
      consideredPayoutKeys.add(enrollment.payoutKey);
      const latestPayout = this.#ledger.latestPayout(enrollment.payoutKey);
      if (
        latestPayout &&
        (latestPayout.state === "attempting" ||
          latestPayout.state === "ambiguous" ||
          latestPayout.state === "deferred")
      ) {
        continue;
      }
      try {
        if (await this.#attemptPayout(enrollment)) result.deferredPayouts += 1;
      } catch {
        result.errors += 1;
      }
    }
    return result;
  }

  balanceForEvent(eventId: string): CreatorBalance {
    const enrollment = this.#ledger.enrollmentForEvent(eventId);
    if (!enrollment) throw new Error("revenue enrollment not found");
    return this.#ledger.balanceFor(enrollment.payoutKey);
  }

  payoutStatusForEvent(eventId: string): RevenuePayout {
    const enrollment = this.#ledger.enrollmentForEvent(eventId);
    if (!enrollment) throw new Error("revenue enrollment not found");
    const payout = this.#ledger.latestPayout(enrollment.payoutKey);
    if (!payout) throw new Error("payout has not been attempted");
    return payout;
  }

  async reconcileSucceededPayoutFee(payoutId: string): Promise<RevenuePayout> {
    const payout = this.#ledger.payoutById(payoutId);
    if (!payout) throw new Error("payout not found");
    if (payout.state !== "succeeded") throw new Error("payout has not succeeded");
    if (!payout.invoice || !payout.providerPaymentId) {
      throw new Error("completed payout is missing its provider identity");
    }
    const payment = await this.#wallet.lookupPayment({
      paymentId: payout.providerPaymentId,
      expectedAmountMsat: payout.amountMsat,
      invoice: payout.invoice,
    });
    if (payment.status !== "succeeded") {
      throw new Error(`provider payment is not final: ${payment.status}`);
    }
    if (payment.paymentId !== payout.providerPaymentId) {
      throw new Error("provider returned an unexpected payment identity");
    }
    return this.#ledger.reconcileSucceededPayoutFee({
      payoutId,
      providerPaymentId: payment.paymentId,
      feeMsat: payment.feeMsat ?? 0,
    });
  }

  backupTo(directory: string): { filename: string } {
    const filename = path.join(directory, `revenue-${new Date().toISOString().replaceAll(":", "-")}.sqlite`);
    this.#ledger.backupTo(filename);
    return { filename: path.basename(filename) };
  }

  close(): void {
    this.#ledger.close();
  }

  async #attemptPayout(enrollment: RevenueEnrollment): Promise<RevenuePayout | null> {
    if (!this.#payoutsEnabled) return null;
    const balance = this.#ledger.balanceFor(enrollment.payoutKey);
    if (balance.availableMsat < this.#minimumPayoutMsat) return null;
    if (this.#ledger.wiredRevenueMsat() < this.#maxRoutingFeeMsat) {
      return this.#ledger.deferPayout({
        payoutKey: enrollment.payoutKey,
        reason: "Wired fee reserve is below the configured routing-fee safety bound",
        nextAttemptAt: Date.now() + 5 * 60_000,
      });
    }
    const address = this.#vault.decrypt({
      keyVersion: enrollment.addressKeyVersion,
      ciphertext: enrollment.addressCiphertext,
      iv: enrollment.addressIv,
      tag: enrollment.addressTag,
    });
    let metadata: LightningAddressMetadata;
    try {
      metadata = await this.#addressResolver.validate(address);
    } catch (error) {
      return this.#ledger.deferPayout({
        payoutKey: enrollment.payoutKey,
        reason: error instanceof Error ? error.message : "Lightning address lookup failed",
        nextAttemptAt: Date.now() + 5 * 60_000,
      });
    }
    if (metadata.minSendableMsat > balance.availableMsat) {
      return this.#ledger.deferPayout({
        payoutKey: enrollment.payoutKey,
        reason: `destination minimum is ${metadata.minSendableMsat} msat`,
        nextAttemptAt: Date.now() + 5 * 60_000,
      });
    }
    const amountMsat = Math.floor(
      Math.min(balance.availableMsat, metadata.maxSendableMsat) / 1_000,
    ) * 1_000;
    if (amountMsat < metadata.minSendableMsat) {
      return this.#ledger.deferPayout({
        payoutKey: enrollment.payoutKey,
        reason: "destination minimum cannot be met after whole-satoshi payout rounding",
        nextAttemptAt: Date.now() + 5 * 60_000,
      });
    }
    let invoice: string;
    try {
      invoice = await this.#addressResolver.requestInvoice(address, amountMsat);
    } catch (error) {
      return this.#ledger.deferPayout({
        payoutKey: enrollment.payoutKey,
        reason: error instanceof Error ? error.message : "payout invoice request failed",
        nextAttemptAt: Date.now() + 5 * 60_000,
      });
    }
    let estimatedFeeMsat: number;
    try {
      estimatedFeeMsat = await this.#wallet.estimateFeeMsat(invoice);
    } catch (error) {
      return this.#ledger.deferPayout({
        payoutKey: enrollment.payoutKey,
        reason: error instanceof Error ? error.message : "routing-fee quote failed",
        nextAttemptAt: Date.now() + 5 * 60_000,
      });
    }
    if (
      estimatedFeeMsat > this.#maxRoutingFeeMsat ||
      estimatedFeeMsat > this.#ledger.wiredRevenueMsat()
    ) {
      return this.#ledger.deferPayout({
        payoutKey: enrollment.payoutKey,
        reason: `estimated routing fee ${estimatedFeeMsat} msat exceeds the safety bound`,
        nextAttemptAt: Date.now() + 5 * 60_000,
      });
    }
    const payoutId = crypto.randomUUID();
    const payout = this.#ledger.reservePayout({
      payoutId,
      payoutKey: enrollment.payoutKey,
      amountMsat,
      invoice,
    });
    this.#ledger.resolveDeferredPayouts(enrollment.payoutKey);
    try {
      const payment = await this.#wallet.payInvoice({
        invoice,
        idempotencyKey: payoutId,
        amountMsat,
      });
      if (payment.status === "succeeded") {
        return this.#ledger.completePayout({
          payoutId,
          providerPaymentId: payment.paymentId,
          feeMsat: payment.feeMsat ?? 0,
        });
      }
      if (payment.status === "pending" || payment.status === "unknown") {
        return this.#ledger.markPayoutAmbiguous({
          payoutId,
          providerPaymentId: payment.paymentId,
          reason: "wallet payment outcome is not final",
          nextAttemptAt: Date.now() + 60_000,
        });
      }
      return this.#ledger.releasePayout({
        payoutId,
        reason: payment.failureReason || "wallet payment failed",
        nextAttemptAt: Date.now() + 5 * 60_000,
      });
    } catch (error) {
      return this.#ledger.markPayoutAmbiguous({
        payoutId,
        providerPaymentId: payoutId,
        reason: error instanceof Error ? error.message : "wallet payment outcome is unknown",
        nextAttemptAt: Date.now() + 60_000,
      });
    }
  }
}
