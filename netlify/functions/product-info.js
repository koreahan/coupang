// Netlify Function v1 (Node 18+)
// 쿠팡 상품명/최저가 추출 API — 순차 시도 + 시간예산 + fail-soft (에러 대신 빈값 반환)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
    if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "POST only" };

    const { url } = JSON.parse(event.body || "{}");
    if (!url) return json({ success: false, error: "No URL provided" });

    const finalUrl = await normalizeUrl(url);

    // 전체 시간 예산(밀리초) — Netlify 무료 플랜 기준 넉넉하게 9.5s
    const BUDGET = 9500;
    const t0 = Date.now();

    // 1) 빠른 정적 시도 (렌더X, 2500ms)
    let html = await tryBee(finalUrl, { render: false, timeout: 2500 }).catch(() => "");
    let parsed = parseInfo(html);

    // 2) 제목/가격이 없으면: 렌더(기본) 5000ms
    if ((!parsed.title || parsed.price == null) && left(t0, BUDGET) > 1200) {
      html = await tryBee(finalUrl, { render: true, timeout: 5000 }).catch(() => "");
      parsed = prefer(parsed, parseInfo(html));
    }

    // 3) 그래도 없고 프리미엄 가능하면: 프리미엄 렌더 6000ms
    if ((!parsed.title || parsed.price == null) && left(t0, BUDGET) > 1200 && process.env.SCRAPINGBEE_PREMIUM === "1") {
      html = await tryBee(finalUrl, { render: true, timeout: 6000, premium: true, blockResources: false }).catch(() => "");
      parsed = prefer(parsed, parseInfo(html));
    }

    // fail-soft: 여기서 에러 던지지 않음. 프런트는 success=true라서 빨간 에러 안 뜸.
    return json({
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: parsed.price ?? null,        // 최저가(정수, 원). 없으면 null
      currency: "KRW",
      provider: parsed.provider ?? "coupang",
      notes: parsed.notes || (parsed.title || parsed.price ? undefined : "no_data"),
    });
  } catch (err) {
    // URL 형식 오류 등만 fail-hard
    return json({ success: false, error: String(err && err.message || err) });
  }
};

function json(obj, code = 200) {
  return { statusCode: code, headers: { "Content-Type": "application/json", ...CORS }, body: JSON.stringify(obj) };
}

/* ---------------- URL 정규화 ---------------- */
async function normalizeUrl(input) {
  let u = String(input || "").trim();

  // 쿠팡 딥링크 해제(1회)
  if (u.includes("link.coupang.com")) {
    try {
      const r = await fetch(u, { method: "HEAD", redirect: "manual" });
      const loc = r.headers.get("location");
      if (loc) u = loc;
    } catch {}
  }

  const url = new URL(u);
  // 추적 파라미터 정리
  [
    "redirect","src","addtag","itime","lptag","wTime","wPcid","wRef","traceid",
    "pageType","pageValue","spec","ctag","mcid","placementid","clickBeacon",
    "campaignid","puidType","contentcategory","imgsize","pageid","tsource",
    "deviceid","token","contenttype","subid","sig","impressionid","campaigntype",
    "puid","requestid","ctime","contentkeyword","portal","landing_exp","subparam"
  ].forEach(p => url.searchParams.delete(p));

  // /vp/products/{id}로 통일
  const m = url.pathname.match(/\/(vp\/)?products\/(\d{6,})/);
  return m ? `https://www.coupang.com/vp/products/${m[2]}` : url.toString();
}

/* ---------------- ScrapingBee 호출(순차) ---------------- */
async function tryBee(url, opt) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  const params = new URLSearchParams({
    api_key: apiKey,
    url,
    render_js: opt.render ? "true" : "false",
    country_code: "kr",
    ...(opt.render ? { wait_for: 'meta[property="og:title"],script[type="application/ld+json"]' } : {}),
    ...(opt.premium ? { premium_proxy: "true" } : {}),
    ...(opt.blockResources === false ? {} : { block_resources: "true" }),
  });

  const headers = opt.mobile
    ? {
        "User-Agent": "Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      }
    : {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opt.timeout || 3000);
  try {
    const res = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, { headers, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`ScrapingBee ${res.status} ${text}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- 파서(최저가 보장) ---------------- */
function toNum(x){ if(x==null) return null; const n = +String(x).replace(/[^\d]/g,""); return Number.isFinite(n) ? n : null; }
function uniqNums(arr){ const s=new Set(), out=[]; for(const n of arr){ if(n==null) continue; if(!s.has(n)){ s.add(n); out.push(n);} } return out; }

function parseInfo(html) {
  if (!html) return { title: null, price: null, provider: "none", notes: "empty_html" };

  let title = null;
  const prices = [];

  // JSON-LD (배열 / @graph)
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean)
    .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));

  for (const o of ldBlocks) {
    const isProduct =
      o && (o['@type'] === 'Product' || (Array.isArray(o['@type']) && o['@type'].includes('Product')) || o.name);
    if (!isProduct) continue;

    if (!title && o.name) title = String(o.name).trim();

    const offers = Array.isArray(o.offers) ? o.offers : (o.offers ? [o.offers] : []);
    for (const off of offers) {
      if (off?.price) prices.push(toNum(off.price));
      if (off?.lowPrice) prices.push(toNum(off.lowPrice));
    }
    if (o.aggregateOffer) {
      const agg = o.aggregateOffer;
      if (agg.lowPrice) prices.push(toNum(agg.lowPrice));
      if (agg.price) prices.push(toNum(agg.price));
    }
  }

  // 메타/타이틀 보강
  if (!title) {
    title =
      (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]) ||
      (html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i)?.[1]) ||
      (html.match(/<title>([^<]+)<\/title>/i)?.[1]) || null;
    if (title) title = title.replace(/\s*-\s*쿠팡.*$/,'').trim();
  }

  // 페이지 내 스크립트/속성에서 가격 후보 추가
  const addNums = (re) => { let m; while ((m = re.exec(html))) { const n = toNum(m[1]); if (n) prices.push(n); } };
  addNums(/"finalPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"discountPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"salePrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"wowPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"rocketCardPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"couponPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"lowestPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"originPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"price"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/data-price="([\d\.]+)"/gi);

  const cand = uniqNums(prices).filter(n => Number.isFinite(n) && n > 0);
  const price = cand.length ? Math.min(...cand) : null;

  return { title: title || null, price, provider: "coupang" };
}

/* ---------------- 유틸 ---------------- */
function left(t0, BUDGET){ return Math.max(0, BUDGET - (Date.now() - t0)); }
function prefer(a,b){ // b에서 새로 얻은 값으로 보강
  return {
    title: b.title || a.title || null,
    price: (a.price ?? b.price ?? null),
    provider: b.provider || a.provider || "coupang",
  };
}

