const crypto = require("crypto");
const axios = require("axios");

const HOST = "https://api-gateway.coupang.com";
const PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const VERSION = "v003-safe50-shortlink-resolve";
const ACCESS = process.env.COUPANG_ACCESS_KEY || "";
const SECRET = process.env.COUPANG_SECRET_KEY || "";
const SUB_ID = process.env.COUPANG_SUB_ID || "";

const MAX_PER_MIN = Math.max(1, Number(process.env.DEEPLINK_MAX_PER_MIN || 50));
const SUCCESS_CACHE_MS = Math.max(60_000, Number(process.env.DEEPLINK_SUCCESS_CACHE_MS || 24 * 60 * 60 * 1000));
const FAIL_CACHE_MS = Math.max(10_000, Number(process.env.DEEPLINK_FAIL_CACHE_MS || 10 * 60 * 1000));
const RATE_COOLDOWN_MS = Math.max(60_000, Number(process.env.DEEPLINK_RATE_COOLDOWN_MS || 60 * 1000));
const MIN_INTERVAL_MS = Math.max(0, Number(process.env.DEEPLINK_MIN_INTERVAL_MS || 1200));
const API_TIMEOUT_MS = Math.max(3000, Number(process.env.DEEPLINK_API_TIMEOUT_MS || 12000));
const RESOLVE_SHORT_LINKS = String(process.env.DEEPLINK_RESOLVE_SHORT_LINKS || "true").toLowerCase() !== "false";
const RESOLVE_TIMEOUT_MS = Math.max(2000, Number(process.env.DEEPLINK_RESOLVE_TIMEOUT_MS || 8000));
const RESOLVE_CACHE_MS = Math.max(60_000, Number(process.env.DEEPLINK_RESOLVE_CACHE_MS || 24 * 60 * 60 * 1000));

// Netlify Functions are serverless. These in-memory guards work per warm instance.
// For perfect multi-instance/global rate limiting, put the same state in Redis/Netlify Blobs later.
const state = global.__KUHOT_DEEPLINK_GATE_STATE__ || {
  successCache: new Map(),
  failCache: new Map(),
  resolveCache: new Map(),
  minuteStart: 0,
  minuteCount: 0,
  cooldownUntil: 0,
  lastApiAt: 0,
  inFlight: false
};
global.__KUHOT_DEEPLINK_GATE_STATE__ = state;

function now() { return Date.now(); }
function iso(ts) { return ts ? new Date(ts).toISOString() : null; }
function json(obj, code = 200) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify(obj)
  };
}

function normalizeInputUrl(input) {
  const original = String(input || "").trim();
  if (!original) return "";
  let u;
  try { u = new URL(original); } catch { return original; }

  // Remove noisy tracking params only. Product detail crawling is not performed here.
  [
    "abTestInfo", "src", "spec", "addtag", "ctag", "lptag", "itime", "wTime", "wPcid", "wRef",
    "traceid", "pageType", "pageValue", "mcid", "placementid", "clickBeacon", "campaignid",
    "requestid", "impressionid", "landing_exp", "subparam", "deviceid", "token"
  ].forEach((p) => u.searchParams.delete(p));
  return u.toString();
}

function isShortCoupangLink(input) {
  return /^https?:\/\/link\.coupang\.com\//i.test(String(input || "").trim());
}

function isCoupangProductUrl(input) {
  return /^https?:\/\/(www\.)?coupang\.com\//i.test(String(input || "").trim());
}

async function resolveShortLinkOnce(inputUrl) {
  const original = String(inputUrl || "").trim();
  if (!RESOLVE_SHORT_LINKS || !isShortCoupangLink(original)) {
    return { url: normalizeInputUrl(original), resolved: false, skipped: !RESOLVE_SHORT_LINKS ? "DISABLED" : "NOT_SHORT" };
  }

  const cached = getCache(state.resolveCache, original);
  if (cached?.resolvedUrl) {
    return { url: cached.resolvedUrl, resolved: true, source: "resolve_cache" };
  }

  try {
    const resp = await axios.head(original, {
      maxRedirects: 0,
      timeout: RESOLVE_TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 400
    }).catch((e) => e?.response || null);

    const loc = resp?.headers?.location;
    if (!loc) {
      setCache(state.resolveCache, original, { error: "NO_LOCATION" }, FAIL_CACHE_MS);
      return { url: normalizeInputUrl(original), resolved: false, error: "NO_LOCATION" };
    }

    const resolvedUrl = normalizeInputUrl(new URL(loc, original).toString());
    setCache(state.resolveCache, original, { resolvedUrl }, RESOLVE_CACHE_MS);
    return { url: resolvedUrl, resolved: true, source: "head_location" };
  } catch (e) {
    const err = String(e?.message || e || "RESOLVE_ERROR");
    setCache(state.resolveCache, original, { error: err.slice(0, 300) }, FAIL_CACHE_MS);
    return { url: normalizeInputUrl(original), resolved: false, error: err.slice(0, 300) };
  }
}

