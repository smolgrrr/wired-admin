import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nip19, Relay } from "nostr-tools";
import { eventPow } from "./pow.js";
import { normalizeUrl, uniqueSorted } from "./utils.js";

function isRootNote(event) {
  return event.kind === 1 && !(event.tags || []).some((tag) => tag[0] === "e");
}

function sinceFromAgeHours(ageHours) {
  return Math.floor(Date.now() / 1000) - ageHours * 60 * 60;
}

function normalizeRelayUrl(url) {
  return url.replace(/\/+$/, "");
}

function uniqueRelays(relays) {
  return [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))];
}

function addRelayHint(relayHintsByEventId, eventId, relayUrl) {
  const normalizedRelay = normalizeRelayUrl(relayUrl);
  const existing = relayHintsByEventId.get(eventId) || [];
  if (existing.includes(normalizedRelay)) return;

  relayHintsByEventId.set(eventId, [...existing, normalizedRelay]);
}

function mergeRelayHints(...hintGroups) {
  const merged = new Map();

  hintGroups.forEach((relayHintsByEventId) => {
    relayHintsByEventId.forEach((relays, eventId) => {
      relays.forEach((relay) => addRelayHint(merged, eventId, relay));
    });
  });

  return merged;
}

function mergeEvents(...eventGroups) {
  const merged = new Map();
  eventGroups.forEach((events) => {
    events.forEach((event) => merged.set(event.id, event));
  });
  return [...merged.values()];
}

function serializeRelayHints(relayHintsByEventId) {
  return Object.fromEntries(
    [...relayHintsByEventId.entries()].map(([eventId, relays]) => [
      eventId,
      uniqueRelays(relays),
    ]),
  );
}

const eventIdPattern = /^[0-9a-f]{64}$/i;
const nostrRefPattern = /nostr:(?:note|nevent|naddr|npub|nprofile|nrelay)1[a-z0-9]+/gi;

