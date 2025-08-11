// netlify/functions/product-info.js
// Netlify Function v1 (Node 18+)
// 쿠팡 상품명/최저가 추출 — 8초 예산, 순차 시도(비렌더→비렌더→렌더→직접), NUXT/NEXT 지원

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
    if (!url) return json({ success:false, error:"No URL provided" }, 400);

    // === 8s budget (Netlify 10s 아래) ===
    const T0 = Date.now(), BUDGET = 8000;
    const left = () => Math.max(0, BUDGET - (Date.now() - T0));

    const finalUrl = await normalizeUrl(url);
    const html = await getHtml(finalUrl, left); // 예산 내에서 순차 시도

    const parsed = parseInfo(html) || { title:null, prices:[], currency:"KRW", provider:"none" };
    const fallback = pickPriceFallback(html);

    const all = [...(parsed.prices||[]), ...fallback].filter(n => Number.isFinite(n) && n > 0);
    const minPrice = all.length ? Math.min(...all) : null;

    return json({
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: minPrice ?? null,      // 숫자(KRW)
      currency: parsed.currency ?? "KRW",
      provider: parsed.provider ?? null
    });
  } catch (e) {
    const msg = String(e && e.message || e);
    return json({ success:false, error: msg.includes("aborted") ? "timeout" : msg }, 504);
  }
};

function json(obj, code=200){
  return { statusCode: code, headers: { "Content-Type":"application/json", ...CORS }, body: JSON.stringify(obj) };
}

// ---------- URL 정규화 (짧은링크 해제 + 추적 제거 + itemId/vendorItemId 보존) ----------
async function normalizeUrl(input){
  let u = String(input||"").trim();
  if (u.includes("link.coupang.com")) {
    try { const r = await fetch(u, { method:"HEAD", redirect:"manual" }); const loc = r.headers.get("location"); if (loc) u = loc; } catch {}
  }
  const url = new URL(u);
  const itemId = url.searchParams.get("itemId");
  const vendorItemId = url.searchParams.get("vendorItemId");

  [
    "redirect","src","addtag","itime","lptag","wTime","wPcid","wRef","traceid",
    "pageType","pageValue","spec","ctag","mcid","placementid","clickBeacon",
    "campaignid","puidType","contentcategory","imgsize","pageid","tsource",
    "deviceid","token","contenttype","subid","sig","impressionid","campaigntype",
    "puid","requestid","ctime","contentkeyword","portal","landing_exp","subparam"
  ].forEach(p => url.searchParams.delete(p));

  const m = url.pathname.match(/\/(vp\/)?products\/(\d+)/);
  if (!m) return url.toString();

  const out = new URL(`https://www.coupang.com/vp/products/${m[2]}`);
  if (itemId) out.searchParams.set("itemId", itemId);
  if (vendorItemId) out.searchParams.set("vendorItemId", vendorItemId);
  return out.toString();
}

