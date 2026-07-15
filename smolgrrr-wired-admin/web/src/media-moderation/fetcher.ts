import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export type ResolvedAddress = { address: string; family: number };
export type FetchedMedia = { bytes: Buffer; contentType: string };
export type MediaTransportResult = FetchedMedia & {
  status: number;
  location?: string;
};

type FetchRemoteMediaOptions = {
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
  transport?: (input: {
    url: URL;
    address: ResolvedAddress;
    maxBytes: number;
    timeoutMs: number;
  }) => Promise<MediaTransportResult>;
};

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  ) {
    return false;
  }
  return true;
}

function isPublicIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("::ffff:")) return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  return normalized.startsWith("2") || normalized.startsWith("3");
}

export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

async function defaultResolve(hostname: string): Promise<ResolvedAddress[]> {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

async function defaultTransport({
  url,
  address,
  maxBytes,
  timeoutMs,
}: {
  url: URL;
  address: ResolvedAddress;
  maxBytes: number;
  timeoutMs: number;
}): Promise<MediaTransportResult> {
  const requester = url.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const request = requester(
      url,
      {
        headers: {
          Accept: "image/*,video/*;q=0.9,*/*;q=0.1",
          "User-Agent": "Wired-Media-Moderation/1.0",
        },
        family: address.family,
        lookup(_hostname, options, callback) {
          if (typeof options === "object" && options.all) {
            const allCallback = callback as unknown as (
              error: NodeJS.ErrnoException | null,
              addresses: Array<{ address: string; family: number }>,
            ) => void;
            allCallback(null, [address]);
            return;
          }
          callback(null, address.address, address.family as 4 | 6);
        },
        timeout: timeoutMs,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const contentLength = Number(response.headers["content-length"] || 0);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
          response.destroy(new Error("media exceeds byte limit"));
          return;
        }
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            response.destroy(new Error("media exceeds byte limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          clearTimeout(deadline);
          resolve({
            status: response.statusCode ?? 502,
            bytes: Buffer.concat(chunks),
            contentType: String(response.headers["content-type"] || "")
              .split(";", 1)[0]
              ?.trim()
              .toLowerCase() || "application/octet-stream",
            ...(response.headers.location
              ? { location: String(response.headers.location) }
              : {}),
          });
        });
        response.on("error", (error) => {
          clearTimeout(deadline);
          reject(error);
        });
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error("media fetch timed out")),
      timeoutMs,
    );
    request.on("timeout", () => request.destroy(new Error("media fetch timed out")));
    request.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end();
  });
}

export async function fetchRemoteMedia(
  source: string,
  options: FetchRemoteMediaOptions = {},
): Promise<FetchedMedia> {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024;
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const resolveAddress = options.resolve ?? defaultResolve;
  const transport = options.transport ?? defaultTransport;
  const visited = new Set<string>();
  let current = new URL(source);

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    if (current.protocol !== "http:" && current.protocol !== "https:") {
      throw new Error("media URL must use HTTP(S)");
    }
    if (current.username || current.password) throw new Error("media URL credentials are forbidden");
    if (visited.has(current.href)) throw new Error("media redirect loop");
    visited.add(current.href);

    const addresses = await resolveAddress(current.hostname);
    if (
      addresses.length === 0 ||
      addresses.some((address) => !isPublicAddress(address.address))
    ) {
      throw new Error("media host must resolve only to a public address");
    }
    const address = addresses[0];
    if (!address) throw new Error("media host did not resolve");
    const result = await transport({ url: current, address, maxBytes, timeoutMs });
    if (result.bytes.length > maxBytes) throw new Error("media exceeds byte limit");

    if (result.status >= 300 && result.status < 400 && result.location) {
      if (redirects === maxRedirects) throw new Error("media redirect limit exceeded");
      current = new URL(result.location, current);
      continue;
    }
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`media origin returned ${result.status}`);
    }
    return { bytes: result.bytes, contentType: result.contentType };
  }
  throw new Error("media redirect limit exceeded");
}