function decodeNostrEventRef(ref) {
  const bech32 = String(ref || "").replace(/^nostr:/i, "");
  try {
    const decoded = nip19.decode(bech32);
    if (decoded.type === "note") {
      return { id: decoded.data, relays: [] };
    }
    if (decoded.type === "nevent") {
      return {
        id: decoded.data.id,
        relays: uniqueRelays(decoded.data.relays || []),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function addReferencedEventRef(refsById, id, relays = []) {
  if (!eventIdPattern.test(id)) return;

  const normalizedId = id.toLowerCase();
  const existing = refsById.get(normalizedId);
  if (existing) {
    existing.relays = uniqueRelays([...existing.relays, ...relays]);
    return;
  }
  refsById.set(normalizedId, { id: normalizedId, relays: uniqueRelays(relays) });
}

function extractMentionedEventRefs(event) {
  const refsById = new Map();

  for (const tag of event.tags || []) {
    if ((tag[0] === "q" || tag[0] === "e") && tag[1]) {
      const relayHint = tag[2] ? normalizeRelayUrl(tag[2]) : undefined;

      if (eventIdPattern.test(tag[1])) {
        addReferencedEventRef(refsById, tag[1], relayHint ? [relayHint] : []);
        continue;
      }

      const decoded = decodeNostrEventRef(tag[1]);
      if (decoded) {
        addReferencedEventRef(
          refsById,
          decoded.id,
          relayHint ? [...decoded.relays, relayHint] : decoded.relays,
        );
      }
    }
  }

  for (const match of String(event.content || "").matchAll(nostrRefPattern)) {
    const decoded = decodeNostrEventRef(match[0]);
    if (decoded) addReferencedEventRef(refsById, decoded.id, decoded.relays);
  }

  return [...refsById.values()];
}

async function connectRelays(urls) {
  const relays = await Promise.all(
    urls.map(async (url) => {
      try {
        return await Relay.connect(url);
      } catch {
        return null;
      }
    }),
  );
  return relays.filter(Boolean);
}

function closeRelays(relays) {
  relays.forEach((relay) => {
    try {
      relay.close();
    } catch {
      // Relay already closed.
    }
  });
}

function buildReplyFilter(parentIds, since) {
  const ids = parentIds.slice(0, 50);
  if (ids.length === 0) return null;
  return {
    "#e": ids,
    kinds: [1],
    since,
    limit: 100,
  };
}

function buildRepliesByParent(events) {
  const repliesByParent = new Map();
  events.forEach((event) => {
    if (event.kind !== 1) return;
    (event.tags || []).forEach((tag) => {
      if (tag[0] !== "e" || !tag[1]) return;
      const replies = repliesByParent.get(tag[1]) || [];
      replies.push(event);
      repliesByParent.set(tag[1], replies);
    });
  });
  return repliesByParent;
}

function collectThreadReplies(rootId, repliesByParent) {
  const replies = [];
  const seen = new Set();
  const pending = [...(repliesByParent.get(rootId) || [])];
  while (pending.length > 0) {
    const reply = pending.shift();
    if (!reply || seen.has(reply.id)) continue;
    seen.add(reply.id);
    replies.push(reply);
    pending.push(...(repliesByParent.get(reply.id) || []));
  }
  return replies;
}

function eventWork(event) {
  return Math.pow(2, eventPow(event));
}

function relayHintsForEvent(eventId, relayHintsByEventId) {
  const relayHints = relayHintsByEventId?.get(eventId);
  if (!relayHints) return undefined;

  const normalized = [...new Set(relayHints.map(normalizeRelayUrl).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function snapshotReferenceRefs(processedEvents) {
  const byId = new Map();

  processedEvents.forEach((processed) => {
    extractMentionedEventRefs(processed.postEvent).forEach((ref) => {
      const existing = byId.get(ref.id);
      if (existing) {
        existing.relays = uniqueRelays([...existing.relays, ...ref.relays]);
        return;
      }
      byId.set(ref.id, { id: ref.id, relays: uniqueRelays(ref.relays) });
    });
  });

  return [...byId.values()];
}

function parseProfileEvent(event) {
  if (event.kind !== 0) return null;
  try {
    const raw = JSON.parse(event.content);
    const profile = {
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined,
      displayName:
        typeof raw.display_name === "string" && raw.display_name.trim()
          ? raw.display_name.trim()
          : typeof raw.displayName === "string" && raw.displayName.trim()
            ? raw.displayName.trim()
            : undefined,
      picture: undefined,
    };
    if (typeof raw.picture === "string") {
      const picture = normalizeUrl(raw.picture.trim());
      if (picture) profile.picture = picture;
    }
    return profile.name || profile.displayName || profile.picture ? profile : null;
  } catch {
    return null;
  }
}

export function createFeedSnapshotService({
  cacheFile,
  refreshSeconds,
  ageHours,
  timeoutMs,
  replyFetchDepth,
  minPow,
  powRelays,
  enrichmentRelays,
  threadRelays,
  moderation,
}) {
  let snapshot = null;
  let lastRefreshError = null;
  let refreshPromise = null;

  async function subscribeOnce(relays, filter, relayUrls) {
    const targetRelays = relayUrls
      ? relays.filter((relay) =>
          relayUrls.some((url) => normalizeRelayUrl(url) === normalizeRelayUrl(relay.url)),
        )
      : relays;

    if (targetRelays.length === 0) {
      return { events: [], relayHintsByEventId: new Map() };
    }

    const events = [];
    const seenIds = new Set();
    const relayHintsByEventId = new Map();

    await new Promise((resolve) => {
      const subscriptions = [];
      let eoseCount = 0;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscriptions.forEach((sub) => {
          try {
            sub.close();
          } catch {
            // Subscription already closed.
          }
        });
        resolve();
      };

      const timer = setTimeout(finish, timeoutMs);

      for (const relay of targetRelays) {
        try {
          const sub = relay.subscribe([filter], {
            onevent(event) {
              addRelayHint(relayHintsByEventId, event.id, relay.url);
              if (!seenIds.has(event.id)) {
                seenIds.add(event.id);
                events.push(event);
              }
            },
            oneose() {
              eoseCount += 1;
              if (eoseCount >= targetRelays.length) finish();
            },
          });
          subscriptions.push(sub);
        } catch {
          eoseCount += 1;
          if (eoseCount >= targetRelays.length) finish();
        }
      }
    });

    return { events, relayHintsByEventId };
  }

  async function fetchReplyClosure({ relays, parentIds, relayUrls, knownEventIds = new Set() }) {
    const replyEvents = [];
    const seenReplyIds = new Set();
    const replyRelayHintsByEventId = new Map();
    const since = sinceFromAgeHours(ageHours);
    let nextParents = [...parentIds];

    for (let depth = 0; depth < replyFetchDepth && nextParents.length > 0; depth += 1) {
      const replyFilter = buildReplyFilter(nextParents, since);
      if (!replyFilter) break;

      const replyBatch = await subscribeOnce(relays, replyFilter, relayUrls);
      const childParentIds = [];

      replyBatch.relayHintsByEventId.forEach((relaysForEvent, eventId) => {
        relaysForEvent.forEach((relay) => addRelayHint(replyRelayHintsByEventId, eventId, relay));
      });

      replyBatch.events.forEach((event) => {
        if (knownEventIds.has(event.id) || seenReplyIds.has(event.id)) return;

        seenReplyIds.add(event.id);
        replyEvents.push(event);
        childParentIds.push(event.id);
      });

      nextParents = childParentIds;
    }

    return { events: replyEvents, relayHintsByEventId: replyRelayHintsByEventId };
  }

  async function fetchGlobalFeedEvents() {
    const relays = await connectRelays(threadRelays);
    try {
      const notes = new Set();
      const since = sinceFromAgeHours(ageHours);
      const rootBatch = await subscribeOnce(
        relays,
        { kinds: [1, 1068], since, limit: 500 },
        powRelays,
      );
      const rootEvents = rootBatch.events;

      rootEvents.forEach((event) => {
        if (isRootNote(event)) notes.add(event.id);
      });

      const replyBatch = await fetchReplyClosure({
        relays,
        parentIds: [...notes],
        relayUrls: threadRelays,
      });

      return {
        events: mergeEvents(rootEvents, replyBatch.events),
        relayHintsByEventId: mergeRelayHints(
          rootBatch.relayHintsByEventId,
          replyBatch.relayHintsByEventId,
        ),
      };
    } finally {
      closeRelays(relays);
    }
  }

  function workScoreBreakdown(event, replies) {
    let rankingReplyCount = 0;
    const replyWork = replies.reduce((sum, reply) => {
      const difficulty = eventPow(reply);
      if (difficulty < minPow) return sum;
      rankingReplyCount += 1;
      return sum + Math.pow(2, difficulty);
    }, 0);
    const rootWork = eventWork(event);
    return {
      rootWork,
      replyWork,
      totalWork: rootWork + replyWork,
      rankingReplyCount,
    };
  }

  function processFeedEvents(events, relayHintsByEventId = new Map()) {
    const repliesByParent = buildRepliesByParent(events);
    const seenPubkeys = new Set();
    const posts = [];

    events.forEach((event) => {
      if (event.kind !== 1 && event.kind !== 1068) return;
      if (seenPubkeys.has(event.pubkey)) return;
      if (event.kind === 1 && !isRootNote(event)) return;
      if (eventPow(event) < minPow) return;
      seenPubkeys.add(event.pubkey);
      posts.push(event);
    });

    return posts
      .map((postEvent) => {
        const replies = collectThreadReplies(postEvent.id, repliesByParent);
        return {
          postEvent,
          replies,
          relayHints: relayHintsForEvent(postEvent.id, relayHintsByEventId),
          threadReplyCount: replies.length,
          ...workScoreBreakdown(postEvent, replies),
        };
      })
      .sort((a, b) => b.totalWork - a.totalWork || b.postEvent.created_at - a.postEvent.created_at);
  }

  async function fetchReferencedEvents(refs, knownEventIds) {
    const missingRefs = refs.filter((ref) => !knownEventIds.has(ref.id));
    if (missingRefs.length === 0) {
      return { events: [], relayHintsByEventId: new Map() };
    }

    const relayUrls = uniqueRelays([
      ...threadRelays,
      ...missingRefs.flatMap((ref) => ref.relays),
    ]);
    const relays = await connectRelays(relayUrls);

    try {
      const referencedBatch = await subscribeOnce(
        relays,
        {
          ids: missingRefs.map((ref) => ref.id),
          kinds: [1, 1068],
          limit: missingRefs.length,
        },
        relayUrls,
      );

      const replyBatch = await fetchReplyClosure({
        relays,
        parentIds: referencedBatch.events.map((event) => event.id),
        relayUrls,
        knownEventIds,
      });

      return {
        events: mergeEvents(referencedBatch.events, replyBatch.events),
        relayHintsByEventId: mergeRelayHints(
          referencedBatch.relayHintsByEventId,
          replyBatch.relayHintsByEventId,
        ),
      };
    } finally {
      closeRelays(relays);
    }
  }

  async function fetchProfileMetadata(pubkeys) {
    if (pubkeys.length === 0) return {};
    const relays = await connectRelays(threadRelays);
    try {
      const { events } = await subscribeOnce(
        relays,
        {
          authors: pubkeys,
          kinds: [0],
          limit: Math.min(pubkeys.length, 250),
        },
        threadRelays,
      );

      const profiles = {};
      events.forEach((event) => {
        const profile = parseProfileEvent(event);
        if (!profile) return;
        const existing = profiles[event.pubkey];
        if (existing && existing.createdAt >= event.created_at) return;
        profiles[event.pubkey] = { profile, createdAt: event.created_at };
      });

      return Object.fromEntries(
        Object.entries(profiles).map(([pubkey, entry]) => [pubkey, entry.profile]),
      );
    } finally {
      closeRelays(relays);
    }
  }

  async function loadFromDisk() {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8"));
      if (
        typeof cached.fetchedAt === "number" &&
        Array.isArray(cached.processedEvents) &&
        Array.isArray(cached.events) &&
        cached.relayHintsByEventId &&
        typeof cached.relayHintsByEventId === "object" &&
        cached.profiles &&
        typeof cached.profiles === "object"
      ) {
        snapshot = cached;
      }
    } catch {
      // The cache is optional.
    }
  }

  async function persist(nextSnapshot) {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(nextSnapshot), "utf8");
  }

  async function fetch() {
    const feedBatch = await fetchGlobalFeedEvents();
    const manifest = await moderation.getManifest();
    const visibleFeedEvents =
      manifest.updatedAt === 0
        ? feedBatch.events
        : feedBatch.events.filter((event) => !moderation.isEventModerated(event, manifest));
    const processedEvents = processFeedEvents(
      visibleFeedEvents,
      feedBatch.relayHintsByEventId,
    );
    const knownEventIds = new Set(visibleFeedEvents.map((event) => event.id));
    const referencedBatch = await fetchReferencedEvents(
      snapshotReferenceRefs(processedEvents),
      knownEventIds,
    );
    const visibleReferencedEvents =
      manifest.updatedAt === 0
        ? referencedBatch.events
        : referencedBatch.events.filter((event) => !moderation.isEventModerated(event, manifest));
    const events = mergeEvents(visibleFeedEvents, visibleReferencedEvents);
    const relayHintsByEventId = mergeRelayHints(
      feedBatch.relayHintsByEventId,
      referencedBatch.relayHintsByEventId,
    );
    const pubkeys = [
      ...new Set([
        ...processedEvents.flatMap((processed) => [
          processed.postEvent.pubkey,
          ...processed.replies.map((reply) => reply.pubkey),
        ]),
        ...visibleReferencedEvents.map((event) => event.pubkey),
      ]),
    ];
    const profiles = await fetchProfileMetadata(pubkeys);

    return {
      fetchedAt: Date.now(),
      processedEvents,
      events,
      relayHintsByEventId: serializeRelayHints(relayHintsByEventId),
      profiles,
    };
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;

    refreshPromise = fetch()
      .then(async (nextSnapshot) => {
        snapshot = nextSnapshot;
        lastRefreshError = null;
        await persist(nextSnapshot);
        return nextSnapshot;
      })
      .catch((error) => {
        lastRefreshError = error instanceof Error ? error.message : "refresh failed";
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });

    return refreshPromise;
  }

  function status() {
    return {
      fetchedAt: snapshot?.fetchedAt || null,
      postCount: snapshot?.processedEvents?.length || 0,
      eventCount: snapshot?.events?.length || 0,
      relayHintCount: snapshot ? Object.keys(snapshot.relayHintsByEventId || {}).length : 0,
      profileCount: snapshot ? Object.keys(snapshot.profiles).length : 0,
      refreshing: Boolean(refreshPromise),
      lastRefreshError,
      refreshSeconds,
      ageHours,
      timeoutMs,
      powRelays,
      enrichmentRelays,
      cacheFile,
    };
  }

  return {
    current: () => snapshot,
    fetchProfileMetadata,
    lastRefreshError: () => lastRefreshError,
    loadFromDisk,
    refresh,
    status,
  };
}
