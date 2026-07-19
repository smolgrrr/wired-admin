import crypto from "node:crypto";
import { withTimeout } from "./utils.js";

export type XClientConfig = {
  dryRun: boolean;
  oauth1ApiKey: string;
  oauth1ApiSecret: string;
  oauth1AccessToken: string;
  oauth1AccessSecret: string;
};

export type PostTweetInput = {
  text?: string;
  inReplyToTweetId?: string | null;
  mediaIds?: string[];
  cardUri?: string | null;
};

type TweetRequestBody = {
  text?: string;
  card_uri?: string;
  reply?: {
    in_reply_to_tweet_id: string;
  };
  media?: {
    media_ids: string[];
  };
};

export type XClient = ReturnType<typeof createXClient>;

function oauthPercentEncode(value: string): string {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
}

function oauthNonce() {
  return crypto.randomBytes(16).toString("base64url");
}

export function createXClient(config: XClientConfig, timeoutMs: number) {
  function configured(): boolean {
    return Boolean(
      config.oauth1ApiKey &&
        config.oauth1ApiSecret &&
        config.oauth1AccessToken &&
        config.oauth1AccessSecret,
    );
  }

  function authMode(): "oauth1" | "dry_run" | "none" {
    if (configured()) return "oauth1";
    if (config.dryRun) return "dry_run";
    return "none";
  }

  function oauth1AuthorizationHeader(method: string, url: string): string {
    const oauthParams = {
      oauth_consumer_key: config.oauth1ApiKey,
      oauth_nonce: oauthNonce(),
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(Math.floor(Date.now() / 1000)),
      oauth_token: config.oauth1AccessToken,
      oauth_version: "1.0",
    };

    const parsedUrl = new URL(url);
    const signatureParams = [
      ...Object.entries(oauthParams),
      ...[...parsedUrl.searchParams.entries()],
    ].sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
      return leftKey.localeCompare(rightKey);
    });
    const parameterString = signatureParams
      .map(([key, value]) => `${oauthPercentEncode(key)}=${oauthPercentEncode(value)}`)
      .join("&");
    const normalizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`;
    const signatureBase = [
      method.toUpperCase(),
      oauthPercentEncode(normalizedUrl),
      oauthPercentEncode(parameterString),
    ].join("&");
    const signingKey = `${oauthPercentEncode(config.oauth1ApiSecret)}&${oauthPercentEncode(
      config.oauth1AccessSecret,
    )}`;
    const signature = crypto
      .createHmac("sha1", signingKey)
      .update(signatureBase)
      .digest("base64");

    return `OAuth ${Object.entries({ ...oauthParams, oauth_signature: signature })
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
      .join(", ")}`;
  }

  async function postTweet({
    text = "",
    inReplyToTweetId = null,
    mediaIds = [],
    cardUri = null,
  }: PostTweetInput = {}): Promise<Response> {
    const url = "https://api.x.com/2/tweets";
    const body: TweetRequestBody = {};
    const trimmedText = String(text || "").trim();
    const trimmedCardUri = String(cardUri || "").trim();
    if (trimmedText) body.text = trimmedText;
    if (trimmedCardUri) body.card_uri = trimmedCardUri;
    if (inReplyToTweetId) {
      body.reply = { in_reply_to_tweet_id: inReplyToTweetId };
    }
    if (mediaIds.length > 0) {
      body.media = { media_ids: mediaIds };
    }
    return withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: oauth1AuthorizationHeader("POST", url),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      timeoutMs,
      "X post",
    );
  }

  async function uploadImage(buffer: Buffer): Promise<Response> {
    const url = "https://api.x.com/2/media/upload";
    const form = new FormData();
    form.append("media_category", "tweet_image");
    form.append("media_type", "image/png");
    form.append("media", new Blob([buffer], { type: "image/png" }), "wired-confess.png");

    return withTimeout(
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: oauth1AuthorizationHeader("POST", url),
        },
        body: form,
      }),
      timeoutMs,
      "X media upload",
    );
  }

  return {
    authMode,
    configured,
    postTweet,
    uploadImage,
  };
}
