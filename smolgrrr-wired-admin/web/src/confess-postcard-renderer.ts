import crypto from "node:crypto";
import net from "node:net";
import sharp from "sharp";
import { nip19 } from "nostr-tools";
import { countLeadingZeroBits } from "./pow.js";
import type { ProfileSummary } from "./contracts/api.js";

export type ConfessPostcardImageConfig = {
  width: number;
  height: number;
  maxBytes: number;
  template: string;
};

export type ConfessPostcardRendererOptions = {
  image: ConfessPostcardImageConfig;
  profileImage: {
    timeoutMs: number;
    maxBytes: number;
  };
  fetchProfileMetadata: (pubkeys: string[]) => Promise<Record<string, ProfileSummary>>;
};

export type ConfessPostcardRenderInput = {
  text: string;
  eventId: string;
  pubkey: string;
};

export type ConfessPostcardRenderResult = {
  buffer: Buffer;
  imageHash: string;
  imageBytes: number;
  width: number;
  height: number;
  template: string;
};

type SvgProfile = ProfileSummary | null;

function escapeXml(value: unknown): string {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeSvgText(value: unknown): string {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function wrapSvgText(value: unknown, maxCharacters: number, maxLines: number): string[] {
  const paragraphs = normalizeSvgText(value).split("\n");
  const lines: string[] = [];
  let truncated = false;

  for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex += 1) {
    const paragraph = paragraphs[paragraphIndex] ?? "";
    if (lines.length >= maxLines) {
      truncated = true;
      break;
    }
    if (!paragraph.trim()) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") lines.push("");
      continue;
    }

    let line = "";
    for (const word of paragraph.trim().split(/\s+/)) {
      const nextLine = line ? `${line} ${word}` : word;
      if (nextLine.length <= maxCharacters) {
        line = nextLine;
        continue;
      }

      if (line) lines.push(line);
      line = word;

      while (line.length > maxCharacters) {
        if (lines.length >= maxLines) {
          truncated = true;
          break;
        }
        lines.push(line.slice(0, maxCharacters));
        line = line.slice(maxCharacters);
      }

      if (lines.length >= maxLines) {
        truncated = true;
        break;
      }
    }

    if (line && lines.length < maxLines) lines.push(line);
    if (paragraphIndex < paragraphs.length - 1 && lines.length >= maxLines) {
      truncated = true;
      break;
    }
  }

  const limited = lines.slice(0, maxLines);
  if (limited.length === 0) limited.push("");
  if (truncated && limited.length > 0) {
    const lastLine = limited[limited.length - 1] ?? "";
    limited[limited.length - 1] = `${lastLine.replace(/\s+$/, "")}...`;
  }
  return limited;
}

function avatarCellsForPubkey(pubkey: string): boolean[] {
  const digest = crypto.createHash("sha256").update(String(pubkey || "")).digest();
  return Array.from({ length: 16 }, (_, index) => ((digest[index] ?? 0) & 1) === 1);
}

