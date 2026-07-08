import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nip19, Relay, type Filter } from "nostr-tools";
import { eventPow } from "./pow.js";
import { normalizeRelayUrl, normalizeUrl, uniqueRelays } from "./utils.js";
import type {
  FeedBootstrapProcessedEvent,
  FeedBootstrapSnapshot,
  FeedSnapshotStatus,
  ProcessedFeedEvent,
  ProfileSummary,
} from "./contracts/api.js";
import type {
  NostrEvent,
  Pubkey,
  ReferencedEventRef,
  RelayHintsByEventId,
  RelayHintsRecord,
  RelayUrl,
} from "./contracts/nostr.js";
import type { ModerationService } from "./moderation.js";
import { isNostrEvent, parseFeedBootstrapSnapshot } from "./contracts/validation.js";

type ConnectedRelay = Awaited<ReturnType<typeof Relay.connect>>;

type SubscriptionLike = {
  close: () => void;
};

type RelayBatch = {
  events: NostrEvent[];
  relayHintsByEventId: RelayHintsByEventId;
};

type FeedSnapshotServiceOptions = {
  cacheFile: string;
  refreshSeconds: number;
  ageHours: number;
  timeoutMs: number;
  replyLimit: number;
  replyFetchDepth: number;
  minPow: number;
  powRelays: RelayUrl[];
  enrichmentRelays: RelayUrl[];
  threadRelays: RelayUrl[];
  moderation: ModerationService;
};

const replyParentBatchSize = 50;

type FetchReplyClosureOptions = {
  relays: ConnectedRelay[];
  parentIds: string[];
  relayUrls: RelayUrl[];
  knownEventIds?: Set<string>;
};

type RootRefCandidate = {
  ref: ReferencedEventRef;
  definitive: boolean;
};

type RootResolutionTrace = RootRefCandidate & {
  nextMissingRef?: ReferencedEventRef;
};

export type FeedSnapshotService = ReturnType<typeof createFeedSnapshotService>;

function isRootNote(event: NostrEvent): boolean {
  return event.kind === 1 && !(event.tags || []).some((tag) => tag[0] === "e");
}

function sinceFromAgeHours(ageHours: number): number {
  return Math.floor(Date.now() / 1000) - ageHours * 60 * 60;
}

function addRelayHint(relayHintsByEventId: RelayHintsByEventId, eventId: string, relayUrl: string): void {
  const normalizedRelay = normalizeRelayUrl(relayUrl);
  const existing = relayHintsByEventId.get(eventId) || [];
  if (existing.includes(normalizedRelay)) return;

  relayHintsByEventId.set(eventId, [...existing, normalizedRelay]);
}

function mergeRelayHints(...hintGroups: RelayHintsByEventId[]): RelayHintsByEventId {
  const merged: RelayHintsByEventId = new Map();

  hintGroups.forEach((relayHintsByEventId) => {
    relayHintsByEventId.forEach((relays, eventId) => {
      relays.forEach((relay) => addRelayHint(merged, eventId, relay));
    });
  });

  return merged;
}

function mergeEvents(...eventGroups: NostrEvent[][]): NostrEvent[] {
  const merged = new Map<string, NostrEvent>();
  eventGroups.forEach((events) => {
    events.forEach((event) => merged.set(normalizeEventId(event.id), event));
  });
  return [...merged.values()];
}

function serializeRelayHints(relayHintsByEventId: RelayHintsByEventId): RelayHintsRecord {
  return Object.fromEntries(
    [...relayHintsByEventId.entries()].map(([eventId, relays]) => [
      eventId,
      uniqueRelays(relays),
    ]),
  );
}

const eventIdPattern = /^[0-9a-f]{64}$/i;
const nostrRefPattern = /nostr:(?:note|nevent|naddr|npub|nprofile|nrelay)1[a-z0-9]+/gi;

function normalizeEventId(id: string): string {
  return id.toLowerCase();
}

function isEventId(id: unknown): id is string {
  return typeof id === "string" && eventIdPattern.test(id);
}

function relayHintFromTag(tag: string[]): RelayUrl | undefined {
  const rawRelay = tag[2];
  if (!rawRelay) return undefined;

  const normalizedRelay = normalizeRelayUrl(rawRelay);
  return /^wss?:\/\//i.test(normalizedRelay) ? normalizedRelay : undefined;
}

