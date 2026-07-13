import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Event } from "nostr-tools";

export type CreatorBalance = {
  availableMsat: number;
  reservedMsat: number;
  paidMsat: number;
};

type SettledZapCredit = {
  settlementId: string;
  eventId: string;
  payoutKey: string;
  amountMsat: number;
};

type CreditResult = {
  credited: boolean;
  creatorMsat: number;
  wiredMsat: number;
};

type BalanceRow = {
  available_msat: number;
  reserved_msat: number;
  paid_msat: number;
};

type SumRow = { amount_msat: number };

export type RevenueEnrollment = {
  enrollmentId: string;
  eventId: string;
  event: Event;
  postingPath: "browser" | "wired-account";
  payoutKey: string;
  addressCiphertext: string;
  addressIv: string;
  addressTag: string;
  addressKeyVersion: number;
  state: "pending" | "active" | "failed";
};

export type RevenueInvoice = {
  paymentHash: string;
  zapRequestId: string;
  eventId: string;
  rawZapRequest: string;
  amountMsat: number;
  invoice: string;
  descriptionHash: string;
  state: "pending" | "settled";
  receipt: Event | null;
  receiptPublished: boolean;
};

type EnrollmentRow = {
  enrollment_id: string;
  event_id: string;
  event_json: string;
  posting_path: "browser" | "wired-account";
  payout_key: string;
  address_ciphertext: string;
  address_iv: string;
  address_tag: string;
  address_key_version: number;
  state: "pending" | "active" | "failed";
};

type InvoiceRow = {
  payment_hash: string;
  zap_request_id: string;
  event_id: string;
  zap_request_json: string;
  amount_msat: number;
  invoice: string;
  description_hash: string;
  state: "pending" | "settled";
  receipt_json: string | null;
  receipt_published_at: number | null;
};

export type RevenuePayout = {
  payoutId: string;
  payoutKey: string;
  amountMsat: number;
  state: "attempting" | "deferred" | "ambiguous" | "succeeded" | "resolved";
  invoice: string | null;
  providerPaymentId: string | null;
  feeMsat: number | null;
  reason: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
};

type PayoutRow = {
  payout_id: string;
  payout_key: string;
  amount_msat: number;
  state: RevenuePayout["state"];
  invoice: string | null;
  provider_payment_id: string | null;
  fee_msat: number | null;
  reason: string | null;
  next_attempt_at: number | null;
  created_at: number;
  updated_at: number;
};

function requireMsat(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("amount must be a positive integer millisatoshi value");
  }
  return value;
}

export class RevenueLedger {
  readonly #database: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.#database = new DatabaseSync(filename);
    this.#database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS revenue_settlements (
        settlement_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        payout_key TEXT NOT NULL,
        amount_msat INTEGER NOT NULL CHECK (amount_msat > 0),
        creator_msat INTEGER NOT NULL CHECK (creator_msat >= 0),
        wired_msat INTEGER NOT NULL CHECK (wired_msat >= 0),
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS revenue_ledger_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        unique_key TEXT NOT NULL UNIQUE,
        event_id TEXT,
        payout_key TEXT,
        entry_type TEXT NOT NULL,
        available_delta_msat INTEGER NOT NULL DEFAULT 0,
        reserved_delta_msat INTEGER NOT NULL DEFAULT 0,
        paid_delta_msat INTEGER NOT NULL DEFAULT 0,
        wired_delta_msat INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS revenue_ledger_payout_key
        ON revenue_ledger_entries (payout_key, id);