// ---------- HTML 가져오기 (비렌더→비렌더→렌더→직접) ----------
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
function desktopHeaders(){ return {
  "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};}
function mobileHeaders(){ return {
  "User-Agent":"Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};}

async function getHtml(finalUrl, left){
  const steps = [
    { fn:()=>bee(finalUrl, Math.min(1200, Math.max(600, left()-200)), desktopHeaders(), false) },
    { fn:()=>bee(finalUrl, Math.min(1200, Math.max(600, left()-200)), mobileHeaders(),  false) },
    { fn:()=>bee(finalUrl, Math.min(2000, Math.max(600, left()-200)), desktopHeaders(), true ) },
    { fn:()=>direct(finalUrl, Math.min(1200, Math.max(600, left()-200)), desktopHeaders())    }, // 최후의 보루
  ];
  let last;
  for (const s of steps){
    if (left() < 500) break;
    try { return await s.fn(); } catch(e){ last = e; }
  }
  throw last || new Error("aborted: budget");
}

async function bee(url, timeoutMs, headers, render=true){
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");
  const params = {
    api_key: apiKey,
    url,
    render_js: render ? "true" : "false",
    country_code: "kr",
    ...(render ? {
      wait_for: 'meta[property="og:title"], script[type="application/ld+json"], script[id="__NEXT_DATA__"], #__nuxt, #__next, .prod-buy-header__title'
    } : {}),
    ...(process.env.SCRAPINGBEE_PREMIUM === "1" ? { premium_proxy:"true" } : {}),
    // forward_headers 비활성 권장
  };
  const qs = new URLSearchParams(params);

  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, { method:"GET", headers, signal: ctrl.signal });
    if (!res.ok){
      const body = await res.text().catch(()=> "");
      // 429/5xx 한 번만 짧게 재시도
      const code = Number((/^\D*(\d{3})/.exec(body)||[])[1]||res.status);
      if (code===429 || (code>=500 && code<600)) {
        clearTimeout(t); await sleep(250);
        return await bee(url, timeoutMs, headers, render);
      }
      throw new Error(`ScrapingBee ${res.status} ${body.slice(0,180)}`);
    }
    return await res.text();
  } finally { clearTimeout(t); }
}

// Bee 실패 시 직접 가져오기(서버사이드라 CORS 무관)
async function direct(url, timeoutMs, headers){
  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error("direct "+res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}

// ---------- 파싱 (JSON-LD / NUXT / NEXT.js / META / 텍스트) ----------
function parseInfo(html){
  const prices = [];
  let title = null, currency = "KRW", provider = "none";
  const toNum = v => { const s=String(v??"").replace(/[^0-9.]/g,""); const n=s?Number(s):NaN; return Number.isFinite(n)&&n>0?Math.round(n):null; };
  const push = v => { const n = toNum(v); if (n) prices.push(n); };
  const pullAll = (src, re) => { for (const m of src.matchAll(re)) push(m[1]); };

  // JSON-LD
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)]
    .map(m=>{try{return JSON.parse(m[1]);}catch{return null;}})
    .filter(Boolean)
    .flatMap(o=>Array.isArray(o)?o:(o['@graph']?o['@graph']:[o]));
  const prods = ldBlocks.filter(o=>o&&(o['@type']==='Product'||o['@type']?.includes?.('Product')||o.name));
  if (prods.length){
    provider="json-ld";
    const p0 = prods.find(p=>p?.name); if (p0?.name) title=p0.name;
    for (const p of prods){
      const offers = Array.isArray(p.offers)?p.offers:(p.offers?[p.offers]:[]);
      for (const ofr of offers){
        if (ofr?.priceCurrency) currency = ofr.priceCurrency;
        [ofr?.price, ofr?.lowPrice, ofr?.highPrice].forEach(push);
        const ps = ofr?.priceSpecification;
        (Array.isArray(ps)?ps:(ps?[ps]:[])).forEach(s=>[s?.price,s?.minPrice,s?.maxPrice].forEach(push));
      }
    }
  }

  // META / TITLE
  const og = html.match(/<meta property="og:title" content="([^"]+)"/i) || html.match(/<meta name="title" content="([^"]+)"/i);
  if (!title && og?.[1]) { title = og[1]; provider = provider==="none"?"meta":provider; }
  if (!title){ const t = html.match(/<title>([^<]+)<\/title>/i); if (t?.[1]){ title=t[1].trim(); provider = provider==="none"?"title":provider; } }

  // __NUXT__
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  if (nuxt){
    try{
      const s = JSON.stringify(JSON.parse(nuxt[1]));
      if (!title) title = s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1] || s.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || title;
      ["couponPrice","finalPrice","discountedPrice","salePrice","lowPrice","price","totalPrice","optionPrice","dealPrice","memberPrice","cardPrice","instantDiscountPrice"]
        .forEach(k=>pullAll(s, new RegExp('"' + k + '"\\s*:\\s*("?[-\\d\\.,]+"?)','gi')));
      provider = provider==="none"?"__NUXT__":provider;
    }catch{}
  }

  // __NEXT_DATA__
  const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextData){
    try{
      const obj = JSON.parse(nextData[1]);
      const s = JSON.stringify(obj);
      if (!title) title = s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1] || s.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || title;
      ["couponPrice","finalPrice","discountedPrice","salePrice","lowPrice","price","totalPrice","optionPrice","dealPrice","memberPrice","cardPrice","instantDiscountPrice"]
        .forEach(k=>pullAll(s, new RegExp('"' + k + '"\\s*:\\s*("?[-\\d\\.,]+"?)','gi')));
      provider = provider==="none"?"__NEXT_DATA__":provider;
    }catch{}
  }

  // 최후 SSR 텍스트
  if (!title) title = html.match(/class="prod-buy-header__title"[^>]*>\s*([^<]+)\s*</)?.[1]?.trim() || title;

  return { title: title || null, prices, currency, provider };
}

// ---------- HTML 전역 후보 ----------
function pickPriceFallback(html){
  const out = new Set();
  const toNum = v => { const s=String(v??"").replace(/[^0-9.]/g,""); const n=s?Number(s):NaN; return Number.isFinite(n)&&n>0?Math.round(n):null; };
  const pushAll = re => { for (const m of html.matchAll(re)) { const n = toNum(m[1]); if (n) out.add(n); } };

  [
    /data-rt-price="([\d,\.]+)"/gi,
    /data-price="([\d,\.]+)"/gi,
    /class="total-price[^"]*">[\s\S]*?([\d,\.]+)\s*원/gi,
    /class="prod-price[^"]*">[\s\S]*?([\d,\.]+)\s*원/gi,
    /aria-label="가격\s*([\d,\.]+)\s*원"/gi,
    /<meta property="product:price:amount" content="([^"]+)"/gi,
    /<meta property="og:price:amount" content="([^"]+)"/gi,
    /"couponPrice"\s*:\s*("?[\d,\.]+"?)/gi,
    /"finalPrice"\s*:\s*("?[\d,\.]+"?)/gi,
    /"discountedPrice"\s*:\s*("?[\d,\.]+"?)/gi,
    /"salePrice"\s*:\s*("?[\d,\.]+"?)/gi,
    /"lowPrice"\s*:\s*("?[\d,\.]+"?)/gi,
    /"price"\s*:\s*("?[\d,\.]+"?)/gi,
    /"totalPrice"\s*:\s*("?[\d,\.]+"?)/gi
  ].forEach(re=>pushAll(re));

  return Array.from(out);
}
