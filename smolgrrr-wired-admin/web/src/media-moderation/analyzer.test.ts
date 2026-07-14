import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { createTransientMediaAnalyzer } from "./analyzer.js";
import { fetchRemoteMedia } from "./fetcher.js";
import { createNsfwJsClassifier } from "./local-classifier.js";
import { differenceHash } from "./hashing.js";

test("transient image analysis computes hashes and maps local model signals", async () => {
  const bytes = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const analyzer = createTransientMediaAnalyzer({
    fetcher: async () => ({ bytes, contentType: "image/png" }),
    classifier: {
      version: "fake-model-v1",
      async classify() {
        return [
          { category: "Porn", confidence: 0.97, source: "model" },
          { category: "Neutral", confidence: 0.03, source: "model" },
        ];
      },
    },
    blockThreshold: 0.9,
    reviewThreshold: 0.65,
  });

  const result = await analyzer.analyze({
    eventId: "1".repeat(64),
    mediaType: "image",
    url: "https://cdn.example.com/image.png",
  });

  assert.equal(result.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.match(result.perceptualHash, /^[0-9a-f]{16}$/);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "explicit_media_policy");
  assert.equal(result.signals[0]?.category, "Porn");
});

test("claimed hashes are verified against fetched bytes", async () => {
  const bytes = await sharp({
    create: { width: 16, height: 16, channels: 3, background: "#111111" },
  })
    .jpeg()
    .toBuffer();
  const analyzer = createTransientMediaAnalyzer({
    fetcher: async () => ({ bytes, contentType: "image/jpeg" }),
    classifier: {
      version: "fake-model-v1",
      async classify() {
        return [{ category: "Neutral", confidence: 1, source: "model" }];
      },
    },
  });

  const result = await analyzer.analyze({
    eventId: "2".repeat(64),
    mediaType: "image",
    url: "https://cdn.example.com/image.jpg",
    claimedHash: "f".repeat(64),
  });

  assert.equal(result.status, "review-required");
  assert.equal(result.reason, "claimed_hash_mismatch");
});

test("an exact local hash match blocks without running model inference", async () => {
  const bytes = await sharp({
    create: { width: 24, height: 24, channels: 3, background: "#123456" },
  }).png().toBuffer();
  const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
  let classifications = 0;
  const analyzer = createTransientMediaAnalyzer({
    fetcher: async () => ({ bytes, contentType: "image/png" }),
    exactBlockHashes: [contentHash.toUpperCase()],
    classifier: {
      version: "must-not-run",
      async classify() {
        classifications += 1;
        return [];
      },
    },
  });

  const result = await analyzer.analyze({
    eventId: "3".repeat(64),
    mediaType: "image",
    url: "https://cdn.example.com/exact.png",
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "exact_hash_block");
  assert.equal(result.signals[0]?.source, "exact-hash");
  assert.equal(classifications, 0);
});

test("a nearby local perceptual hash blocks without running model inference", async () => {
  const bytes = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#abcdef" },
  }).png().toBuffer();
  const hash = await differenceHash(bytes);
  const nearby = `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
  let classifications = 0;
  const analyzer = createTransientMediaAnalyzer({
    fetcher: async () => ({ bytes, contentType: "image/png" }),
    perceptualBlockHashes: [nearby],
    perceptualDistance: 4,
    classifier: {
      version: "must-not-run",
      async classify() {
        classifications += 1;
        return [];
      },
    },
  });

  const result = await analyzer.analyze({
    eventId: "4".repeat(64),
    mediaType: "image",
    url: "https://cdn.example.com/similar.png",
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "perceptual_hash_block");
  assert.equal(result.signals[0]?.source, "perceptual-hash");
  assert.equal(classifications, 0);
});

test("remote fetching rejects private destinations before transport", async () => {
  let transportCalls = 0;
  await assert.rejects(
    fetchRemoteMedia("https://images.example/image.jpg", {
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      transport: async () => {
        transportCalls += 1;
        throw new Error("transport must not run");
      },
    }),
    /public address/,
  );
  assert.equal(transportCalls, 0);
});

test("remote fetching revalidates a redirect before contacting its destination", async () => {
  const contacted: string[] = [];
  await assert.rejects(
    fetchRemoteMedia("https://images.example/image.jpg", {
      resolve: async (hostname) => hostname === "images.example"
        ? [{ address: "93.184.216.34", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }],
      transport: async ({ url }) => {
        contacted.push(url.hostname);
        return {
          status: 302,
          location: "http://metadata.internal/latest",
          bytes: Buffer.alloc(0),
          contentType: "text/plain",
        };
      },
    }),
    /public address/,
  );
  assert.deepEqual(contacted, ["images.example"]);
});

test("remote fetching rejects oversized responses from custom transports", async () => {
  await assert.rejects(
    fetchRemoteMedia("https://images.example/image.jpg", {
      maxBytes: 4,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      transport: async () => ({
        status: 200,
        bytes: Buffer.alloc(5),
        contentType: "image/jpeg",
      }),
    }),
    /byte limit/,
  );
});

test("bundled local inference classifies an image without a network model fetch", async () => {
  const bytes = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  const classifier = createNsfwJsClassifier();
  try {
    const signals = await classifier.classify(bytes);
    assert.deepEqual(
      [...signals.map((signal) => signal.category)].sort(),
      ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"].sort(),
    );
    assert.ok(signals.every((signal) => signal.source === "model"));
  } finally {
    await classifier.close?.();
  }
});

test("video analysis blocks when a later representative frame crosses policy", async () => {
  const frameOne = await sharp({
    create: { width: 32, height: 18, channels: 3, background: "#ffffff" },
  }).jpeg().toBuffer();
  const frameTwo = await sharp({
    create: { width: 32, height: 18, channels: 3, background: "#000000" },
  }).jpeg().toBuffer();
  let classifications = 0;
  const analyzer = createTransientMediaAnalyzer({
    fetcher: async () => ({ bytes: Buffer.from("fake-video"), contentType: "video/mp4" }),
    extractVideoFrames: async () => [frameOne, frameTwo],
    classifier: {
      version: "fake-video-model-v1",
      async classify() {
        classifications += 1;
        return classifications === 2
          ? [{ category: "Porn", confidence: 0.96, source: "model" }]
          : [{ category: "Neutral", confidence: 0.99, source: "model" }];
      },
    },
  });

  const result = await analyzer.analyze({
    eventId: "4".repeat(64),
    mediaType: "video",
    url: "https://cdn.example.com/video.mp4",
  });

  assert.equal(classifications, 2);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "explicit_media_policy");
  assert.equal(result.sha256, crypto.createHash("sha256").update("fake-video").digest("hex"));
});
