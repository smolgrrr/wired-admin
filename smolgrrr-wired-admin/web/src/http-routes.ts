import crypto from "node:crypto";
import express from "express";
import type { Application, NextFunction, Request, Response } from "express";
import { getPublicKey } from "nostr-tools";
import type {
  ConfessStatusFromStore,
  ConfessXStatus,
  CreateConfessionResponse,
  CreateWiredAccountPostResponse,
  HttpError,
  RelayInfo,
  RelayStats,
  WiredAccountStatusFromStore,
} from "./contracts/api.js";
import type { ConfessPostcardRenderResult } from "./confess-postcard-renderer.js";
import type { FeedSnapshotService } from "./feed-snapshot-service.js";
import type { ModerationService } from "./moderation.js";
import type { ConfessStore, WiredAccountStore } from "./contracts/stores.js";

type ConfessXConfigForRoutes = {
  enabled: boolean;
  dryRun: boolean;
  accountHandle: string;
};

type RegisterHttpRoutesDeps = {
  backendUrl: string;
  buildConfessXPostText: (content: unknown) => string;
  confessContentMaxLength: number;
  confessRelays: string[];
  confessStoreFile: string;
  confessXConfig: ConfessXConfigForRoutes;
  confessXImageHeight: number;
  confessXImageTemplate: string;
  confessXImageWidth: number;
  confessXAuthMode: () => string;
  confessXConfigured: () => boolean;
  confessXStatusFromStore: (store: ConfessStore) => ConfessXStatus & Record<string, unknown>;
  confessStatusFromStore: ConfessStatusFromStore;
  createWiredAccountPost: (
    event: unknown,
    payoutAddress?: string,
  ) => Promise<Omit<CreateWiredAccountPostResponse, "ok">>;
  createConfession: (event: unknown) => Promise<Omit<CreateConfessionResponse, "ok">>;
  feedSnapshot: FeedSnapshotService;
  isAdminAuthorized: (req: Request) => boolean;
  isCronAuthorized: (req: Request) => boolean;
  moderation: ModerationService;
  moderationStoreFile: string;
  parseConfessSecretKey: () => Uint8Array | null;
  publicDir: string;
  readConfessStore: () => Promise<ConfessStore>;
  readWiredAccountStore: () => Promise<WiredAccountStore>;
  relayInfo: RelayInfo;
  renderConfessXImage: (input: {
    text: string;
    eventId: string;
    pubkey: string;
    customEmojis?: { shortcode: string; url: string }[];
  }) => Promise<ConfessPostcardRenderResult>;
  stats: RelayStats;
  wiredAccountStatusFromStore: WiredAccountStatusFromStore;
  wiredAccountStoreFile: string;
};

