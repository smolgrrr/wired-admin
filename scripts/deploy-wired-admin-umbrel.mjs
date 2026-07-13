#!/usr/bin/env node
import {spawn} from "node:child_process";
import {promises as fs} from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_APP_ID = "smolgrrr-wired-admin";
const DEFAULT_UMBREL_DIR = "/home/umbrel/umbrel";
const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:3000";

const env = process.env;
const appId = env.WIRED_ADMIN_APP_ID || DEFAULT_APP_ID;
const umbrelDir = env.UMBREL_DIR || DEFAULT_UMBREL_DIR;
const appDataDir = env.WIRED_ADMIN_APP_DATA_DIR || path.join(umbrelDir, "app-data", appId);
const deployRef = env.WIRED_ADMIN_DEPLOY_REF || "main";
const dryRun = boolEnv("WIRED_ADMIN_DRY_RUN");

function boolEnv(name) {
  return /^(1|true|yes)$/i.test(env[name] || "");
}

function log(message) {
  console.log(`[wired-admin-deploy] ${message}`);
}

function fail(message) {
  throw new Error(message);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function run(command, args, options = {}) {
  const {cwd, extraEnv, capture = true} = options;
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {...process.env, ...extraEnv},
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({stdout: stdout.trim(), stderr: stderr.trim()});
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code}${stderr ? `: ${stderr}` : ""}`));
    });
  });
}

async function discoverAppStoreDir() {
  const configured = env.WIRED_ADMIN_APP_STORE_DIR;
  if (configured) return configured;

  const candidates = [process.cwd()];
  for (const base of [path.join(umbrelDir, "app-stores"), path.join(umbrelDir, "repos")]) {
    if (!(await pathExists(base))) continue;
    const entries = await fs.readdir(base, {withFileTypes: true});
    for (const entry of entries) {
      if (entry.isDirectory()) candidates.push(path.join(base, entry.name));
    }
  }

  for (const candidate of candidates) {
    if (
      (await pathExists(path.join(candidate, ".git"))) &&
      (await pathExists(path.join(candidate, appId, "docker-compose.yml"))) &&
      (await pathExists(path.join(candidate, appId, "umbrel-app.yml")))
    ) {
      return candidate;
    }
  }

  fail(`Could not find app-store checkout containing ${appId}. Set WIRED_ADMIN_APP_STORE_DIR.`);
}

async function fastForwardCheckout(repoDir) {
  if (boolEnv("WIRED_ADMIN_SYNC_PACKAGE_TO_APP_STORE")) {
    log("Skipping app-store git update because WIRED_ADMIN_SYNC_PACKAGE_TO_APP_STORE is set.");
    return;
  }

  if (boolEnv("WIRED_ADMIN_SKIP_GIT_UPDATE")) {
    log("Skipping app-store git update because WIRED_ADMIN_SKIP_GIT_UPDATE is set.");
    return;
  }

  if (!(await pathExists(path.join(repoDir, ".git")))) {
    log(`Skipping git update because ${repoDir} is not a git checkout.`);
    return;
  }

  const status = await run("git", ["status", "--porcelain"], {cwd: repoDir});
  if (status.stdout && !boolEnv("WIRED_ADMIN_ALLOW_DIRTY_APP_STORE")) {
    fail(`App-store checkout has uncommitted changes. Commit/stash them or set WIRED_ADMIN_ALLOW_DIRTY_APP_STORE=1.`);
  }

  log(`Fast-forwarding app-store checkout at ${repoDir} to ${deployRef}.`);
  await run("git", ["fetch", "origin", deployRef, "--prune"], {cwd: repoDir, capture: false});
  await run("git", ["checkout", deployRef], {cwd: repoDir, capture: false});
  await run("git", ["pull", "--ff-only", "origin", deployRef], {cwd: repoDir, capture: false});
}

function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if ((char === `"` || char === "'") && (!quote || quote === char)) quote = quote ? "" : char;
    if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trim();
  }
  return value.trim();
}