function decodeNostrEventRef(ref: unknown): ReferencedEventRef | null {
  const bech32 = String(ref || "").replace(/^nostr:/i, "");
  try {
    const decoded = nip19.decode(bech32);
    if (decoded.type === "note") {
      return { id: normalizeEventId(decoded.data), relays: [] };
    }
    if (decoded.type === "nevent") {
      return {
        id: normalizeEventId(decoded.data.id),
        relays: uniqueRelays(decoded.data.relays || []),
      };
    }
  } catch {
    return null;
  }
  return null;
}

function addReferencedEventRef(refsById: Map<string, ReferencedEventRef>, id: string, relays: string[] = []): void {
  if (!eventIdPattern.test(id)) return;

  const normalizedId = normalizeEventId(id);
  const existing = refsById.get(normalizedId);
  if (existing) {
    existing.relays = uniqueRelays([...existing.relays, ...relays]);
    return;
  }
  refsById.set(normalizedId, { id: normalizedId, relays: uniqueRelays(relays) });
}

function mergeRefRelays(ref: ReferencedEventRef, relays: RelayUrl[] = []): ReferencedEventRef {
  return {
    id: normalizeEventId(ref.id),
    relays: uniqueRelays([...ref.relays, ...relays]),
  };
}

function addReferencedEventRefValue(
  refsById: Map<string, ReferencedEventRef>,
  ref: ReferencedEventRef,
): void {
  addReferencedEventRef(refsById, ref.id, ref.relays);
}

function eventRefFromETag(tag: string[]): ReferencedEventRef | null {
  if (tag[0] !== "e" || !tag[1]) return null;

  const relayHint = relayHintFromTag(tag);
  if (isEventId(tag[1])) {
    return {
      id: normalizeEventId(tag[1]),
      relays: relayHint ? [relayHint] : [],
    };
  }

  const decoded = decodeNostrEventRef(tag[1]);
  if (!decoded) return null;

  return mergeRefRelays(decoded, relayHint ? [relayHint] : []);
}

function rootMarkerRef(event: NostrEvent): ReferencedEventRef | null {
  for (const tag of event.tags || []) {
    if (String(tag[3] || "").toLowerCase() !== "root") continue;
    const ref = eventRefFromETag(tag);
    if (ref) return ref;
  }

  return null;
}

function firstETagRef(event: NostrEvent): ReferencedEventRef | null {
  for (const tag of event.tags || []) {
    const ref = eventRefFromETag(tag);
    if (ref) return ref;
  }

  return null;
}

function directRootRefCandidate(event: NostrEvent): RootRefCandidate | null {
  if (event.kind !== 1) return null;

  if (isRootNote(event)) {
    return { ref: { id: normalizeEventId(event.id), relays: [] }, definitive: true };
  }

  const rootRef = rootMarkerRef(event);
  if (rootRef) return { ref: rootRef, definitive: true };

  const fallbackRef = firstETagRef(event);
  return fallbackRef ? { ref: fallbackRef, definitive: false } : null;
}

function buildEventById(events: NostrEvent[]): Map<string, NostrEvent> {
  const eventById = new Map<string, NostrEvent>();
  events.forEach((event) => eventById.set(normalizeEventId(event.id), event));
  return eventById;
}

function traceRootRefFromKnownEvents(
  event: NostrEvent,
  eventById: Map<string, NostrEvent>,
  maxDepth: number,
): RootResolutionTrace | null {
  const direct = directRootRefCandidate(event);
  if (!direct) return null;
  if (isRootNote(event)) return direct;

  const fallbackRef = direct.ref;
  let currentRef = direct.ref;
  const seenIds = new Set<string>([normalizeEventId(event.id)]);

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seenIds.has(currentRef.id)) break;
    seenIds.add(currentRef.id);

    const linkedEvent = eventById.get(currentRef.id);
    if (!linkedEvent) {
      return {
        ref: fallbackRef,
        definitive: false,
        nextMissingRef: currentRef,
      };
    }

    if (isRootNote(linkedEvent)) {
      return {
        ref: mergeRefRelays({ id: normalizeEventId(linkedEvent.id), relays: [] }, currentRef.relays),
        definitive: true,
      };
    }

    const linkedRoot = directRootRefCandidate(linkedEvent);
    if (!linkedRoot) break;
    currentRef = mergeRefRelays(linkedRoot.ref, currentRef.relays);
  }

  return { ref: fallbackRef, definitive: false };
}

