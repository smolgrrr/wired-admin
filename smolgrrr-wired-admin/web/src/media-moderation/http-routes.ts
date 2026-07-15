import type { Application, Request, Response } from "express";
import type { MediaModerationService } from "./service.js";
import type { MediaVerdictRequest } from "./contracts.js";

function isMediaVerdictRequest(value: unknown): value is MediaVerdictRequest {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MediaVerdictRequest>;
  return (
    typeof item.requestId === "string" &&
    item.requestId.length > 0 &&
    item.requestId.length <= 512 &&
    (item.mediaType === "image" || item.mediaType === "video") &&
    typeof item.url === "string" &&
    item.url.length > 0 &&
    item.url.length <= 4_096 &&
    (!item.claimedHash || /^[0-9a-f]{64}$/i.test(item.claimedHash)) &&
    Boolean(item.event) &&
    typeof item.event === "object" &&
    typeof item.event.id === "string" &&
    typeof item.event.pubkey === "string" &&
    typeof item.event.sig === "string" &&
    typeof item.event.content === "string" &&
    typeof item.event.created_at === "number" &&
    typeof item.event.kind === "number" &&
    Array.isArray(item.event.tags)
  );
}

export function registerMediaModerationRoutes(
  app: Application,
  {
    service,
    isAdminAuthorized,
  }: {
    service: MediaModerationService;
    isAdminAuthorized: (request: Request) => boolean;
  },
): void {
  const rateLimits = new Map<string, { resetAt: number; batches: number; items: number }>();

  app.get(
    "/api/media-moderation/status",
    (_request: Request, response: Response) => {
      response.setHeader("Cache-Control", "no-store");
      response.json(service.status());
    },
  );

  app.post(
    "/api/media-moderation/verdicts",
    async (request: Request, response: Response) => {
      const items = request.body?.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
        response.status(400).json({ error: "items must contain 1 to 100 attachments" });
        return;
      }
      if (!items.every(isMediaVerdictRequest)) {
        response.status(400).json({ error: "invalid media verdict item" });
        return;
      }
      const now = Date.now();
      if (rateLimits.size > 1_000) {
        for (const [rateKey, rateValue] of rateLimits) {
          if (rateValue.resetAt <= now) rateLimits.delete(rateKey);
        }
      }
      const key = request.ip || request.socket.remoteAddress || "unknown";
      const existing = rateLimits.get(key);
      const rate =
        !existing || existing.resetAt <= now
          ? { resetAt: now + 60_000, batches: 0, items: 0 }
          : existing;
      rate.batches += 1;
      rate.items += items.length;
      rateLimits.set(key, rate);
      if (rate.batches > 30 || rate.items > 300) {
        response.setHeader("Retry-After", String(Math.ceil((rate.resetAt - now) / 1000)));
        response.status(429).json({ error: "media verdict rate limit exceeded" });
        return;
      }

      response.setHeader("Cache-Control", "no-store");
      response.json(await service.getVerdicts(items));
    },
  );

  app.get(
    "/api/media-moderation/admin",
    async (request: Request, response: Response) => {
      if (!isAdminAuthorized(request)) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.json(await service.adminState());
    },
  );

  app.get(
    "/api/media-moderation/audit",
    async (request: Request, response: Response) => {
      if (!isAdminAuthorized(request)) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.json({ entries: await service.getAudit() });
    },
  );

  app.get(
    "/api/media-moderation/overrides",
    async (request: Request, response: Response) => {
      if (!isAdminAuthorized(request)) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.json({ overrides: await service.getOverrides() });
    },
  );

  app.post(
    "/api/media-moderation/overrides",
    async (request: Request, response: Response) => {
      if (!isAdminAuthorized(request)) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      try {
        const override = await service.createOverride(request.body || {});
        response.status(201).json({ override });
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : "invalid override",
        });
      }
    },
  );

  app.delete(
    "/api/media-moderation/overrides/:id",
    async (request: Request, response: Response) => {
      if (!isAdminAuthorized(request)) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      try {
        response.json({
          override: await service.removeOverride(
            request.params.id || "",
            String(request.body?.moderator || ""),
          ),
        });
      } catch (error) {
        response.status(404).json({
          error: error instanceof Error ? error.message : "override not found",
        });
      }
    },
  );

  app.post(
    "/api/media-moderation/rescan",
    async (request: Request, response: Response) => {
      if (!isAdminAuthorized(request)) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      try {
        await service.rescan(
          String(request.body?.url || ""),
          String(request.body?.moderator || ""),
        );
        response.status(202).json({ ok: true });
      } catch (error) {
        response.status(400).json({
          error: error instanceof Error ? error.message : "rescan failed",
        });
      }
    },
  );
}
