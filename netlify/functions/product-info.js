// netlify/functions/product-info.js
// Node 18+ (fetch 내장)
// Netlify v1 handler + CORS + ScrapingBee 병렬 시도 + JSON-LD/og/__NUXT__ 파싱

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: CORS, body: "POST only" };
    }

    const { url } = JSON.parse(event.body || "{}");
    if (!url) return json({ success: false, error: "No URL provided" });

    const finalUrl = await normalizeUrl(url);
    const html = await getFastestHtml(finalUrl);

    const parsed = parseInfo(html) || {};
    return json({
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: parsed.price ?? null,
      currency: parsed.currency ?? "KRW",
      provider: parsed.provider ?? null
    });
  } catch (err) {
    return json({ success: false, error: String(err && err.message || err) });
  }
};

function json(obj, code = 200) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", ...CORS },
    body: JSON.stringify(obj),
  };
}

// ---------------- URL 정규화 ----------------
async function normalizeUrl(input) {
  let u = input.trim();

  // 쿠팡 파트너스 짧은링크 해제
  if (u.includes("link.coupang.com")) {
    const r = await fetch(u, { method: "HEAD", redirect: "manual" });
    const loc = r.headers.get("location");
    if (loc) u = loc;
  }

  const url = new URL(u);
  [
    "redirect","src","addtag","itime","lptag","wTime","wPcid","wRef","traceid",
    "pageType","pageValue","spec","ctag","mcid","placementid","clickBeacon","campaignid",
    "puidType","contentcategory","imgsize","pageid","tsource","deviceid","token","contenttype",
    "subid","sig","impressionid","campaigntype","puid","requestid","ctime","contentkeyword",
    "portal","landing_exp","subparam"
  ].forEach(p => url.searchParams.delete(p));

  const m = url.pathname.match(/\/(vp\/)?products\/(\d+)/);
  return m ? `https://www.coupang.com/vp/products/${m[2]}` : url.toString();
}

// ---------------- 병렬 시도 ----------------
async function getFastestHtml(finalUrl) {
  const attempts = [
    () => scrapeWithScrapingBee(finalUrl, 6500, desktopHeaders(), true),
    () => scrapeWithScrapingBee(finalUrl, 6500, mobileHeaders(), true),
    () => scrapeWithScrapingBee(finalUrl, 2500, desktopHeaders(), false),
  ];

  const results = await Promise.allSettled(attempts.map(fn => fn()));
  const ok = results.find(r => r.status === "fulfilled");
  if (ok) return ok.value;

  const reasons = results
    .filter(r => r.status === "rejected")
    .map(r => String(r.reason));
  throw new Error("All attempts failed: " + reasons.join(" | "));
}

function desktopHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };
}

function mobileHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };
}

// ---------------- ScrapingBee 호출 ----------------
async function scrapeWithScrapingBee(url, timeoutMs, headers, render = true) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  const params = {
    api_key: apiKey,
    url,
    render_js: render ? "true" : "false",
    premium_proxy: "true",
    country_code: "kr",
    forward_headers: "true",
    ...(render ? {
      wait: "networkidle",
      wait_for: 'meta[property="og:title"],script[type="application/ld+json"]',
    } : {})
  };

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") {
      qs.append(k, v);
    }
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  const res = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, {
    method: "GET",
    headers,
    signal: ctrl.signal
  }).finally(() => clearTimeout(t));

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ScrapingBee ${res.status} ${body}`);
  }
  return res.text();
}

// ---------------- 파싱 로직 ----------------
function parseInfo(html) {
  // 1) JSON-LD(Product)
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find(o => o && (o["@type"] === "Product" || o.name));
  if (ld) {
    const price = ld?.offers?.price ?? ld?.offers?.lowPrice ?? null;
    const currency = ld?.offers?.priceCurrency ?? "KRW";
    if (ld.name) return { title: ld.name, price: price ? String(price) : null, currency, provider: "json-ld" };
  }

  // 2) og:title
  const og = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (og?.[1]) {
    const p = pickPriceFallback(html);
    return { title: og[1], price: p, currency: "KRW", provider: "og" };
  }

  // 3) __NUXT__ JSON
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  if (nuxt) try {
    const s = JSON.stringify(JSON.parse(nuxt[1]));
    const price = (s.match(/"salePrice"\s*:\s*(\d+)/)?.[1]) ||
                  (s.match(/"price"\s*:\s*(\d+)/)?.[1]) || null;
    const title = (s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1]) || null;
    if (title || price) return { title, price, currency: "KRW", provider: "__NUXT__" };
  } catch {}

  return { title: null, price: null, currency: "KRW", provider: "none" };
}

function pickPriceFallback(html) {
  const m =
    html.match(/"salePrice"\s*:\s*(\d+)/) ||
    html.match(/"price"\s*:\s*(\d+)/) ||
    html.match(/data-price="(\d+)"/);
  return m?.[1] || null;
}
