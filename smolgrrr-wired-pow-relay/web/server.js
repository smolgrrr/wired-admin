import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import WebSocket, { WebSocketServer } from "ws";
import { getEventHash } from "nostr-tools";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const port = Number(process.env.PORT || 3000);
const backendUrl = process.env.RELAY_BACKEND_URL || "ws://relay:7777";
const minPow = Number(process.env.RELAY_MIN_POW || 16);

const relayInfo = {
  name: process.env.RELAY_NAME || "Wired PoW Relay",
  description: process.env.RELAY_DESCRIPTION || "A Wired proof-of-work Nostr relay backed by strfry.",
  pubkey: process.env.RELAY_PUBKEY || undefined,
  contact: process.env.RELAY_CONTACT || undefined,
  icon: process.env.RELAY_ICON || undefined,
  supported_nips: [1, 9, 11, 13, 15, 20, 22, 33, 40],
  software: process.env.RELAY_SOFTWARE || "https://github.com/smolgrrr/wired-pow-relay-app",
  version: process.env.RELAY_VERSION || "0.1.0",
  limitation: {
    auth_required: false,
    payment_required: false,
    min_pow_difficulty: minPow,
  },
};

const stats = {
  startedAt: Date.now(),
  backendUrl,
  minPow,
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

function addRecent(type, detail) {
  stats.recent.unshift({
    at: Date.now(),
    type,
    detail,
  });
  stats.recent = stats.recent.slice(0, 50);
}

function countLeadingZeroBits(hex) {
  let count = 0;
  for (const char of hex) {
    const nibble = Number.parseInt(char, 16);
    if (Number.isNaN(nibble)) return 0;
    if (nibble === 0) {
      count += 4;
      continue;
    }
    return count + Math.clz32(nibble) - 28;
  }
  return count;
}

function verifyPow(event) {
  if (!event || typeof event !== "object") {
    return { ok: false, reason: "invalid event", pow: 0 };
  }

  let hash;
  try {
    hash = getEventHash(event);
  } catch {
    return { ok: false, reason: "invalid event hash", pow: 0 };
  }

  if (hash !== event.id) {
    return { ok: false, reason: "event id does not match event hash", pow: countLeadingZeroBits(hash) };
  }

  const pow = countLeadingZeroBits(hash);
  const nonceTag = Array.isArray(event.tags)
    ? event.tags.find((tag) => Array.isArray(tag) && tag[0] === "nonce")
    : undefined;
  const claimedTarget = Number.parseInt(nonceTag?.[2] || "", 10);

  if (!nonceTag || Number.isNaN(claimedTarget)) {
    return { ok: false, reason: "missing nonce tag", pow };
  }

  if (claimedTarget < minPow) {
    return { ok: false, reason: `nonce target ${claimedTarget} is below ${minPow}`, pow };
  }

  if (pow < minPow) {
    return { ok: false, reason: `proof ${pow} is below ${minPow}`, pow };
  }

  return { ok: true, reason: "", pow };
}

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

function handleClientConnection(client) {
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
      const result = verifyPow(event);

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
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.disable("x-powered-by");

app.get("/api/status", (_req, res) => {
  res.json({
    ...stats,
    uptimeSeconds: Math.floor((Date.now() - stats.startedAt) / 1000),
    relayInfo,
    generatedAt: Date.now(),
    instanceId: crypto.createHash("sha256").update(`${stats.startedAt}:${backendUrl}`).digest("hex").slice(0, 12),
  });
});

app.get("/", (req, res, next) => {
  const accept = String(req.headers.accept || "");
  if (accept.includes("application/nostr+json")) {
    res.type("application/nostr+json").json(relayInfo);
    return;
  }
  next();
});

app.use(express.static(path.join(__dirname, "public"), {
  extensions: ["html"],
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-store");
  },
}));

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/" && url.pathname !== "/relay") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    handleClientConnection(ws);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Wired PoW Relay gateway listening on ${port}`);
  console.log(`Proxying Nostr traffic to ${backendUrl}`);
});
