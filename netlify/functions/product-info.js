// netlify/functions/product-info.js
// POST 전용: 짧은링크 해제 → (입력 URL 선추출) productId → 렌더링된 HTML 파싱(title/price)
// 실패해도 200으로 { success:false, reason } 반환하여 프런트 흐름 유지

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const COMMON_HEADERS = {
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Cache-Control": "no-cache",
  "Pragma": "no-cache",
  "Upgrade-Insecure-Requests": "1",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const ENV = {
  SCRAPINGBEE_KEY: process.env.SCRAPINGBEE_KEY,
  ZYTE_API_KEY: process.env.ZYTE_API_KEY,
  SCRAPFLY_KEY: process.env.SCRAPFLY_KEY,
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, "Allow": "POST, OPTIONS" },
      body: JSON.stringify({ success: false, reason: "Method Not Allowed. Use POST." }),
    };
  }

  try {
    const { url: inputUrl } = JSON.parse(event.body || "{}");
    if (!inputUrl) return json200({ success: false, reason: "Missing 'url' in body." });

    // (A) 입력 URL에서 먼저 productId 선추출 (리다이렉트 전에!)
    let ex = extractProductId(inputUrl);

    // (B) 짧은링크/리다이렉트 해제
    const { finalUrl, hops } = await resolveShortUrl(inputUrl);

    // (C) 선추출 실패 시 최종 URL에서 재시도
    if (!ex?.productId) ex = extractProductId(finalUrl);

    // (D) 그래도 없으면 HTML에서 productId 폴백 탐색
    if (!ex?.productId) {
      const provider0 = pickProvider();
      if (!provider0) {
        return json200({
          success: false,
          reason: "No scraping provider configured and URL has no productId.",
          originalUrl: inputUrl,
          finalUrl,
          hops,
        });
      }
      try {
        const htmlForId = await fetchRenderedHtml(provider0, finalUrl, DESKTOP_UA, 8000);
        const discoveredId = discoverProductIdFromHtml(htmlForId);
        if (discoveredId) ex = { productId: discoveredId };
      } catch { /* ignore */ }
    }

    if (!ex?.productId) {
      return json200({
        success: false,
        reason: "Cannot extract productId from input/final URL or page HTML.",
        originalUrl: inputUrl,
        finalUrl,
        hops,
      });
    }

    // (E) 본문 수집: 데스크탑 → 모바일 순으로 렌더링 HTML 요청
    const provider = pickProvider();
    if (!provider) {
      return json200({
        success: false,
        reason: "No scraping provider configured.",
        originalUrl: inputUrl,
        finalUrl,
        hops,
        productId: ex.productId,
      });
    }

    const desktopUrl = toDesktopUrl(finalUrl, ex.productId);
    const mobileUrl = toMobileUrl(finalUrl, ex.productId);

    let html = null;
    let source = null;
    let lastErr = null;

    for (const [tryUrl, ua, label] of [
      [desktopUrl, DESKTOP_UA, "desktop"],
      [mobileUrl, MOBILE_UA, "mobile"],
    ]) {
      try {
        html = await fetchRenderedHtml(provider, tryUrl, ua, 9000);
        source = label;
        if (html && html.length > 1500) break;
      } catch (e) {
        lastErr = e;
      }
    }

    if (!html) {
      return json200({
        success: false,
        reason: `Rendered HTML fetch failed (${provider.name})` + (lastErr ? `: ${safeMsg(lastErr)}` : ""),
        originalUrl: inputUrl,
        finalUrl,
        hops,
        productId: ex.productId,
      });
    }

    // (F) 파싱 (title / price)
    const title = pickOg(html, "og:title") || pickMetaName(html, "title") || pickTitleTag(html);
    const priceInfo = pickPrice(html);
    const price = priceInfo?.price ?? null;
    const currency = priceInfo?.currency ?? "KRW";

    if (!title && !price) {
      return json200({
        success: false,
        reason: "Parse failed (no title/price found).",
        originalUrl: inputUrl,
        finalUrl,
        hops,
        productId: ex.productId,
        source,
      });
    }

    return json200({
      success: true,
      provider: provider.name,
      source,
      originalUrl: inputUrl,
      finalUrl,
      hops,
      productId: ex.productId,
      title: title || null,
      price: typeof price === "number" ? price : null,
      currency,
    });
  } catch (err) {
    return json200({ success: false, reason: `Exception: ${safeMsg(err)}` });
  }
};

