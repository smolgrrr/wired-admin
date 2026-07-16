import type {
  ModerationActionsResponse,
  MediaModerationAdminState,
  RelayRecentActivity,
  StatusResponse,
} from "../contracts/api.js";
import type { ModerationAction } from "../contracts/stores.js";

const fields = [
  "activeClients",
  "publishAttempts",
  "acceptedPublishes",
  "powRejectedPublishes",
  "backendRejectedPublishes",
  "reqMessages",
  "backendUrl",
] as const;

const ids = [
  ...fields,
  "health",
  "endpoint",
  "minPow",
  "postCount",
  "profileCount",
  "refreshing",
  "ageHours",
  "refreshSeconds",
  "bootstrapUrl",
  "snapshotFetchedAt",
  "powRelays",
  "enrichmentRelays",
  "lastRefreshError",
  "software",
  "nips",
  "activity",
  "actions",
  "updatedAt",
  "moderationSummary",
  "manifestUpdatedAt",
  "tokenForm",
  "adminToken",
  "moderationForm",
  "formStatus",
  "refreshSnapshot",
  "mediaMode",
  "mediaQueue",
  "mediaActive",
  "mediaLatency",
  "mediaSearch",
  "mediaVerdicts",
  "mediaOverrides",
  "mediaAudit",
  "mediaOverrideForm",
  "mediaOverrideStatus",
] as const;

type ElementId = (typeof ids)[number];
type StatField = (typeof fields)[number];
type AdminElements = Record<ElementId, HTMLElement> & {
  adminToken: HTMLInputElement;
  moderationForm: HTMLFormElement;
  refreshSnapshot: HTMLButtonElement;
  tokenForm: HTMLFormElement;
  mediaOverrideForm: HTMLFormElement;
  mediaSearch: HTMLInputElement;
};

function requireElement<T extends HTMLElement = HTMLElement>(id: ElementId): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing #${id}`);
  return element as T;
}

const elements = Object.fromEntries(ids.map((id) => [id, requireElement(id)])) as AdminElements;
elements.adminToken = requireElement<HTMLInputElement>("adminToken");
elements.moderationForm = requireElement<HTMLFormElement>("moderationForm");
elements.refreshSnapshot = requireElement<HTMLButtonElement>("refreshSnapshot");
elements.tokenForm = requireElement<HTMLFormElement>("tokenForm");
elements.mediaOverrideForm = requireElement<HTMLFormElement>("mediaOverrideForm");
elements.mediaSearch = requireElement<HTMLInputElement>("mediaSearch");

const ADMIN_TOKEN_STORAGE_KEY = "wiredAdminToken";

function adminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)?.trim() || "";
}

function adminHeaders(extra: Record<string, string> = {}): HeadersInit {
  const token = adminToken();
  return token ? { ...extra, "X-Admin-Token": token } : extra;
}

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m`;
  return `${seconds}s`;
}

function formatTime(value: number | string | null | undefined): string {
  if (!value) return "--";
  return new Date(value).toLocaleString();
}

function relayEndpoint(path = "/"): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

function httpEndpoint(path: string): string {
  return `${window.location.origin}${path}`;
}

function renderRecent(items: RelayRecentActivity[]): void {
  elements.activity.innerHTML = "";
  const recent =
    items.length > 0
      ? items
      : [{ at: Date.now(), type: "idle", detail: "waiting for relay activity" }];

  for (const item of recent) {
    elements.activity.append(activityItem(item.at, item.type, item.detail));
  }
}

function activityItem(at: number, type: string, detail: unknown): HTMLLIElement {
  const li = document.createElement("li");
  const time = document.createElement("time");
  const body = document.createElement("div");
  const heading = document.createElement("strong");
  const code = document.createElement("code");

  time.textContent = formatTime(at);
  heading.textContent = type;
  code.textContent = typeof detail === "string" ? detail : JSON.stringify(detail);

  body.append(heading, code);
  li.append(time, body);
  return li;
}

function renderActions(actions: ModerationAction[]): void {
  elements.actions.innerHTML = "";
  if (!actions.length) {
    elements.actions.append(activityItem(Date.now(), "empty", "no moderation actions"));
    return;
  }

  for (const action of actions) {
    const item = activityItem(
      action.createdAt,
      `${action.kind} / ${action.reason}`,
      `${action.value}${action.note ? ` - ${action.note}` : ""}`,
    );
    const button = document.createElement("button");
    button.className = "button danger delete-action";
    button.type = "button";
    button.textContent = "Remove";
    button.addEventListener("click", () => deleteAction(action.id));
    item.append(button);
    elements.actions.append(item);
  }
}

function responseErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === "object" && "error" in data) {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return fallback;
}

async function deleteAction(id: string): Promise<void> {
  elements.formStatus.textContent = "Removing";
  const response = await fetch(`/api/moderation/actions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    elements.formStatus.textContent = responseErrorMessage(data, `HTTP ${response.status}`);
    return;
  }

  elements.formStatus.textContent = "Action removed";
  await Promise.all([refresh(), fetchActions()]);
}

