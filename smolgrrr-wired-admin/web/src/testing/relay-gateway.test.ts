import assert from "node:assert/strict";
import test from "node:test";
import { finalizeEvent } from "nostr-tools";
import WebSocket, { WebSocketServer } from "ws";
import type { RelayStats } from "../contracts/api.js";
import { createRelayGateway } from "../relay-gateway.js";
import {
  RelayTranscriptHarness,
  RelayTranscriptSession,
} from "./relay-transcript.js";

const event = finalizeEvent({
  created_at: 1_700_000_000,
  kind: 1,
  tags: [["nonce", "0", "0"]],
  content: "gateway publish transcript",
}, new Uint8Array(32).fill(4));

function createStats(backendUrl: string): RelayStats {
  return {
    startedAt: Date.now(),
    backendUrl,
    minPow: 0,
    activeClients: 0,
    totalConnections: 0,
    clientMessages: 0,
    backendMessages: 0,
    publishAttempts: 0,
    acceptedPublishes: 0,
    powRejectedPublishes: 0,
    backendRejectedPublishes: 0,
    malformedMessages: 0,
    reqMessages: 0,
    closeMessages: 0,
    lastBackendOpenAt: null,
    lastBackendErrorAt: null,
    recent: [],
  };
}

async function listenGateway(
  backendUrl: string,
  minPow: number,
  stats: RelayStats,
): Promise<{ server: WebSocketServer; url: string }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  server.on("connection", createRelayGateway({
    backendUrl,
    minPow,
    stats,
    addRecent() {},
  }));
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, url: `ws://127.0.0.1:${address.port}` };
}

function openClient(url: string): Promise<WebSocket> {
  const client = new WebSocket(url);
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

function nextMessage(client: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    client.once("message", (data) => resolve(JSON.parse(data.toString())));
    client.once("error", reject);
  });
}

async function closeServer(server: WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("relay gateway forwards an accepted EVENT and returns its backend ACK", async () => {
  const session = new RelayTranscriptSession();
  const backend = await RelayTranscriptHarness.listen({
    session,
    onPublish(publish) {
      publish.acknowledge(true);
    },
  });
  const stats = createStats(backend.url);
  const gateway = await listenGateway(backend.url, 0, stats);
  const client = await openClient(gateway.url);

  try {
    const workflow = session.beginWorkflow("gateway-publish-accepted");
    const acknowledgement = nextMessage(client);
    client.send(JSON.stringify(["EVENT", event]));
    assert.deepEqual(await acknowledgement, ["OK", event.id, true, ""]);
    workflow.complete();

    const summary = session.summary(workflow);
    assert.equal(summary.openedConnections, 1);
    assert.equal(summary.publishes, 1);
    assert.equal(summary.acknowledgements, 1);
    assert.equal(summary.rejections, 0);
    assert.equal(summary.relayFanout, 1);
    assert.equal(stats.publishAttempts, 1);
    assert.equal(stats.acceptedPublishes, 1);
  } finally {
    client.close();
    await backend.close();
    await closeServer(gateway.server);
  }
});

test("relay gateway rejects insufficient PoW without forwarding EVENT", async () => {
  const session = new RelayTranscriptSession();
  const backend = await RelayTranscriptHarness.listen({ session });
  const stats = createStats(backend.url);
  const gateway = await listenGateway(backend.url, 256, stats);
  const client = await openClient(gateway.url);

  try {
    const workflow = session.beginWorkflow("gateway-publish-pow-rejected");
    const acknowledgement = nextMessage(client);
    client.send(JSON.stringify(["EVENT", event]));
    const message = await acknowledgement;
    workflow.complete();

    assert.ok(Array.isArray(message));
    assert.deepEqual(message.slice(0, 3), ["OK", event.id, false]);
    assert.equal(session.summary(workflow).publishes, 0);
    assert.equal(stats.publishAttempts, 1);
    assert.equal(stats.powRejectedPublishes, 1);
  } finally {
    client.close();
    await backend.close();
    await closeServer(gateway.server);
  }
});
