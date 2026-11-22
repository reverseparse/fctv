import "dotenv/config";
import express from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { encodeId, decodeId } from "./src/id.js";
import { streamDetail } from "./src/stream.js";
import { liveMatches, inspectLiveCatalog, resolveMatchStreams, cachedMatch } from "./src/live.js";
import { getDomainStatus, startDomainRefresh } from "./src/domains.js";

const VERSION = "0.9.12";
const IS_PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 7070);
const HOST = process.env.HOST || "0.0.0.0";
const ACCESS_KEY = (process.env.ACCESS_KEY || "").trim();
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
const PROXY_TTL_MS = Number(process.env.HLS_TTL_MS || 6 * 3600 * 1000);
const MAX_PROXY_CONCURRENCY = Number(process.env.PROXY_MAX_CONCURRENCY || 40);
const MAX_PLAYLIST_BYTES = 1024 * 1024;
const MAX_SEGMENT_BYTES = Number(process.env.PROXY_MAX_SEGMENT_BYTES || 16 * 1024 * 1024);
const MAX_STREAMS_PER_EVENT = 6;

// Optional external proxy: when set, streams are served through EasyProxy instead of the built-in /hls + /seg proxy.
const EASYPROXY_URL = (process.env.EASYPROXY_URL || "").trim().replace(/\/+$/, "");
const EASYPROXY_PASSWORD = (process.env.EASYPROXY_PASSWORD || "").trim();
if (EASYPROXY_URL && !/^https?:\/\/[^/\s]+$/i.test(EASYPROXY_URL)) {
  console.error("EASYPROXY_URL must be an origin without path, e.g. https://easyproxy.example.com");
  process.exit(1);
}

// EasyProxy format: <base>/proxy/manifest.m3u8?url=<target>&h_<Header>=<value>[&api_password=<pw>]
function easyProxyUrl(target, headers) {
  const params = new URLSearchParams({ url: target });
  for (const [name, value] of Object.entries(headers || {})) if (value) params.set(`h_${name}`, value);
  if (EASYPROXY_PASSWORD) params.set("api_password", EASYPROXY_PASSWORD);
  return `${EASYPROXY_URL}/proxy/manifest.m3u8?${params}`;
}

if (ACCESS_KEY && !/^[A-Za-z0-9_-]{16,128}$/.test(ACCESS_KEY)) {
  console.error("ACCESS_KEY must be 16-128 chars of [A-Za-z0-9_-].");
  process.exit(1);
}
if (IS_PROD && !PUBLIC_BASE_URL) {
  console.error("PUBLIC_BASE_URL is required when NODE_ENV=production (e.g. https://addon.example.com).");
  process.exit(1);
}
if (PUBLIC_BASE_URL && !/^https?:\/\/[^/\s]+$/i.test(PUBLIC_BASE_URL)) {
  console.error("PUBLIC_BASE_URL must be an origin without path, e.g. https://addon.example.com");
  process.exit(1);
}
let HLS_SECRET = process.env.HLS_SECRET || "";
if (!HLS_SECRET) {
  HLS_SECRET = randomBytes(32).toString("hex");
  console.warn("HLS_SECRET not set: using a random one, playing streams break on every restart.");
}