function truncateSvgLabel(value: unknown, maxLength: number): string {
  const label = String(value || "").replace(/\s+/g, " ").trim();
  if (label.length <= maxLength) return label;
  return `${label.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function confessProfileDisplayName(profile: SvgProfile, pubkey: string): string {
  if (profile?.displayName) return profile.displayName;
  if (profile?.name) return profile.name;
  try {
    return truncateSvgLabel(nip19.npubEncode(pubkey), 18);
  } catch {
    return "wired confess";
  }
}

function safeProfileImageMarkup({
  imageDataUri,
  cells,
  cardX,
  headerY,
  scale,
}: {
  imageDataUri: string | null;
  cells: string;
  cardX: number;
  headerY: number;
  scale: number;
}): string {
  const avatarX = cardX + Math.round(42 * scale);
  const avatarY = headerY - Math.round(24 * scale);
  const avatarSize = Math.round(48 * scale);
  const avatarRadius = Math.round(avatarSize / 2);
  const avatarCenterX = avatarX + avatarRadius;
  const avatarCenterY = avatarY + avatarRadius;

  if (imageDataUri) {
    return `
  <clipPath id="profile-avatar-clip">
    <circle cx="${avatarCenterX}" cy="${avatarCenterY}" r="${avatarRadius}" />
  </clipPath>
  <image href="${escapeXml(imageDataUri)}" x="${avatarX}" y="${avatarY}" width="${avatarSize}" height="${avatarSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#profile-avatar-clip)" />
  <circle cx="${avatarCenterX}" cy="${avatarCenterY}" r="${avatarRadius}" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="${Math.max(1, Math.round(1 * scale))}" />`;
  }

  return cells;
}

function confessPostcardSvg({
  text,
  eventId,
  pubkey,
  profile,
  profileImageDataUri,
  image,
}: ConfessPostcardRenderInput & {
  profile: SvgProfile;
  profileImageDataUri: string | null;
  image: ConfessPostcardImageConfig;
}): string {
  const { width, height } = image;
  const scale = width / 1200;
  const outer = Math.round(78 * scale);
  const cardX = Math.round(128 * scale);
  const cardY = Math.round(104 * scale);
  const cardWidth = width - cardX * 2;
  const cardHeight = height - cardY * 2;
  const headerY = cardY + Math.round(50 * scale);
  const bodyX = cardX + Math.round(42 * scale);
  const bodyY = cardY + Math.round(150 * scale);
  const fontSize = Math.max(24, Math.round(36 * scale));
  const lineHeight = Math.round(fontSize * 1.55);
  const maxBodyWidth = cardWidth - Math.round(84 * scale);
  const maxCharacters = Math.max(18, Math.floor(maxBodyWidth / (fontSize * 0.62)));
  const maxLines = Math.max(3, Math.floor((cardHeight - Math.round(290 * scale)) / lineHeight));
  const lines = wrapSvgText(text, maxCharacters, maxLines);
  const bodyTspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : line === "" ? lineHeight * 0.72 : lineHeight;
      return `<tspan x="${bodyX}" dy="${index === 0 ? 0 : dy}">${escapeXml(line)}</tspan>`;
    })
    .join("");
  const signal = Math.max(0, countLeadingZeroBits(String(eventId || "")));
  const shortEvent = String(eventId || "").slice(0, 12);
  const cells = avatarCellsForPubkey(pubkey)
    .map((filled, index) => {
      if (!filled) return "";
      const cell = Math.round(8 * scale);
      const gap = Math.round(2 * scale);
      const x = cardX + Math.round(42 * scale) + (index % 4) * (cell + gap);
      const y = headerY - Math.round(12 * scale) + Math.floor(index / 4) * (cell + gap);
      return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="#5eead4" opacity="0.55" />`;
    })
    .join("");
  const labelX = cardX + Math.round(92 * scale);
  const labelY = headerY + Math.round(11 * scale);
  const metaY = cardY + cardHeight - Math.round(54 * scale);
  const profileName = truncateSvgLabel(confessProfileDisplayName(profile, pubkey), 36);
  const profileAvatar = safeProfileImageMarkup({
    imageDataUri: profileImageDataUri,
    cells,
    cardX,
    headerY,
    scale,
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="signal-glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="${Math.max(2, 5 * scale)}" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
    <linearGradient id="card-shade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111118" />
      <stop offset="100%" stop-color="#0a0a0f" />
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="#050508" />
  <rect x="${outer}" y="${Math.round(56 * scale)}" width="${width - outer * 2}" height="${height - Math.round(112 * scale)}" fill="#0a0a0f" opacity="0.72" />
  <rect x="${cardX}" y="${cardY}" width="${cardWidth}" height="${cardHeight}" rx="${Math.round(10 * scale)}" fill="url(#card-shade)" stroke="rgba(255,255,255,0.08)" />
  <line x1="${cardX}" y1="${cardY + cardHeight - Math.round(96 * scale)}" x2="${cardX + cardWidth}" y2="${cardY + cardHeight - Math.round(96 * scale)}" stroke="rgba(255,255,255,0.06)" />
  ${profileAvatar}
  <text x="${labelX}" y="${labelY}" fill="#8a8a96" font-family="'IBM Plex Mono','DejaVu Sans Mono',monospace" font-size="${Math.round(22 * scale)}" letter-spacing="${0.4 * scale}">
    ${escapeXml(profileName)}
  </text>
  <text x="${bodyX}" y="${bodyY}" fill="#e8e8ec" font-family="'IBM Plex Mono','DejaVu Sans Mono',monospace" font-size="${fontSize}" line-height="${lineHeight}">
    ${bodyTspans}
  </text>
  <g font-family="'IBM Plex Mono','DejaVu Sans Mono',monospace" font-size="${Math.round(19 * scale)}" fill="#8a8a96">
    <text x="${bodyX}" y="${metaY}" fill="#5eead4" filter="url(#signal-glow)">signal ${signal}</text>
    <text x="${bodyX + Math.round(150 * scale)}" y="${metaY}">now</text>
  </g>
  <text x="${bodyX}" y="${cardY + cardHeight - Math.round(22 * scale)}" fill="#4a4a56" font-family="'IBM Plex Mono','DejaVu Sans Mono',monospace" font-size="${Math.round(15 * scale)}">
    ${escapeXml(shortEvent)} / wiredsignal.online
  </text>
</svg>`;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first = 0, second = 0] = parts;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isSafeProfileImageUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (parsed.protocol !== "https:") return false;
    if (!hostname || hostname === "localhost" || hostname.endsWith(".local")) return false;
    if (net.isIPv4(hostname) && isPrivateIpv4(hostname)) return false;
    if (net.isIPv6(hostname) && (hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd"))) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function createConfessPostcardRenderer({
  image,
  profileImage,
  fetchProfileMetadata,
}: ConfessPostcardRendererOptions) {
  async function fetchProfileImageDataUri(url: string | undefined): Promise<string | null> {
    if (!url || !isSafeProfileImageUrl(url)) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), profileImage.timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "image/*" },
      });
      if (!response.ok) return null;

      const contentType = String(response.headers.get("content-type") || "").toLowerCase();
      if (contentType && !contentType.startsWith("image/")) return null;

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > profileImage.maxBytes) return null;

      const arrayBuffer = await response.arrayBuffer();
      if (arrayBuffer.byteLength > profileImage.maxBytes) return null;

      const png = await sharp(Buffer.from(arrayBuffer), {
        limitInputPixels: 4096 * 4096,
      })
        .resize(128, 128, { fit: "cover" })
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer();
      return `data:image/png;base64,${png.toString("base64")}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveProfile(
    pubkey: string,
  ): Promise<{ profile: SvgProfile; imageDataUri: string | null }> {
    if (!/^[0-9a-f]{64}$/i.test(String(pubkey || ""))) {
      return { profile: null, imageDataUri: null };
    }

    try {
      const profiles = await fetchProfileMetadata([pubkey]);
      const profile = profiles[pubkey] || null;
      const imageDataUri = await fetchProfileImageDataUri(profile?.picture);
      return { profile, imageDataUri };
    } catch {
      return { profile: null, imageDataUri: null };
    }
  }

  async function render({
    text,
    eventId,
    pubkey,
  }: ConfessPostcardRenderInput): Promise<ConfessPostcardRenderResult> {
    const { profile, imageDataUri } = await resolveProfile(pubkey);
    const svg = confessPostcardSvg({
      text,
      eventId,
      pubkey,
      profile,
      profileImageDataUri: imageDataUri,
      image,
    });
    const buffer = await sharp(Buffer.from(svg), {
      limitInputPixels: image.width * image.height * 2,
    })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    const imageHash = crypto.createHash("sha256").update(buffer).digest("hex");
    if (buffer.byteLength > image.maxBytes) {
      const error = new Error(`generated X image exceeds ${image.maxBytes} bytes`) as Error & {
        imageHash: string;
        imageBytes: number;
      };
      error.imageHash = imageHash;
      error.imageBytes = buffer.byteLength;
      throw error;
    }
    return {
      buffer,
      imageHash,
      imageBytes: buffer.byteLength,
      width: image.width,
      height: image.height,
      template: image.template,
    };
  }

  return { render };
}
