import type { Event, Filter } from "nostr-tools";

export type EventId = string;
export type Pubkey = string;
export type RelayUrl = string;
export type NostrTag = string[];
export type NostrEvent = Event;
export type NostrFilter = Filter;

export type RelayHintsRecord = Record<EventId, RelayUrl[]>;
export type RelayHintsByEventId = Map<EventId, RelayUrl[]>;

export type ReferencedEventRef = {
  id: EventId;
  relays: RelayUrl[];
};
