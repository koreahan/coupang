const axios = require("axios");
const crypto = require("crypto");

const TIMEOUT_MS = 7000;
const MAX_REDIRECTS = 5;

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  };
}

function isShortCoupang(u) {
  try {
    const { hostname } = new URL(u);
    return ["coupa.ng", "link.coupang.com"].includes(hostname);
  } catch { return false; }
}

async function resolveShortUrl(u) {
  let current = u;
  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await axios.get(current, {
      maxRedirects: 0,
      validateStatus: s => s >= 200 && s < 400,
      timeout: TIMEOUT_MS,
      headers: { "User-Agent": "Mozilla/5.0 (NetlifyFunction; CoupangResolver)" }
    }).catch(err => {
      if (err.response) return err.response;
      throw err;
    });

    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, current).toString();
      current = next;
      continue;
    }
    return current;
  }
  return current;
}

function buildSignature(secret, datetime, method, pathWithQuery) {
  const message = datetime + method + pathWithQuery + "\n";
  return crypto.createHmac("sha256", secret).update(message).digest("base64");
}

function nowIso() {
  return new Date().toISOString();
}

exports.handler = async (event) => {
  const ts = nowIso();

  if (event.httpMethod !== "POST") {
    return json(405, {
      success: false,
      error: { code: "METHOD_NOT_ALLOWED", message: "POST only" }
    });
  }

  const ACCESS = process.env.COUPANG_ACCESS_KEY;
  const SECRET = process.env.COUPANG_SECRET_KEY;
  const SUB_ID = process.env.COUPANG_SUB_ID;
  if (!ACCESS || !SECRET || !SUB_ID) {
    return json(500, {
      success: false,
      error: { code: "MISSING_ENV", message: "Coupang credentials missing" }
    });
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch {
    return json(400, { success: false, error: { code: "BAD_JSON", message: "Invalid JSON body" } });
  }
  const inputUrl = (body.url || "").trim();
  if (!inputUrl) {
    return json(400, { success: false, error: { code: "BAD_REQUEST", message: "'url' is required" } });
  }

  let resolvedUrl = inputUrl;
  let wasShort = false;
  try {
    if (isShortCoupang(inputUrl)) {
      wasShort = true;
      resolvedUrl = await resolveShortUrl(inputUrl);
    }
  } catch (e) {
    return json(502, {
      success: false,
      error: { code: "RESOLVE_FAILED", message: "Failed to resolve short link", details: String(e.message || e) },
      input: { url: inputUrl, resolvedUrl: null, isShort: true }
    });
  }

  const domain = "https://api-gateway.coupang.com";
  const path = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

  const datetime = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const signature = buildSignature(SECRET, datetime, "POST", path);

  try {
    const resp = await axios.post(
      domain + path,
      { coupangUrls: [resolvedUrl] },
      {
        timeout: TIMEOUT_MS,
        headers: {
          "Content-Type": "application/json",
          "X-COUPANG-API-TIMESTAMP": datetime,
          "X-COUPANG-API-SIGNATURE": signature,
          "X-COUPANG-API-ACCESS-KEY": ACCESS,
          "X-COUPANG-API-SUB-ID": SUB_ID,
        },
        validateStatus: s => s >= 200 && s < 500,
      }
    );

    if (resp.status >= 200 && resp.status < 300) {
      let link = "";
      try {
        const arr = resp.data?.data || resp.data?.content || resp.data?.result;
        if (Array.isArray(arr) && arr.length) {
          const it = arr[0];
          link = it.deeplink || it.deepLink || it.shortenUrl || it.shortUrl || it.trackingUrl || it.coupangUrl || it.landingUrl || "";
          if (!link) {
            for (const v of Object.values(it)) {
              if (typeof v === "string" && /^https?:\/\//i.test(v)) { link = v; break; }
            }
          }
        }
      } catch {}

      if (!link) {
        return json(502, {
          success: false,
          error: { code: "PARSE_ERROR", message: "Could not extract deeplink from Coupang response" },
          input: { url: inputUrl, resolvedUrl, isShort: wasShort },
          meta: { provider: "coupang", ts }
        });
      }

      return json(200, {
        success: true,
        link,
        input: { url: inputUrl, resolvedUrl, isShort: wasShort },
        meta: { provider: "coupang", ts }
      });
    }

    return json(resp.status, {
      success: false,
      error: {
        code: "COUPANG_ERROR",
        message: resp.data?.message || `Coupang API error (HTTP ${resp.status})`,
        details: resp.data || null
      },
      input: { url: inputUrl, resolvedUrl, isShort: wasShort },
      meta: { provider: "coupang", ts }
    });

  } catch (e) {
    return json(502, {
      success: false,
      error: { code: "NETWORK_ERROR", message: "Network/timeout calling Coupang API", details: String(e.message || e) },
      input: { url: inputUrl, resolvedUrl, isShort: wasShort },
      meta: { provider: "coupang", ts }
    });
  }
};