async function fetchActions(): Promise<void> {
  const response = await fetch("/api/moderation/actions", {
    cache: "no-store",
    headers: adminHeaders(),
  });
  if (!response.ok) {
    renderActions([]);
    elements.formStatus.textContent =
      response.status === 401 ? "Enter the admin token to manage actions." : "";
    return;
  }
  const data = (await response.json()) as ModerationActionsResponse;
  renderActions(data.actions || []);
}

function renderMediaAdmin(data: MediaModerationAdminState): void {
  elements.mediaMode.textContent = data.status.mode;
  elements.mediaQueue.textContent = String(data.status.queueDepth);
  elements.mediaActive.textContent = `${data.status.activeImages} image / ${data.status.activeVideos} video`;
  elements.mediaLatency.textContent = data.status.scanLatencyP95Ms === null
    ? "--"
    : `${data.status.scanLatencyP95Ms}ms p95 · queue ${Math.round(data.status.queueAgeMs / 1000)}s`;

  elements.mediaVerdicts.innerHTML = "";
  const query = elements.mediaSearch.value.trim().toLowerCase();
  const matchingVerdicts = data.verdicts.filter((verdict) =>
    !query || verdict.url.toLowerCase().includes(query) || verdict.sha256?.includes(query),
  );
  const groups = [
    ["likely violations", matchingVerdicts.filter((item) => item.status === "blocked")],
    ["review required", matchingVerdicts.filter((item) => item.status === "review-required")],
    ["detector unavailable", matchingVerdicts.filter((item) => item.status === "unavailable")],
    ["allowed", matchingVerdicts.filter((item) => item.status === "allowed")],
  ] as const;
  if (data.jobs.length > 0) {
    elements.mediaVerdicts.append(activityItem(Date.now(), "pending analysis", `${data.jobs.length} queued or active`));
  }
  for (const [label, verdicts] of groups) {
    if (verdicts.length === 0) continue;
    elements.mediaVerdicts.append(activityItem(Date.now(), label, `${verdicts.length} verdicts`));
    for (const verdict of verdicts.slice(0, 100)) {
    const item = activityItem(
      verdict.checkedAt,
      `${verdict.status} / ${verdict.mediaType}`,
      `${verdict.url} · ${verdict.reason}${verdict.sha256 ? ` · sha256:${verdict.sha256}` : ""}`,
    );
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button";
    button.textContent = "Re-scan";
    button.addEventListener("click", () => requestRescan(verdict.url));
    item.append(button);
    elements.mediaVerdicts.append(item);
    }
  }
  if (!data.jobs.length && !matchingVerdicts.length) {
    elements.mediaVerdicts.append(activityItem(Date.now(), "empty", "no media verdicts"));
  }

  elements.mediaOverrides.innerHTML = "";
  for (const override of data.overrides) {
    const item = activityItem(
      override.createdAt,
      `${override.decision} / ${override.targetType}`,
      `${override.target}${override.note ? ` · ${override.note}` : ""}`,
    );
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button danger";
    button.textContent = "Remove";
    button.addEventListener("click", () => removeMediaOverride(override.id));
    item.append(button);
    elements.mediaOverrides.append(item);
  }
  if (!data.overrides.length) {
    elements.mediaOverrides.append(activityItem(Date.now(), "empty", "no media overrides"));
  }

  elements.mediaAudit.innerHTML = "";
  for (const entry of data.audit.slice(0, 100)) {
    elements.mediaAudit.append(
      activityItem(entry.at, `${entry.action} / ${entry.actor}`, entry.target),
    );
  }
}

let latestMediaAdmin: MediaModerationAdminState | null = null;

async function fetchMediaAdmin(): Promise<void> {
  const response = await fetch("/api/media-moderation/admin", {
    cache: "no-store",
    headers: adminHeaders(),
  });
  if (!response.ok) {
    const message = response.status === 401
      ? "Enter the admin token above to load stored scan results."
      : `Media verdict request failed (HTTP ${response.status}).`;
    elements.mediaOverrideStatus.textContent = message;
    elements.mediaVerdicts.innerHTML = "";
    elements.mediaVerdicts.append(
      activityItem(Date.now(), "media verdicts unavailable", message),
    );
    return;
  }
  latestMediaAdmin = (await response.json()) as MediaModerationAdminState;
  renderMediaAdmin(latestMediaAdmin);
}

async function requestRescan(url: string): Promise<void> {
  const response = await fetch("/api/media-moderation/rescan", {
    method: "POST",
    headers: adminHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ url }),
  });
  elements.mediaOverrideStatus.textContent = response.ok ? "Re-scan queued" : "Re-scan failed";
  await fetchMediaAdmin();
}

