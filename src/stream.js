import { createCipheriv } from "node:crypto";
import { parseFields, first, all, asString, asMessage } from "./protobuf.js";
import { getDataApiBase } from "./domains.js";

const TIMEOUT_MS = Number(process.env.FCTV77_STREAM_TIMEOUT_MS || 12000);

function rot47(value) {
  return [...value].map(char => {
    const code = char.charCodeAt(0);
    return code >= 33 && code <= 126
      ? String.fromCharCode(33 + ((code - 33 + 47) % 94))
      : char;
  }).join("");
}

function forceHttps(value) {
  const candidate = String(value || "").trim();
  if (!/^https?:\/\//i.test(candidate)) return "";
  try {
    const url = new URL(candidate);
    url.protocol = "https:";
    return url.toString();
  } catch {
    return "";
  }
}

// Mirrors UrlTools.signPlayUrl() in the APK: AES-256-CTR (fixed key/IV) over the
// rb-session header, base64, URL-encoded, suffixed with "a", inserted as
// /token-<value>/ right after the host. Segments are 401 without it.
function encodeStreamToken(session) {
  const cipher = createCipheriv("aes-256-ctr", Buffer.from("a7981cc9eb2f4d19dcfea57b101ecd89"), Buffer.from("8017d3a8f1400d2f"));
  const encrypted = Buffer.concat([cipher.update(Buffer.from(session, "utf8")), cipher.final()]);
  return `${encodeURIComponent(encrypted.toString("base64").replace(/[\r\n]/g, ""))}a`;
}

function signPlayUrl(value, session) {
  if (!value || !session) return value;
  try {
    const url = new URL(value);
    return `https://${url.host}/token-${encodeStreamToken(session)}${url.pathname}${url.search}`;
  } catch {
    return value;
  }
}

function decodeStreamUrl(value) {
  const decoded = rot47(String(value || "").trim());
  // The APK's encoded field leaves this fixed marker before the HTTP URL.
  const withoutMarker = decoded.replace(/^GRu8LFS8(?=https?:\/\/)/i, "");
  const match = withoutMarker.match(/https?:\/\/[^\s"'<>\\]+/i);
  return match ? forceHttps(match[0].replace(/[),.;]+$/, "")) : "";
}

function findUrl(fields, depth = 0) {
  if (depth > 12) return "";

  for (const field of fields) {
    if (field.wire !== 2) continue;

    const text = asString(field).trim();
    const match = text.match(/https?:\/\/[^\s"\'<>\\\\]+/i);
    if (match) {
      return forceHttps(match[0].replace(/[),.;]+$/, ""));
    }
  }

  for (const field of fields) {
    if (field.wire !== 2) continue;
    try {
      const nested = asMessage(field);
      if (nested.length) {
        const value = findUrl(nested, depth + 1);
        if (value) return value;
      }
    } catch {}
  }

  return "";
}

function fieldSummary(fields, depth = 0) {
  return fields.slice(0, 60).map(field => {
    const item = { number: field.number, wire: field.wire };
    if (field.wire === 0) item.value = String(field.value);
    if (field.wire === 2) {
      item.length = field.value.length;
      const text = asString(field).trim();
      if (text && /^[\x20-\x7e]+$/.test(text)) {
        item.text = text.slice(0, 180);
      }
      if (depth < 5) {
        try {
          const nested = asMessage(field);
          if (nested.length) item.nested = fieldSummary(nested, depth + 1);
        } catch {}
      }
    }
    return item;
  });
}

// The web client calls stream/detail with digit=seth plus continent/country and then
// receives a CDN URL whose segments are reachable (with /token-<session>/ + referer).
// Without these params the API returns play.10xstm2.top, whose segments answer 401.
const DEFAULT_DIGIT = process.env.FCTV77_DIGIT || "seth";
const DEFAULT_CONTINENT = process.env.FCTV77_CONTINENT || "EU";
const DEFAULT_COUNTRY = process.env.FCTV77_COUNTRY || "IT";
const FALLBACK_REFERER = process.env.FCTV77_PLAYER_REFERER || "https://jack01eo.m8ow6pride8nly2qearly.cfd";
let refererCache = { value: "", expiresAt: 0 };

// Referer accepted by the CDN: first iframePlayerDomains entry of common:web:client (as the APK does).
async function getPlayerReferer() {
  if (process.env.FCTV77_PLAYER_REFERER) return FALLBACK_REFERER;
  if (refererCache.value && refererCache.expiresAt > Date.now()) return refererCache.value;
  let value = FALLBACK_REFERER;
  try {
    const base = await getDataApiBase();
    const response = await fetch(new URL("/api/common/params", base), {
      headers: { "user-agent": "FCTV-Stremio/1.0.0" },
      signal: AbortSignal.timeout(8000)
    });
    if (response.ok) {
      const params = JSON.parse(rot47(await response.text()));
      const web = JSON.parse(params["common:web:client"]);
      const domain = String(web?.trd?.iframePlayerDomains?.[0] || "").trim();
      if (domain) value = /^https?:\/\//i.test(domain) ? domain.replace(/\/+$/, "") : `https://${domain}`;
    }
  } catch {}
  refererCache = { value, expiresAt: Date.now() + 600000 };
  return value;
}

export async function streamDetail(q, { diagnostics = false } = {}) {
  const base = await getDataApiBase();
  const url = new URL("/api/stream/detail", base);
  const params = {
    ...q,
    digit: q.digit || DEFAULT_DIGIT,
    continent: q.continent || DEFAULT_CONTINENT,
    country: q.country || DEFAULT_COUNTRY
  };
  for (const key of ["matchId", "sportType", "streamId", "siteType", "continent", "country", "digit", "withOriginal"]) {
    if (params[key] !== undefined && params[key] !== null && params[key] !== "") url.searchParams.set(key, String(params[key]));
  }

  let response;
  let bytes;
  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/octet-stream, application/x-protobuf, */*",
          "user-agent": "FCTV-Stremio/1.0.0"
        }
      });
      bytes = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      // Transient network errors (ETIMEDOUT/EHOSTUNREACH): retry instead of failing the stream.
      if (attempt === 3) {
        const cause = error.cause?.code || error.cause?.errors?.map(e => e.code).join(",") || "";
        throw new Error(`stream/detail ${error.message}${cause ? ` (${cause})` : ""}`);
      }
      await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
      continue;
    } finally {
      clearTimeout(timer);
    }
    // Cloudflare rate limit: wait and retry with growing delay.
    if (response.status !== 429 || attempt === 3) break;
    await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1) + Math.random() * 500));
  }
  if (!response.ok) throw new Error(`stream/detail HTTP ${response.status}: ${new TextDecoder().decode(bytes).slice(0, 160)}`);

  const envelope = parseFields(bytes);
  const data = first(envelope, 10);
  if (!data || data.wire !== 2) {
    if (diagnostics) return { url: "", diagnostics: { status: response.status, bytes: bytes.length, envelope: fieldSummary(envelope) } };
    throw new Error("PBResponse.data (field 10) missing in stream/detail");
  }
  const responseFields = parseFields(data.value);
  const streamField = first(responseFields, 2);
  const streamFields = streamField?.wire === 2 ? asMessage(streamField) : [];
  const streamUrlField = first(streamFields, 4);
  const directUrl = streamUrlField?.wire === 2 ? asString(streamUrlField).trim() : "";
  const resolvedUrl = /^https?:\/\//i.test(directUrl)
    ? forceHttps(directUrl)
    : decodeStreamUrl(directUrl) || findUrl(responseFields);
  const name = asString(first(streamFields, 3)) || "FCTV77";

  if (diagnostics) {
    return {
      url: resolvedUrl,
      name,
      diagnostics: {
        status: response.status,
        bytes: bytes.length,
        envelope: fieldSummary(envelope),
        payload: fieldSummary(responseFields),
        stream: fieldSummary(streamFields),
        urlFound: Boolean(resolvedUrl),
        urlProtocol: resolvedUrl ? new URL(resolvedUrl).protocol : null,
        encodedUrlFieldPresent: Boolean(directUrl),
        rbSessionPresent: Boolean(response.headers.get("rb-session"))
      }
    };
  }

  if (!resolvedUrl) throw new Error(`URL stream non trovata; payload fields: ${responseFields.map(field => `${field.number}:${field.wire}`).join(",")}`);
  const rbSession = response.headers.get("rb-session") || "";
  const referer = await getPlayerReferer();
  return {
    url: signPlayUrl(resolvedUrl, rbSession),
    name,
    rbSessionPresent: Boolean(rbSession),
    headers: { Referer: `${referer}/`, Origin: referer }
  };
}