/* ------------------------ providers ------------------------ */

function pickProvider() {
  if (ENV.SCRAPINGBEE_KEY) return { name: "scrapingbee", fetch: fetchViaScrapingBee };
  if (ENV.ZYTE_API_KEY) return { name: "zyte", fetch: fetchViaZyte };
  if (ENV.SCRAPFLY_KEY) return { name: "scrapfly", fetch: fetchViaScrapfly };
  return null;
}

async function fetchRenderedHtml(provider, url, userAgent, timeoutMs = 9000) {
  return provider.fetch(url, userAgent, timeoutMs);
}

// ScrapingBee
async function fetchViaScrapingBee(url, userAgent, timeoutMs) {
  const endpoint = new URL("https://app.scrapingbee.com/api/v1/");
  endpoint.searchParams.set("api_key", process.env.SCRAPINGBEE_KEY);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("render_js", "true");
  endpoint.searchParams.set("wait", "2000");
  endpoint.searchParams.set("block_resources", "false");
  const res = await fetchWithTimeout(endpoint.toString(), {
    method: "GET",
    headers: { "X-User-Agent": userAgent },
  }, timeoutMs);
  if (res.status >= 400) throw new Error(`ScrapingBee HTTP ${res.status}`);
  return await res.text();
}

// Zyte API
async function fetchViaZyte(url, userAgent, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.zyte.com/v1/extract", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + process.env.ZYTE_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        browserHtml: true,
        httpResponseBody: true,
        browser: { userAgent },
        actions: [{ type: "wait", duration: 2.0 }],
      }),
      signal: controller.signal,
    });
    if (res.status >= 400) throw new Error(`Zyte HTTP ${res.status}`);
    const data = await res.json();
    if (data.browserHtml) return data.browserHtml;
    if (data.httpResponseBody) {
      try { return Buffer.from(data.httpResponseBody, "base64").toString("utf8"); } catch {}
    }
    throw new Error("Zyte: empty body");
  } finally {
    clearTimeout(id);
  }
}

// Scrapfly
async function fetchViaScrapfly(url, userAgent, timeoutMs) {
  const endpoint = new URL("https://api.scrapfly.io/scrape");
  endpoint.searchParams.set("key", process.env.SCRAPFLY_KEY);
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("render_js", "true");
  endpoint.searchParams.set("country", "kr");
  endpoint.searchParams.set("asp", "true");
  endpoint.searchParams.set("wait_for", "2000");

  const res = await fetchWithTimeout(endpoint.toString(), {
    method: "GET",
    headers: { "X-Scrapfly-User-Agent": userAgent },
  }, timeoutMs);
  if (res.status >= 400) throw new Error(`Scrapfly HTTP ${res.status}`);

  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await res.json();
    return j?.result?.content || j?.content || "";
  }
  return await res.text();
}

/* ------------------------ helpers ------------------------ */

function json200(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(obj) };
}

async function resolveShortUrl(startUrl) {
  let current = startUrl;
  const hops = [current];

  for (let i = 0; i < 4; i++) {
    const head = await fetchWithTimeout(current, {
      method: "HEAD",
      redirect: "manual",
      headers: { ...COMMON_HEADERS, "User-Agent": DESKTOP_UA },
    }, 1500).catch(() => null);

    if (head && head.status >= 300 && head.status < 400) {
      const loc = head.headers.get("location");
      if (!loc) break;
      current = new URL(loc, current).toString();
      hops.push(current);
      continue;
    }

    if (!head || head.status === 405 || head.status === 400) {
      const get = await fetchWithTimeout(current, {
        method: "GET",
        redirect: "manual",
        headers: { ...COMMON_HEADERS, "Range": "bytes=0-0", "User-Agent": DESKTOP_UA },
      }, 1500).catch(() => null);

      if (get && get.status >= 300 && get.status < 400) {
        const loc = get.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).toString();
        hops.push(current);
        continue;
      }
    }
    break;
  }
  return { finalUrl: current, hops };
}

