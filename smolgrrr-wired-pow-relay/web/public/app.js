const fields = [
  "activeClients",
  "publishAttempts",
  "acceptedPublishes",
  "powRejectedPublishes",
  "backendRejectedPublishes",
  "reqMessages",
  "backendUrl",
];

const elements = Object.fromEntries(
  [...fields, "health", "endpoint", "minPow", "uptime", "software", "nips", "activity", "updatedAt"].map((id) => [
    id,
    document.getElementById(id),
  ]),
);

function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m`;
  return `${seconds}s`;
}

function relayEndpoint() {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/`;
}

function renderRecent(items) {
  elements.activity.innerHTML = "";
  const recent = items.length > 0 ? items : [{ at: Date.now(), type: "idle", detail: "waiting for relay activity" }];

  for (const item of recent) {
    const li = document.createElement("li");
    const time = document.createElement("time");
    const body = document.createElement("div");
    const type = document.createElement("strong");
    const detail = document.createElement("code");

    time.textContent = new Date(item.at).toLocaleTimeString();
    type.textContent = item.type;
    detail.textContent = typeof item.detail === "string" ? item.detail : JSON.stringify(item.detail);

    body.append(type, detail);
    li.append(time, body);
    elements.activity.append(li);
  }
}

async function refresh() {
  try {
    const response = await fetch("/api/status", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();

    elements.health.textContent = "online";
    elements.health.className = "status-pill ok";
    elements.endpoint.textContent = relayEndpoint();
    elements.minPow.textContent = data.minPow;
    elements.uptime.textContent = formatDuration(data.uptimeSeconds);
    elements.software.textContent = `${data.relayInfo.software} ${data.relayInfo.version}`;
    elements.nips.textContent = data.relayInfo.supported_nips.join(", ");
    elements.updatedAt.textContent = `updated ${new Date(data.generatedAt).toLocaleTimeString()}`;

    for (const field of fields) {
      if (elements[field]) elements[field].textContent = data[field];
    }

    renderRecent(data.recent || []);
  } catch (error) {
    elements.health.textContent = "offline";
    elements.health.className = "status-pill bad";
    elements.updatedAt.textContent = error.message;
  }
}

refresh();
setInterval(refresh, 2500);
