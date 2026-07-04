export function envList(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

export function envFlag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export function normalizeHost(value) {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed) return "";

  try {
    return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname
      .replace(/\.$/, "");
  } catch {
    return trimmed.split(":")[0].replace(/\.$/, "");
  }
}

export function requestHost(req) {
  const forwardedHost = String(req.headers["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  return normalizeHost(forwardedHost || req.headers.host || "");
}

export function hostMatchesPattern(host, pattern) {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }

  return host === pattern;
}

export function isPublicHost(req, publicHostPatterns) {
  const host = requestHost(req);
  return Boolean(host && publicHostPatterns.some((pattern) => hostMatchesPattern(host, pattern)));
}

export function normalizeUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

export function uniqueSorted(values) {
  return [...new Set([...values].filter(Boolean))].sort();
}

export function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export function summarizeHttpError(payload) {
  if (!payload) return "empty response";
  if (typeof payload.detail === "string") return payload.detail;
  if (typeof payload.title === "string") return payload.title;
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    return payload.errors
      .map((error) => error.detail || error.message || error.title || String(error))
      .join("; ")
      .slice(0, 300);
  }
  return JSON.stringify(payload).slice(0, 300);
}
