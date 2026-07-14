import { Relay, type Event } from "nostr-tools";
import {
  normalizeRelayUrl,
  uniqueSorted,
  withTimeout,
} from "./utils.js";

type RelayConnection = Pick<
  Awaited<ReturnType<typeof Relay.connect>>,
  "close" | "publish" | "url"
>;

export type RelayConnector = (url: string) => Promise<RelayConnection>;

export type PublishNostrEventOptions = {
  connectRelay?: RelayConnector;
};

export async function publishNostrEvent(
  event: Event,
  relayUrls: string[],
  timeoutMs: number,
  { connectRelay = Relay.connect }: PublishNostrEventOptions = {},
): Promise<string[]> {
  const results = await Promise.allSettled(
    relayUrls.map(async (url) => {
      const relay = await withTimeout(connectRelay(url), timeoutMs, url);
      try {
        await withTimeout(relay.publish(event), timeoutMs, url);
        return normalizeRelayUrl(relay.url || url);
      } finally {
        try {
          relay.close();
        } catch {
          // Relay already closed.
        }
      }
    }),
  );

  return uniqueSorted(
    results
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value),
  );
}
