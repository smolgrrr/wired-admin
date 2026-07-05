import WebSocket from "ws";
import { verifyPow } from "./pow.js";
import type { RelayRecentActivity, RelayStats } from "./contracts/api.js";
import type { NostrEvent } from "./contracts/nostr.js";

type AddRecent = (type: string, detail: unknown) => void;

type RelayGatewayOptions = {
  backendUrl: string;
  minPow: number;
  stats: RelayStats;
  addRecent: AddRecent;
};

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendOk(ws: WebSocket, eventId: string | undefined, ok: boolean, reason: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(["OK", eventId || "", ok, reason]));
  }
}

function summarizeEvent(event: NostrEvent, pow: number): RelayRecentActivity["detail"] {
  return {
    id: event.id,
    kind: event.kind,
    pow,
    created_at: event.created_at,
  };
}

export function createRelayGateway({ backendUrl, minPow, stats, addRecent }: RelayGatewayOptions) {
  return function handleClientConnection(client: WebSocket): void {
    stats.activeClients += 1;
    stats.totalConnections += 1;
    addRecent("client-connected", `${stats.activeClients} active`);

    const backend = new WebSocket(backendUrl);
    const queued: string[] = [];

    backend.on("open", () => {
      stats.lastBackendOpenAt = Date.now();
      while (queued.length > 0 && backend.readyState === WebSocket.OPEN) {
        const queuedMessage = queued.shift();
        if (queuedMessage) backend.send(queuedMessage);
      }
    });

    backend.on("message", (data) => {
      stats.backendMessages += 1;
      const raw = data.toString();
      const msg = safeJsonParse(raw);

      if (Array.isArray(msg) && msg[0] === "OK") {
        const ok = msg[2] === true;
        if (ok) {
          stats.acceptedPublishes += 1;
          addRecent("accepted", msg[1]);
        } else {
          stats.backendRejectedPublishes += 1;
          addRecent("backend-rejected", `${msg[1]}: ${msg[3] || ""}`);
        }
      }

      if (client.readyState === WebSocket.OPEN) {
        client.send(raw);
      }
    });

    backend.on("error", (error) => {
      stats.lastBackendErrorAt = Date.now();
      addRecent("backend-error", error.message);
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(["NOTICE", "error: relay backend unavailable"]));
      }
    });

    backend.on("close", () => {
      if (client.readyState === WebSocket.OPEN) {
        client.close(1011, "relay backend closed");
      }
    });

    client.on("message", (data) => {
      stats.clientMessages += 1;
      const raw = data.toString();
      const msg = safeJsonParse(raw);

      if (!Array.isArray(msg) || typeof msg[0] !== "string") {
        stats.malformedMessages += 1;
        addRecent("malformed", "invalid nostr message");
        client.send(JSON.stringify(["NOTICE", "invalid: malformed nostr message"]));
        return;
      }

      if (msg[0] === "EVENT") {
        stats.publishAttempts += 1;
        const event = msg[1] as NostrEvent | undefined;
        const result = verifyPow(event, minPow);

        if (!result.ok) {
          stats.powRejectedPublishes += 1;
          addRecent("pow-rejected", `${event?.id || "unknown"}: ${result.reason}`);
          sendOk(client, event?.id, false, `pow: ${result.reason}`);
          return;
        }

        if (!event) return;
        addRecent("publish", summarizeEvent(event, result.pow));
      } else if (msg[0] === "REQ" || msg[0] === "COUNT") {
        stats.reqMessages += 1;
      } else if (msg[0] === "CLOSE") {
        stats.closeMessages += 1;
      }

      if (backend.readyState === WebSocket.OPEN) {
        backend.send(raw);
      } else if (backend.readyState === WebSocket.CONNECTING) {
        queued.push(raw);
      } else {
        client.send(JSON.stringify(["NOTICE", "error: relay backend unavailable"]));
      }
    });

    client.on("close", () => {
      stats.activeClients = Math.max(0, stats.activeClients - 1);
      addRecent("client-closed", `${stats.activeClients} active`);
      if (backend.readyState === WebSocket.OPEN || backend.readyState === WebSocket.CONNECTING) {
        backend.close();
      }
    });
  };
}
