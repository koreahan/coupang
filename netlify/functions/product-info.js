// netlify/functions/product-info.js
// Node 18+ (fetch 내장). Netlify v1 handler.
// ScrapingBee 병렬 시도 + 데스크톱/모바일 URL 동시 시도 + 견고한 파싱 + 400 방지 + 디버그.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const DEBUG = process.env.DEBUG === "true"; // DEBUG=true 시 파싱실패 디버그 필드 포함

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
    const payload = {
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: parsed.price ?? null,
      currency: parsed.currency ?? "KRW",
      provider: parsed.provider ?? null,
    };

    if (DEBUG && !parsed.title && !parsed.price) {
      payload.debug = {
        htmlLength: html?.length || 0,
        hasOg: /<meta property="og:title"/.test(html),
        ldCount: (html.match(/<script type="application\/ld\+json">/g) || []).length,
        hasNuxt: /window\.__NUXT__\s*=/.test(html),
        hasNext: /id="__NEXT_DATA__"/.test(html),
      };
    }

    return json(payload);
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

/* ---------------- URL 정규화 ---------------- */
async function normalizeUrl(input) {
  let u = input.trim();

  // 쿠팡 파트너스 짧은링크 서버에서 해제
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
  const desktop = m ? `https://www.coupang.com/vp/products/${m[2]}` : url.toString();
  const mobile  = m ? `https://m.coupang.com/vp/products/${m[2]}` : desktop;

  return { desktop, mobile, id: m ? m[2] : null, toString(){ return desktop; } };
}

/* ---------------- 병렬 시도(데스크톱+모바일) ---------------- */
async function getFastestHtml(finalUrlObj) {
  const { desktop, mobile } = typeof finalUrlObj === 'string'
    ? { desktop: finalUrlObj, mobile: toMobile(finalUrlObj) }
    : finalUrlObj;

  const attempts = [
    // 데스크톱 렌더링/비렌더
    () => scrapeWithScrapingBee(desktop, 9000, desktopHeaders(), true),
    () => scrapeWithScrapingBee(desktop, 2800, desktopHeaders(), false),
    // 모바일 렌더링/비렌더 (모바일이 더 잘 뜨는 상품 존재)
    () => scrapeWithScrapingBee(mobile, 9000, mobileHeaders(), true),
    () => scrapeWithScrapingBee(mobile, 2800, mobileHeaders(), false),
  ];

  const results = await Promise.allSettled(attempts.map(fn => fn()));
  const ok = results.find(r => r.status === "fulfilled");
  if (ok) return ok.value;

  const reasons = results.filter(r => r.status === "rejected").map(r => String(r.reason));
  throw new Error("All attempts failed: " + reasons.join(" | "));
}