async function removeMediaOverride(id: string): Promise<void> {
  const response = await fetch(`/api/media-moderation/overrides/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: adminHeaders(),
  });
  elements.mediaOverrideStatus.textContent = response.ok ? "Override removed" : "Remove failed";
  await fetchMediaAdmin();
}

async function refresh(): Promise<void> {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as StatusResponse;
    const snapshot = data.snapshot || {};
    const moderation = data.moderation || {};
    const manifest = moderation.manifest || {};

    elements.health.textContent = "online";
    elements.health.className = "status-pill ok";
    elements.endpoint.textContent = relayEndpoint("/");
    elements.minPow.textContent = String(data.minPow);
    elements.postCount.textContent = String(snapshot.postCount ?? 0);
    elements.profileCount.textContent = String(snapshot.profileCount ?? 0);
    elements.refreshing.textContent = snapshot.refreshing ? "yes" : "no";
    elements.ageHours.textContent = `${snapshot.ageHours ?? "--"}h`;
    elements.refreshSeconds.textContent = formatDuration(snapshot.refreshSeconds || 0);
    elements.bootstrapUrl.textContent = httpEndpoint("/api/feed/bootstrap");
    elements.snapshotFetchedAt.textContent = formatTime(snapshot.fetchedAt);
    elements.powRelays.textContent = (snapshot.powRelays || []).join(", ");
    elements.enrichmentRelays.textContent = (snapshot.enrichmentRelays || []).join(", ");
    elements.lastRefreshError.textContent = snapshot.lastRefreshError || "--";
    elements.software.textContent = `${data.relayInfo.software} ${data.relayInfo.version}`;
    elements.nips.textContent = data.relayInfo.supported_nips.join(", ");
    elements.updatedAt.textContent = `updated ${new Date(data.generatedAt).toLocaleTimeString()}`;
    elements.moderationSummary.textContent = `${moderation.actionCount || 0} actions`;
    elements.manifestUpdatedAt.textContent = manifest.updatedAt
      ? `manifest ${formatTime(manifest.updatedAt)}`
      : "manifest empty";

    for (const field of fields) {
      elements[field].textContent = String(data[field]);
    }

    renderRecent(data.recent || []);
  } catch (error) {
    elements.health.textContent = "offline";
    elements.health.className = "status-pill bad";
    elements.updatedAt.textContent = error instanceof Error ? error.message : "refresh failed";
  }
}

async function refreshSnapshot(): Promise<void> {
  elements.refreshSnapshot.disabled = true;
  elements.refreshSnapshot.textContent = "Refreshing";
  try {
    await fetch("/api/cron/refresh-feed", {
      cache: "no-store",
      headers: adminHeaders({ Authorization: `Bearer ${adminToken()}` }),
    });
    await refresh();
  } finally {
    elements.refreshSnapshot.disabled = false;
    elements.refreshSnapshot.textContent = "Refresh now";
  }
}

function setupTokenForm(): void {
  elements.adminToken.value = adminToken();
  elements.tokenForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = elements.adminToken.value.trim();
    if (token) {
      localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
      elements.formStatus.textContent = "Admin token saved";
    } else {
      localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      elements.formStatus.textContent = "Admin token cleared";
    }
    void Promise.all([refresh(), fetchActions(), fetchMediaAdmin()]);
  });
}

function setupTabs(): void {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((item) => item.classList.remove("active"));
      document
        .querySelectorAll(".tab-panel")
        .forEach((panel) => panel.classList.remove("active"));
      tab.classList.add("active");
      if (!(tab instanceof HTMLElement)) return;
      const panel = document.getElementById(`tab-${tab.dataset.tab}`);
      panel?.classList.add("active");
    });
  });
}

function setupModerationForm(): void {
  elements.moderationForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(elements.moderationForm);
    elements.formStatus.textContent = "Saving";

    const response = await fetch("/api/moderation/actions", {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      elements.formStatus.textContent = responseErrorMessage(data, `HTTP ${response.status}`);
      return;
    }

    elements.moderationForm.reset();
    elements.formStatus.textContent = "Action added";
    await Promise.all([refresh(), fetchActions()]);
  });
}

function setupMediaOverrideForm(): void {
  elements.mediaOverrideForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const formData = new FormData(elements.mediaOverrideForm);
    elements.mediaOverrideStatus.textContent = "Saving";
    const response = await fetch("/api/media-moderation/overrides", {
      method: "POST",
      headers: adminHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      elements.mediaOverrideStatus.textContent = responseErrorMessage(data, `HTTP ${response.status}`);
      return;
    }
    elements.mediaOverrideForm.reset();
    elements.mediaOverrideStatus.textContent = "Override added";
    await fetchMediaAdmin();
  });
}

setupTokenForm();
setupTabs();
setupModerationForm();
setupMediaOverrideForm();
elements.refreshSnapshot.addEventListener("click", refreshSnapshot);
elements.mediaSearch.addEventListener("input", () => {
  if (latestMediaAdmin) renderMediaAdmin(latestMediaAdmin);
});

refresh();
fetchActions();
fetchMediaAdmin();
setInterval(refresh, 2500);
setInterval(fetchActions, 10000);
setInterval(fetchMediaAdmin, 5000);
