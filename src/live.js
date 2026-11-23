import { createHash } from "node:crypto";
import { parseFields, first, all, asNumber, asString, asId, asMessage } from "./protobuf.js";
import { getDataApiBase, getLogoHostSync } from "./domains.js";

const LIVE_CODE = Number(process.env.FCTV77_LIVE_CODE || 100);
const MATCH_DETAIL_CODE = 102;
const LANGUAGE = Number(process.env.FCTV77_LANGUAGE || 8); // PBLanguage.L_IT in the APK
const REQUEST_DELAY_MS = Number(process.env.FCTV77_REQUEST_DELAY_MS ?? 100);
const DETAIL_CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.FCTV77_DETAIL_CONCURRENCY || 6)));
const TIMEOUT_MS = Number(process.env.FCTV77_CATALOG_TIMEOUT_MS || 12000);
const CACHE_MS = Number(process.env.FCTV77_CATALOG_CACHE_MS || 120000);
const DETAIL_CACHE_MS = Number(process.env.FCTV77_DETAIL_CACHE_MS || 300000);

const SPORTS = [
  ["football", 1], ["basketball", 2], ["tennis", 3], ["baseball", 4],
  ["cricket", 5], ["moto", 6], ["rugby", 7], ["american-football", 8],
  ["aussie-rules", 9], ["hockey", 10], ["badminton", 11], ["volleyball", 12],
  ["fighting", 13], ["cycling", 14], ["handball", 15], ["other", 19]
];

const detailCache = new Map();
const detailInFlight = new Map();

function textMapEntry(field) {
  const entry = asMessage(field);
  // Protobuf map<int32,string>: key is a varint (field 1), value is a string (field 2).
  return [String(asNumber(first(entry, 1))), asString(first(entry, 2)).trim()];
}

function localizedMapName(containerField, mapFieldNumber = 3, lang = LANGUAGE) {
  if (!containerField || containerField.wire !== 2) return "";
  const container = asMessage(containerField);
  const entries = all(container, mapFieldNumber).map(textMapEntry).filter(([, value]) => value);
  return entries.find(([language]) => language === String(lang))?.[1]
    || entries.find(([language]) => language === "8")?.[1]
    || entries.find(([, value]) => value)?.[1]
    || "";
}

function nestedText(field, depth = 0) {
  if (!field || field.wire !== 2 || depth > 4) return "";
  const direct = asString(field).trim();
  if (direct && !/[\u0000-\u0008]/.test(direct)) return direct;
  let nested;
  try { nested = asMessage(field); } catch { return ""; }
  const candidates = [];
  for (const number of [3, 2, 1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 19, 20, 21]) {
    for (const item of all(nested, number)) {
      if (item.wire !== 2) continue;
      const value = nestedText(item, depth + 1);
      if (value && !/^\d+$/.test(value)) candidates.push(value);
    }
  }
  return candidates.find(value => value.length > 1) || candidates[0] || "";
}

function teamName(field, lang = LANGUAGE) {
  return localizedMapName(field, 3, lang) || nestedText(field);
}

function matchName(field) {
  if (!field || field.wire !== 2) return "";
  const direct = asString(field).trim();
  if (direct && !/^\d+$/.test(direct)) return direct;
  return nestedText(field);
}

function leagueName(field, lang = LANGUAGE) {
  return localizedMapName(field, 3, lang) || nestedText(field);
}

// PBDataLeague.country (field 80) carries a localized name map like teams/leagues do.
function countryName(leagueField, lang = LANGUAGE) {
  if (!leagueField || leagueField.wire !== 2) return "";
  try { return localizedMapName(first(asMessage(leagueField), 80), 3, lang); } catch { return ""; }
}