const basePath = ACCESS_KEY ? `/${ACCESS_KEY}` : "";
const publicBase = req => `${PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`}${basePath}`;

// ---------- helpers ----------
const clip = (value, max = 200) => String(value ?? "").slice(0, max);
const slimMatch = ({ logos, leagueLogo, streams, ...rest }) => rest;

function hmac(data) {
  return createHmac("sha256", HLS_SECRET).update(data).digest("base64url");
}

function safeEqual(a, b) {
  const x = createHmac("sha256", "cmp").update(String(a)).digest();
  const y = createHmac("sha256", "cmp").update(String(b)).digest();
  return timingSafeEqual(x, y);
}

function packProxy(url, headers) {
  const clean = {};
  for (const key of ["Referer", "Origin"]) if (headers?.[key]) clean[key] = clip(headers[key], 300);
  const body = Buffer.from(JSON.stringify({ u: url, h: clean, e: Date.now() + PROXY_TTL_MS }), "utf8").toString("base64url");
  return `${body}.${hmac(body)}`;
}

class Forbidden extends Error {}

function unpackProxy(value) {
  const parts = String(value).split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || value.length > 4000) throw new Forbidden("bad payload");
  if (!safeEqual(parts[1], hmac(parts[0]))) throw new Forbidden("bad signature");
  let parsed;
  try { parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")); } catch { throw new Forbidden("bad payload"); }
  if (!parsed || typeof parsed.u !== "string" || !(parsed.e > Date.now())) throw new Forbidden("expired");
  const headers = {};
  for (const key of ["Referer", "Origin"]) if (typeof parsed.h?.[key] === "string") headers[key] = parsed.h[key];
  return { url: parsed.u, headers };
}

function isPrivateIp(ip) {
  const family = isIP(ip);
  if (family === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (family === 6) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    if (v.startsWith("::ffff:")) return v.includes(".") ? isPrivateIp(v.slice(7)) : true;
    return v.startsWith("fc") || v.startsWith("fd") || /^fe[89ab]/.test(v);
  }
  return true;
}

// SSRF guard: https only, default port, public addresses only.
async function assertPublicUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Forbidden("bad url"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Forbidden("url not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Forbidden("address not allowed");
    return url;
  }
  let addresses;
  try { addresses = await lookup(host, { all: true }); } catch { throw new Error("dns failure"); }
  if (!addresses.length || addresses.some(entry => isPrivateIp(entry.address))) throw new Forbidden("address not allowed");
  return url;
}

async function readLimited(response, max) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > max) throw new Error("upstream too large");
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > max) { try { await response.body.cancel(); } catch {} throw new Error("upstream too large"); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function fetchUpstream(value, headers, timeoutMs, maxBytes) {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = value;
  // Redirects are followed manually (max 3) and every hop is re-validated by the SSRF guard.
  for (let hop = 0; hop <= 3; hop++) {
    const url = await assertPublicUrl(current);
    const response = await fetch(url, { headers, redirect: "manual", signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      try { await response.body?.cancel(); } catch {}
      if (!location || hop === 3) throw new Error("too many or invalid redirects");
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    return { url, body: await readLimited(response, maxBytes) };
  }
  throw new Error("too many redirects");
}

let activeProxy = 0;
async function withProxySlot(res, work) {
  if (activeProxy >= MAX_PROXY_CONCURRENCY) return res.status(503).set("Retry-After", "2").type("text/plain").send("busy");
  activeProxy++;
  try { await work(); } finally { activeProxy--; }
}

function rateLimit({ windowMs = 60000, max }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [key, entry] of hits) if (entry.reset < now) hits.delete(key); }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    if (hits.size > 50000) hits.clear();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset < now) { entry = { count: 0, reset: now + windowMs }; hits.set(req.ip, entry); }
    if (++entry.count > max) {
      res.setHeader("Retry-After", String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: "rate limited" });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).end();
  const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!given || !safeEqual(given, ADMIN_TOKEN)) return res.status(401).json({ error: "unauthorized" });
  next();
}

function parseItem(rawId) {
  if (String(rawId).length > 4000) throw new Error("id too long");
  const item = decodeId(rawId);
  if (!/^\d{1,20}$/.test(String(item.matchId))) throw new Error("bad matchId");
  const sport = Number(item.sportType);
  item.sportType = Number.isInteger(sport) && sport >= 0 && sport < 1000 ? sport : 0;
  return item;
}

const eventTitle = item => item.home && item.away
  ? `${clip(item.home)} - ${clip(item.away)}`
  : item.title && !/^Match \d+$/.test(item.title) ? clip(item.title) : `Evento ${item.matchId}`;

const describe = item => [
  clip(item.league), clip(item.round), clip(item.group),
  item.venue ? `Luogo: ${clip(item.venue)}` : "",
  Number.isFinite(item.homeScore) && Number.isFinite(item.awayScore) ? `Risultato: ${item.homeScore} - ${item.awayScore}` : ""
].filter(Boolean).join(" · ") || undefined;

// ---------- app ----------
const app = express();
app.disable("x-powered-by");
const trust = process.env.TRUST_PROXY;
if (trust) app.set("trust proxy", /^\d+$/.test(trust) ? Number(trust) : trust);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

// Minimal liveness probe for the hosting platform: no internals exposed.
app.get("/health", (_req, res) => res.json({ ok: true }));

const router = express.Router();
const apiLimit = rateLimit({ max: Number(process.env.RATE_LIMIT_API_MAX || 120) });
const proxyLimit = rateLimit({ max: Number(process.env.RATE_LIMIT_PROXY_MAX || 900) });

router.get("/manifest.json", apiLimit, (_req, res) => res.json({
  id: "community.fctv77.streams",
  version: VERSION,
  name: "FCTV77 Streams",
  description: "FCTV77 live catalog discovered directly from the app API, with stream resolver.",
  resources: ["catalog", "meta", "stream"],
  types: ["tv"],
  catalogs: [{ type: "tv", id: "fctv77_live", name: "FCTV77 Live" }]
}));

router.get("/catalog/tv/fctv77_live.json", apiLimit, async (_req, res) => {
  try {
    const matches = await liveMatches();
    res.json({ metas: matches.map(match => ({
      id: encodeId(slimMatch(match)),
      type: "tv",
      poster: match.logos?.[0] || match.leagueLogo || undefined,
      background: match.leagueLogo || match.logos?.[1] || undefined,
      logo: match.leagueLogo || undefined,
      name: eventTitle(match),
      description: describe(match),
      posterShape: "landscape"
    })) });
  } catch (error) {
    console.error("Catalog error:", error.message);
    res.status(502).json({ metas: [] });
  }
});

router.get("/meta/:type/:id.json", apiLimit, (req, res) => {
  try {
    if (req.params.type !== "tv") return res.status(404).json({ meta: null });
    const item = parseItem(req.params.id);
    const meta = {
      id: req.params.id.startsWith("fctv77:") ? req.params.id : `fctv77:${req.params.id}`,
      type: "tv",
      name: eventTitle(item),
      description: describe(item),
      posterShape: "landscape"
    };
    const cached = cachedMatch(item.matchId);
    if (cached) {
      meta.poster = cached.logos?.[0] || cached.leagueLogo || undefined;
      meta.background = cached.leagueLogo || cached.logos?.[1] || undefined;
      meta.logo = cached.leagueLogo || undefined;
    }
    res.json({ meta });
  } catch {
    res.status(400).json({ meta: null, error: "Invalid event id" });
  }
});

router.get("/stream/:type/:id.json", apiLimit, async (req, res) => {
  try {
    if (req.params.type !== "tv") return res.json({ streams: [] });
    const item = parseItem(req.params.id);
    // Stream ids are always resolved server-side: nothing the client puts in the id reaches the upstream API.
    const candidates = (await resolveMatchStreams(item.matchId, item.sportType)).slice(0, MAX_STREAMS_PER_EVENT);
    const base = publicBase(req);
    const resolved = await Promise.all(candidates.map(async candidate => {
      try {
        const stream = await streamDetail({
          matchId: item.matchId,
          sportType: candidate.sportType ?? item.sportType,
          streamId: candidate.streamId,
          siteType: candidate.siteType ?? 0,
          withOriginal: true
        });
        if (!stream?.url) return null;
        return {
          name: clip(candidate.name || stream.name || "FCTV77", 80),
          title: eventTitle(item),
          url: EASYPROXY_URL
            ? easyProxyUrl(stream.url, stream.headers)
            : `${base}/hls/${packProxy(stream.url, stream.headers)}/index.m3u8`,
          behaviorHints: { notWebReady: true }
        };
      } catch (error) {
        console.error(`Stream resolution failed for ${candidate.streamId}:`, error.message);
        return null;
      }
    }));
    res.json({ streams: resolved.filter(Boolean) });
  } catch (error) {
    console.error("Stream route error:", error.message);
    res.json({ streams: [] });
  }
});

// ---------- HLS proxy (signed, SSRF-guarded) ----------
// Disabled when EasyProxy is used, to keep the attack surface minimal.
router.use(["/hls", "/seg"], (_req, res, next) => EASYPROXY_URL ? res.status(404).end() : next());

function proxyError(res, error, label) {
  if (error instanceof Forbidden) return res.status(403).type("text/plain").send("forbidden");
  console.error(`${label}:`, error.message);
  res.status(502).type("text/plain").send("upstream error");
}

router.get("/hls/:payload/index.m3u8", proxyLimit, async (req, res) => {
  try {
    const { url: target, headers } = unpackProxy(req.params.payload);
    await withProxySlot(res, async () => {
      const { url, body } = await fetchUpstream(target, headers, 12000, MAX_PLAYLIST_BYTES);
      const base = publicBase(req);
      const text = body.toString("utf8").split(/\r?\n/).map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return line;
        const absolute = new URL(trimmed, url);
        // Playlists may only point at the host that served them.
        if (absolute.hostname !== url.hostname) throw new Forbidden("cross-host playlist entry");
        const payload = packProxy(absolute.toString(), headers);
        return /\.m3u8$/i.test(absolute.pathname) ? `${base}/hls/${payload}/index.m3u8` : `${base}/seg/${payload}/segment.ts`;
      }).join("\n");
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.send(text);
    });
  } catch (error) {
    proxyError(res, error, "HLS playlist proxy error");
  }
});

router.get("/seg/:payload/segment.ts", proxyLimit, async (req, res) => {
  try {
    const { url: target, headers } = unpackProxy(req.params.payload);
    await withProxySlot(res, async () => {
      const { body } = await fetchUpstream(target, headers, 15000, MAX_SEGMENT_BYTES);
      res.setHeader("Content-Type", "video/mp2t");
      res.setHeader("Content-Length", body.length);
      res.end(req.method === "HEAD" ? undefined : body);
    });
  } catch (error) {
    proxyError(res, error, "HLS segment proxy error");
  }
});

// ---------- admin-only diagnostics (disabled unless ADMIN_TOKEN is set) ----------
const adminLimit = rateLimit({ max: 20 });
router.get("/debug/stream/:type/:id.json", adminLimit, requireAdmin, async (req, res) => {
  try {
    const item = parseItem(req.params.id);
    const [candidate] = await resolveMatchStreams(item.matchId, item.sportType);
    if (!candidate?.streamId) return res.status(404).json({ ok: false, error: "no stream" });
    const result = await streamDetail({
      matchId: item.matchId, sportType: candidate.sportType ?? item.sportType,
      streamId: candidate.streamId, siteType: candidate.siteType ?? 0, withOriginal: true
    }, { diagnostics: true });
    res.json({ ok: Boolean(result.url), streamName: result.name, diagnostics: result.diagnostics });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

router.get("/debug/catalog", adminLimit, requireAdmin, async (_req, res) => {
  try {
    res.json({ ok: true, version: VERSION, ...(await inspectLiveCatalog()) });
  } catch (error) {
    res.status(502).json({ ok: false, error: error.message });
  }
});

router.get("/debug/health", adminLimit, requireAdmin, (_req, res) => res.json({ ok: true, version: VERSION, domains: getDomainStatus() }));

app.use(basePath || "/", router);
app.use((_req, res) => res.status(404).json({ error: "not found" }));
app.use((error, _req, res, _next) => {
  console.error("Unhandled error:", error.message);
  res.status(500).json({ error: "internal error" });
});

process.on("unhandledRejection", reason => console.error("Unhandled rejection:", reason?.message || reason));

startDomainRefresh();
app.listen(PORT, HOST, () => {
  console.log(`FCTV77 Stremio addon v${VERSION} listening on ${HOST}:${PORT}${ACCESS_KEY ? " (access key enabled)" : ""}${ADMIN_TOKEN ? " (admin enabled)" : ""}`);
});
