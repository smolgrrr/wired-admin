import { isPublicHost } from "./utils.js";

function acceptsNostrJson(req) {
  return String(req.headers.accept || "").includes("application/nostr+json");
}

function isPublicHttpRouteAllowed(req) {
  const url = new URL(req.originalUrl || req.url || "/", "http://localhost");

  if (url.pathname === "/") {
    return req.method === "GET" && acceptsNostrJson(req);
  }

  if (url.pathname === "/api/feed/bootstrap") {
    return req.method === "GET" || req.method === "OPTIONS";
  }

  if (url.pathname === "/api/moderation/manifest") {
    return req.method === "GET" || req.method === "OPTIONS";
  }

  if (url.pathname === "/api/confess/status") {
    return req.method === "GET" || req.method === "OPTIONS";
  }

  if (url.pathname === "/api/confess") {
    return req.method === "POST" || req.method === "OPTIONS";
  }

  return false;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Admin-Token",
  );
}

function setSecurityHeaders(res, securityHeaders) {
  for (const [header, value] of Object.entries(securityHeaders)) {
    res.setHeader(header, value);
  }
}

function adminBearerToken(req) {
  const value = req.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  return value.slice("Bearer ".length).trim();
}

function isLocalRequest(req) {
  const remote = req.socket.remoteAddress || "";
  return remote === "127.0.0.1" || remote === "::1" || remote.startsWith("::ffff:127.");
}

export function createHttpAccess({ publicHostPatterns, securityHeaders }) {
  function isCronAuthorized(req) {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) return true;
    return req.headers.authorization === `Bearer ${cronSecret}`;
  }

  function isAdminAuthorized(req) {
    if (isPublicHost(req, publicHostPatterns)) return false;
    if (process.env.MODERATION_ADMIN_OPEN === "true") return true;

    const token = process.env.MODERATION_ADMIN_TOKEN;
    if (!token) return isLocalRequest(req) || process.env.NODE_ENV !== "production";
    return adminBearerToken(req) === token || req.headers["x-admin-token"] === token;
  }

  function middleware(req, res, next) {
    setSecurityHeaders(res, securityHeaders);
    setCorsHeaders(res);

    if (isPublicHost(req, publicHostPatterns) && !isPublicHttpRouteAllowed(req)) {
      res.status(404).json({ error: "not found" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  }

  return {
    isAdminAuthorized,
    isCronAuthorized,
    middleware,
  };
}
