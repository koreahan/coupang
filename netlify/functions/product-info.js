// netlify/functions/product-info.js
const http = require("http");
const https = require("https");
const axios = require("axios");

/** Keep-Alive agents to reduce latency */
const agentHttp = new http.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 10000 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 50, keepAliveMsecs: 10000 });
const AX = axios.create({
  timeout: 12000,
  httpAgent: agentHttp,
  httpsAgent: agentHttps,
  decompress: true,
  headers: { "Accept-Encoding": "gzip, deflate, br" }
});

/** Extract first http(s) URL from arbitrary text */
function extractFirstUrl(input) {
  if (!input) return "";
  const m = String(input).match(/https?:\/\/[^\s]+/);
  return m ? m[0] : "";
}

/** Resolve link.coupang.com / coupa.ng short links (HEAD -> (optional) GET) */
async function resolveShort(inputUrl, fast=false) {
  const isShort = /^https?:\/\/(link\.coupang\.com|coupa\.ng)\//i.test(inputUrl);
  if (!isShort) return inputUrl;
  let cur = inputUrl;

  // Try HEAD first
  const h = await AX.head(cur, {
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400
  }).catch(e => e?.response);

  let loc = h?.headers?.location;
  if (loc) return new URL(loc, cur).toString();

  if (fast) return cur; // fast 모드면 여기서 종료 (느려짐 방지)

  // Fallback GET once
  const g = await AX.get(cur, {
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400
  }).catch(e => e?.response);

  loc = g?.headers?.location;
  return loc ? new URL(loc, cur).toString() : cur;
}

/** Fetch HTML (mobile first -> desktop fallback) */
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

async function fetchHtml(url, fast=false) {
  // Mobile first
  try {
    const mUrl = url.replace("://www.", "://m.");
    const { data } = await AX.get(mUrl, {
      timeout: fast ? 8000 : 12000,
      headers: {
        "User-Agent": UA_MOBILE,
        "Referer": "https://m.coupang.com/",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml"
      },
      responseType: "text"
    });
    if (typeof data === "string" && data) return { html: data, from: "m" };
  } catch {}

  if (fast) return { html: "", from: "m" }; // fast면 폴백 생략

  const wUrl = url.replace("://m.", "://www.");
  const { data } = await AX.get(wUrl, {
    timeout: 12000,
    headers: {
      "User-Agent": UA_DESKTOP,
      "Referer": "https://www.coupang.com/",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept": "text/html,application/xhtml+xml"
    },
    responseType: "text"
  });
  return { html: data, from: "www" };
}

const toInt = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/[^\d]/g, "");
  return m ? parseInt(m, 10) : null;
};

function parseNamePrice(html) {
  let name = null;

  // Name candidates
  const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (og) name = og[1];
  if (!name) {
    const pn = html.match(/"productName"\s*:\s*"([^"]+)"/i);
    if (pn) name = pn[1];
  }
  if (!name) {
    const tt = html.match(/<title>([^<]+)<\/title>/i);
    if (tt) name = tt[1];
  }
  if (name) name = name.replace(/\s*\|.*$/, "").trim();

  // Price candidates
  const nums = [];
  const keyRx = /"(finalPrice|salePrice|discountedPrice|discountPrice|originPrice|price|unitPrice|wowPrice|minPrice|maxPrice|pcPrice|mobilePrice)"\s*:\s*(\d{2,})/gi;
  let m;
  while ((m = keyRx.exec(html)) !== null) {
    const v = parseInt(m[2], 10);
    if (Number.isFinite(v)) nums.push(v);
  }
  const metaAmt = html.match(/<meta[^>]+property=["']og:product:price:amount["'][^>]+content=["']([^"']+)["']/i);
  if (metaAmt) nums.push(toInt(metaAmt[1]));
  const domStrong = html.match(/<span[^>]*class=["'][^"']*(?:total-price|sale|price)[^"']*["'][^>]*>\s*<strong[^>]*>([^<]+)<\/strong>/i);
  if (domStrong) nums.push(toInt(domStrong[1]));
  const domPlain = html.match(/<span[^>]*class=["'][^"']*prod-price__price[^"']*["'][^>]*>([^<]+)<\/span>/i);
  if (domPlain) nums.push(toInt(domPlain[1]));

  const candidates = nums.filter(n => Number.isFinite(n) && n > 0);
  const price = candidates.length ? Math.min(...candidates) : null;

  return { name: name || null, price: price ?? null };
}

exports.handler = async (event) => {
  const isOptions = event.httpMethod === "OPTIONS";
  if (isOptions) {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ success:false, error:{ code:"METHOD_NOT_ALLOWED", message:"POST only" } })
    };
  }

  const qs = event.queryStringParameters || {};
  const fast = qs.fast === "1";
  const debug = qs.debug === "1";

  let url = "";
  try {
    const body = JSON.parse(event.body || "{}");
    url = extractFirstUrl((body.url || "").trim());
  } catch {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ success:false, error:{ code:"BAD_JSON", message:"Invalid JSON body" } })
    };
  }
  if (!url) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ success:false, error:{ code:"URL_REQUIRED", message:"Valid URL required" } })
    };
  }

  // Resolve short link
  let finalUrl = url;
  try { finalUrl = await resolveShort(url, fast); } catch {}

  // Only coupang domain
  if (!/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(finalUrl)) {
    return {
      statusCode: 400,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ success:false, error:{ code:"INVALID_URL", message:"쿠팡 상품 URL이 아닙니다." }, input:{ url, finalUrl } })
    };
  }

  try {
    const { html, from } = await fetchHtml(finalUrl, fast);
    if (!html) {
      return {
        statusCode: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ success:false, error:{ code:"FETCH_FAILED", message:"상품 페이지를 불러오지 못했습니다." }, input:{ url, finalUrl } })
      };
    }

    const info = parseNamePrice(html);
    const detail = debug ? {
      hasOgTitle: /property=["']og:title/.test(html),
      hasProductNameKey: /"productName"\s*:/.test(html),
      sample: html.slice(0, 1500)
    } : undefined;

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        success: true,
        info: {
          name: info.name,
          price: info.price,
          formattedPrice: Number.isFinite(info.price) ? info.price.toLocaleString("ko-KR") + "원" : null
        },
        source: from,
        input: { url, finalUrl },
        detail
      })
    };
  } catch (e) {
    return {
      statusCode: 502,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ success:false, error:{ code:"PARSE_FAILED", message:String(e?.message || e) }, input:{ url, finalUrl } })
    };
  }
};
