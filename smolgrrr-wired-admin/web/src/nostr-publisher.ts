import { Relay, type Event } from "nostr-tools";
import {
  normalizeRelayUrl,
  uniqueRelays,
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
    uniqueRelays(relayUrls).map(async (url) => {
      const pendingRelay = connectRelay(url);
      let relay: RelayConnection;
      try {
        relay = await withTimeout(pendingRelay, timeoutMs, url);
      } catch (error) {
        void pendingRelay.then((lateRelay) => {
          try {
            lateRelay.close();
          } catch {
            // Relay already closed.
          }
        }, () => {});
        throw error;
      }
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
