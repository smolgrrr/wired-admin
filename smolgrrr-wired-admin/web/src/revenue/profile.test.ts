import assert from "node:assert/strict";
import test from "node:test";
import { buildRevenueProfileMetadata } from "./profile.js";

test("revenue profile metadata preserves the configured identity and uses Wired LNURL", () => {
  assert.deepEqual(buildRevenueProfileMetadata({
    publicBaseUrl: "https://relay.wiredsignal.online",
    lnurlUsername: "wired",
    name: "Wired",
    about: "high signal posts from the Wired",
    website: "wiredsignal.online",
    picture: "https://cdn.example/wired.gif",
    banner: "https://cdn.example/wired.jpg",
  }), {
    name: "Wired",
    display_name: "Wired",
    about: "high signal posts from the Wired",
    lud16: "wired@relay.wiredsignal.online",
    website: "wiredsignal.online",
    picture: "https://cdn.example/wired.gif",
    banner: "https://cdn.example/wired.jpg",
  });
});

test("staging profile metadata can use a distinct public name without empty optional fields", () => {
  assert.deepEqual(buildRevenueProfileMetadata({
    publicBaseUrl: "https://staging.wiredsignal.online",
    lnurlUsername: "wired",
    name: "Wired Staging",
  }), {
    name: "Wired Staging",
    display_name: "Wired Staging",
    about: "Proof-of-work posts routed through Wired.",
    lud16: "wired@staging.wiredsignal.online",
  });
});
