// netlify/functions/product-info.js
// POST 전용. 짧은링크 해제 → 모바일 페이지 시도 → 데스크탑 페이지 시도
// 모든 실패도 200으로 응답 + reason 포함 (프런트 흐름 유지)

const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const COMMON_HEADERS = {
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
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
    const { url } = JSON.parse(event.body || "{}");
    if (!url) {
      return json200({ success: false, reason: "Missing 'url' in body." });
    }

    // 1) 짧은링크 해제 (HEAD 우선, 불가하면 GET with redirect: 'manual')
    const { finalUrl, hops, resolveReason } = await resolveShortUrl(url);

    // 2) productId 추출
    const { productId } = extractProductId(finalUrl) || {};
    if (!productId) {
      return json200({
        success: false,
        reason: `Cannot extract productId. ${resolveReason ? "(" + resolveReason + ")" : ""}`,
        originalUrl: url,
        finalUrl,
        hops,
      });
    }

    // 3) 모바일 페이지 시도
    const mobileUrl = toMobileUrl(finalUrl, productId);
    const mobileTry = await tryFetchProduct(mobileUrl, "mobile");

    if (mobileTry.success) {
      return json200({
        success: true,
        source: "mobile",
        originalUrl: url,
        finalUrl,
        hops,
        productId,
        title: mobileTry.title || null,
        price: mobileTry.price || null,
        currency: mobileTry.currency || "KRW",
        raw: mobileTry.rawPicked ? undefined : undefined, // 의도적 미노출
      });
    }

    // 4) 데스크탑 페이지 시도
    const desktopUrl = toDesktopUrl(finalUrl, productId);
    const desktopTry = await tryFetchProduct(desktopUrl, "desktop");

    if (desktopTry.success) {
      return json200({
        success: true,
        source: "desktop",
        originalUrl: url,
        finalUrl,
        hops,
        productId,
        title: desktopTry.title || null,
        price: desktopTry.price || null,
        currency: desktopTry.currency || "KRW",
      });
    }

    // 5) 모두 실패: 그래도 200 + reason 반환
    return json200({
      success: false,
      reason: `Parse failed. mobile: ${mobileTry.reason} / desktop: ${desktopTry.reason}`,
      originalUrl: url,
      finalUrl,
      hops,
      productId,
    });
  } catch (err) {
    // 예외도 200으로 랩핑
    return json200({ success: false, reason: `Exception: ${err.message || String(err)}` });
  }
};

/* ------------------------ helpers ------------------------ */

function json200(obj) {
  return { statusCode: 200, headers: { "Content-Type": "application/json", ...CORS_HEADERS }, body: JSON.stringify(obj) };
}

async function resolveShortUrl(startUrl) {
  let current = startUrl;
  const hops = [current];
  let reason = "";

  // 최대 4회 hop, 각 요청 타임아웃 짧게(1.5s)
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

    // 일부 서버가 HEAD 미지원 → 최소 GET(1바이트 범위)로 시도
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

    // 더 이상 수동 리디렉트 없음 → 종료
    break;
  }

  // 쿠팡 도메인 normalize
  try {
    const u = new URL(current);
    if (u.hostname.endsWith("link.coupang.com")) {
      reason = "Short link not fully resolved to coupang.com";
    }
  } catch (_) {}

  return { finalUrl: current, hops, resolveReason: reason };
}

function extractProductId(u) {
  try {
    const url = new URL(u);
    // 일반 패턴: /vp/products/:productId
    const m = url.pathname.match(/\/vp\/products\/(\d+)/);
    if (m) return { productId: m[1] };

    // 다른 패턴 대비(안전장치): /products/:id
    const m2 = url.pathname.match(/\/products\/(\d+)/);
    if (m2) return { productId: m2[1] };

    return null;
  } catch {
    return null;
  }
}

function toMobileUrl(u, productId) {
  const url = new URL(u);
  url.hostname = "m.coupang.com";
  // 모바일 상세 기본 경로도 /vp/products 유지되는 케이스가 많음
  url.pathname = `/vp/products/${productId}`;
  return url.toString();
}

function toDesktopUrl(u, productId) {
  const url = new URL(u);
  url.hostname = "www.coupang.com";
  url.pathname = `/vp/products/${productId}`;
  return url.toString();
}

async function tryFetchProduct(u, mode /* 'mobile' | 'desktop' */) {
  const ua = mode === "mobile" ? MOBILE_UA : DESKTOP_UA;
  const timeoutMs = 4500; // 이전 대비 타임아웃 단축

  const res = await fetchWithTimeout(u, {
    method: "GET",
    redirect: "follow",
    headers: { ...COMMON_HEADERS, "User-Agent": ua },
  }, timeoutMs).catch((e) => ({ _error: e }));

  if (!res || res._error) {
    return { success: false, reason: `fetch timeout or network error (${mode})` };
  }

  if (res.status >= 400) {
    return { success: false, reason: `HTTP ${res.status} (${mode})` };
  }

  const html = await res.text();
  // 간단/견고 파서: og:title, og:price:amount or JSON-LD offers.price
  const title = pickOg(html, "og:title") || pickMetaName(html, "title") || pickTitleTag(html);
  const { price, currency } = pickPrice(html) || {};

  if (!title && !price) {
    return { success: false, reason: `parse failed (${mode})` };
  }

  return { success: true, title, price, currency: currency || "KRW" };
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
  // 1) og:price:amount
  const ogPrice = pickOg(html, "product:price:amount") || pickOg(html, "og:price:amount");
  const ogCurrency = pickOg(html, "product:price:currency") || pickOg(html, "og:price:currency");
  if (ogPrice) return { price: toNumber(ogPrice), currency: ogCurrency || "KRW" };

  // 2) JSON-LD offers.price
  const jsonLdBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  for (const block of jsonLdBlocks) {
    try {
      const data = JSON.parse(block);
      const offers = Array.isArray(data) ? data.flatMap(x => x.offers ? [x.offers] : []) : (data.offers ? [data.offers] : []);
      for (const off of offers) {
        if (!off) continue;
        if (typeof off.price === "number" || typeof off.price === "string") {
          return { price: toNumber(off.price), currency: off.priceCurrency || "KRW" };
        }
      }
    } catch {}
  }

  // 3) fallback: 페이지 내 숫자 패턴(원 단위) heuristic
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