function extractProductId(u) {
  try {
    const p = new URL(u).pathname;
    let m = p.match(/\/vp\/products\/(\d+)/i);
    if (m) return { productId: m[1] };
    m = p.match(/\/np\/products\/(\d+)/i);
    if (m) return { productId: m[1] };
    m = p.match(/\/products\/(\d+)/i);
    if (m) return { productId: m[1] };
    return null;
  } catch { return null; }
}

function toMobileUrl(u, productId) {
  const url = new URL(u);
  url.hostname = "m.coupang.com";
  url.pathname = `/vp/products/${productId}`;
  return url.toString();
}

function toDesktopUrl(u, productId) {
  const url = new URL(u);
  url.hostname = "www.coupang.com";
  url.pathname = `/vp/products/${productId}`;
  return url.toString();
}

function discoverProductIdFromHtml(html) {
  if (!html) return null;
  let m;
  m = html.match(/href=["'][^"']*\/vp\/products\/(\d+)[^"']*["']/i);
  if (m) return m[1];
  m = html.match(/href=["'][^"']*\/products\/(\d+)[^"']*["']/i);
  if (m) return m[1];
  m = html.match(/https?:\/\/(?:www\.)?coupang\.com\/vp\/products\/(\d+)/i);
  if (m) return m[1];
  m = html.match(/https?:\/\/(?:www\.)?coupang\.com\/products\/(\d+)/i);
  if (m) return m[1];
  m = html.match(/productId["']?\s*[:=]\s*["']?(\d{6,})["']?/i);
  if (m) return m[1];
  return null;
}

function pickOg(html, property) {
  const re = new RegExp(`<meta[^>]+property=["']${escapeRe(property)}["'][^>]+content=["']([^"']+)["']`, "i");
  const m = html.match(re);
  return m ? decodeHtml(m[1]).trim() : null;
}
function pickMetaName(html, name) {
  const re = new RegExp(`<meta[^>]+name=["']${escapeRe(name)}["'][^>]+content=["']([^"']+)["']`, "i");
  const m = html.match(re);
  return m ? decodeHtml(m[1]).trim() : null;
}
function pickTitleTag(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeHtml(m[1]).trim() : null;
}

function pickPrice(html) {
  const ogPrice = pickOg(html, "product:price:amount") || pickOg(html, "og:price:amount");
  const ogCurrency = pickOg(html, "product:price:currency") || pickOg(html, "og:price:currency");
  if (ogPrice) return { price: toNumber(ogPrice), currency: ogCurrency || "KRW" };

  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block);
      const arr = Array.isArray(data) ? data : [data];
      for (const node of arr) {
        const offers = node?.offers;
        const arrOffers = Array.isArray(offers) ? offers : offers ? [offers] : [];
        for (const off of arrOffers) {
          if (off && (typeof off.price === "number" || typeof off.price === "string")) {
            return { price: toNumber(off.price), currency: off.priceCurrency || "KRW" };
          }
        }
      }
    } catch {}
  }

  const wonMatch = html.match(/([0-9][0-9,]{3,})\s*(?:원|KRW)/);
  if (wonMatch) return { price: toNumber(wonMatch[1]), currency: "KRW" };
  return null;
}

function toNumber(v) {
  if (typeof v === "number") return v;
  return Number(String(v).replace(/[^\d.]/g, ""));
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function decodeHtml(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"');
}

async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function safeMsg(e) {
  try { return e?.message || String(e); } catch { return "error"; }
}
