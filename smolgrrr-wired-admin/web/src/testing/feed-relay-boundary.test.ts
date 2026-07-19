import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("feed snapshot production reads stay behind the finite relay session", async () => {
  const source = await readFile(
    path.join(process.cwd(), "src/feed-snapshot-service.ts"),
    "utf8",
  );

  assert.doesNotMatch(source, /\bRelay\.connect\s*\(/);
  assert.doesNotMatch(source, /\.subscribe\s*\(/);
  assert.doesNotMatch(source, /\bconnectRelays\b|\bsubscribeOnce\b/);
});