      CREATE TABLE IF NOT EXISTS revenue_enrollments (
        enrollment_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        event_json TEXT NOT NULL,
        posting_path TEXT NOT NULL CHECK (posting_path IN ('browser', 'wired-account')),
        payout_key TEXT NOT NULL,
        address_ciphertext TEXT NOT NULL,
        address_iv TEXT NOT NULL,
        address_tag TEXT NOT NULL,
        address_key_version INTEGER NOT NULL CHECK (address_key_version > 0),
        state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'failed')),
        created_at INTEGER NOT NULL,
        activated_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS revenue_invoices (
        payment_hash TEXT PRIMARY KEY,
        zap_request_id TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL REFERENCES revenue_enrollments(event_id),
        zap_request_json TEXT NOT NULL,
        amount_msat INTEGER NOT NULL CHECK (amount_msat > 0),
        invoice TEXT NOT NULL,
        description_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'settled')),
        receipt_json TEXT,
        receipt_published_at INTEGER,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      ) STRICT;

      CREATE TABLE IF NOT EXISTS revenue_invoice_intents (
        zap_request_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        amount_msat INTEGER NOT NULL CHECK (amount_msat > 0),
        description_hash TEXT NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS revenue_payouts (
        payout_id TEXT PRIMARY KEY,
        payout_key TEXT NOT NULL,
        amount_msat INTEGER NOT NULL CHECK (amount_msat >= 0),
        state TEXT NOT NULL CHECK (state IN ('attempting', 'deferred', 'ambiguous', 'succeeded', 'resolved')),
        invoice TEXT,
        provider_payment_id TEXT,
        fee_msat INTEGER,
        reason TEXT,
        next_attempt_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX IF NOT EXISTS revenue_payout_active_key
        ON revenue_payouts (payout_key)
        WHERE state IN ('attempting', 'ambiguous');
    `);
    const enrollmentColumns = this.#database
      .prepare("PRAGMA table_info(revenue_enrollments)")
      .all() as Array<{ name: string }>;
    if (!enrollmentColumns.some((column) => column.name === "address_key_version")) {
      this.#database.exec(`
        ALTER TABLE revenue_enrollments
        ADD COLUMN address_key_version INTEGER NOT NULL DEFAULT 1 CHECK (address_key_version > 0)
      `);
    }
  }

  createEnrollment(enrollment: RevenueEnrollment): RevenueEnrollment {
    const existing = this.enrollmentForEvent(enrollment.eventId);
    if (existing) {
      if (
        existing.payoutKey !== enrollment.payoutKey ||
        existing.postingPath !== enrollment.postingPath ||
        JSON.stringify(existing.event) !== JSON.stringify(enrollment.event)
      ) {
        throw new Error("event already has a conflicting revenue enrollment");
      }
      return existing;
    }
    this.#database
      .prepare(`
        INSERT INTO revenue_enrollments (
          enrollment_id, event_id, event_json, posting_path, payout_key,
          address_ciphertext, address_iv, address_tag, address_key_version, state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        enrollment.enrollmentId,
        enrollment.eventId,
        JSON.stringify(enrollment.event),
        enrollment.postingPath,
        enrollment.payoutKey,
        enrollment.addressCiphertext,
        enrollment.addressIv,
        enrollment.addressTag,
        enrollment.addressKeyVersion,
        enrollment.state,
        Date.now(),
      );
    return enrollment;
  }

  enrollmentForEvent(eventId: string): RevenueEnrollment | null {
    const row = this.#database
      .prepare("SELECT * FROM revenue_enrollments WHERE event_id = ?")
      .get(eventId) as EnrollmentRow | undefined;
    return row ? this.#mapEnrollment(row) : null;
  }

  enrollmentById(enrollmentId: string): RevenueEnrollment | null {
    const row = this.#database
      .prepare("SELECT * FROM revenue_enrollments WHERE enrollment_id = ?")
      .get(enrollmentId) as EnrollmentRow | undefined;
    return row ? this.#mapEnrollment(row) : null;
  }

  setEnrollmentState(enrollmentId: string, state: RevenueEnrollment["state"]): RevenueEnrollment {
    this.#database
      .prepare(`
        UPDATE revenue_enrollments
        SET state = ?, activated_at = CASE WHEN ? = 'active' THEN ? ELSE activated_at END
        WHERE enrollment_id = ?
          AND (state = 'pending' OR state = ?)
      `)
      .run(state, state, Date.now(), enrollmentId, state);
    const enrollment = this.enrollmentById(enrollmentId);
    if (!enrollment) throw new Error("revenue enrollment not found");
    return enrollment;
  }

  createInvoice(invoice: RevenueInvoice): RevenueInvoice {
    const existing = this.invoiceForZapRequest(invoice.zapRequestId);
    if (existing) {
      if (existing.eventId !== invoice.eventId || existing.amountMsat !== invoice.amountMsat) {
        throw new Error("zap request already created a conflicting invoice");
      }
      return existing;
    }
    this.#database
      .prepare(`
        INSERT INTO revenue_invoices (
          payment_hash, zap_request_id, event_id, zap_request_json, amount_msat,
          invoice, description_hash, state, receipt_json, receipt_published_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        invoice.paymentHash,
        invoice.zapRequestId,
        invoice.eventId,
        invoice.rawZapRequest,
        invoice.amountMsat,
        invoice.invoice,
        invoice.descriptionHash,
        invoice.state,
        invoice.receipt ? JSON.stringify(invoice.receipt) : null,
        invoice.receiptPublished ? Date.now() : null,
        Date.now(),
      );
    this.#database
      .prepare("DELETE FROM revenue_invoice_intents WHERE zap_request_id = ?")
      .run(invoice.zapRequestId);
    return invoice;
  }

  claimInvoiceCreation(input: {
    zapRequestId: string;
    eventId: string;
    amountMsat: number;
    descriptionHash: string;
    now?: number;
    leaseMs?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    const leaseExpiresAt = now + (input.leaseMs ?? 120_000);
    const inserted = this.#database
      .prepare(`
        INSERT OR IGNORE INTO revenue_invoice_intents (
          zap_request_id, event_id, amount_msat, description_hash, lease_expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.zapRequestId,
        input.eventId,
        input.amountMsat,
        input.descriptionHash,
        leaseExpiresAt,
        now,
      );
    if (inserted.changes === 1) return true;
    const existing = this.#database
      .prepare("SELECT * FROM revenue_invoice_intents WHERE zap_request_id = ?")
      .get(input.zapRequestId) as {
        event_id: string;
        amount_msat: number;
        description_hash: string;
        lease_expires_at: number;
      } | undefined;
    if (!existing) return false;
    if (
      existing.event_id !== input.eventId ||
      Number(existing.amount_msat) !== input.amountMsat ||
      existing.description_hash !== input.descriptionHash
    ) {
      throw new Error("zap request already has a conflicting invoice intent");
    }
    if (Number(existing.lease_expires_at) > now) return false;
    const renewed = this.#database
      .prepare(`
        UPDATE revenue_invoice_intents
        SET lease_expires_at = ?
        WHERE zap_request_id = ? AND lease_expires_at <= ?
      `)
      .run(leaseExpiresAt, input.zapRequestId, now);
    return renewed.changes === 1;
  }

  invoiceForZapRequest(zapRequestId: string): RevenueInvoice | null {
    const row = this.#database
      .prepare("SELECT * FROM revenue_invoices WHERE zap_request_id = ?")
      .get(zapRequestId) as InvoiceRow | undefined;
    return row ? this.#mapInvoice(row) : null;
  }

  invoiceByPaymentHash(paymentHash: string): RevenueInvoice | null {
    const row = this.#database
      .prepare("SELECT * FROM revenue_invoices WHERE payment_hash = ?")
      .get(paymentHash) as InvoiceRow | undefined;
    return row ? this.#mapInvoice(row) : null;
  }

  pendingInvoices(): RevenueInvoice[] {
    return (this.#database
      .prepare("SELECT * FROM revenue_invoices WHERE state = 'pending' ORDER BY created_at")
      .all() as InvoiceRow[]).map((row) => this.#mapInvoice(row));
  }

  unpublishedReceipts(): RevenueInvoice[] {
    return (this.#database
      .prepare(`
        SELECT * FROM revenue_invoices
        WHERE state = 'settled' AND receipt_json IS NOT NULL AND receipt_published_at IS NULL
        ORDER BY settled_at
      `)
      .all() as InvoiceRow[]).map((row) => this.#mapInvoice(row));
  }

  settleInvoice(paymentHash: string, receipt: Event): RevenueInvoice {
    this.#database
      .prepare(`
        UPDATE revenue_invoices
        SET state = 'settled', receipt_json = COALESCE(receipt_json, ?), settled_at = COALESCE(settled_at, ?)
        WHERE payment_hash = ?
      `)
      .run(JSON.stringify(receipt), Date.now(), paymentHash);
    const invoice = this.invoiceByPaymentHash(paymentHash);
    if (!invoice) throw new Error("revenue invoice not found");
    return invoice;
  }

  markReceiptPublished(paymentHash: string): RevenueInvoice {
    this.#database
      .prepare(`
        UPDATE revenue_invoices
        SET receipt_published_at = COALESCE(receipt_published_at, ?)
        WHERE payment_hash = ?
      `)
      .run(Date.now(), paymentHash);
    const invoice = this.invoiceByPaymentHash(paymentHash);
    if (!invoice) throw new Error("revenue invoice not found");
    return invoice;
  }

  creditSettledZap(input: SettledZapCredit): CreditResult {
    const amountMsat = requireMsat(input.amountMsat);
    const creatorMsat = Math.floor((amountMsat * 70) / 100);
    const wiredMsat = amountMsat - creatorMsat;
    const existing = this.#database
      .prepare("SELECT settlement_id FROM revenue_settlements WHERE settlement_id = ?")
      .get(input.settlementId);
    if (existing) return { credited: false, creatorMsat, wiredMsat };

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const duplicate = this.#database
        .prepare("SELECT settlement_id FROM revenue_settlements WHERE settlement_id = ?")
        .get(input.settlementId);
      if (duplicate) {
        this.#database.exec("ROLLBACK");
        return { credited: false, creatorMsat, wiredMsat };
      }

      const now = Date.now();
      this.#database
        .prepare(`
          INSERT INTO revenue_settlements (
            settlement_id, event_id, payout_key, amount_msat, creator_msat, wired_msat, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.settlementId,
          input.eventId,
          input.payoutKey,
          amountMsat,
          creatorMsat,
          wiredMsat,
          now,
        );
      this.#database
        .prepare(`
          INSERT INTO revenue_ledger_entries (
            unique_key, event_id, payout_key, entry_type, available_delta_msat, created_at
          ) VALUES (?, ?, ?, 'creator_credit', ?, ?)
        `)
        .run(`settlement:${input.settlementId}:creator`, input.eventId, input.payoutKey, creatorMsat, now);
      this.#database
        .prepare(`
          INSERT INTO revenue_ledger_entries (
            unique_key, event_id, entry_type, wired_delta_msat, created_at
          ) VALUES (?, ?, 'wired_credit', ?, ?)
        `)
        .run(`settlement:${input.settlementId}:wired`, input.eventId, wiredMsat, now);
      this.#database.exec("COMMIT");
      return { credited: true, creatorMsat, wiredMsat };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  balanceFor(payoutKey: string): CreatorBalance {
    const row = this.#database
      .prepare(`
        SELECT
          COALESCE(SUM(available_delta_msat), 0) AS available_msat,
          COALESCE(SUM(reserved_delta_msat), 0) AS reserved_msat,
          COALESCE(SUM(paid_delta_msat), 0) AS paid_msat
        FROM revenue_ledger_entries
        WHERE payout_key = ?
      `)
      .get(payoutKey) as BalanceRow;
    return {
      availableMsat: Number(row.available_msat),
      reservedMsat: Number(row.reserved_msat),
      paidMsat: Number(row.paid_msat),
    };
  }

  reservePayout(input: {
    payoutId: string;
    payoutKey: string;
    amountMsat: number;
    invoice: string;
  }): RevenuePayout {
    const amountMsat = requireMsat(input.amountMsat);
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const balance = this.balanceFor(input.payoutKey);
      if (balance.availableMsat < amountMsat) throw new Error("creator balance is no longer available");
      const now = Date.now();
      this.#database
        .prepare(`
          INSERT INTO revenue_payouts (
            payout_id, payout_key, amount_msat, state, invoice, created_at, updated_at
          ) VALUES (?, ?, ?, 'attempting', ?, ?, ?)
        `)
        .run(input.payoutId, input.payoutKey, amountMsat, input.invoice, now, now);
      this.#database
        .prepare(`
          INSERT INTO revenue_ledger_entries (
            unique_key, payout_key, entry_type, available_delta_msat, reserved_delta_msat, created_at
          ) VALUES (?, ?, 'payout_reserve', ?, ?, ?)
        `)
        .run(`payout:${input.payoutId}:reserve`, input.payoutKey, -amountMsat, amountMsat, now);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    const payout = this.payoutById(input.payoutId);
    if (!payout) throw new Error("reserved payout is missing");
    return payout;
  }

  completePayout(input: {
    payoutId: string;
    providerPaymentId: string;
    feeMsat: number;
  }): RevenuePayout {
    const payout = this.payoutById(input.payoutId);
    if (!payout) throw new Error("payout not found");
    if (payout.state === "succeeded") return payout;
    if (payout.state !== "attempting" && payout.state !== "ambiguous") {
      throw new Error("payout is not reserved");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      this.#database
        .prepare(`
          INSERT OR IGNORE INTO revenue_ledger_entries (
            unique_key, payout_key, entry_type, reserved_delta_msat, paid_delta_msat, wired_delta_msat, created_at
          ) VALUES (?, ?, 'payout_complete', ?, ?, ?, ?)
        `)
        .run(
          `payout:${input.payoutId}:complete`,
          payout.payoutKey,
          -payout.amountMsat,
          payout.amountMsat,
          -Math.max(0, Math.floor(input.feeMsat)),
          now,
        );
      this.#database
        .prepare(`
          UPDATE revenue_payouts
          SET state = 'succeeded', provider_payment_id = ?, fee_msat = ?, reason = NULL,
              next_attempt_at = NULL, updated_at = ?
          WHERE payout_id = ?
        `)
        .run(input.providerPaymentId, Math.max(0, Math.floor(input.feeMsat)), now, input.payoutId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.payoutById(input.payoutId) as RevenuePayout;
  }

  releasePayout(input: { payoutId: string; reason: string; nextAttemptAt: number }): RevenuePayout {
    const payout = this.payoutById(input.payoutId);
    if (!payout) throw new Error("payout not found");
    if (payout.state === "deferred") return payout;
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      this.#database
        .prepare(`
          INSERT OR IGNORE INTO revenue_ledger_entries (
            unique_key, payout_key, entry_type, available_delta_msat, reserved_delta_msat, created_at
          ) VALUES (?, ?, 'payout_release', ?, ?, ?)
        `)
        .run(
          `payout:${input.payoutId}:release`,
          payout.payoutKey,
          payout.amountMsat,
          -payout.amountMsat,
          now,
        );
      this.#database
        .prepare(`
          UPDATE revenue_payouts
          SET state = 'deferred', reason = ?, next_attempt_at = ?, updated_at = ?
          WHERE payout_id = ?
        `)
        .run(input.reason, input.nextAttemptAt, now, input.payoutId);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
    return this.payoutById(input.payoutId) as RevenuePayout;
  }

  deferPayout(input: { payoutKey: string; reason: string; nextAttemptAt: number }): RevenuePayout {
    const payoutId = `deferred:${input.payoutKey}`;
    const now = Date.now();
    this.#database
      .prepare(`
        INSERT INTO revenue_payouts (
          payout_id, payout_key, amount_msat, state, reason, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, 0, 'deferred', ?, ?, ?, ?)
        ON CONFLICT(payout_id) DO UPDATE SET
          state = 'deferred', reason = excluded.reason,
          next_attempt_at = excluded.next_attempt_at, updated_at = excluded.updated_at
      `)
      .run(payoutId, input.payoutKey, input.reason, input.nextAttemptAt, now, now);
    return this.payoutById(payoutId) as RevenuePayout;
  }

  markPayoutAmbiguous(input: {
    payoutId: string;
    providerPaymentId: string;
    reason: string;
    nextAttemptAt: number;
  }): RevenuePayout {
    this.#database
      .prepare(`
        UPDATE revenue_payouts
        SET state = 'ambiguous', provider_payment_id = ?, reason = ?, next_attempt_at = ?, updated_at = ?
        WHERE payout_id = ?
      `)
      .run(input.providerPaymentId, input.reason, input.nextAttemptAt, Date.now(), input.payoutId);
    const payout = this.payoutById(input.payoutId);
    if (!payout) throw new Error("payout not found");
    return payout;
  }

  payoutById(payoutId: string): RevenuePayout | null {
    const row = this.#database
      .prepare("SELECT * FROM revenue_payouts WHERE payout_id = ?")
      .get(payoutId) as PayoutRow | undefined;
    return row ? this.#mapPayout(row) : null;
  }

  latestPayout(payoutKey: string): RevenuePayout | null {
    const row = this.#database
      .prepare("SELECT * FROM revenue_payouts WHERE payout_key = ? ORDER BY updated_at DESC LIMIT 1")
      .get(payoutKey) as PayoutRow | undefined;
    return row ? this.#mapPayout(row) : null;
  }

  resolveDeferredPayouts(payoutKey: string): void {
    this.#database
      .prepare(`
        UPDATE revenue_payouts
        SET state = 'resolved', next_attempt_at = NULL, updated_at = ?
        WHERE payout_key = ? AND state = 'deferred'
      `)
      .run(Date.now(), payoutKey);
  }

  duePayouts(now = Date.now()): RevenuePayout[] {
    return (this.#database
      .prepare(`
        SELECT * FROM revenue_payouts
        WHERE state IN ('attempting', 'deferred', 'ambiguous')
          AND COALESCE(next_attempt_at, 0) <= ?
        ORDER BY updated_at
      `)
      .all(now) as PayoutRow[]).map((row) => this.#mapPayout(row));
  }

  enrollmentForPayoutKey(payoutKey: string): RevenueEnrollment | null {
    const row = this.#database
      .prepare(`
        SELECT * FROM revenue_enrollments
        WHERE payout_key = ? AND state = 'active'
        ORDER BY activated_at DESC LIMIT 1
      `)
      .get(payoutKey) as EnrollmentRow | undefined;
    return row ? this.#mapEnrollment(row) : null;
  }

  enrollmentKeyVersions(): number[] {
    const rows = this.#database
      .prepare("SELECT DISTINCT address_key_version AS version FROM revenue_enrollments ORDER BY version")
      .all() as Array<{ version: number }>;
    return rows.map((row) => Number(row.version));
  }

  activeEnrollments(): RevenueEnrollment[] {
    return (this.#database
      .prepare("SELECT * FROM revenue_enrollments WHERE state = 'active'")
      .all() as EnrollmentRow[]).map((row) => this.#mapEnrollment(row));
  }

  staleUncertainPayoutCount(before: number): number {
    const row = this.#database
      .prepare(`
        SELECT COUNT(*) AS amount_msat FROM revenue_payouts
        WHERE state IN ('attempting', 'ambiguous') AND updated_at < ?
      `)
      .get(before) as SumRow;
    return Number(row.amount_msat);
  }

  accountingDivergenceMsat(): number {
    const gross = this.#database
      .prepare("SELECT COALESCE(SUM(amount_msat), 0) AS amount_msat FROM revenue_settlements")
      .get() as SumRow;
    const fees = this.#database
      .prepare(`
        SELECT COALESCE(SUM(fee_msat), 0) AS amount_msat
        FROM revenue_payouts WHERE state = 'succeeded'
      `)
      .get() as SumRow;
    return Number(gross.amount_msat) - Number(fees.amount_msat) - this.totalLedgerMsat();
  }

  wiredRevenueMsat(): number {
    const row = this.#database
      .prepare("SELECT COALESCE(SUM(wired_delta_msat), 0) AS amount_msat FROM revenue_ledger_entries")
      .get() as SumRow;
    return Number(row.amount_msat);
  }

  status(): {
    enrollments: Record<string, number>;
    invoices: Record<string, number>;
    payouts: Record<string, number>;
    creatorAvailableMsat: number;
    creatorReservedMsat: number;
    creatorPaidMsat: number;
    wiredRevenueMsat: number;
  } {
    const counts = (table: string): Record<string, number> => {
      const rows = this.#database.prepare(`SELECT state, COUNT(*) AS count FROM ${table} GROUP BY state`).all() as Array<{
        state: string;
        count: number;
      }>;
      return Object.fromEntries(rows.map((row) => [row.state, Number(row.count)]));
    };
    const balances = this.#database.prepare(`
      SELECT
        COALESCE(SUM(available_delta_msat), 0) AS available_msat,
        COALESCE(SUM(reserved_delta_msat), 0) AS reserved_msat,
        COALESCE(SUM(paid_delta_msat), 0) AS paid_msat
      FROM revenue_ledger_entries
    `).get() as BalanceRow;
    return {
      enrollments: counts("revenue_enrollments"),
      invoices: counts("revenue_invoices"),
      payouts: counts("revenue_payouts"),
      creatorAvailableMsat: Number(balances.available_msat),
      creatorReservedMsat: Number(balances.reserved_msat),
      creatorPaidMsat: Number(balances.paid_msat),
      wiredRevenueMsat: this.wiredRevenueMsat(),
    };
  }

  totalLedgerMsat(): number {
    const row = this.#database
      .prepare(`
        SELECT COALESCE(SUM(
          available_delta_msat + reserved_delta_msat + paid_delta_msat + wired_delta_msat
        ), 0) AS amount_msat
        FROM revenue_ledger_entries
      `)
      .get() as SumRow;
    return Number(row.amount_msat);
  }

  backupTo(filename: string): void {
    if (existsSync(filename)) throw new Error("revenue backup destination already exists");
    mkdirSync(path.dirname(filename), { recursive: true });
    const escaped = filename.replaceAll("'", "''");
    this.#database.exec("PRAGMA wal_checkpoint(FULL)");
    this.#database.exec(`VACUUM INTO '${escaped}'`);
  }

  close(): void {
    this.#database.close();
  }

  #mapEnrollment(row: EnrollmentRow): RevenueEnrollment {
    return {
      enrollmentId: row.enrollment_id,
      eventId: row.event_id,
      event: JSON.parse(row.event_json) as Event,
      postingPath: row.posting_path,
      payoutKey: row.payout_key,
      addressCiphertext: row.address_ciphertext,
      addressIv: row.address_iv,
      addressTag: row.address_tag,
      addressKeyVersion: Number(row.address_key_version),
      state: row.state,
    };
  }

  #mapInvoice(row: InvoiceRow): RevenueInvoice {
    return {
      paymentHash: row.payment_hash,
      zapRequestId: row.zap_request_id,
      eventId: row.event_id,
      rawZapRequest: row.zap_request_json,
      amountMsat: Number(row.amount_msat),
      invoice: row.invoice,
      descriptionHash: row.description_hash,
      state: row.state,
      receipt: row.receipt_json ? (JSON.parse(row.receipt_json) as Event) : null,
      receiptPublished: row.receipt_published_at !== null,
    };
  }

  #mapPayout(row: PayoutRow): RevenuePayout {
    return {
      payoutId: row.payout_id,
      payoutKey: row.payout_key,
      amountMsat: Number(row.amount_msat),
      state: row.state,
      invoice: row.invoice,
      providerPaymentId: row.provider_payment_id,
      feeMsat: row.fee_msat === null ? null : Number(row.fee_msat),
      reason: row.reason,
      nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
