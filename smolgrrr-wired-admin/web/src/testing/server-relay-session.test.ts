import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { finalizeEvent, Relay, type Event, type Filter } from "nostr-tools";
import {
  withFiniteRelaySession,
  type QueryCompletion,
} from "../server-relay-session.js";
import {
  RelayTranscriptHarness,
  RelayTranscriptSession,
} from "./relay-transcript.js";

type SubscriptionCallbacks = {
  onevent?: (event: Event) => void;
  oneose?: () => void;
  onclose?: (reason: string) => void;
};

function controlledRelay(url: string) {
  const callbacks: SubscriptionCallbacks[] = [];
  const subscriptions: Array<{ closeCalls: number; close: () => void }> = [];
  const relay = {
    url,
    connected: true,
    closeCalls: 0,
    close() {
      this.closeCalls += 1;
      this.connected = false;
    },
    subscribe(_filters: Filter[], params: SubscriptionCallbacks) {
      callbacks.push(params);
      const subscription = {
        closeCalls: 0,
        close() {
          this.closeCalls += 1;
        },
      };
      subscriptions.push(subscription);
      return subscription;
    },
  };
  return { callbacks, relay, subscriptions };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function mockConnections(
  connect: (url: string) => Promise<unknown>,
): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const replacement = mock.method(
    Relay,
    "connect",
    (url: string) => {
      calls.push(url);
      return connect(url);
    },
  );
  return { calls, restore: () => replacement.mock.restore() };
}

