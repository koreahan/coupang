// Netlify Function (최종 통합 버전)
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

    // 1단계: 빠른 비렌더링 스크래핑 시도
    let html = await getFastestHtml(finalUrl, { render: false, timeout: 5000 });
    let parsed = parseInfo(html) || {};

    // 2단계: 1단계에서 가격을 찾지 못했다면 느린 렌더링 스크래핑 시도
    if (parsed.price === null) {
      html = await getFastestHtml(finalUrl, { render: true, timeout: 15000, premium: true });
      parsed = parseInfo(html) || parsed; // 기존에 찾은 title을 유지
    }

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

function json(obj, code = 200) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", ...CORS },
    body: JSON.stringify(obj),
  };
}

async function normalizeUrl(input) {
  let u = input.trim();
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

async function getFastestHtml(finalUrl, options) {
  try {
    const html = await scrapeWithScrapingBee(finalUrl, options);
    if (/Sorry!\s*Access\s*denied/i.test(html) || html.length < 2000) {
      throw new Error('BLOCKED_PAGE');
    }
    return html;
  } catch (e) {
    throw new Error(`스크래핑 실패: ${e.message}`);
  }
}

async function scrapeWithScrapingBee(url, options) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");
  const params = {
    api_key: apiKey,
    url,
    render_js: options.render ? "true" : "false",
    ...(options.premium ? { premium_proxy: "true" } : {}),
    country_code: "kr",
    ...(options.render ? { wait: "3000", wait_for: 'meta[property="og:title"], script[type="application/ld+json"]' } : {}),
    forward_headers: "true",
  };
  const qs = new URLSearchParams(params);
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), options.timeout);
  const res = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, {
    method: "GET",
    headers,
    signal: ctrl.signal,
  }).finally(() => clearTimeout(t));
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ScrapingBee ${res.status} ${body}`);
  }
  return res.text();
}

// HTML 파싱 (최저가 검색 로직 보강)
function parseInfo(html) {
  const prices = [];
  let title = null, currency = "KRW", provider = "none";
  const toNum = v => {
    const s = String(v ?? "").replace(/[^0-9.]/g, "");
    const n = s ? Number(s) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const push = v => { const n = toNum(v); if (n) prices.push(n); };

  // 1. 단순 패턴 먼저 시도
  const simplePricePatterns = [
    /class="salePrice"[^>]*>[\s\S]*?([\d,.]+)<\/span>/gi, // 사용자님 코드와 유사한 단순 패턴
    /class="price"[^>]*>[\s\S]*?<strong>([\d,.]+)<\/strong>/gi,
    /data-price="([\d,.]+)"/gi,
  ];
  simplePricePatterns.forEach(re => {
    const m = html.match(re);
    if (m && m[1]) {
      push(m[1]);
    }
  });

  // 2. JSON-LD 파싱 (1순위)
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean)
    .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));
  const prod = ldBlocks.find(o => (o['@type'] === 'Product' || o['@type']?.includes?.('Product') || o.name));
  if (prod) {
    provider = 'json-ld';
    if (prod.name) title = prod.name;
    const offers = Array.isArray(prod.offers) ? prod.offers : (prod.offers ? [prod.offers] : []);
    offers.forEach(o => {
      if (o?.priceCurrency) currency = o.priceCurrency;
      [o?.price, o?.lowPrice, o?.highPrice].forEach(v => {
        const n = toNum(v);
        if (n) prices.push(n);
      });
    });
  }

  // 3. og:title 파싱
  const og = html.match(/<meta property="og:title" content="([^"]+)"/) || html.match(/<meta name="title" content="([^"]+)"/);
  if (!title && og?.[1]) {
    title = og[1];
    provider = provider === 'none' ? 'meta' : provider;
  }

  // 4. __NUXT__ 내부 파싱
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  if (nuxt) try {
    const s = nuxt[1];
    if (!title) {
        title = s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1]
             || s.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || null;
    }
    const nuxtPrices = [...s.matchAll(/"(couponPrice|finalPrice|discountedPrice|salePrice|lowPrice|price|totalPrice|optionPrice|dealPrice|memberPrice|cardPrice|instantDiscountPrice)"\s*:\s*("?[\d,\.]+"?)/g)];
    nuxtPrices.forEach(m => push(m[2]));
    provider = provider === 'none' ? '__NUXT__' : provider;
  } catch {}

  // 5. 모든 가격 후보 중 최저가 선택
  const minPrice = prices.length ? Math.min(...prices) : null;

  return {
    title,
    price: minPrice != null ? String(minPrice) : null,
    currency,
    provider
  };
}

function pickPriceFallback(html) {
  // 사용자의 원본 pickPriceFallback 함수는 최저가를 찾지 못하므로, 이 함수는 사용하지 않습니다.
  return null;
}
