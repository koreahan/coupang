// netlify/functions/product-info.js
// Node 18+ (fetch 내장). Netlify v1 handler.

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
    if (!url) {
      return json({ success: false, error: "No URL provided" });
    }

    const finalUrl = await normalizeUrl(url);
    const html = await getFastestHtml(finalUrl);

    const parsed = parseInfo(html) || {};
    return json({
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: parsed.price ?? null,
      currency: parsed.currency ?? "KRW",
      provider: parsed.provider ?? null,
    });
  } catch (err) {
    return json({ success: false, error: String(err && err.message || err) });
  }
};

// -------- helpers --------
function json(obj, code = 200) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", ...CORS },
    body: JSON.stringify(obj),
  };
}

// 1) URL 정규화: 짧은링크 해제 + 추적파라미터 제거 + canonical 경로 강제
async function normalizeUrl(input) {
  let u = input.trim();

  // a) 쿠팡 파트너스 짧은링크는 서버에서만 해제(프론트 CORS 회피)
  if (u.includes("link.coupang.com")) {
    const r = await fetch(u, { method: "HEAD", redirect: "manual" });
    const loc = r.headers.get("location");
    if (loc) u = loc;
  }

  const url = new URL(u);
  [
    "redirect","src","addtag","itime","lptag","wTime","wPcid","wRef","traceid",
    "pageType","pageValue","spec","ctag","mcid","placementid","clickBeacon",
    "campaignid","puidType","contentcategory","imgsize","pageid","tsource",
    "deviceid","token","contenttype","subid","sig","impressionid","campaigntype",
    "puid","requestid","ctime","contentkeyword","portal","landing_exp","subparam"
  ].forEach(p => url.searchParams.delete(p));

  const m = url.pathname.match(/\/(vp\/)?products\/(\d+)/);
  return m ? `https://www.coupang.com/vp/products/${m[2]}` : url.toString();
}

// 2) 가장 빠른 HTML(병렬 레이스)
async function getFastestHtml(finalUrl) {
  const attempts = [];

  // ScrapingBee (필수)
  attempts.push(() => scrapeWithScrapingBee(finalUrl, 6500, desktopHeaders(), true));
  attempts.push(() => scrapeWithScrapingBee(finalUrl, 6500, mobileHeaders(), true));
  attempts.push(() => scrapeWithScrapingBee(finalUrl, 2500, desktopHeaders(), false)); // 비렌더 백업

  // Zyte (선택)
  if (process.env.ZYTE_API_KEY) {
    attempts.push(() => scrapeWithZyte(finalUrl, 7500));
  }
  // Scrapfly (선택)
  if (process.env.SCRAPFLY_KEY) {
    attempts.push(() => scrapeWithScrapfly(finalUrl, 7500));
  }

  // 먼저 성공한 시도 하나만 선택
  const settled = await Promise.allSettled(attempts.map(fn => fn()));
  const ok = settled.find(r => r.status === "fulfilled");
  if (ok) return ok.value;

  // 디버깅 도움: 실패 사유를 묶어서 반환
  const reasons = settled.map(r => r.status === "rejected" ? String(r.reason) : "").filter(Boolean);
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

// 3) Providers
async function scrapeWithScrapingBee(url, timeoutMs, headers, render = true) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  const qs = new URLSearchParams({
    api_key: apiKey,
    url,
    render_js: render ? "true" : "false",
    premium_proxy: "true",
    country_code: "kr",
    wait: render ? "networkidle" : "",
    wait_for: render ? 'meta[property="og:title"]' : "",
    forward_headers: "true",
  });

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, {
    method: "GET",
    headers,
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));

  if (!res.ok) throw new Error(`ScrapingBee ${res.status}`);
  return res.text();
}

async function scrapeWithZyte(url, timeoutMs) {
  const key = process.env.ZYTE_API_KEY;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch("https://api.zyte.com/v1/extract", {
    method: "POST",
    headers: {
      "Authorization": "APIKey " + key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url,
      browserHtml: true,
      httpResponseBody: true,
      actions: [{ action: "waitForSelector", selector: 'meta[property="og:title"]', timeout: 6500 }],
    }),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));
  if (!res.ok) throw new Error(`Zyte ${res.status}`);
  const data = await res.json();
  return data.browserHtml?.html || data.httpResponseBody || "";
}

async function scrapeWithScrapfly(url, timeoutMs) {
  const key = process.env.SCRAPFLY_KEY;
  const qs = new URLSearchParams({
    key,
    url,
    render_js: "true",
    asp: "true",
    country: "kr",
    wait_for_selector: 'meta[property="og:title"]',
  });
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(`https://api.scrapfly.io/scrape?${qs}`, { signal: ctrl.signal })
    .finally(() => clearTimeout(t));
  if (!res.ok) throw new Error(`Scrapfly ${res.status}`);
  const data = await res.json();
  return data.result?.content || "";
}

// 4) 파싱
function parseInfo(html) {
  // JSON‑LD(Product)
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find(o => o && (o["@type"] === "Product" || o.name));
  if (ld) {
    const price = ld?.offers?.price ?? ld?.offers?.lowPrice ?? null;
    const currency = ld?.offers?.priceCurrency ?? "KRW";
    if (ld.name) return { title: ld.name, price: price ? String(price) : null, currency, provider: "json-ld" };
  }

  // og:title
  const og = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (og?.[1]) {
    const p = pickPriceFallback(html);
    return { title: og[1], price: p, currency: "KRW", provider: "og" };
  }

  // __NUXT__ 내부 가격
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  if (nuxt) try {
    const s = JSON.stringify(JSON.parse(nuxt[1]));
    const price = (s.match(/"salePrice"\s*:\s*(\d+)/)?.[1]) || (s.match(/"price"\s*:\s*(\d+)/)?.[1]) || null;
    // 제목 백업
    const title = (s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1]) || null;
    if (title || price) return { title, price, currency: "KRW", provider: "__NUXT__" };
  } catch {}

  return { title: null, price: null, currency: "KRW", provider: "none" };
}

function pickPriceFallback(html) {
  // 간단 백업: common price markers
  const m =
    html.match(/"salePrice"\s*:\s*(\d+)/) ||
    html.match(/"price"\s*:\s*(\d+)/) ||
    html.match(/data-price="(\d+)"/);
  return m?.[1] || null;
}
