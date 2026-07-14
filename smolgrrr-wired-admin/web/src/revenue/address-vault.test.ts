import assert from "node:assert/strict";
import test from "node:test";
import { AddressVault } from "./address-vault.js";

test("rotated encryption keys retain old decryption and stable payout grouping", () => {
  const firstKey = Buffer.alloc(32, 1);
  const secondKey = Buffer.alloc(32, 2);
  const firstVault = new AddressVault(firstKey, 1);
  const oldSnapshot = firstVault.encrypt("creator@example.com");
  const rotatedVault = new AddressVault(secondKey, 2, { 1: firstKey });
  const newSnapshot = rotatedVault.encrypt("creator@example.com");

  assert.equal(rotatedVault.decrypt(oldSnapshot), "creator@example.com");
  assert.equal(rotatedVault.decrypt(newSnapshot), "creator@example.com");
  assert.equal(newSnapshot.keyVersion, 2);
  assert.equal(newSnapshot.payoutKey, oldSnapshot.payoutKey);
});