function cacheKey(url) {
  return normalizeInputUrl(url);
}

function getCache(map, key) {
  const hit = map.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= now()) {
    map.delete(key);
    return null;
  }
  return hit;
}

function setCache(map, key, value, ttl) {
  map.set(key, { ...value, expiresAt: now() + ttl });
}

function resetMinuteIfNeeded() {
  const t = now();
  if (!state.minuteStart || t - state.minuteStart >= 60_000) {
    state.minuteStart = t;
    state.minuteCount = 0;
  }
}

function getRetryAfterMs() {
  resetMinuteIfNeeded();
  return Math.max(0, 60_000 - (now() - state.minuteStart));
}

function canCallApi() {
  const t = now();
  if (state.cooldownUntil && t < state.cooldownUntil) {
    return { ok: false, reason: "COOLDOWN_ACTIVE", retryAfterMs: state.cooldownUntil - t };
  }
  resetMinuteIfNeeded();
  if (state.minuteCount >= MAX_PER_MIN) {
    const retryAfterMs = getRetryAfterMs();
    // Local cooldown until next minute. Do not hold the serverless function open for 60 seconds.
    state.cooldownUntil = Math.max(state.cooldownUntil || 0, t + retryAfterMs);
    return { ok: false, reason: "LOCAL_RATE_LIMIT", retryAfterMs };
  }
  if (state.inFlight) {
    return { ok: false, reason: "INFLIGHT_BUSY", retryAfterMs: Math.max(1000, MIN_INTERVAL_MS) };
  }
  const sinceLast = t - (state.lastApiAt || 0);
  if (sinceLast < MIN_INTERVAL_MS) {
    return { ok: false, reason: "MIN_INTERVAL", retryAfterMs: MIN_INTERVAL_MS - sinceLast };
  }
  return { ok: true };
}

function markApiCall() {
  resetMinuteIfNeeded();
  state.minuteCount += 1;
  state.lastApiAt = now();
}

function utcSignedDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return String(d.getUTCFullYear()).slice(2) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) + "T" +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) + "Z";
}

function buildAuth(method, path, query = "") {
  const datetime = utcSignedDate();
  const message = `${datetime}${method.toUpperCase()}${path}${query}`;
  const signature = crypto.createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
  const header = `CEA algorithm=HmacSHA256,access-key=${ACCESS},signed-date=${datetime},signature=${signature}`;
  return { header, datetime };
}

function extractPartnerLink(data) {
  const item = Array.isArray(data?.data) ? data.data[0] : null;
  return item?.shortenUrl || item?.landingUrl || item?.shortenUrlMobile || null;
}

