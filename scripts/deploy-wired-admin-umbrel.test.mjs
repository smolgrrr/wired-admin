import assert from "node:assert/strict";
import test from "node:test";
import {updateInstalledCompose} from "./deploy-wired-admin-umbrel.mjs";

const packageCompose = `services:
  web:
    image: package-image
    environment:
      RELAY_VERSION: package-version
  relay_init:
    image: strfry
    user: "0:0"
    entrypoint: ["chown"]
  relay:
    image: strfry
    user: "1000:1000"
    depends_on:
      relay_init:
        condition: service_completed_successfully
`;

const installedCompose = `services:
  app_proxy:
    image: umbrel-proxy
  web:
    image: old-image
    environment:
      RELAY_VERSION: old-version
  relay:
    image: old-strfry
    user: "1000:1000"
`;

test("an existing Umbrel compose receives top-level relay migration services", () => {
  const updated = updateInstalledCompose(installedCompose, packageCompose, {
    image: "new-image",
    relayVersion: "new-version",
    environment: {},
  });

  assert.equal(updated.match(/^  relay_init:/gm)?.length, 1);
  assert.equal(updated.match(/^      relay_init:/gm)?.length, 1);
  assert.match(updated, /^  relay_init:\n    image: strfry\n    user: "0:0"/m);
  assert.match(
    updated,
    /^  relay:\n    image: strfry\n    user: "1000:1000"\n    depends_on:\n      relay_init:/m,
  );
  assert.match(updated, /^    image: new-image$/m);
  assert.match(updated, /^      RELAY_VERSION: "new-version"$/m);
  assert.match(updated, /^  app_proxy:\n    image: umbrel-proxy$/m);
});
