const FIREBASE_PROJECT_ID = process.env.FCTV77_FIREBASE_PROJECT_ID || "rbapp-672ea";
const FIRESTORE_DOCUMENT_PATH = process.env.FCTV77_FIRESTORE_DOCUMENT || "foth_APP_KVS/params_production";
const FIRESTORE_DATABASE = process.env.FCTV77_FIRESTORE_DATABASE || "(default)";
const REFRESH_INTERVAL_MS = Math.max(60_000, Number(process.env.FCTV77_CONFIG_REFRESH_MS || 300_000));
const REQUEST_TIMEOUT_MS = Math.max(2_000, Number(process.env.FCTV77_CONFIG_TIMEOUT_MS || 8_000));

const FALLBACKS = {
  DATA_API: process.env.FCTV77_DATA_API_BASE_URL || "https://apis-data10.tcdru136ovur.ru",
  DATA_API_EU: process.env.FCTV77_DATA_API_EU_BASE_URL || "",
  LIVE_API: process.env.FCTV77_LIVE_API_BASE_URL || "https://apis-live.ta2mnt200stayr2.cfd",
  LIVE_API_EU: process.env.FCTV77_LIVE_API_EU_BASE_URL || "",
  LOGO_HOST: process.env.FCTV77_LOGO_HOST || ""
};

let config = { ...FALLBACKS };
let lastRefreshAt = 0;
let lastRemoteSuccessAt = 0;
let lastRefreshError = null;
let refreshInFlight = null;

function normalizeHost(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (!candidate) return null;
  let parsed;
  try {
    parsed = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null;
  return parsed.origin;
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return value;
  if (typeof value.stringValue === "string") return value.stringValue;
  if (typeof value.referenceValue === "string") return value.referenceValue;
  if (typeof value.integerValue === "string") return value.integerValue;
  if (typeof value.doubleValue === "number") return String(value.doubleValue);
  if (value.mapValue?.fields) return value.mapValue.fields;
  if (Array.isArray(value.arrayValue?.values)) return value.arrayValue.values.map(decodeFirestoreValue);
  return value;
}

function findValue(node, wanted) {
  if (!node || typeof node !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(node, wanted)) return decodeFirestoreValue(node[wanted]);
  for (const value of Object.values(node)) {
    const found = findValue(value, wanted);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function probeHost(host) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${host}/`, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { "user-agent": "FCTV77-Stremio/0.8.0" }
    });
    return response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRemoteConfig() {
  const documentPath = FIRESTORE_DOCUMENT_PATH.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(FIREBASE_PROJECT_ID)}/databases/${encodeURIComponent(FIRESTORE_DATABASE)}/documents/${documentPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "FCTV77-Stremio/0.8.0" }
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 180);
      throw new Error(`Firestore HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshDomains({ force = false } = {}) {
  if (!force && Date.now() - lastRefreshAt < REFRESH_INTERVAL_MS) return config;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    lastRefreshAt = Date.now();
    try {
      const document = await fetchRemoteConfig();
      const candidate = { ...config };
      for (const key of Object.keys(candidate)) {
        const raw = findValue(document.fields || document, key);
        const normalized = normalizeHost(typeof raw === "string" ? raw : "");
        if (normalized) candidate[key] = normalized;
      }

      const dataApiChanged = candidate.DATA_API !== config.DATA_API;
      const liveApiChanged = candidate.LIVE_API !== config.LIVE_API;
      const checks = await Promise.all([
        ...(dataApiChanged ? [["DATA_API", candidate.DATA_API]] : []),
        ...(liveApiChanged ? [["LIVE_API", candidate.LIVE_API]] : []),
        ...(candidate.DATA_API_EU !== config.DATA_API_EU && candidate.DATA_API_EU ? [["DATA_API_EU", candidate.DATA_API_EU]] : []),
        ...(candidate.LIVE_API_EU !== config.LIVE_API_EU && candidate.LIVE_API_EU ? [["LIVE_API_EU", candidate.LIVE_API_EU]] : [])
      ].map(async ([key, host]) => [key, await probeHost(host)]));

      for (const [key, reachable] of checks) {
        if (!reachable) candidate[key] = config[key];
      }

      config = candidate;
      lastRemoteSuccessAt = Date.now();
      lastRefreshError = null;
      console.log("FCTV77 remote domains synchronized", {
        dataApi: config.DATA_API,
        dataApiEu: config.DATA_API_EU || undefined,
        liveApi: config.LIVE_API,
        liveApiEu: config.LIVE_API_EU || undefined
      });
    } catch (error) {
      lastRefreshError = error.message;
      console.warn("FCTV77 remote domain sync failed; retaining last known hosts:", error.message);
    } finally {
      refreshInFlight = null;
    }
    return config;
  })();

  return refreshInFlight;
}

export async function getDataApiBase() {
  await refreshDomains();
  return config.DATA_API;
}

export async function getLiveApiBase() {
  await refreshDomains();
  return config.LIVE_API;
}

// Sync accessor: the logo host the APK substitutes into every logo URL (LogoConstant.getCompletedServerUrl).
export function getLogoHostSync() {
  return config.LOGO_HOST || "";
}

export function getDomainStatus() {
  return {
    dataApi: config.DATA_API,
    dataApiEu: config.DATA_API_EU || null,
    liveApi: config.LIVE_API,
    liveApiEu: config.LIVE_API_EU || null,
    lastRefreshAt: lastRefreshAt ? new Date(lastRefreshAt).toISOString() : null,
    lastRemoteSuccessAt: lastRemoteSuccessAt ? new Date(lastRemoteSuccessAt).toISOString() : null,
    lastRefreshError
  };
}

export function startDomainRefresh() {
  refreshDomains({ force: true }).catch(() => {});
  const timer = setInterval(() => refreshDomains({ force: true }).catch(() => {}), REFRESH_INTERVAL_MS);
  timer.unref?.();
  return timer;
}
