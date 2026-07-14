import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { finalizeEvent } from "nostr-tools";
import { createMediaModerationService } from "./service.js";
import { registerMediaModerationRoutes } from "./http-routes.js";
import { createModerationService } from "../moderation.js";

test("the public verdict route rejects malformed attachment batches", async () => {
  const app = express();
  app.use(express.json());
  registerMediaModerationRoutes(app, {
    service: {
      getVerdicts: async () => {
        throw new Error("malformed requests must not reach the service");
      },
    } as unknown as ReturnType<typeof createMediaModerationService>,
    isAdminAuthorized: () => false,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/media-moderation/verdicts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ requestId: "broken", mediaType: "image" }] }),
      },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid media verdict item" });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("batched verdicts apply a manual media URL block before analysis", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "wired-media-moderation-"),
  );
  const moderation = createModerationService(
    path.join(temporaryDirectory, "moderation.json"),
  );
  const mediaUrl = "https://cdn.example.com/blocked.jpg";
  await moderation.createAction({
    kind: "block_media_url",
    value: mediaUrl,
    reason: "manual",
    moderator: "test-admin",
  });
  let analyzeCalls = 0;
  const service = createMediaModerationService({
    mode: "enforce",
    moderation,
    storeFile: path.join(temporaryDirectory, "media-moderation.json"),
    analyzer: {
      version: "fake-v1",
      async analyze() {
        analyzeCalls += 1;
        throw new Error("manual blocks must not reach analysis");
      },
    },
  });
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: 1_700_000_000,
      tags: [["imeta", `url ${mediaUrl}`, "m image/jpeg"]],
      content: mediaUrl,
    },
    new Uint8Array(32).fill(7),
  );
  const app = express();
  app.use(express.json());
  registerMediaModerationRoutes(app, {
    service,
    isAdminAuthorized: () => false,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/media-moderation/verdicts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [
            {
              requestId: "attachment-1",
              event,
              mediaType: "image",
              url: mediaUrl,
            },
          ],
        }),
      },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      mode: "enforce",
      policyVersion: "wired-media-v1",
      verdicts: [
        {
          requestId: "attachment-1",
          eventId: event.id,
          url: mediaUrl,
          mediaType: "image",
          status: "blocked",
          reason: "manual_url_block",
          expiresAt: null,
        },
      ],
    });
    assert.equal(analyzeCalls, 0);
  } finally {
    await service.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("an uncached verdict becomes content-bound and survives a service restart", async () => {
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "wired-media-cache-"),
  );
  const storeFile = path.join(temporaryDirectory, "media-moderation.json");
  const moderation = createModerationService(
    path.join(temporaryDirectory, "moderation.json"),
  );
  const mediaUrl = "https://cdn.example.com/allowed.jpg";
  const event = finalizeEvent(
    {
      kind: 1,
      created_at: 1_700_000_001,
      tags: [["imeta", `url ${mediaUrl}`, "m image/jpeg"]],
      content: `photo ${mediaUrl}`,
    },
    new Uint8Array(32).fill(8),
  );
  let analyzeCalls = 0;
  const firstService = createMediaModerationService({
    mode: "enforce",
    moderation,
    storeFile,
    analyzer: {
      version: "fake-v2",
      async analyze() {
        analyzeCalls += 1;
        return {
          sha256: "a".repeat(64),
          perceptualHash: "0123456789abcdef",
          signals: [],
          status: "allowed",
          reason: "policy_allowed",
        };
      },
    },
  });

  const request = {
    requestId: "attachment-2",
    event,
    mediaType: "image" as const,
    url: mediaUrl,
  };

  try {
    const pending = await firstService.getVerdicts([request]);
    assert.equal(pending.verdicts[0]?.status, "pending");
    const completed = await firstService.waitForIdle();
    assert.equal(completed, true);
    const allowed = await firstService.getVerdicts([request]);
    assert.deepEqual(allowed.verdicts[0], {
      requestId: "attachment-2",
      eventId: event.id,
      url: mediaUrl,
      mediaType: "image",
      status: "allowed",
      reason: "policy_allowed",
      expiresAt: allowed.verdicts[0]?.expiresAt,
      checkedAt: allowed.verdicts[0]?.checkedAt,
      detectorVersion: "fake-v2",
      sha256: "a".repeat(64),
      perceptualHash: "0123456789abcdef",
    });
    assert.equal(analyzeCalls, 1);
    await firstService.close();

    const restartedService = createMediaModerationService({
      mode: "enforce",
      moderation,
      storeFile,
      analyzer: {
        version: "must-not-run",
        async analyze() {
          throw new Error("cached verdict should survive restart");
        },
      },
    });
    try {
      const cached = await restartedService.getVerdicts([request]);
      assert.equal(cached.verdicts[0]?.status, "allowed");
      assert.equal(cached.verdicts[0]?.sha256, "a".repeat(64));
    } finally {
      await restartedService.close();
    }
  } finally {
    await firstService.close();
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("an authorized audited allow override reverses an automatic block", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "wired-media-override-"));
  const moderation = createModerationService(path.join(temporaryDirectory, "moderation.json"));
  const mediaUrl = "https://cdn.example.com/false-positive.jpg";
  const event = finalizeEvent({
    kind: 1,
    created_at: 1_700_000_002,
    tags: [["imeta", `url ${mediaUrl}`, "m image/jpeg"]],
    content: mediaUrl,
  }, new Uint8Array(32).fill(9));
  const service = createMediaModerationService({
    mode: "enforce",
    moderation,
    storeFile: path.join(temporaryDirectory, "media-moderation.json"),
    analyzer: {
      version: "fake-blocker-v1",
      async analyze() {
        return {
          sha256: "c".repeat(64),
          perceptualHash: "fedcba9876543210",
          signals: [{ category: "Porn", confidence: 0.99, source: "model" }],
          status: "blocked",
          reason: "explicit_media_policy",
        };
      },
    },
  });
  const app = express();
  app.use(express.json());
  registerMediaModerationRoutes(app, {
    service,
    isAdminAuthorized: (request) => request.headers["x-admin-token"] === "secret",
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const item = {
    requestId: "attachment-3",
    event,
    mediaType: "image" as const,
    url: mediaUrl,
  };

  try {
    assert.equal((await service.getVerdicts([item])).verdicts[0]?.status, "pending");
    await service.waitForIdle();
    assert.equal((await service.getVerdicts([item])).verdicts[0]?.status, "blocked");

    const unauthorized = await fetch(`${baseUrl}/api/media-moderation/overrides`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetType: "sha256", target: "c".repeat(64), decision: "allowed" }),
    });
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${baseUrl}/api/media-moderation/overrides`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Token": "secret" },
      body: JSON.stringify({
        targetType: "sha256",
        target: "c".repeat(64),
        decision: "allowed",
        moderator: "safety-admin",
        note: "reviewed false positive",
      }),
    });
    assert.equal(response.status, 201);
    assert.equal((await service.getVerdicts([item])).verdicts[0]?.status, "allowed");
    assert.equal(
      (await service.getVerdicts([item])).verdicts[0]?.reason,
      "admin_allow_override",
    );

    const auditResponse = await fetch(`${baseUrl}/api/media-moderation/audit`, {
      headers: { "X-Admin-Token": "secret" },
    });
    assert.equal(auditResponse.status, 200);
    const audit = (await auditResponse.json()) as { entries: Array<Record<string, unknown>> };
    assert.equal(audit.entries[0]?.actor, "safety-admin");
    assert.equal(audit.entries[0]?.action, "override_created");
  } finally {
    await service.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
