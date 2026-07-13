#!/usr/bin/env node

import process from "node:process";
import {setTimeout as sleep} from "node:timers/promises";
import {verifyEvent} from "../smolgrrr-wired-admin/web/node_modules/nostr-tools/lib/esm/index.js";

const baseUrl = new URL(process.argv[2] || "https://staging.wiredsignal.online");
const attempts = 12;
const notBefore = Number(process.env.REVENUE_PROFILE_NOT_BEFORE || 0);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(url) {
  const response = await fetch(url, {cache: "no-store"});
  assert(response.ok, `${url} returned HTTP ${response.status}`);
  return response.json();
}

function latestRevenueProfile(relayUrl, pubkey) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(relayUrl);
    const subscriptionId = `wired-profile-${crypto.randomUUID()}`;
    const events = [];
    const timeout = setTimeout(() => finish(new Error(`timed out querying ${relayUrl}`)), 8_000);

    function finish(error) {
      clearTimeout(timeout);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(["CLOSE", subscriptionId]));
        socket.close();
      }
      if (error) reject(error);
      else resolve(events.sort((a, b) => b.created_at - a.created_at)[0] || null);
    }

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify([
        "REQ",
        subscriptionId,
        {
          kinds: [0],
          authors: [pubkey],
          ...(notBefore > 0 ? {since: notBefore} : {}),
          limit: 5,
        },
      ]));
    });
    socket.addEventListener("message", ({data}) => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message[0] === "EVENT" && message[1] === subscriptionId) events.push(message[2]);
      if (message[0] === "EOSE" && message[1] === subscriptionId) finish();
      if (message[0] === "NOTICE") finish(new Error(`${relayUrl}: ${message[1] || "relay notice"}`));
    });
    socket.addEventListener("error", () => finish(new Error(`failed to query ${relayUrl}`)));
  });
}

assert(baseUrl.protocol === "https:", "revenue profile verification requires an HTTPS base URL");
const configUrl = new URL("/api/revenue/config", baseUrl);
const config = await readJson(configUrl);
assert(config.enabled === true, "revenue routing is not enabled");
assert(/^[0-9a-f]{64}$/.test(config.recipientPubkey), "revenue recipient pubkey is invalid");
assert(/^wss:\/\//.test(config.relayUrl), "revenue metadata relay must use wss://");

const expectedLud16 = `wired@${baseUrl.hostname}`;
const discoveryUrl = new URL(`https://${baseUrl.hostname}/.well-known/lnurlp/wired`);
const discovery = await readJson(discoveryUrl);
assert(discovery.tag === "payRequest", "LNURL discovery is not a payRequest");
assert(discovery.allowsNostr === true, "LNURL discovery does not allow Nostr zaps");
assert(discovery.nostrPubkey === config.recipientPubkey, "LNURL receipt signer does not match revenue recipient");
assert(/^https:\/\//.test(discovery.callback), "LNURL callback must use HTTPS");

let lastError;
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const profile = await latestRevenueProfile(config.relayUrl, config.recipientPubkey);
    assert(profile, `no kind-0 metadata found on ${config.relayUrl}`);
    assert(verifyEvent(profile), "kind-0 event ID or signature is invalid");
    assert(profile.kind === 0, "retrieved event is not kind 0");
    assert(profile.pubkey === config.recipientPubkey, "kind-0 author does not match revenue recipient");
    assert(profile.created_at >= notBefore, "kind-0 predates this deployment");
    const metadata = JSON.parse(profile.content);
    assert(metadata.lud16 === expectedLud16, `kind-0 lud16 is not ${expectedLud16}`);
    console.log(`verified ${expectedLud16} for ${config.recipientPubkey} on ${config.relayUrl}`);
    process.exit(0);
  } catch (error) {
    lastError = error;
    if (attempt < attempts) await sleep(5_000);
  }
}

throw lastError;