function stringifyErrorData(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function detectRateLimit(text) {
  const s = String(text || "");
  if (!/(사용 횟수|초과|rate|limit|Too Many Requests|429|총\s*3회)/i.test(s)) return null;
  const m = s.match(/(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)/);
  let until = now() + RATE_COOLDOWN_MS;
  if (m) {
    const parsed = Date.parse(m[1] + "+09:00");
    if (Number.isFinite(parsed)) until = Math.max(until, parsed);
  }
  state.cooldownUntil = Math.max(state.cooldownUntil || 0, until);
  return { cooldownUntil: state.cooldownUntil, retryAfterMs: Math.max(0, state.cooldownUntil - now()) };
}

function fallback(originalUrl, normalizedUrl, reason, extra = {}) {
  return {
    ok: true,
    success: true,
    partnerOk: false,
    fallbackOriginal: true,
    reason,
    url: originalUrl,
    link: originalUrl,
    partnerUrl: originalUrl,
    partnersUrl: originalUrl,
    finalUrl: originalUrl,
    deepLink: originalUrl,
    deeplink: originalUrl,
    convertedUrl: originalUrl,
    originalUrl,
    normalizedUrl,
    apiCalled: false,
    version: VERSION,
    ...extra
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };

  if (event.httpMethod === "GET") {
    return json({
      ok: true,
      success: true,
      service: "kuhot-deeplink-gate",
      version: VERSION,
      message: "POST only for deeplink conversion. GET is health/dry status only.",
      policy: {
        maxPerMinute: MAX_PER_MIN,
        minIntervalMs: MIN_INTERVAL_MS,
        directMaxAttemptsPerRequest: 1,
        netlifyRetry: false,
        resolveShortLinks: RESOLVE_SHORT_LINKS,
        resolveRetry: false,
        fallbackOriginal: true,
        cooldownUntil: iso(state.cooldownUntil)
      },
      state: {
        minuteCount: state.minuteCount,
        minuteStart: iso(state.minuteStart),
        cooldownUntil: iso(state.cooldownUntil),
        successCacheSize: state.successCache.size,
        failCacheSize: state.failCache.size,
        resolveCacheSize: state.resolveCache.size
      }
    });
  }

  if (event.httpMethod !== "POST") {
    return json({ ok: false, success: false, error: "METHOD_NOT_ALLOWED", message: "POST only" }, 405);
  }

  let body = {};
  try {
    const rawBody = String(event.body || "").trim();
    if (!rawBody) {
      body = {};
    } else {
      try {
        body = JSON.parse(rawBody);
      } catch (_) {
        // PowerShell + curl.exe 조합에서 -d $body 사용 시 내부 따옴표가 깨져 {url:https://...} 형태로 들어오는 경우 방어.
        // 또한 x-www-form-urlencoded(url=...)와 plain URL도 허용한다.
        const ctype = String(event.headers?.["content-type"] || event.headers?.["Content-Type"] || "").toLowerCase();
        if (ctype.includes("application/x-www-form-urlencoded") || rawBody.includes("url=")) {
          const params = new URLSearchParams(rawBody);
          body = Object.fromEntries(params.entries());
        } else if (/^https?:\/\//i.test(rawBody)) {
          body = { url: rawBody };
        } else {
          const m = rawBody.match(/(?:"|')?url(?:"|')?\s*[:=]\s*(?:"|')?(https?:\/\/[^"'\s}]+)(?:"|')?/i)
            || rawBody.match(/(https?:\/\/[^"'\s}]+)/i);
          if (m) body = { url: m[1] };
          else return json({ ok: false, success: false, error: "BAD_JSON", hint: "Send JSON like {\"url\":\"https://link.coupang.com/a/...\"}" }, 400);
        }
      }
    }
  } catch (_) {
    return json({ ok: false, success: false, error: "BAD_BODY" }, 400);
  }

  const originalUrl = String(body.url || body.coupangUrl || body.link || "").trim();
  if (!originalUrl) return json({ ok: false, success: false, error: "URL_REQUIRED", message: "url required" }, 400);

  const resolveInfo = await resolveShortLinkOnce(originalUrl);
  const normalizedUrl = cacheKey(resolveInfo.url || originalUrl);
  const dryRun = body.dryRun === true || body.dryRun === "true";

  // Coupang Deeplink API는 link.coupang.com 단축링크를 그대로 넣으면 rCode 400/url convert failed가 날 수 있다.
  // 단축링크 해제가 안 되면 API를 낭비하지 않고 원본 링크를 그대로 반환한다.
  if (isShortCoupangLink(originalUrl) && !isCoupangProductUrl(normalizedUrl)) {
    return json(fallback(originalUrl, normalizedUrl, "SHORT_LINK_RESOLVE_FAILED_NO_API", {
      resolveInfo,
      apiCalled: false,
      retryAfterMs: FAIL_CACHE_MS
    }));
  }

  const successHit = getCache(state.successCache, normalizedUrl);
  if (successHit) {
    return json({
      ok: true,
      success: true,
      partnerOk: true,
      url: successHit.partnerUrl,
      link: successHit.partnerUrl,
      partnerUrl: successHit.partnerUrl,
      partnersUrl: successHit.partnerUrl,
      finalUrl: successHit.partnerUrl,
      deepLink: successHit.partnerUrl,
      deeplink: successHit.partnerUrl,
      convertedUrl: successHit.partnerUrl,
      originalUrl,
      normalizedUrl,
      resolvedFromShortLink: resolveInfo.resolved,
      resolveInfo,
      source: "success_cache",
      apiCalled: false,
      version: VERSION
    });
  }

  const failHit = getCache(state.failCache, normalizedUrl);
  if (failHit) {
    return json(fallback(originalUrl, normalizedUrl, "FAIL_CACHE", {
      source: "fail_cache",
      retryAfterMs: Math.max(0, failHit.expiresAt - now()),
      lastError: failHit.error
    }));
  }

  if (dryRun) {
    const gate = canCallApi();
    return json({
      ok: true,
      success: true,
      partnerOk: false,
      dryRun: true,
      originalUrl,
      normalizedUrl,
      resolvedFromShortLink: resolveInfo.resolved,
      resolveInfo,
      wouldCallApi: gate.ok,
      gate,
      apiCalled: false,
      version: VERSION
    });
  }

  if (!ACCESS || !SECRET) {
    setCache(state.failCache, normalizedUrl, { error: "ENV_MISSING" }, FAIL_CACHE_MS);
    return json(fallback(originalUrl, normalizedUrl, "ENV_MISSING", { env: { accessKey: Boolean(ACCESS), secretKey: Boolean(SECRET), subId: Boolean(SUB_ID) } }));
  }

  const gate = canCallApi();
  if (!gate.ok) {
    return json(fallback(originalUrl, normalizedUrl, gate.reason, {
      cooldown: gate.reason === "COOLDOWN_ACTIVE" || gate.reason === "LOCAL_RATE_LIMIT",
      retryAfterMs: gate.retryAfterMs,
      cooldownUntil: iso(state.cooldownUntil)
    }));
  }

  state.inFlight = true;
  markApiCall();

  try {
    const { header } = buildAuth("POST", PATH, "");
    const payload = { coupangUrls: [normalizedUrl] };
    if (SUB_ID) payload.subId = SUB_ID;

    const resp = await axios.post(`${HOST}${PATH}`, payload, {
      headers: { Authorization: header, "Content-Type": "application/json" },
      timeout: API_TIMEOUT_MS,
      validateStatus: () => true
    });

    const partnerUrl = resp.status === 200 ? extractPartnerLink(resp.data) : null;
    if (partnerUrl) {
      setCache(state.successCache, normalizedUrl, { partnerUrl }, SUCCESS_CACHE_MS);
      return json({
        ok: true,
        success: true,
        partnerOk: true,
        url: partnerUrl,
        link: partnerUrl,
        partnerUrl,
        partnersUrl: partnerUrl,
        finalUrl: partnerUrl,
        deepLink: partnerUrl,
        deeplink: partnerUrl,
        convertedUrl: partnerUrl,
        originalUrl,
        normalizedUrl,
        resolvedFromShortLink: resolveInfo.resolved,
        resolveInfo,
        source: "api",
        apiCalled: true,
        upstreamStatus: resp.status,
        version: VERSION
      });
    }

    const errText = stringifyErrorData(resp.data);
    const rate = detectRateLimit(errText || resp.status);
    setCache(state.failCache, normalizedUrl, { error: errText.slice(0, 500) }, FAIL_CACHE_MS);
    return json(fallback(originalUrl, normalizedUrl, rate ? "UPSTREAM_RATE_LIMIT" : "UPSTREAM_NO_LINK", {
      apiCalled: true,
      upstreamStatus: resp.status,
      upstreamData: resp.data,
      cooldown: Boolean(rate),
      retryAfterMs: rate?.retryAfterMs || FAIL_CACHE_MS,
      cooldownUntil: rate ? iso(rate.cooldownUntil) : iso(state.cooldownUntil)
    }));
  } catch (e) {
    const errText = stringifyErrorData(e?.response?.data || e?.message || e);
    const rate = detectRateLimit(errText);
    setCache(state.failCache, normalizedUrl, { error: errText.slice(0, 500) }, FAIL_CACHE_MS);
    return json(fallback(originalUrl, normalizedUrl, rate ? "UPSTREAM_RATE_LIMIT" : "UPSTREAM_ERROR", {
      apiCalled: true,
      error: errText.slice(0, 500),
      cooldown: Boolean(rate),
      retryAfterMs: rate?.retryAfterMs || FAIL_CACHE_MS,
      cooldownUntil: rate ? iso(rate.cooldownUntil) : iso(state.cooldownUntil)
    }));
  } finally {
    state.inFlight = false;
  }
};