function logoOf(field) {
  // PBDataTeam / PBDataLeague / PBDataPlayer: logo or avatar URL at field 4.
  if (!field || field.wire !== 2) return "";
  try {
    const value = asString(first(asMessage(field), 4)).trim();
    if (!/^https?:\/\//i.test(value)) return "";
    // The API sends a stale logo host; swap in the current LOGO_HOST like the APK does.
    const host = getLogoHostSync();
    if (host) {
      const url = new URL(value);
      url.host = new URL(host).host;
      return url.toString();
    }
    return value;
  } catch { return ""; }
}

function contenderInfo(field, lang = LANGUAGE) {
  // PBDataContender: name=2 (string, whole event "A vs B"), team=10 (PBDataTeam), player=20 (PBDataPlayer).
  if (!field || field.wire !== 2) return { event: "", side: "" };
  const c = asMessage(field);
  const event = asString(first(c, 2)).trim();
  const team = first(c, 10);
  const player = first(c, 20);
  const side = (team ? teamName(team, lang) : "") || (player ? teamName(player, lang) : "");
  return { event, side, logo: logoOf(team) || logoOf(player) };
}

function decodeMatch(field, lang = LANGUAGE) {
  const f = asMessage(field);
  const matchId = asId(first(f, 1));
  const sportType = asNumber(first(f, 2));
  const contenders = all(f, 30).map(c => contenderInfo(c, lang));
  const sides = contenders.map(c => c.side).filter(Boolean);
  const contenderEvent = contenders.map(c => c.event).find(Boolean) || "";
  const home = teamName(first(f, 20), lang) || sides[0] || "";
  const away = teamName(first(f, 21), lang) || sides[1] || "";
  const explicitName = matchName(first(f, 19)) || contenderEvent;
  const title = [home, away].filter(Boolean).join(" - ") || explicitName || `Match ${matchId}`;
  const homeScoreField = first(f, 22);
  const awayScoreField = first(f, 23);
  const textValue = field => {
    if (!field) return "";
    if (field.wire === 2) return asString(field).trim() || nestedText(field);
    return "";
  };
  return {
    matchId, sportType, title, home, away,
    league: leagueName(first(f, 10), lang),
    leagueId: asId(first(asMessage(first(f, 10)), 1)),
    country: countryName(first(f, 10), lang),
    logos: contenders.map(c => c.logo).filter(Boolean),
    leagueLogo: logoOf(first(f, 10)),
    status: first(f, 4)?.wire === 0 ? asNumber(first(f, 4)) : null,
    homeScore: homeScoreField?.wire === 0 ? asNumber(homeScoreField) : null,
    awayScore: awayScoreField?.wire === 0 ? asNumber(awayScoreField) : null,
    group: textValue(first(f, 40)),
    round: textValue(first(f, 41)),
    venue: textValue(first(f, 79))
  };
}

function decodeStreamFields(fields) {
  return {
    streamId: asId(first(fields, 1)),
    sportType: asNumber(first(fields, 2)),
    name: asString(first(fields, 10)) || asString(first(fields, 3)) || "FCTV77",
    streamStatus: asNumber(first(fields, 5)),
    siteType: asNumber(first(fields, 9)),
    matchId: asId(first(fields, 50))
  };
}

function decodeStream(field) {
  return decodeStreamFields(asMessage(field));
}

function collectDetailedStreams(fields, found = [], depth = 0) {
  if (depth > 5) return found;
  const streamId = first(fields, 1);
  const matchId = first(fields, 50);
  if (streamId?.wire === 0 && matchId?.wire === 0) {
    const stream = decodeStreamFields(fields);
    if (stream.streamId && stream.matchId) found.push(stream);
    return found;
  }
  for (const item of fields) {
    if (item.wire !== 2) continue;
    try { collectDetailedStreams(asMessage(item), found, depth + 1); } catch {}
  }
  return found;
}

function responseData(bytes, label) {
  const envelope = parseFields(bytes);
  const data = first(envelope, 10);
  if (!data || data.wire !== 2) throw new Error(`${label}: PBResponse.data (field 10) missing`);
  return { envelope, payload: parseFields(data.value) };
}

function signatureVersion(payload, code = LIVE_CODE) {
  // PBBodySignatureResp.kvMap is a protobuf map<int32,string>.
  // The map entry for code=100 is field 1: { key=100, value=<32-char version> }.
  for (const field of all(payload, 1)) {
    if (field.wire !== 2) continue;
    const entry = asMessage(field);
    const key = asNumber(first(entry, 1));
    const value = asString(first(entry, 2));
    if (key === code && value) return value;
  }
  throw new Error(`PBBodySignatureResp: version for code ${code} not found in kvMap`);
}

async function fetchProtobuf(url, label) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/x-protobuf, application/octet-stream, */*",
          "user-agent": "FCTV77-Stremio/0.9.6"
        }
      });
      const contentType = response.headers.get("content-type") || "";
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (response.status === 429 && attempt < 2) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!response.ok) {
        const detail = new TextDecoder().decode(bytes).slice(0, 180);
        const error = new Error(`${label}: HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
        error.status = response.status;
        error.contentType = contentType;
        error.bytes = bytes.length;
        throw error;
      }
      return { bytes, contentType, status: response.status };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`${label}: HTTP 429 after retry`);
}

function buildMatchUrl(base, sportType, version, lang = LANGUAGE) {
  // This mirrors MatchRepository.getLiveGame() in the APK:
  // md5("language=<n>&sportType=<n>&stream=true"), then prefix it with LIVE_CODE.
  const querySignature = `language=${lang}&sportType=${sportType}&stream=true`;
  const digest = createHash("md5").update(querySignature, "utf8").digest("hex");
  const params = `${LIVE_CODE}${digest}`;
  const url = new URL(`/sfver${params}${version}/api/match/live`, base);
  url.searchParams.set("language", String(lang));
  url.searchParams.set("sportType", String(sportType));
  url.searchParams.set("stream", "true");
  return url;
}

async function requestSport(sportName, sportType, lang = LANGUAGE) {
  const base = (await getDataApiBase()).replace(/\/+$/, "");
  const signatureUrl = new URL("/api/common/bs", `${base}/`);
  signatureUrl.searchParams.set("code", String(LIVE_CODE));
  signatureUrl.searchParams.set("sportType", String(sportType));
  signatureUrl.searchParams.set("stream", "true");
  signatureUrl.searchParams.set("cachePriority", "false");

  const signatureResponse = await fetchProtobuf(signatureUrl, `signature ${sportName}`);
  const signatureEnvelope = responseData(signatureResponse.bytes, `signature ${sportName}`);
  const version = signatureVersion(signatureEnvelope.payload);
  const matchUrl = buildMatchUrl(base, sportType, version, lang);
  const matchResponse = await fetchProtobuf(matchUrl, `match/live ${sportName}`);
  const matchEnvelope = responseData(matchResponse.bytes, `match/live ${sportName}`);

  const matchFields = all(matchEnvelope.payload, 1);
  const streamFields = all(matchEnvelope.payload, 2);
  const matches = matchFields.map(f => decodeMatch(f, lang)).filter(match => match.matchId);
  const streams = streamFields.map(decodeStream).filter(stream => stream.matchId);

  const summarizeNameField = field => {
    if (!field) return null;
    if (field.wire !== 2) return { wire: field.wire };
    let nested = [];
    try { nested = asMessage(field); } catch {}
    return {
      wire: field.wire,
      length: field.value.length,
      text: asString(field).slice(0, 120) || undefined,
      nested: nested.slice(0, 30).map(child => {
        if (child.wire !== 2) return { number: child.number, wire: child.wire, value: String(child.value) };
        let entry = [];
        try { entry = asMessage(child); } catch {}
        const key = first(entry, 1);
        const value = first(entry, 2);
        return {
          number: child.number,
          wire: child.wire,
          length: child.value.length,
          mapKey: key?.wire === 0 ? String(key.value) : undefined,
          mapValue: value?.wire === 2 ? asString(value) : undefined,
          childFields: entry.slice(0, 12).map(part => ({
            number: part.number,
            wire: part.wire,
            text: part.wire === 2 ? asString(part).slice(0, 100) : undefined,
            value: part.wire === 0 ? String(part.value) : undefined
          }))
        };
      })
    };
  };
  const summarizeMatchNames = field => {
    const match = asMessage(field);
    return {
      matchId: asId(first(match, 1)),
      fields: Object.fromEntries([10, 19, 20, 21, 40, 41, 79].map(number => [
        String(number), summarizeNameField(first(match, number))
      ]))
    };
  };

  const summarizeNested = field => {
    const nested = field.wire === 2 ? asMessage(field) : [];
    return {
      wire: field.wire,
      length: field.wire === 2 ? field.value.length : undefined,
      nestedFields: nested.slice(0, 80).map(item => ({
        number: item.number,
        wire: item.wire,
        value: item.wire === 0 ? String(item.value) : undefined,
        valueLength: item.wire === 2 ? item.value.length : undefined
      })),
      idField: first(nested, 1) ? {
        wire: first(nested, 1).wire,
        value: asId(first(nested, 1))
      } : null,
      matchIdField: first(nested, 50) ? {
        wire: first(nested, 50).wire,
        value: asId(first(nested, 50))
      } : null,
      scalarCandidates: Object.fromEntries([2, 5, 9].map(number => {
        const item = first(nested, number);
        return [String(number), item?.wire === 0 ? String(item.value) : null];
      }))
    };
  };

  return {
    matches,
    streams,
    diagnostics: {
      sport: sportName,
      sportType,
      language: LANGUAGE,
      signature: {
        status: signatureResponse.status,
        contentType: signatureResponse.contentType,
        bytes: signatureResponse.bytes.length,
        version
      },
      live: {
        status: matchResponse.status,
        contentType: matchResponse.contentType,
        bytes: matchResponse.bytes.length,
        envelopeFields: matchEnvelope.envelope.map(field => field.number),
        payloadFields: matchEnvelope.payload.map(field => field.number),
        payloadWireTypes: matchEnvelope.payload.reduce((counts, field) => {
          const key = `${field.number}:${field.wire}`;
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {}),
        candidateMatchCount: matchFields.length,
        candidateStreamCount: streamFields.length,
        matchSamples: matchFields.slice(0, 3).map(summarizeNested),
        decodedMatchSamples: matches.slice(0, 5),
        matchNameStructures: matchFields.slice(0, 3).map(summarizeMatchNames),
        streamSamples: streamFields.slice(0, 5).map(summarizeNested),
        matches: matches.length,
        streams: streams.length
      }
    }
  };
}

function joinMatches(results, detailedByMatch) {
  const byMatch = new Map();
  for (const result of results) {
    for (const match of result.matches) {
      if (!match.matchId) continue;
      const streams = detailedByMatch.get(match.matchId) || [];
      if (!streams.length) continue;
      const existing = byMatch.get(match.matchId);
      if (existing) {
        const known = new Set(existing.streams.map(stream => `${stream.streamId}:${stream.siteType}`));
        for (const stream of streams) {
          const key = `${stream.streamId}:${stream.siteType}`;
          if (!known.has(key)) existing.streams.push(stream);
        }
      } else {
        byMatch.set(match.matchId, { ...match, streams: [...streams] });
      }
    }
  }
  return [...byMatch.values()];
}

async function requestMatchDetailUncached(matchId, sportType) {
  const base = (await getDataApiBase()).replace(/\/+$/, "");
  const signatureUrl = new URL("/api/common/bs", `${base}/`);
  signatureUrl.searchParams.set("code", String(MATCH_DETAIL_CODE));
  signatureUrl.searchParams.set("matchId", String(matchId));
  signatureUrl.searchParams.set("sportType", String(sportType));
  signatureUrl.searchParams.set("stream", "true");
  signatureUrl.searchParams.set("cachePriority", "false");

  const signatureResponse = await fetchProtobuf(signatureUrl, `match detail signature ${matchId}`);
  const signatureEnvelope = responseData(signatureResponse.bytes, `match detail signature ${matchId}`);
  const version = signatureVersion(signatureEnvelope.payload, MATCH_DETAIL_CODE);
  const querySignature = `language=${LANGUAGE}&matchId=${matchId}&sportType=${sportType}&stream=true`;
  const digest = createHash("md5").update(querySignature, "utf8").digest("hex");
  const params = `${MATCH_DETAIL_CODE}${digest}`;
  const detailUrl = new URL(`/sfver${params}${version}/api/match/detail`, base);
  detailUrl.searchParams.set("matchId", String(matchId));
  detailUrl.searchParams.set("language", String(LANGUAGE));
  detailUrl.searchParams.set("sportType", String(sportType));
  detailUrl.searchParams.set("stream", "true");

  const detailResponse = await fetchProtobuf(detailUrl, `match/detail ${matchId}`);
  const detailEnvelope = responseData(detailResponse.bytes, `match/detail ${matchId}`);
  const streams = collectDetailedStreams(detailEnvelope.payload)
    .map(stream => ({ ...stream, matchId: stream.matchId || String(matchId) }));
  return { streams, diagnostics: {
    matchId, sportType, signatureStatus: signatureResponse.status,
    detailStatus: detailResponse.status, detailBytes: detailResponse.bytes.length,
    payloadFields: detailEnvelope.payload.map(field => `${field.number}:${field.wire}`),
    streams: streams.length,
    streamSamples: streams.slice(0, 3).map(stream => ({
      streamId: stream.streamId, sportType: stream.sportType,
      siteType: stream.siteType, streamStatus: stream.streamStatus,
      matchId: stream.matchId, name: stream.name
    }))
  }};
}

async function requestMatchDetail(matchId, sportType) {
  const key = `${matchId}:${sportType}`;
  const cached = detailCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (detailInFlight.has(key)) return detailInFlight.get(key);
  const pending = requestMatchDetailUncached(matchId, sportType).then(value => {
    detailCache.set(key, { value, expiresAt: Date.now() + DETAIL_CACHE_MS });
    return value;
  }).finally(() => detailInFlight.delete(key));
  detailInFlight.set(key, pending);
  return pending;
}

async function resolveDetailedStreams(results, { limit = Infinity } = {}) {
  const refs = new Map();
  for (const result of results) {
    for (const stream of result.streams) {
      if (!stream.matchId || !stream.streamStatus) continue;
      if (!refs.has(stream.matchId)) refs.set(stream.matchId, stream.sportType);
    }
  }
  const entries = [...refs.entries()].slice(0, limit);
  const detailed = new Map();
  const diagnostics = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < entries.length) {
      const [matchId, sportType] = entries[cursor++];
      try {
        const result = await requestMatchDetail(matchId, sportType);
        if (result.streams.length) detailed.set(matchId, result.streams);
        diagnostics.push(result.diagnostics);
      } catch (error) {
        diagnostics.push({ matchId, sportType, error: error.message, status: error.status });
      }
      if (REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, entries.length) }, worker));
  return { detailed, diagnostics, referenceCount: refs.size };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function inspectQueries(queries, lang = LANGUAGE) {
  const results = [];
  for (let index = 0; index < queries.length; index++) {
    const [name, type] = queries[index];
    try {
      results.push(await requestSport(name, type, lang));
    } catch (error) {
      results.push({ matches: [], streams: [], diagnostics: {
        sport: name,
        sportType: type,
        error: error.message,
        status: error.status,
        contentType: error.contentType,
        bytes: error.bytes
      } });
    }
    if (index < queries.length - 1 && REQUEST_DELAY_MS > 0) await sleep(REQUEST_DELAY_MS);
  }
  return results;
}

export async function inspectLiveCatalog() {
  const settled = await inspectQueries([["all", 0], ...SPORTS]);
  const valid = settled.filter(result => result.matches.length || result.streams.length);
  const aggregate = settled[0];
  const detailCheck = aggregate ? await resolveDetailedStreams([aggregate], { limit: 2 }) : { detailed: new Map(), diagnostics: [], referenceCount: 0 };
  return {
    api: await getDataApiBase(),
    liveCode: LIVE_CODE,
    matchDetailCode: MATCH_DETAIL_CODE,
    language: LANGUAGE,
    requests: settled.map(result => result.diagnostics),
    rawMatchCount: valid.reduce((sum, result) => sum + result.matches.length, 0),
    rawStreamCount: valid.reduce((sum, result) => sum + result.streams.length, 0),
    streamReferenceCount: detailCheck.referenceCount,
    detailSamples: detailCheck.diagnostics,
    detailedStreamCount: [...detailCheck.detailed.values()].reduce((sum, streams) => sum + streams.length, 0)
  };
}

function listStreamBacked(results) {
  const byMatch = new Map();
  for (const result of results) {
    const alive = new Set(result.streams.filter(s => s.matchId && s.streamStatus).map(s => s.matchId));
    for (const match of result.matches) {
      if (match.matchId && alive.has(match.matchId) && !byMatch.has(match.matchId)) byMatch.set(match.matchId, match);
    }
  }
  return [...byMatch.values()];
}

export async function resolveMatchStreams(matchId, sportType) {
  const { streams } = await requestMatchDetail(matchId, sportType);
  return streams;
}

export const LANGUAGES = { it: 8, en: 0, es: 4, pt: 5, fr: 6, de: 7, ru: 9, pl: 16, ro: 17, nl: 21, tr: 24 };

const catalogCaches = new Map(); // lang -> { expiresAt, matches }
const catalogInFlight = new Map();

export function cachedMatch(matchId, lang) {
  const id = String(matchId);
  const pools = lang !== undefined && catalogCaches.has(lang) ? [catalogCaches.get(lang)] : [...catalogCaches.values()];
  for (const pool of pools) {
    const found = pool.matches?.find(match => match.matchId === id);
    if (found) return found;
  }
  return null;
}

export async function liveMatches({ force = false, lang = LANGUAGE } = {}) {
  const cached = catalogCaches.get(lang);
  if (!force && cached?.matches && cached.expiresAt > Date.now()) return cached.matches;
  if (catalogInFlight.has(lang)) return catalogInFlight.get(lang);

  const pending = (async () => {
    const aggregate = await requestSport("all", 0, lang).catch(error => {
      console.error("FCTV aggregate catalog:", error.message);
      return null;
    });
    let results = aggregate ? [aggregate] : [];
    // Stream ids are resolved lazily when an event is opened (resolveMatchStreams).
    let matches = listStreamBacked(results);
    if (!matches.length) {
      results = await inspectQueries(SPORTS, lang);
      matches = listStreamBacked(results);
    }
    console.info(`[FCTV catalog:${lang}] ${matches.length} stream-backed matches`);
    catalogCaches.set(lang, { matches, expiresAt: Date.now() + CACHE_MS });
    return matches;
  })().finally(() => catalogInFlight.delete(lang));

  catalogInFlight.set(lang, pending);
  return pending;
}
