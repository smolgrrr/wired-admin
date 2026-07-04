import crypto from "node:crypto";
import express from "express";
import { getPublicKey } from "nostr-tools";

export function registerHttpRoutes(app, deps) {
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
    createConfession,
    feedSnapshot,
    isAdminAuthorized,
    isCronAuthorized,
    moderation,
    moderationStoreFile,
    parseConfessSecretKey,
    publicDir,
    readConfessStore,
    relayInfo,
    renderConfessXImage,
    stats,
  } = deps;

  app.get("/api/status", async (_req, res) => {
    const actions = await moderation.getActions();
    const manifest = moderation.manifestFromActions(actions);
    const confessStore = await readConfessStore();
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

  app.get("/api/feed/bootstrap", async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=120, stale-while-revalidate=300");
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

  app.get("/api/cron/refresh-feed", async (req, res) => {
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

  app.get("/healthz", (_req, res) => {
    res.status(feedSnapshot.current() ? 200 : 503).json({
      ok: Boolean(feedSnapshot.current()),
      ...feedSnapshot.status(),
    });
  });

  app.get("/api/confess/status", async (_req, res) => {
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

  app.get("/api/confess/x-image-preview", async (req, res) => {
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

  app.post("/api/confess", async (req, res) => {
    try {
      const result = await createConfession(req.body?.event);
      res.status(201).json({ ok: true, ...result });
    } catch (error) {
      const statusCode =
        typeof error?.statusCode === "number" ? error.statusCode : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : "confess failed",
        pow: typeof error?.pow === "number" ? error.pow : undefined,
      });
    }
  });

  app.get("/api/moderation/manifest", async (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=45");
    res.json(await moderation.getManifest());
  });

  app.get("/api/moderation/actions", async (req, res) => {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    res.json({ actions: await moderation.getActions() });
  });

  app.post("/api/moderation/actions", async (req, res) => {
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

  app.delete("/api/moderation/actions/:id", async (req, res) => {
    if (!isAdminAuthorized(req)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    try {
      const action = await moderation.deleteAction(req.params.id);
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

  app.get("/", (req, res, next) => {
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
      setHeaders(res) {
        res.setHeader("Cache-Control", "no-store");
      },
    }),
  );
}
