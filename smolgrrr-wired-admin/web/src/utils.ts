import type { Request } from "express";

export function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? values : fallback;
}

export function envFlag(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export function normalizeHost(value: unknown): string {
  const trimmed = String(value || "").trim().toLowerCase();
  if (!trimmed) return "";

  try {
    return new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`).hostname
      .replace(/\.$/, "");
  } catch {
    return (trimmed.split(":")[0] || "").replace(/\.$/, "");
  }
}

export function requestHost(req: Request): string {
  const forwardedHost = (String(req.headers["x-forwarded-host"] || "").split(",")[0] || "").trim();
  return normalizeHost(forwardedHost || req.headers.host || "");
}

export function hostMatchesPattern(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }

  return host === pattern;
}

export function isPublicHost(req: Request, publicHostPatterns: string[]): boolean {
  const host = requestHost(req);
  return Boolean(host && publicHostPatterns.some((pattern) => hostMatchesPattern(host, pattern)));
}

export function normalizeUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

export function uniqueSorted<T extends string>(values: Iterable<T | "" | null | undefined>): T[] {
  return [...new Set([...values].filter((value): value is T => Boolean(value)))].sort();
}

export function normalizeRelayUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

export function uniqueRelays(relays: string[]): string[] {
  return [...new Set(relays.map(normalizeRelayUrl).filter(Boolean))];
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export function summarizeHttpError(payload: unknown): string {
  if (!payload) return "empty response";
  if (typeof payload !== "object") return String(payload).slice(0, 300);
  const record = payload as Record<string, unknown>;
  if (typeof record.detail === "string") return record.detail;
  if (typeof record.title === "string") return record.title;
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return record.errors
      .map((error) => {
        if (error && typeof error === "object") {
          const errorRecord = error as Record<string, unknown>;
          return errorRecord.detail || errorRecord.message || errorRecord.title || String(error);
        }
        return String(error);
      })
      .join("; ")
      .slice(0, 300);
  }
  return JSON.stringify(payload).slice(0, 300);
}
