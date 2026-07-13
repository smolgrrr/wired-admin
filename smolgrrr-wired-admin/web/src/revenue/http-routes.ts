import type { Application, Request, Response } from "express";
import type { Event } from "nostr-tools";
import { FakeWallet } from "./fake-wallet.js";
import { RevenueService } from "./service.js";

type RevenueRoutesOptions = {
  service: RevenueService;
  fakeWallet?: FakeWallet;
  isAdminAuthorized: (request: Request) => boolean;
  lnurlUsername: string;
  minSendableMsat: number;
  maxSendableMsat: number;
  backupDirectory?: string;
};

function eventIdFromZapRequest(raw: string): string {
  let value: Event;
  try {
    value = JSON.parse(raw) as Event;
  } catch {
    throw new Error("invalid zap request JSON");
  }
  const eventTags = Array.isArray(value.tags) ? value.tags.filter((tag) => tag[0] === "e") : [];
  if (eventTags.length !== 1 || !eventTags[0]?.[1]) {
    throw new Error("zap request requires exactly one e tag");
  }
  return eventTags[0][1];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "revenue request failed";
}

export function registerRevenueRoutes(app: Application, options: RevenueRoutesOptions): void {
  const { service } = options;

  app.get("/api/revenue/config", (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json(service.publicConfig());
  });

  app.post("/api/revenue/address/validate", async (req: Request, res: Response) => {
    try {
      const result = await service.validateAddress(String(req.body?.address || ""));
      res.json({
        ok: true,
        address: result.address,
        minSendableMsat: result.minSendableMsat,
        maxSendableMsat: result.maxSendableMsat,
      });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/revenue/enroll", (req: Request, res: Response) => {
    try {
      const enrollment = service.enrollEvent({
        event: req.body?.event as Event,
        address: String(req.body?.address || ""),
        postingPath: "browser",
      });
      res.status(201).json({
        ok: true,
        enrollmentId: enrollment.enrollmentId,
        eventId: enrollment.eventId,
        state: enrollment.state,
      });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/revenue/enroll/:id/activate", (req: Request, res: Response) => {
    try {
      const enrollment = service.activateEnrollment(String(req.params.id || ""));
      res.json({ ok: true, eventId: enrollment.eventId, state: enrollment.state });
    } catch (error) {
      res.status(404).json({ error: errorMessage(error) });
    }
  });

  app.post("/api/revenue/enroll/:id/fail", (req: Request, res: Response) => {
    try {
      const enrollment = service.failEnrollment(String(req.params.id || ""));
      res.json({ ok: true, eventId: enrollment.eventId, state: enrollment.state });
    } catch (error) {
      res.status(404).json({ error: errorMessage(error) });
    }
  });

  app.get(`/.well-known/lnurlp/${options.lnurlUsername}`, (_req: Request, res: Response) => {
    const config = service.publicConfig();
    res.setHeader("Cache-Control", "public, max-age=60");
    res.json({
      callback: config.callbackUrl,
      minSendable: options.minSendableMsat,
      maxSendable: options.maxSendableMsat,
      metadata: JSON.stringify([["text/plain", "Zap a Wired post"]]),
      tag: "payRequest",
      allowsNostr: true,
      nostrPubkey: config.recipientPubkey,
    });
  });

  app.get("/api/revenue/zap", async (req: Request, res: Response) => {
    try {
      const rawZapRequest = String(req.query.nostr || "");
      const amountMsat = Number(req.query.amount);
      if (amountMsat < options.minSendableMsat || amountMsat > options.maxSendableMsat) {
        throw new Error("zap amount is outside the configured LNURL bounds");
      }
      const result = await service.createZapInvoice({
        eventId: eventIdFromZapRequest(rawZapRequest),
        amountMsat,
        rawZapRequest,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ pr: result.invoice, routes: [] });
    } catch (error) {
      res.json({ status: "ERROR", reason: errorMessage(error) });
    }
  });

  app.post("/api/revenue/wallet/webhook", async (req: Request, res: Response) => {
    const paymentHash = String(req.body?.payment_hash || req.body?.paymentHash || "");
    if (!paymentHash) {
      res.status(400).json({ error: "payment hash is required" });
      return;
    }
    try {
      await service.reconcileInvoice(paymentHash);
      res.json({ ok: true });
    } catch (error) {
      res.status(202).json({ ok: false, reason: errorMessage(error) });
    }
  });

  app.post("/api/revenue/fake/settle", async (req: Request, res: Response) => {
    if (!options.isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!options.fakeWallet) {
      res.status(404).json({ error: "FakeWallet is not enabled" });
      return;
    }
    try {
      const paymentHash = String(req.body?.paymentHash || "");
      await options.fakeWallet.settleInvoice(paymentHash);
      const result = await service.reconcileInvoice(paymentHash);
      res.json({
        ok: true,
        paymentHash,
        creatorMsat: result.creatorMsat,
        wiredMsat: result.wiredMsat,
        receiptId: result.receipt.id,
      });
    } catch (error) {
      res.status(400).json({ error: errorMessage(error) });
    }
  });

  app.get("/api/revenue/operator/status", (req: Request, res: Response) => {
    if (!options.isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json(service.operatorStatus());
  });

  app.post("/api/revenue/operator/reconcile", async (req: Request, res: Response) => {
    if (!options.isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ ok: true, ...(await service.reconcileAll()) });
  });

  app.post("/api/revenue/operator/backup", (req: Request, res: Response) => {
    if (!options.isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    if (!options.backupDirectory) {
      res.status(503).json({ error: "revenue backup directory is not configured" });
      return;
    }
    try {
      res.status(201).json({ ok: true, ...service.backupTo(options.backupDirectory) });
    } catch (error) {
      res.status(500).json({ error: errorMessage(error) });
    }
  });
}