export function registerHttpRoutes(app: Application, deps: RegisterHttpRoutesDeps): void {
  const {
    backendUrl,
    buildConfessXPostText,
    confessContentMaxLength,
    confessRelays,
    confessStoreFile,
    confessXConfig,
    confessXImageHeight,
    confessXImageTemplate,
    confessXImageWidth,
    confessXAuthMode,
    confessXConfigured,
    confessXStatusFromStore,
    createWiredAccountPost,
    createConfession,
    feedSnapshot,
    isAdminAuthorized,
    isCronAuthorized,
    moderation,
    moderationStoreFile,
    parseConfessSecretKey,
    publicDir,
    readConfessStore,
    readWiredAccountStore,
    relayInfo,
    renderConfessXImage,
    stats,
    wiredAccountStatusFromStore,
    wiredAccountStoreFile,
  } = deps;

  app.get("/api/status", async (_req: Request, res: Response) => {
    const actions = await moderation.getActions();
    const manifest = moderation.manifestFromActions(actions);
    const confessStore = await readConfessStore();
    const wiredAccountStore = await readWiredAccountStore();
    const confessSecretKey = parseConfessSecretKey();
    res.json({
      ...stats,
      uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
      relayInfo,
      snapshot: feedSnapshot.status(),
      confess: {
        ...deps.confessStatusFromStore(confessStore),
        storeFile: confessStoreFile,
        relays: confessRelays,
        linkedPubkey: confessSecretKey ? getPublicKey(confessSecretKey) : null,
        xMirror: confessXStatusFromStore(confessStore),
      },
      wiredAccount: {
        ...wiredAccountStatusFromStore(wiredAccountStore),
        storeFile: wiredAccountStoreFile,
      },
      moderation: {
        actionCount: actions.length,
        manifest,
        storeFile: moderationStoreFile,
      },
      generatedAt: Date.now(),
      instanceId: crypto
        .createHash("sha256")
        .update(`${stats.startedAt}:${backendUrl}`)
        .digest("hex")
        .slice(0, 12),
    });
  });

  app.get("/api/feed/bootstrap", async (_req: Request, res: Response) => {
    res.setHeader(
      "Cache-Control",
      "public, max-age=60, s-maxage=120, stale-while-revalidate=600",
    );
    const currentSnapshot = feedSnapshot.current();
    if (currentSnapshot) {
      res.json(currentSnapshot);
      return;
    }

    try {
      res.json(await feedSnapshot.refresh());
    } catch {
      res.status(503).json({
        error: "bootstrap unavailable",
        lastRefreshError: feedSnapshot.lastRefreshError(),
      });
    }
  });

  app.get("/api/cron/refresh-feed", async (req: Request, res: Response) => {
    if (!isCronAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const nextSnapshot = await feedSnapshot.refresh();
      res.json({
        ok: true,
        fetchedAt: nextSnapshot.fetchedAt,
        postCount: nextSnapshot.processedEvents.length,
        profileCount: Object.keys(nextSnapshot.profiles).length,
      });
    } catch {
      res.status(500).json({ error: feedSnapshot.lastRefreshError() || "refresh failed" });
    }
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(feedSnapshot.current() ? 200 : 503).json({
      ok: Boolean(feedSnapshot.current()),
      ...feedSnapshot.status(),
    });
  });

  app.get("/api/confess/status", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    const store = await readConfessStore();
    res.json({
      ...deps.confessStatusFromStore(store),
      xMirror: {
        enabled: confessXConfig.enabled,
        dryRun: confessXConfig.dryRun,
        configured: confessXConfigured(),
        authMode: confessXAuthMode(),
        accountHandle: confessXConfig.accountHandle || null,
        postMode: "image",
        image: {
          width: confessXImageWidth,
          height: confessXImageHeight,
          template: confessXImageTemplate,
        },
      },
    });
  });

  app.get("/api/wired-account/status", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(wiredAccountStatusFromStore(await readWiredAccountStore()));
  });

  app.post("/api/wired-account/posts", async (req: Request, res: Response) => {
    try {
      const result = await createWiredAccountPost(
        req.body?.event,
        typeof req.body?.payoutAddress === "string" ? req.body.payoutAddress : undefined,
      );
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      const httpError = error as HttpError;
      const statusCode =
        typeof httpError.statusCode === "number" ? httpError.statusCode : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : "wired account publish failed",
        pow: typeof httpError.pow === "number" ? httpError.pow : undefined,
      });
    }
  });

  app.get("/api/confess/x-image-preview", async (req: Request, res: Response) => {
    try {
      const secretKey = parseConfessSecretKey();
      const text = String(
        req.query.text ||
          "some things are easier to say when the signal does not point back at you.",
      ).slice(0, confessContentMaxLength);
      const eventId = crypto.createHash("sha256").update(`preview:${text}`).digest("hex");
      const rendered = await renderConfessXImage({
        text: buildConfessXPostText(text),
        eventId,
        pubkey: secretKey ? getPublicKey(secretKey) : "preview",
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "image/png");
      res.setHeader("X-Confess-Image-Hash", rendered.imageHash);
      res.setHeader("X-Confess-Image-Bytes", String(rendered.imageBytes));
      res.send(rendered.buffer);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : "image preview failed",
      });
    }
  });

  app.post("/api/confess", async (req: Request, res: Response) => {
    try {
      const result = await createConfession(req.body?.event);
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      const httpError = error as HttpError;
      const statusCode =
        typeof httpError.statusCode === "number" ? httpError.statusCode : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : "confess failed",
        pow: typeof httpError.pow === "number" ? httpError.pow : undefined,
      });
    }
  });

  app.get("/api/moderation/manifest", async (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
    res.json(await moderation.getManifest());
  });

  app.get("/api/moderation/actions", async (req: Request, res: Response) => {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ actions: await moderation.getActions() });
  });

  app.post("/api/moderation/actions", async (req: Request, res: Response) => {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const action = await moderation.createAction(req.body || {});
      void feedSnapshot.refresh().catch(() => {
        console.error(feedSnapshot.lastRefreshError() || "moderation refresh failed");
      });
      res.status(201).json({ action });
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "invalid action",
      });
    }
  });

  app.delete("/api/moderation/actions/:id", async (req: Request, res: Response) => {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const actionId = req.params.id;
      if (!actionId) {
        res.status(404).json({ error: "not found" });
        return;
      }
      const action = await moderation.deleteAction(actionId);
      void feedSnapshot.refresh().catch(() => {
        console.error(feedSnapshot.lastRefreshError() || "moderation refresh failed");
      });
      res.json({ action });
    } catch (error) {
      res.status(404).json({
        error: error instanceof Error ? error.message : "not found",
      });
    }
  });

  app.get("/", (req: Request, res: Response, next: NextFunction) => {
    const accept = String(req.headers.accept || "");
    if (accept.includes("application/nostr+json")) {
      res.type("application/nostr+json").json(relayInfo);
      return;
    }
    next();
  });

  app.use(
    express.static(publicDir, {
      extensions: ["html"],
      setHeaders(res, path) {
        if (path.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-store");
        }
      },
    }),
  );
}
