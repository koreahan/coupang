// Netlify Function v1 (Node 18+)
// 쿠팡 상품명/최저가 추출 API
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

    const finalUrl = await normalizeUrl(url);     // ✅ 짧은링크 해체 + itemId 보존
    const html = await getFastestHtml(finalUrl);  // ✅ 렌더 대기 강화

    const parsed = parseInfo(html) || { title:null, prices:[], currency:"KRW", provider:"none" };
    const fallback = pickPriceFallback(html);     // 모든 후보 수집(Set → array)

    const all = [...(parsed.prices||[]), ...fallback].filter(n => Number.isFinite(n) && n > 0);
    const minPrice = all.length ? Math.min(...all) : null;

    return json({
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: minPrice != null ? String(minPrice) : null,  // ✅ 최저가
      currency: parsed.currency ?? "KRW",
      provider: parsed.provider ?? null,
      debug: { count: all.length, sample: all.slice(0, 20) }
    });
  } catch (e) {
    return json({ success:false, error:String(e?.message || e) }, 500);
  }
};

function json(obj, code=200){
  return { statusCode: code, headers: { "Content-Type":"application/json", ...CORS }, body: JSON.stringify(obj) };
}

// ---------- URL 정규화(짧은링크 해체 + 추적 제거 + itemId/vendorItemId 보존) ----------
async function normalizeUrl(input){
  let u = String(input || "").trim();

  // ✅ 짧은링크 해체
  if (u.includes("link.coupang.com")) {
    const r = await fetch(u, { method: "HEAD", redirect: "manual" });
    const loc = r.headers.get("location");
    if (loc) u = loc;
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

// ---------- 스크래핑 ----------
async function getFastestHtml(finalUrl){
  const attempts = [
    () => scrapeWithScrapingBee(finalUrl, 14000, desktopHeaders(), true),
    () => scrapeWithScrapingBee(finalUrl, 14000, mobileHeaders(),  true),
    () => scrapeWithScrapingBee(finalUrl, 7000,  desktopHeaders(), false),
  ];
  try { return await Promise.any(attempts.map(fn => fn())); }
  catch {
    const settled = await Promise.allSettled(attempts.map(fn => fn()));
    const reasons = settled.map(r => r.status === "rejected" ? String(r.reason) : "").filter(Boolean);
    throw new Error("All attempts failed: " + reasons.join(" | "));
  }
}

function desktopHeaders(){ return {
  "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};}
function mobileHeaders(){ return {
  "User-Agent":"Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};}

async function scrapeWithScrapingBee(url, timeoutMs, headers, render=true){
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  const params = {
    api_key: apiKey,
    url,
    render_js: render ? "true" : "false",
    country_code: "kr",
    ...(render ? { wait:"2500", wait_for:'meta[property="og:title"], script[type="application/ld+json"]' } : {}),
    ...(process.env.SCRAPINGBEE_PREMIUM === "1" ? { premium_proxy:"true" } : {}),
    forward_headers: "true",
  };
  const qs = new URLSearchParams(params);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, { method:"GET", headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(()=> "");
      throw new Error(`ScrapingBee ${res.status} ${body.slice(0,300)}`);
    }
    return res.text();
  } finally { clearTimeout(t); }
}

// ---------- 파싱(옵션 20개까지 가격 싹 긁기) ----------
function parseInfo(html){
  const prices = [];
  let title = null, currency = "KRW", provider = "none";

  const toNum = v => {
    const s = String(v ?? "").replace(/[^0-9.]/g, "");
    const n = s ? Number(s) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  const push = v => { const n = toNum(v); if (n) prices.push(n); };
  const pullAll = (src, re) => { for (const m of src.matchAll(re)) push(m[1]); };

  // JSON-LD
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean)
    .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));

  const prods = ldBlocks.filter(o => o && (o['@type']==='Product' || o['@type']?.includes?.('Product') || o.name));
  if (prods.length){
    provider = "json-ld";
    const p0 = prods.find(p => p?.name);
    if (p0?.name) title = p0.name;
    for (const p of prods){
      const offers = Array.isArray(p.offers) ? p.offers : (p.offers ? [p.offers] : []);
      for (const ofr of offers){
        if (ofr?.priceCurrency) currency = ofr.priceCurrency;
        [ofr?.price, ofr?.lowPrice, ofr?.highPrice].forEach(push);
        const ps = ofr?.priceSpecification;
        (Array.isArray(ps) ? ps : ps ? [ps] : []).forEach(s => [s?.price, s?.minPrice, s?.maxPrice].forEach(push));
      }
    }
  }

  // og / <title>
  const og = html.match(/<meta property="og:title" content="([^"]+)"/i) || html.match(/<meta name="title" content="([^"]+)"/i);
  if (!title && og?.[1]) { title = og[1]; provider = provider === "none" ? "meta" : provider; }
  if (!title){
    const t = html.match(/<title>([^<]+)<\/title>/i);
    if (t?.[1]) { title = t[1].trim(); provider = provider === "none" ? "title" : provider; }
  }

  // __NUXT__ 전체 스캔 (옵션/버전 배열 포함)
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  if (nuxt){
    try{
      const s = JSON.stringify(JSON.parse(nuxt[1]));
      if (!title) title = s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1] || s.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || title;

      const keys = [
        "couponPrice","finalPrice","discountedPrice","salePrice","lowPrice","price","totalPrice",
        // 옵션/버전 배열에서 자주 쓰이는 키들:
        "optionPrice","dealPrice","memberPrice","cardPrice","instantDiscountPrice"
      ];
      keys.forEach(k => pullAll(s, new RegExp(`"${k}"\\s*:\\s*("?[\\d,\\.]+\"?)`, "gi")));
      provider = provider === "none" ? "__NUXT__" : provider;
    } catch {}
  }

  return { title: title || null, prices, currency, provider };
}

// ---------- HTML 전역 후보 ----------
function pickPriceFallback(html){
  const out = new Set();
  const toNum = v => {
    const s = String(v ?? "").replace(/[^0-9.]/g, "");
    const n = s ? Number(s) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
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
    /"totalPrice"\s*:\s*("?[\d,\.
