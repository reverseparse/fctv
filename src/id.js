function normalizeId(value) {
  let id = String(value ?? "").trim();

  for (let attempt = 0; attempt < 2 && id.includes("%"); attempt++) {
    try {
      id = decodeURIComponent(id);
    } catch {
      break;
    }
  }

  return id;
}

export function encodeId(value) {
  return `fctv77:${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

export function decodeId(value) {
  let id = normalizeId(value);

  if (id.startsWith("fctv77:")) id = id.slice("fctv77:".length);
  if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new Error("Invalid FCTV77 id: expected Base64URL");
  }

  let decoded;
  try {
    decoded = Buffer.from(id, "base64url").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.matchId) {
      throw new Error("Missing matchId");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Invalid FCTV77 id payload: ${error.message}`);
  }
}