function parseYamlScalar(raw) {
  const value = stripYamlComment(raw);
  if (
    (value.startsWith(`"`) && value.endsWith(`"`)) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteYamlString(value) {
  return JSON.stringify(String(value));
}

function lineIndent(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function yamlKeyPattern(key) {
  return new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.*)$`);
}

function findChildBlock(lines, parentStart, parentEnd, key) {
  const parentIndent = lineIndent(lines[parentStart]);
  const pattern = yamlKeyPattern(key);
  for (let i = parentStart + 1; i < parentEnd; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = lineIndent(line);
    if (indent <= parentIndent) break;
    const match = line.match(pattern);
    if (!match || indent !== match[1].length) continue;
    const childIndent = indent;
    let end = parentEnd;
    for (let j = i + 1; j < parentEnd; j += 1) {
      const candidate = lines[j];
      if (!candidate.trim() || candidate.trimStart().startsWith("#")) continue;
      if (lineIndent(candidate) <= childIndent) {
        end = j;
        break;
      }
    }
    return {start: i, end};
  }
  return null;
}

function findServicesBlock(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^services\s*:/.test(lines[i])) {
      let end = lines.length;
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (!line.trim() || line.trimStart().startsWith("#")) continue;
        if (lineIndent(line) === 0 && /^[A-Za-z0-9_-]+\s*:/.test(line)) {
          end = j;
          break;
        }
      }
      return {start: i, end};
    }
  }
  fail("Could not find top-level services block in docker-compose.yml.");
}

function findWebServiceBlock(lines) {
  const services = findServicesBlock(lines);
  const web = findChildBlock(lines, services.start, services.end, "web");
  if (!web) fail("Could not find services.web in docker-compose.yml.");
  return web;
}

function readScalarInBlock(lines, block, key) {
  const pattern = yamlKeyPattern(key);
  for (let i = block.start + 1; i < block.end; i += 1) {
    const match = lines[i].match(pattern);
    if (match) return parseYamlScalar(match[2]);
  }
  fail(`Could not find ${key} in docker-compose.yml.`);
}

function updateScalarInBlock(lines, block, key, value, {quote = true, insert = false} = {}) {
  const pattern = yamlKeyPattern(key);
  for (let i = block.start + 1; i < block.end; i += 1) {
    const match = lines[i].match(pattern);
    if (!match) continue;
    const rendered = quote ? quoteYamlString(value) : String(value);
    lines[i] = `${match[1]}${key}: ${rendered}`;
    return true;
  }
  if (insert) {
    const rendered = quote ? quoteYamlString(value) : String(value);
    const indent = " ".repeat(lineIndent(lines[block.start]) + 2);
    lines.splice(block.end, 0, `${indent}${key}: ${rendered}`);
    block.end += 1;
    return true;
  }
  fail(`Could not update ${key} in docker-compose.yml.`);
}

function updateTopLevelScalar(text, key, value, {quote = true} = {}) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (trailingNewline) lines.pop();

  const pattern = yamlKeyPattern(key);
  for (let i = 0; i < lines.length; i += 1) {
    if (lineIndent(lines[i]) !== 0) continue;
    const match = lines[i].match(pattern);
    if (!match) continue;
    const rendered = quote ? quoteYamlString(value) : String(value);
    lines[i] = `${match[1]}${key}: ${rendered}`;
    return `${lines.join(newline)}${trailingNewline ? newline : ""}`;
  }

  fail(`Could not update top-level ${key} in umbrel-app.yml.`);
}

function prefixedEnvironmentOverrides() {
  const prefix = "WIRED_ADMIN_SET_";
  return Object.fromEntries(
    Object.entries(env)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value || ""])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function getComposeTarget(composeText) {
  const lines = composeText.split(/\r?\n/);
  const web = findWebServiceBlock(lines);
  const envBlock = findChildBlock(lines, web.start, web.end, "environment");
  if (!envBlock) fail("Could not find services.web.environment in package docker-compose.yml.");

  return {
    image: readScalarInBlock(lines, web, "image"),
    relayVersion: readScalarInBlock(lines, envBlock, "RELAY_VERSION"),
    environment: prefixedEnvironmentOverrides(),
  };
}

function updateInstalledCompose(composeText, target) {
  const newline = composeText.includes("\r\n") ? "\r\n" : "\n";
  const trailingNewline = composeText.endsWith("\n");
  const lines = composeText.split(/\r?\n/);
  if (trailingNewline) lines.pop();

  const web = findWebServiceBlock(lines);
  const envBlock = findChildBlock(lines, web.start, web.end, "environment");
  if (!envBlock) fail("Could not find services.web.environment in installed docker-compose.yml.");

  updateScalarInBlock(lines, web, "image", target.image, {quote: false});
  updateScalarInBlock(lines, envBlock, "RELAY_VERSION", target.relayVersion, {quote: true});
  for (const [key, value] of Object.entries(target.environment)) {
    updateScalarInBlock(lines, envBlock, key, value, {quote: true, insert: true});
  }

  return `${lines.join(newline)}${trailingNewline ? newline : ""}`;
}

function readTopLevelYamlScalar(text, key) {
  const pattern = yamlKeyPattern(key);
  for (const line of text.split(/\r?\n/)) {
    if (lineIndent(line) !== 0) continue;
    const match = line.match(pattern);
    if (match) return parseYamlScalar(match[2]);
  }
  fail(`Could not find top-level ${key} in umbrel-app.yml.`);
}

async function backupInstalledFiles(stamp) {
  const backupDir = path.join(appDataDir, "backups", `auto-deploy-${stamp}`);
  await fs.mkdir(backupDir, {recursive: true});

  for (const fileName of ["docker-compose.yml", "umbrel-app.yml"]) {
    const source = path.join(appDataDir, fileName);
    if (!(await pathExists(source))) fail(`Installed ${fileName} not found at ${source}.`);
    await fs.copyFile(source, path.join(backupDir, fileName));
  }

  log(`Backed up installed compose and manifest to ${backupDir}.`);
  return backupDir;
}

async function syncPackageToAppStore(appStoreDir, sourcePackageDir) {
  if (!boolEnv("WIRED_ADMIN_SYNC_PACKAGE_TO_APP_STORE")) return;

  const targetPackageDir = path.join(appStoreDir, appId);
  if (path.resolve(sourcePackageDir) === path.resolve(targetPackageDir)) {
    log("Package source is already inside the app-store checkout.");
    return;
  }

  if (!(await pathExists(sourcePackageDir))) {
    fail(`Source package directory not found at ${sourcePackageDir}.`);
  }

  if (dryRun) {
    log(`Dry run enabled; would sync ${sourcePackageDir} to ${targetPackageDir}.`);
    return;
  }

  await fs.rm(targetPackageDir, {recursive: true, force: true});
  await fs.cp(sourcePackageDir, targetPackageDir, {recursive: true});
  log(`Synced ${appId} package into Umbrel app-store checkout.`);
}

async function writeFileAtomic(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}`;
  const stat = await fs.stat(filePath);
  await fs.writeFile(tempPath, content, {mode: stat.mode});
  await fs.rename(tempPath, filePath);
}

async function callUmbreld(args) {
  const bin = env.UMBRELD_BIN || "umbreld";
  const result = await run(bin, ["client", ...args], {
    extraEnv: {
      UMBREL_DATA_DIR: umbrelDir,
      UMBREL_TRPC_ENDPOINT: env.UMBREL_TRPC_ENDPOINT || "http://localhost/trpc",
    },
  });
  if (!result.stdout) return null;
  return JSON.parse(result.stdout);
}

async function ensureAppStoreRepository() {
  const repositoryUrl = env.WIRED_ADMIN_APP_STORE_REPOSITORY_URL;
  if (!repositoryUrl) return;

  if (dryRun) {
    log(`Dry run enabled; would register Umbrel app-store repository ${repositoryUrl}.`);
    return;
  }

  log(`Registering Umbrel app-store repository ${repositoryUrl}.`);
  try {
    await callUmbreld(["appStore.addRepository.mutate", JSON.stringify({url: repositoryUrl})]);
  } catch (error) {
    if (error.message.includes("already exists")) {
      log(`Umbrel app-store repository already registered: ${repositoryUrl}`);
      return;
    }
    throw error;
  }
}

async function ensureAppInstalled() {
  const state = await callUmbreld(["apps.state.query", "--appId", appId]).catch((error) => ({error: error.message}));
  if (state?.state && state.state !== "not-installed") {
    log(`${appId} is already installed with state ${state.state}.`);
    return true;
  }

  if (dryRun) {
    log(`Dry run enabled; would install ${appId} through Umbrel tRPC.`);
    return false;
  }

  log(`Installing ${appId} through Umbrel tRPC.`);
  const installed = await callUmbreld(["apps.install.mutate", "--appId", appId]);
  if (installed !== true) fail(`Umbrel install returned ${JSON.stringify(installed)}.`);
  return true;
}

async function restartApp() {
  if (boolEnv("WIRED_ADMIN_SKIP_RESTART")) {
    log("Skipping Umbrel restart because WIRED_ADMIN_SKIP_RESTART is set.");
    return;
  }
  log(`Restarting ${appId} through Umbrel tRPC.`);
  await callUmbreld(["apps.restart.mutate", "--appId", appId]);
}

async function pollAppReady() {
  if (boolEnv("WIRED_ADMIN_SKIP_RESTART") || boolEnv("WIRED_ADMIN_SKIP_READY_POLL")) return;

  const timeoutMs = Number(env.WIRED_ADMIN_READY_TIMEOUT_MS || 180000);
  const intervalMs = Number(env.WIRED_ADMIN_READY_POLL_MS || 5000);
  const deadline = Date.now() + timeoutMs;
  let lastState = "unknown";

  while (Date.now() < deadline) {
    const state = await callUmbreld(["apps.state.query", "--appId", appId]).catch((error) => ({error: error.message}));
    if (state?.state) {
      lastState = `${state.state}${typeof state.progress === "number" ? ` (${state.progress}%)` : ""}`;
      log(`Umbrel app state: ${lastState}`);
      if (state.state === "ready" || state.state === "running") return;
      if (state.state === "stopped" || state.state === "not-installed") fail(`Umbrel app entered ${state.state} state.`);
    } else if (state?.error) {
      lastState = state.error;
      log(`Waiting for app state: ${state.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  fail(`Timed out waiting for ${appId} to become ready. Last state: ${lastState}`);
}

async function fetchJson(url) {
  const response = await fetch(url, {headers: {"Accept": "application/json"}});
  if (!response.ok) fail(`${url} returned HTTP ${response.status}`);
  return await response.json();
}

async function pollLocalStatus(targetVersion) {
  if (boolEnv("WIRED_ADMIN_SKIP_LOCAL_SMOKE") || dryRun) return;

  const baseUrl = (env.WIRED_ADMIN_LOCAL_BASE_URL || DEFAULT_LOCAL_BASE_URL).replace(/\/+$/, "");
  const statusUrl = `${baseUrl}/api/status`;
  const timeoutMs = Number(env.WIRED_ADMIN_LOCAL_SMOKE_TIMEOUT_MS || 120000);
  const intervalMs = Number(env.WIRED_ADMIN_LOCAL_SMOKE_POLL_MS || 5000);
  const deadline = Date.now() + timeoutMs;
  let lastVersion = "unknown";

  while (Date.now() < deadline) {
    try {
      const status = await fetchJson(statusUrl);
      lastVersion = status?.relayInfo?.version || "missing";
      if (lastVersion === targetVersion) {
        log(`Local smoke passed: /api/status reports version ${lastVersion}.`);
        return;
      }
      log(`Waiting for local /api/status version ${targetVersion}; current ${lastVersion}.`);
    } catch (error) {
      log(`Waiting for local /api/status: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  fail(`Timed out waiting for local /api/status version ${targetVersion}. Last version: ${lastVersion}`);
}

function configuredPublicSmokeUrls() {
  if (env.WIRED_ADMIN_PUBLIC_SMOKE_URLS) {
    return env.WIRED_ADMIN_PUBLIC_SMOKE_URLS.split(/[,\s]+/).map((url) => url.trim()).filter(Boolean);
  }
  if (!env.WIRED_ADMIN_PUBLIC_BASE_URL) return [];
  const baseUrl = env.WIRED_ADMIN_PUBLIC_BASE_URL.replace(/\/+$/, "");
  return [
    `${baseUrl}/api/confess/status`,
    `${baseUrl}/api/feed/bootstrap`,
    `${baseUrl}/api/wired-account/status`,
  ];
}

async function smokePublicEndpoints() {
  if (dryRun) return;
  const urls = configuredPublicSmokeUrls();
  if (urls.length === 0) {
    log("Skipping public smoke checks; no public smoke URLs configured.");
    return;
  }

  for (const url of urls) {
    await fetchJson(url);
    log(`Public smoke passed: ${new URL(url).pathname}`);
  }
}

async function main() {
  await ensureAppStoreRepository();

  const appStoreDir = await discoverAppStoreDir();
  await fastForwardCheckout(appStoreDir);

  const sourcePackageDir = env.WIRED_ADMIN_SOURCE_PACKAGE_DIR || env.WIRED_ADMIN_PACKAGE_DIR || path.join(appStoreDir, appId);
  await syncPackageToAppStore(appStoreDir, sourcePackageDir);

  const packageDir = env.WIRED_ADMIN_PACKAGE_DIR || sourcePackageDir;
  const packageComposePath = path.join(packageDir, "docker-compose.yml");
  const packageManifestPath = path.join(packageDir, "umbrel-app.yml");
  const installedComposePath = path.join(appDataDir, "docker-compose.yml");
  const installedManifestPath = path.join(appDataDir, "umbrel-app.yml");

  const packageCompose = await fs.readFile(packageComposePath, "utf8");
  const packageManifest = await fs.readFile(packageManifestPath, "utf8");
  const target = getComposeTarget(packageCompose);
  target.image = env.WIRED_ADMIN_IMAGE_OVERRIDE || target.image;
  target.relayVersion = env.WIRED_ADMIN_RELAY_VERSION_OVERRIDE || target.relayVersion;
  const manifestVersion = readTopLevelYamlScalar(packageManifest, "version");

  if (manifestVersion !== target.relayVersion && !boolEnv("WIRED_ADMIN_ALLOW_VERSION_MISMATCH")) {
    fail(`Package manifest version ${manifestVersion} does not match RELAY_VERSION ${target.relayVersion}.`);
  }

  log(`Target image: ${target.image}`);
  log(`Target version: ${target.relayVersion}`);
  if (Object.keys(target.environment).length > 0) {
    log(`Compose environment overrides: ${Object.keys(target.environment).join(", ")}`);
  }

  const appInstalled = await ensureAppInstalled();
  if (!appInstalled) {
    log("Dry run stopped before installed app file inspection because the app is not installed yet.");
    return;
  }

  const installedCompose = await fs.readFile(installedComposePath, "utf8");
  const updatedCompose = updateInstalledCompose(installedCompose, target);
  const updatedManifest = env.WIRED_ADMIN_MANIFEST_VERSION_OVERRIDE || env.WIRED_ADMIN_RELAY_VERSION_OVERRIDE
    ? updateTopLevelScalar(packageManifest, "version", env.WIRED_ADMIN_MANIFEST_VERSION_OVERRIDE || target.relayVersion, {quote: true})
    : packageManifest;

  if (dryRun) {
    log("Dry run enabled; no installed files were changed, no backups were created, and no restart was requested.");
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  await backupInstalledFiles(stamp);

  if (updatedCompose !== installedCompose) {
    await writeFileAtomic(installedComposePath, updatedCompose);
    log("Updated installed docker-compose.yml image and RELAY_VERSION.");
  } else {
    log("Installed docker-compose.yml already has the target image and RELAY_VERSION.");
  }

  await writeFileAtomic(installedManifestPath, updatedManifest);
  log("Copied package umbrel-app.yml into installed app data.");

  await restartApp();
  await pollAppReady();
  await pollLocalStatus(target.relayVersion);
  await smokePublicEndpoints();

  log("Deploy completed.");
}

main().catch((error) => {
  console.error(`[wired-admin-deploy] ERROR: ${error.message}`);
  process.exit(1);
});