function extractMentionedEventRefs(event: NostrEvent): ReferencedEventRef[] {
  const refsById = new Map<string, ReferencedEventRef>();

  for (const tag of event.tags || []) {
    if ((tag[0] === "q" || tag[0] === "e") && tag[1]) {
      const relayHint = relayHintFromTag(tag);

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

async function connectRelays(urls: RelayUrl[]): Promise<ConnectedRelay[]> {
  const relays = await Promise.all(
    urls.map(async (url) => {
      try {
        return await Relay.connect(url);
      } catch {
        return null;
      }
    }),
  );
  return relays.filter((relay): relay is ConnectedRelay => Boolean(relay));
}

function closeRelays(relays: ConnectedRelay[]): void {
  relays.forEach((relay) => {
    try {
      relay.close();
    } catch {
      // Relay already closed.
    }
  });
}

function chunkIds(ids: string[], batchSize: number): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += batchSize) {
    chunks.push(ids.slice(index, index + batchSize));
  }
  return chunks;
}

function buildReplyFilter(parentIds: string[], since: number, replyLimit: number): Filter | null {
  if (parentIds.length === 0) return null;
  return {
    "#e": parentIds,
    kinds: [1],
    since,
    limit: replyLimit,
  };
}

function buildRepliesByParent(events: NostrEvent[]): Map<string, NostrEvent[]> {
  const repliesByParent = new Map<string, NostrEvent[]>();
  events.forEach((event) => {
    if (event.kind !== 1) return;
    (event.tags || []).forEach((tag) => {
      if (tag[0] !== "e" || !isEventId(tag[1])) return;
      const parentId = normalizeEventId(tag[1]);
      const replies = repliesByParent.get(parentId) || [];
      replies.push(event);
      repliesByParent.set(parentId, replies);
    });
  });
  return repliesByParent;
}

function collectThreadReplies(rootId: string, repliesByParent: Map<string, NostrEvent[]>): NostrEvent[] {
  const replies: NostrEvent[] = [];
  const seen = new Set<string>();
  const pending = [...(repliesByParent.get(normalizeEventId(rootId)) || [])];
  while (pending.length > 0) {
    const reply = pending.shift();
    const replyId = reply ? normalizeEventId(reply.id) : "";
    if (!reply || seen.has(replyId)) continue;
    seen.add(replyId);
    replies.push(reply);
    pending.push(...(repliesByParent.get(replyId) || []));
  }
  return replies;
}

function eventWork(event: NostrEvent): number {
  return Math.pow(2, eventPow(event));
}

function relayHintsForEvent(eventId: string, relayHintsByEventId: RelayHintsByEventId): RelayUrl[] | undefined {
  const relayHints = relayHintsByEventId.get(eventId) || relayHintsByEventId.get(normalizeEventId(eventId));
  if (!relayHints) return undefined;

  const normalized = [...new Set(relayHints.map(normalizeRelayUrl).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function snapshotReferenceRefs(processedEvents: ProcessedFeedEvent[]): ReferencedEventRef[] {
  const byId = new Map<string, ReferencedEventRef>();

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

function parseProfileEvent(event: NostrEvent): ProfileSummary | null {
  if (event.kind !== 0) return null;
  try {
    const raw = JSON.parse(event.content) as Record<string, unknown>;
    const profile: ProfileSummary = {};
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : undefined;
    const displayName =
      typeof raw.display_name === "string" && raw.display_name.trim()
        ? raw.display_name.trim()
        : typeof raw.displayName === "string" && raw.displayName.trim()
          ? raw.displayName.trim()
          : undefined;
    if (name) profile.name = name;
    if (displayName) profile.displayName = displayName;
    if (typeof raw.picture === "string") {
      const picture = normalizeUrl(raw.picture.trim());
      if (picture) profile.picture = picture;
    }
    return profile.name || profile.displayName || profile.picture ? profile : null;
  } catch {
    return null;
  }
}

function prioritizeRootIds(
  rootIds: string[],
  activityEvents: NostrEvent[],
  eventById: Map<string, NostrEvent>,
  rootResolutionDepth: number,
): string[] {
  const maxPowByRoot = new Map<string, number>();

  activityEvents.forEach((event) => {
    const trace = traceRootRefFromKnownEvents(event, eventById, rootResolutionDepth);
    if (!trace) return;

    const pow = eventPow(event);
    const rootId = trace.ref.id;
    maxPowByRoot.set(rootId, Math.max(maxPowByRoot.get(rootId) || 0, pow));
  });

  return [...rootIds].sort(
    (left, right) => (maxPowByRoot.get(right) || 0) - (maxPowByRoot.get(left) || 0),
  );
}

export function createFeedSnapshotService({
  cacheFile,
  refreshSeconds,
  ageHours,
  timeoutMs,
  replyLimit,
  replyFetchDepth,
  minPow,
  powRelays,
  enrichmentRelays,
  threadRelays,
  moderation,
}: FeedSnapshotServiceOptions) {
  let snapshot: FeedBootstrapSnapshot | null = null;
  let lastRefreshError: string | null = null;
  let refreshPromise: Promise<FeedBootstrapSnapshot> | null = null;
  const rootResolutionDepth = Math.max(1, replyFetchDepth + 1);

  async function subscribeOnce(relays: ConnectedRelay[], filter: Filter, relayUrls?: RelayUrl[]): Promise<RelayBatch> {
    const targetRelays = relayUrls
      ? relays.filter((relay) =>
          relayUrls.some((url) => normalizeRelayUrl(url) === normalizeRelayUrl(relay.url)),
        )
      : relays;

    if (targetRelays.length === 0) {
      return { events: [], relayHintsByEventId: new Map() };
    }

    const events: NostrEvent[] = [];
    const seenIds = new Set<string>();
    const relayHintsByEventId: RelayHintsByEventId = new Map();

    await new Promise<void>((resolve) => {
      const subscriptions: SubscriptionLike[] = [];
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
            onevent(event: unknown) {
              if (!isNostrEvent(event)) return;
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

  async function fetchReplyClosure({ relays, parentIds, relayUrls, knownEventIds = new Set() }: FetchReplyClosureOptions): Promise<RelayBatch> {
    const replyEvents: NostrEvent[] = [];
    const seenReplyIds = new Set<string>();
    const replyRelayHintsByEventId: RelayHintsByEventId = new Map();
    const since = sinceFromAgeHours(ageHours);
    let nextParents = [...parentIds];

    for (let depth = 0; depth < replyFetchDepth && nextParents.length > 0; depth += 1) {
      const childParentIds: string[] = [];

      for (const parentChunk of chunkIds(nextParents, replyParentBatchSize)) {
        const replyFilter = buildReplyFilter(parentChunk, since, replyLimit);
        if (!replyFilter) continue;

        const replyBatch = await subscribeOnce(relays, replyFilter, relayUrls);

        replyBatch.relayHintsByEventId.forEach((relaysForEvent, eventId) => {
          relaysForEvent.forEach((relay) => addRelayHint(replyRelayHintsByEventId, eventId, relay));
        });

        replyBatch.events.forEach((event) => {
          const eventId = normalizeEventId(event.id);
          if (knownEventIds.has(eventId) || seenReplyIds.has(eventId)) return;

          seenReplyIds.add(eventId);
          replyEvents.push(event);
          childParentIds.push(eventId);
        });
      }

      nextParents = childParentIds;
    }

    return { events: replyEvents, relayHintsByEventId: replyRelayHintsByEventId };
  }

  async function fetchEventsByRefs(
    refs: ReferencedEventRef[],
    baseRelayUrls: RelayUrl[],
    knownEventIds: Set<string> = new Set(),
  ): Promise<RelayBatch> {
    const refsById = new Map<string, ReferencedEventRef>();
    refs.forEach((ref) => {
      if (isEventId(ref.id)) addReferencedEventRefValue(refsById, ref);
    });

    const missingRefs = [...refsById.values()].filter((ref) => !knownEventIds.has(ref.id));
    if (missingRefs.length === 0) {
      return { events: [], relayHintsByEventId: new Map() };
    }

    const relayUrls = uniqueRelays([
      ...baseRelayUrls,
      ...missingRefs.flatMap((ref) => ref.relays),
    ]);
    const relays = await connectRelays(relayUrls);

    try {
      return await subscribeOnce(
        relays,
        {
          ids: missingRefs.map((ref) => ref.id),
          kinds: [1],
          limit: missingRefs.length,
        },
        relayUrls,
      );
    } finally {
      closeRelays(relays);
    }
  }

  async function resolveRootRefsForActivity(
    activityEvents: NostrEvent[],
    seedEvents: NostrEvent[],
  ): Promise<RelayBatch & { rootRefs: ReferencedEventRef[] }> {
    const eventById = buildEventById(seedEvents);
    const attemptedIds = new Set<string>();
    const resolutionBatches: RelayBatch[] = [];

    const resolveFromKnownEvents = () => {
      const rootRefsById = new Map<string, ReferencedEventRef>();
      const nextMissingRefsById = new Map<string, ReferencedEventRef>();

      activityEvents.forEach((event) => {
        const trace = traceRootRefFromKnownEvents(event, eventById, rootResolutionDepth);
        if (!trace) return;

        addReferencedEventRefValue(rootRefsById, trace.ref);
        if (
          trace.nextMissingRef &&
          !eventById.has(trace.nextMissingRef.id) &&
          !attemptedIds.has(trace.nextMissingRef.id)
        ) {
          addReferencedEventRefValue(nextMissingRefsById, trace.nextMissingRef);
        }
      });

      return {
        rootRefs: [...rootRefsById.values()],
        nextMissingRefs: [...nextMissingRefsById.values()],
      };
    };

    let resolved = resolveFromKnownEvents();

    for (
      let depth = 0;
      depth < rootResolutionDepth && resolved.nextMissingRefs.length > 0;
      depth += 1
    ) {
      resolved.nextMissingRefs.forEach((ref) => attemptedIds.add(ref.id));

      const batch = await fetchEventsByRefs(
        resolved.nextMissingRefs,
        uniqueRelays([...threadRelays, ...enrichmentRelays]),
        new Set(eventById.keys()),
      );
      resolutionBatches.push(batch);
      batch.events.forEach((event) => eventById.set(normalizeEventId(event.id), event));

      resolved = resolveFromKnownEvents();
    }

    return {
      rootRefs: resolved.rootRefs,
      events: mergeEvents(...resolutionBatches.map((batch) => batch.events)),
      relayHintsByEventId: mergeRelayHints(
        ...resolutionBatches.map((batch) => batch.relayHintsByEventId),
      ),
    };
  }

  async function fetchGlobalFeedEvents(): Promise<RelayBatch> {
    const relays = await connectRelays(uniqueRelays([...threadRelays, ...powRelays]));
    try {
      const since = sinceFromAgeHours(ageHours);
      const activityBatch = await subscribeOnce(
        relays,
        { kinds: [1], since, limit: 500 },
        powRelays,
      );
      const qualifyingActivityEvents = activityBatch.events.filter(
        (event) => event.kind === 1 && eventPow(event) >= minPow,
      );
      const rootResolutionBatch = await resolveRootRefsForActivity(
        qualifyingActivityEvents,
        activityBatch.events,
      );
      const knownEventIds = new Set(
        mergeEvents(activityBatch.events, rootResolutionBatch.events).map((event) =>
          normalizeEventId(event.id),
        ),
      );
      const rootBatch = await fetchEventsByRefs(
        rootResolutionBatch.rootRefs,
        uniqueRelays([...threadRelays, ...enrichmentRelays]),
        knownEventIds,
      );
      rootBatch.events.forEach((event) => knownEventIds.add(normalizeEventId(event.id)));

      const eventById = buildEventById(
        mergeEvents(activityBatch.events, rootResolutionBatch.events, rootBatch.events),
      );
      const rootIds = prioritizeRootIds(
        rootResolutionBatch.rootRefs.map((ref) => ref.id),
        qualifyingActivityEvents,
        eventById,
        rootResolutionDepth,
      );
      const replyBatch = await fetchReplyClosure({
        relays,
        parentIds: rootIds,
        relayUrls: threadRelays,
        knownEventIds,
      });

      return {
        events: mergeEvents(
          activityBatch.events,
          rootResolutionBatch.events,
          rootBatch.events,
          replyBatch.events,
        ),
        relayHintsByEventId: mergeRelayHints(
          activityBatch.relayHintsByEventId,
          rootResolutionBatch.relayHintsByEventId,
          rootBatch.relayHintsByEventId,
          replyBatch.relayHintsByEventId,
        ),
      };
    } finally {
      closeRelays(relays);
    }
  }

  function workScoreBreakdown(event: NostrEvent, replies: NostrEvent[]) {
    let rankingReplyCount = 0;
    const replyWork = replies.reduce((sum, reply) => {
      const difficulty = eventPow(reply);
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

  function processFeedEvents(events: NostrEvent[], relayHintsByEventId: RelayHintsByEventId = new Map()): ProcessedFeedEvent[] {
    const eventById = buildEventById(events);
    const repliesByParent = buildRepliesByParent(events);
    const powRelaySet = new Set(powRelays.map(normalizeRelayUrl));
    const since = sinceFromAgeHours(ageHours);
    const eligibleRootIds = new Set<string>();

    events.forEach((event) => {
      if (event.kind !== 1) return;
      if (event.created_at < since) return;
      if (eventPow(event) < minPow) return;

      const sourceRelayHints =
        relayHintsByEventId.get(event.id) || relayHintsByEventId.get(normalizeEventId(event.id)) || [];
      const seenOnPowRelay = sourceRelayHints.some((relay) =>
        powRelaySet.has(normalizeRelayUrl(relay)),
      );
      if (!seenOnPowRelay) return;

      const resolvedRoot = traceRootRefFromKnownEvents(event, eventById, rootResolutionDepth);
      if (resolvedRoot) eligibleRootIds.add(resolvedRoot.ref.id);
    });

    const posts = [...eligibleRootIds]
      .map((rootId) => eventById.get(rootId))
      .filter((event): event is NostrEvent => (event ? isRootNote(event) : false));

    return posts
      .map((postEvent) => {
        const replies = collectThreadReplies(postEvent.id, repliesByParent);
        const processed: ProcessedFeedEvent = {
          postEvent,
          replies,
          threadReplyCount: replies.length,
          ...workScoreBreakdown(postEvent, replies),
        };
        const relayHints = relayHintsForEvent(postEvent.id, relayHintsByEventId);
        if (relayHints) processed.relayHints = relayHints;
        return processed;
      })
      .sort((a, b) => b.totalWork - a.totalWork || b.postEvent.created_at - a.postEvent.created_at);
  }

  function buildEventsById(events: NostrEvent[]): Record<string, NostrEvent> {
    return Object.fromEntries(
      mergeEvents(events).map((event) => [normalizeEventId(event.id), event]),
    );
  }

  function serializeProcessedEvents(
    processedEvents: ProcessedFeedEvent[],
  ): FeedBootstrapProcessedEvent[] {
    return processedEvents.map((processed) => {
      const serialized: FeedBootstrapProcessedEvent = {
        postEventId: normalizeEventId(processed.postEvent.id),
        replyIds: processed.replies.map((reply) => normalizeEventId(reply.id)),
        threadReplyCount: processed.threadReplyCount,
        rootWork: processed.rootWork,
        replyWork: processed.replyWork,
        totalWork: processed.totalWork,
        rankingReplyCount: processed.rankingReplyCount,
      };
      if (processed.relayHints && processed.relayHints.length > 0) {
        serialized.relayHints = processed.relayHints;
      }
      return serialized;
    });
  }

  async function fetchReferencedEvents(refs: ReferencedEventRef[], knownEventIds: Set<string>): Promise<RelayBatch> {
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
          kinds: [1],
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

  async function fetchProfileMetadata(pubkeys: Pubkey[]): Promise<Record<Pubkey, ProfileSummary>> {
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
      const profiles: Record<Pubkey, { profile: ProfileSummary; createdAt: number }> = {};
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

  async function loadFromDisk(): Promise<void> {
    try {
      const cached = JSON.parse(await readFile(cacheFile, "utf8"));
      if (parseFeedBootstrapSnapshot(cached)) {
        snapshot = cached;
      }
    } catch {
      // The cache is optional.
    }
  }

  async function persist(nextSnapshot: FeedBootstrapSnapshot): Promise<void> {
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, JSON.stringify(nextSnapshot), "utf8");
  }

  async function fetch(): Promise<FeedBootstrapSnapshot> {
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
      processedEvents: serializeProcessedEvents(processedEvents),
      eventsById: buildEventsById(events),
      relayHintsByEventId: serializeRelayHints(relayHintsByEventId),
      profiles,
      scoring: {
        ageHours,
        minPow,
        replyDepth: replyFetchDepth,
        sort: "totalWork",
      },
    };
  }

  async function refresh(): Promise<FeedBootstrapSnapshot> {
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

  function status(): FeedSnapshotStatus {
    return {
      fetchedAt: snapshot?.fetchedAt || null,
      postCount: snapshot?.processedEvents?.length || 0,
      eventCount: snapshot ? Object.keys(snapshot.eventsById || {}).length : 0,
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
