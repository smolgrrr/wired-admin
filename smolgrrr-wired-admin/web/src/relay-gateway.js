import WebSocket from "ws";
import { verifyPow } from "./pow.js";

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sendOk(ws, eventId, ok, reason) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(["OK", eventId || "", ok, reason]));
  }
}

function summarizeEvent(event, pow) {
  return {
    id: event.id,
    kind: event.kind,
    pow,
    created_at: event.created_at,
  };
}

export function createRelayGateway({ backendUrl, minPow, stats, addRecent }) {
  return function handleClientConnection(client) {
    stats.activeClients += 1;
    stats.totalConnections += 1;
    addRecent("client-connected", `${stats.activeClients} active`);

    const backend = new WebSocket(backendUrl);
    const queued = [];

    backend.on("open", () => {
      stats.lastBackendOpenAt = Date.now();
      while (queued.length > 0 && backend.readyState === WebSocket.OPEN) {
        backend.send(queued.shift());
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
        const event = msg[1];
        const result = verifyPow(event, minPow);

        if (!result.ok) {
          stats.powRejectedPublishes += 1;
          addRecent("pow-rejected", `${event?.id || "unknown"}: ${result.reason}`);
          sendOk(client, event?.id, false, `pow: ${result.reason}`);
          return;
        }

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