function toMobile(desktopUrl) {
  try {
    const u = new URL(desktopUrl);
    u.hostname = "m.coupang.com";
    return u.toString();
  } catch { return desktopUrl; }
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

/* ---------------- ScrapingBee 호출 ---------------- */
async function scrapeWithScrapingBee(url, timeoutMs, headers, render = true) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  // 빈 값 전송 금지(400 방지) + 렌더링 시에만 wait/selector
  const params = {
    api_key: apiKey,
    url,
    render_js: render ? "true" : "false",
    premium_proxy: "true",
    country_code: "kr",
    forward_headers: "true",
    ...(render ? {
      wait: "networkidle",
      wait_for: [
        'meta[property="og:title"]',
        'script[type="application/ld+json"]',
        '#__NEXT_DATA__',
        'script#__NEXT_DATA__',
      ].join(','),
      js_scenario: 'return true;', // 렌더 안정화용 no-op
    } : {})
  };

  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") qs.append(k, v);
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

/* ---------------- 파싱 로직(강화판) ---------------- */
function parseInfo(html) {
  // 1) JSON‑LD(Product) — 배열/@graph 지원
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean);

  const flatten = (node) => {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap(flatten);
    if (node['@graph']) return flatten(node['@graph']);
    return [node];
  };
  const ldFlat = ldBlocks.flatMap(flatten);

  const product = ldFlat.find(o =>
    (o['@type'] && String(o['@type']).toLowerCase().includes('product')) ||
    (o.name && (o.offers || o.price || o.brand))
  );

  if (product) {
    const title = product.name || product.headline || null;
    const offers = product.offers && (Array.isArray(product.offers) ? product.offers[0] : product.offers);
    let price = offers?.price ?? offers?.lowPrice ?? product.price ?? null;
    if (typeof price === 'string') {
      const m = price.replace(/[^\d.]/g,'').match(/\d+(?:\.\d+)?/);
      price = m ? m[0] : null;
    }
    const currency = offers?.priceCurrency || product.priceCurrency || 'KRW';
    if (title || price) return { title: title ?? null, price: price ?? null, currency, provider: 'json-ld' };
  }

  // 2) OG
  const og = html.match(/<meta property="og:title" content="([^"]+)"/);
  if (og?.[1]) {
    const p = pickPriceFallback(html);
    return { title: og[1], price: p, currency: "KRW", provider: "og" };
  }

  // 3) __NUXT__ (Nuxt)
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  if (nuxt) try {
    const s = JSON.stringify(JSON.parse(nuxt[1]));
    const price = (s.match(/"salePrice"\s*:\s*"?([\d,]+)"?/)?.[1]) ||
                  (s.match(/"discountedPrice"\s*:\s*"?([\d,]+)"?/)?.[1]) ||
                  (s.match(/"price"\s*:\s*"?([\d,]+)"?/)?.[1]) || null;
    const title = (s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1]) ||
                  (s.match(/"displayProductName"\s*:\s*"([^"]+)"/)?.[1]) ||
                  (s.match(/"name"\s*:\s*"([^"]+)"/)?.[1]) || null;
    const normPrice = price ? price.replace(/[^\d]/g,'') : null;
    if (title || normPrice) return { title, price: normPrice, currency: "KRW", provider: "__NUXT__" };
  } catch {}

  // 4) __NEXT_DATA__ (Next.js)
  const nextTag = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextTag) {
    try {
      const data = JSON.parse(nextTag[1]);
      const s = JSON.stringify(data);
      const title = (s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1]) ||
                    (s.match(/"displayProductName"\s*:\s*"([^"]+)"/)?.[1]) ||
                    (s.match(/"name"\s*:\s*"([^"]+)"/)?.[1]) || null;
      const price = (s.match(/"priceSales"\s*:\s*"?([\d,]+)"?/)?.[1]) ||
                    (s.match(/"salePrice"\s*:\s*"?([\d,]+)"?/)?.[1]) ||
                    (s.match(/"discountedPrice"\s*:\s*"?([\d,]+)"?/)?.[1]) ||
                    (s.match(/"buyPrice"\s*:\s*"?([\d,]+)"?/)?.[1]) ||
                    (s.match(/"price"\s*:\s*"?([\d,]+)"?/)?.[1]) || null;
      const normPrice = price ? price.replace(/[^\d]/g,'') : null;
      if (title || normPrice) return { title, price: normPrice, currency: "KRW", provider: "__NEXT_DATA__" };
    } catch {}
  }

  // 5) meta price 백업
  const metaPrice =
    html.match(/<meta[^>]+itemprop="price"[^>]+content="([\d,]+)"/) ||
    html.match(/<meta[^>]+property="product:price:amount"[^>]+content="([\d,]+)"/);
  if (metaPrice?.[1]) {
    const t = og?.[1] || extractTitleTag(html);
    return { title: t || null, price: metaPrice[1].replace(/[^\d]/g,''), currency: "KRW", provider: "meta" };
  }

  // 6) 흔한 일반 키(백업)
  const genericTitle =
    html.match(/"displayProductName"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/"productName"\s*:\s*"([^"]+)"/)?.[1] ||
    html.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ||
    null;

  const genericPrice =
    html.match(/"priceSales"\s*:\s*"?([\d,]+)"?/)?.[1] ||
    html.match(/"buyPrice"\s*:\s*"?([\d,]+)"?/)?.[1] ||
    html.match(/"salePrice"\s*:\s*"?([\d,]+)"?/)?.[1] ||
    html.match(/"price"\s*:\s*"?([\d,]+)"?/)?.[1] ||
    html.match(/data-price="([\d,]+)"/)?.[1] ||
    null;

  if (genericTitle || genericPrice) {
    return {
      title: genericTitle || null,
      price: genericPrice ? genericPrice.replace(/[^\d]/g,'') : null,
      currency: "KRW",
      provider: "generic"
    };
  }

  // 7) <title> 최종 백업
  const ttl = extractTitleTag(html);
  if (ttl) {
    return { title: ttl, price: pickPriceFallback(html), currency: "KRW", provider: "title" };
  }

  return { title: null, price: null, currency: "KRW", provider: "none" };
}

function pickPriceFallback(html) {
  const m =
    html.match(/"priceSales"\s*:\s*"?([\d,]+)"?/) ||
    html.match(/"discountedPrice"\s*:\s*"?([\d,]+)"?/) ||
    html.match(/"salePrice"\s*:\s*"?([\d,]+)"?/) ||
    html.match(/"buyPrice"\s*:\s*"?([\d,]+)"?/) ||
    html.match(/"price"\s*:\s*"?([\d,]+)"?/) ||
    html.match(/data-price="([\d,]+)"/);
  const v = m?.[1]?.replace(/[^\d]/g,'');
  return v || null;
}

function extractTitleTag(html){
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  let t = m[1].replace(/\s+/g,' ').trim();
  t = t.replace(/\|?\s*쿠팡!?/g,'').replace(/:\s*로켓배송.*$/,'').trim();
  return t || null;
}