test("finite relay session normalizes targets, reuses connections, and closes once", async () => {
  const target = controlledRelay("wss://one.example/");
  const connectionMock = mockConnections(async () => target.relay);
  try {
    const outcomes = await withFiniteRelaySession(
      {
        relayUrls: ["WSS://ONE.EXAMPLE", "wss://one.example/"],
        connectDeadlineMs: 100,
      },
      (session) => session.ensureRelays(["wss://one.example"], 100),
    );

    assert.deepEqual(connectionMock.calls, ["wss://one.example/"]);
    assert.deepEqual(outcomes, [
      { relayUrl: "wss://one.example/", state: "connected" },
    ]);
    assert.equal(target.relay.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session reports a connect deadline and closes a late relay", async () => {
  const target = controlledRelay("wss://late.example/");
  const connection = deferred<unknown>();
  const connectionMock = mockConnections(() => connection.promise);
  try {
    const operation = withFiniteRelaySession(
      { relayUrls: [target.relay.url], connectDeadlineMs: 15 },
      (session) => session.ensureRelays([target.relay.url], 15),
    );

    assert.deepEqual(await operation, [
      { relayUrl: target.relay.url, state: "timed-out" },
    ]);
    connection.resolve(target.relay);
    await nextTurn();

    assert.equal(target.relay.closeCalls, 1);
    assert.equal(target.subscriptions.length, 0);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session preserves partial success and explicit failed targets", async () => {
  const connected = controlledRelay("wss://connected.example/");
  const failedUrl = "wss://offline.example/";
  const connectionMock = mockConnections((url) =>
    url === connected.relay.url
      ? Promise.resolve(connected.relay)
      : Promise.reject(new Error("offline")),
  );
  try {
    const result = await withFiniteRelaySession(
      {
        relayUrls: [connected.relay.url, failedUrl],
        connectDeadlineMs: 100,
      },
      async (session) => {
        const query = session.query({
          filters: [{ kinds: [1] }],
          deadlineMs: 100,
          onEvent() {},
        });
        connected.callbacks[0]?.oneose?.();
        return query;
      },
    );

    assert.deepEqual(result, {
      reason: "settled",
      targets: [
        { relayUrl: connected.relay.url, state: "eose" },
        { relayUrl: failedUrl, state: "connect-failed" },
      ],
      receivedEvents: 0,
    });
    assert.equal(connected.subscriptions[0]?.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session settles immediately when every connection fails", async () => {
  const urls = ["wss://one.example/", "wss://two.example/"];
  const connectionMock = mockConnections(() =>
    Promise.reject(new Error("offline")),
  );
  try {
    const result = await withFiniteRelaySession(
      { relayUrls: urls, connectDeadlineMs: 100 },
      (session) =>
        session.query({
          filters: [{ kinds: [1] }],
          deadlineMs: 100,
          onEvent() {},
        }),
    );

    assert.deepEqual(result, {
      reason: "settled",
      targets: urls.map((relayUrl) => ({
        relayUrl,
        state: "connect-failed",
      })),
      receivedEvents: 0,
    });
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session streams events and settles terminal relay closure", async () => {
  const first = controlledRelay("wss://one.example/");
  const second = controlledRelay("wss://two.example/");
  const connectionMock = mockConnections(async (url) =>
    url === first.relay.url ? first.relay : second.relay,
  );
  try {
    const received: Array<{ id: string; relayUrl: string }> = [];
    const event = { id: "1".repeat(64) } as Event;
    const result = await withFiniteRelaySession(
      {
        relayUrls: [first.relay.url, second.relay.url],
        connectDeadlineMs: 100,
      },
      async (session) => {
        const query = session.query({
          filters: [{ kinds: [1] }],
          deadlineMs: 100,
          onEvent: (nextEvent, relayUrl) =>
            received.push({ id: nextEvent.id, relayUrl }),
        });
        first.callbacks[0]?.onevent?.(event);
        first.callbacks[0]?.oneose?.();
        second.callbacks[0]?.onclose?.("relay closed");
        return query;
      },
    );

    assert.deepEqual(received, [{ id: event.id, relayUrl: first.relay.url }]);
    assert.deepEqual(result, {
      reason: "settled",
      targets: [
        { relayUrl: first.relay.url, state: "eose" },
        { relayUrl: second.relay.url, state: "closed" },
      ],
      receivedEvents: 1,
    });
    assert.equal(first.subscriptions[0]?.closeCalls, 1);
    assert.equal(second.subscriptions[0]?.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session cleans a subscription that reaches EOSE during setup", async () => {
  const target = controlledRelay("wss://synchronous.example/");
  target.relay.subscribe = (_filters, params) => {
    const subscription = {
      closeCalls: 0,
      close() {
        this.closeCalls += 1;
      },
    };
    target.subscriptions.push(subscription);
    params.oneose?.();
    return subscription;
  };
  const connectionMock = mockConnections(async () => target.relay);
  try {
    const result = await withFiniteRelaySession(
      { relayUrls: [target.relay.url], connectDeadlineMs: 100 },
      (session) =>
        session.query({
          filters: [{ kinds: [1] }],
          deadlineMs: 100,
          onEvent() {},
        }),
    );

    assert.deepEqual(result.targets, [
      { relayUrl: target.relay.url, state: "eose" },
    ]);
    assert.equal(target.subscriptions[0]?.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session times out no-EOSE targets only after subscription cleanup", async () => {
  const target = controlledRelay("wss://silent.example/");
  const connectionMock = mockConnections(async () => target.relay);
  try {
    const result = await withFiniteRelaySession(
      { relayUrls: [target.relay.url], connectDeadlineMs: 100 },
      (session) =>
        session.query({
          filters: [{ kinds: [1] }],
          deadlineMs: 15,
          onEvent() {},
        }),
    );

    assert.deepEqual(result, {
      reason: "deadline",
      targets: [{ relayUrl: target.relay.url, state: "timed-out" }],
      receivedEvents: 0,
    });
    assert.equal(target.subscriptions[0]?.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session cancellation cleans first and ignores later events", async () => {
  const target = controlledRelay("wss://cancelled.example/");
  const connectionMock = mockConnections(async () => target.relay);
  try {
    const controller = new AbortController();
    const received: string[] = [];
    const result = await withFiniteRelaySession(
      { relayUrls: [target.relay.url], connectDeadlineMs: 100 },
      async (session) => {
        const query = session.query({
          filters: [{ kinds: [1] }],
          deadlineMs: 100,
          signal: controller.signal,
          onEvent: (event) => received.push(event.id),
        });
        controller.abort();
        target.callbacks[0]?.onevent?.({ id: "2".repeat(64) } as Event);
        return query;
      },
    );

    assert.deepEqual(result, {
      reason: "cancelled",
      targets: [{ relayUrl: target.relay.url, state: "cancelled" }],
      receivedEvents: 0,
    });
    assert.deepEqual(received, []);
    assert.equal(target.subscriptions[0]?.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session adds dynamic hints and reuses them across phases", async () => {
  const configured = controlledRelay("wss://configured.example/");
  const hinted = controlledRelay("wss://hinted.example/");
  const connectionMock = mockConnections(async (url) =>
    url === configured.relay.url ? configured.relay : hinted.relay,
  );
  try {
    const result = await withFiniteRelaySession(
      { relayUrls: [configured.relay.url], connectDeadlineMs: 100 },
      async (session) => {
        const hintOutcomes = await session.ensureRelays(
          [hinted.relay.url, "WSS://HINTED.EXAMPLE"],
          100,
        );
        const firstQuery = session.query({
          filters: [{ ids: ["1".repeat(64)] }],
          relayUrls: [configured.relay.url, hinted.relay.url],
          deadlineMs: 100,
          onEvent() {},
        });
        configured.callbacks[0]?.oneose?.();
        hinted.callbacks[0]?.oneose?.();
        const firstCompletion = await firstQuery;

        const secondQuery = session.query({
          filters: [{ ids: ["2".repeat(64)] }],
          relayUrls: [hinted.relay.url],
          deadlineMs: 100,
          onEvent() {},
        });
        hinted.callbacks[1]?.oneose?.();
        return {
          firstCompletion,
          hintOutcomes,
          secondCompletion: await secondQuery,
        };
      },
    );

    assert.deepEqual(connectionMock.calls, [configured.relay.url, hinted.relay.url]);
    assert.deepEqual(result.hintOutcomes, [
      { relayUrl: hinted.relay.url, state: "connected" },
    ]);
    assert.equal(result.firstCompletion.reason, "settled");
    assert.equal(result.secondCompletion.reason, "settled");
    assert.equal(hinted.subscriptions.length, 2);
    assert.equal(hinted.relay.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session scope abort cancels active work and closes the socket", async () => {
  const target = controlledRelay("wss://scope-cancelled.example/");
  const connectionMock = mockConnections(async () => target.relay);
  try {
    const controller = new AbortController();
    let completion: QueryCompletion | undefined;
    await withFiniteRelaySession(
      {
        relayUrls: [target.relay.url],
        connectDeadlineMs: 100,
        signal: controller.signal,
      },
      async (session) => {
        const query = session.query({
          filters: [{ kinds: [1] }],
          deadlineMs: 100,
          onEvent() {},
        });
        controller.abort();
        completion = await query;
      },
    );

    assert.deepEqual(completion, {
      reason: "cancelled",
      targets: [{ relayUrl: target.relay.url, state: "cancelled" }],
      receivedEvents: 0,
    });
    assert.equal(target.subscriptions[0]?.closeCalls, 1);
    assert.equal(target.relay.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session closes connected resources when its callback throws", async () => {
  const target = controlledRelay("wss://throw.example/");
  const connectionMock = mockConnections(async () => target.relay);
  try {
    let queryCompletion: Promise<QueryCompletion> | undefined;
    await assert.rejects(
      withFiniteRelaySession(
        { relayUrls: [target.relay.url], connectDeadlineMs: 100 },
        (session) => {
          queryCompletion = session.query({
            filters: [{ kinds: [1] }],
            deadlineMs: 100,
            onEvent() {},
          });
          throw new Error("workflow failed");
        },
      ),
      /workflow failed/,
    );
    assert.deepEqual(await queryCompletion, {
      reason: "cancelled",
      targets: [{ relayUrl: target.relay.url, state: "cancelled" }],
      receivedEvents: 0,
    });
    assert.equal(target.subscriptions[0]?.closeCalls, 1);
    assert.equal(target.relay.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session owns an unawaited hinted connection after callback exit", async () => {
  const target = controlledRelay("wss://unawaited.example/");
  const connection = deferred<unknown>();
  const connectionMock = mockConnections(() => connection.promise);
  try {
    let hintOutcome:
      | Promise<readonly { relayUrl: string; state: string }[]>
      | undefined;
    await withFiniteRelaySession(
      { relayUrls: [], connectDeadlineMs: 100 },
      (session) => {
        hintOutcome = session.ensureRelays([target.relay.url], 100);
      },
    );

    assert.deepEqual(await hintOutcome, [
      { relayUrl: target.relay.url, state: "cancelled" },
    ]);
    connection.resolve(target.relay);
    await nextTurn();
    assert.equal(target.relay.closeCalls, 1);
  } finally {
    connectionMock.restore();
  }
});

test("finite relay session production adapter reuses a socket and preserves exact query results", async () => {
  const transcript = new RelayTranscriptSession();
  const event = finalizeEvent(
    {
      created_at: 2_000_000_000,
      kind: 1,
      tags: [],
      content: "session compatibility",
    },
    new Uint8Array(32).fill(91),
  );
  const harness = await RelayTranscriptHarness.listen({
    session: transcript,
    onRequest(request) {
      request.sendEvent(event);
      request.sendEose();
    },
  });

  try {
    const received: string[] = [];
    const completions = await withFiniteRelaySession(
      { relayUrls: [harness.url], connectDeadlineMs: 1_000 },
      async (session) => {
        const query = (kind: number) =>
          session.query({
            filters: [{ kinds: [kind] }],
            deadlineMs: 1_000,
            onEvent: (nextEvent) => received.push(nextEvent.id),
          });
        return [await query(1), await query(1)];
      },
    );
    await transcript.waitFor(
      (entries) =>
        entries.filter((entry) => entry.type === "connection-closed").length ===
        1,
    );

    assert.deepEqual(received, [event.id, event.id]);
    assert.deepEqual(
      completions.map((completion) => completion.reason),
      ["settled", "settled"],
    );
    assert.deepEqual(
      {
        opened: transcript.entries.filter(
          (entry) => entry.type === "connection-opened",
        ).length,
        closed: transcript.entries.filter(
          (entry) => entry.type === "connection-closed",
        ).length,
        requests: transcript.entries.filter((entry) => entry.type === "request")
          .length,
        closes: transcript.entries.filter((entry) => entry.type === "close")
          .length,
      },
      { opened: 1, closed: 1, requests: 2, closes: 2 },
    );
  } finally {
    await harness.close();
  }
});
