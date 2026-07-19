import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installGracefulShutdown } from "../server-shutdown.js";

test("graceful shutdown cancels owned work before closing upgraded clients and HTTP", () => {
  const events: string[] = [];
  const signalSource = new EventEmitter();
  const serverEvents = new EventEmitter();
  const server = {
    close() {
      events.push("http-close");
      serverEvents.emit("close");
    },
    closeAllConnections() {
      events.push("http-force-close");
    },
    once: serverEvents.once.bind(serverEvents),
    off: serverEvents.off.bind(serverEvents),
  };
  const webSockets = {
    clients: new Set([
      { terminate: () => events.push("websocket-terminate") },
    ]),
    close() {
      events.push("websocket-close");
    },
  };

  installGracefulShutdown({
    server,
    webSockets,
    onShutdown: () => events.push("owned-work-cancel"),
    signalSource,
  });
  signalSource.emit("SIGTERM");
  signalSource.emit("SIGINT");

  assert.deepEqual(events, [
    "owned-work-cancel",
    "websocket-terminate",
    "websocket-close",
    "http-close",
  ]);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});

test("graceful shutdown force-closes connections after its bound", async () => {
  const events: string[] = [];
  const signalSource = new EventEmitter();
  const serverEvents = new EventEmitter();
  let resolveForced!: () => void;
  const forced = new Promise<void>((resolve) => {
    resolveForced = resolve;
  });

  installGracefulShutdown({
    server: {
      close: () => events.push("http-close"),
      closeAllConnections: () => {
        events.push("http-force-close");
        resolveForced();
      },
      once: serverEvents.once.bind(serverEvents),
      off: serverEvents.off.bind(serverEvents),
    },
    webSockets: {
      clients: new Set([
        { terminate: () => events.push("websocket-terminate") },
      ]),
      close: () => events.push("websocket-close"),
    },
    onShutdown: () => events.push("owned-work-cancel"),
    forceAfterMs: 0,
    signalSource,
  });
  signalSource.emit("SIGINT");
  await forced;

  assert.deepEqual(events, [
    "owned-work-cancel",
    "websocket-terminate",
    "websocket-close",
    "http-close",
    "websocket-terminate",
    "http-force-close",
  ]);
  serverEvents.emit("close");
});
