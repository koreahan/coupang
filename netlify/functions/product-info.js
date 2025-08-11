// Netlify Function v1 (Node 18+)
// 10초 예산에 맞춘 쿠팡 상품명/최저가 추출
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

    const t0 = Date.now();
    const BUDGET = 9500; // ms (Netlify 10s 아래로)
    const left = () => Math.max(0, BUDGET - (Date.now() - t0));

    const finalUrl = await normalizeUrl(url);

    const html = await getHtmlWithinBudget(finalUrl, left);

    const parsed = parseInfo(html) || { title:null, prices:[], currency:"KRW", provider:"none" };
    const fallback = pickPriceFallback(html);

    const all = [...(parsed.prices||[]), ...fallback].filter(n => Number.isFinite(n) && n > 0);
    const minPrice = all.length ? Math.min(...all) : null;

    return json({
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: minPrice ?? null,        // 숫자 KRW
      currency: parsed.currency ?? "KRW",
      provider: parsed.provider ?? null
    });
  } catch (e) {
    return json({ success:false, error:String(e?.message || e) }, 504);
  }
};

function json(obj, code=200){
  return { statusCode: code, headers: { "Content-Type":"application/json", ...CORS }, body: JSON.stringify(obj) };
}

// ---------- URL 정규화 ----------
async function normalizeUrl(input){
  let u = String(input||"").trim();
  if (u.includes("link.coupang.com")) {
    try {
      const r = await fetch(u, { method:"HEAD", redirect:"manual" });
      const loc = r.headers.get("location"); if (loc) u = loc;
    } catch {}
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

// ---------- ScrapingBee (예산 내 순차 시도) ----------
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
function desktopHeaders(){ return {
  "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};}
function mobileHeaders(){ return {
  "User-Agent":"Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
};}

async function getHtmlWithinBudget(finalUrl, left){
  const steps = [
    // 빠른 비렌더 먼저 (각 2s)
    { h: desktopHeaders(), render:false, ms:2000 },
    { h: mobileHeaders(),  render:false, ms:2000 },
    // 필요시 렌더 (최대 4.5s)
    { h: desktopHeaders(), render:true,  ms:4500 },
  ];
  let lastErr;
  for (const s of steps){
    if (left() < 600) break; // 남은 예산 부족
    const to = Math.min(s.ms, left()-200); // 마진 확보
    try {
      return await fetchBeeWithRetry(finalUrl, to, s.h, s.render, left);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("Timeout: budget exceeded");
}

async function fetchBeeWithRetry(url, timeoutMs, headers, render, left){
  const delays = [300, 700]; // 총 대기 ≤ 1s
  for (let i=0; i<=delays.length; i++){
    if (left && left() < 400) throw new Error("Timeout: budget low");
    try {
      return await scrapeWithScrapingBee(url, timeoutMs, headers, render);
    } catch (e){
      const msg = String(e?.message||"");
      const status = Number((/ScrapingBee\s+(\d+)/.exec(msg)||[])[1]||0);
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || i === delays.length) throw e;
      await sleep(delays[i]);
    }
  }
}

async function scrapeWithScrapingBee(url, timeoutMs, headers, render=true){
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  const params = {
    api_key: apiKey,
    url,
    render_js: render ? "true" : "false",
    country_code: "kr",
    ...(render ? { wait_for:'meta[property="og:title"], script[type="application/ld+json"]' } : {}),
    ...(process.env.SCRAPINGBEE_PREMIUM === "1" ? { premium_proxy:"true" } : {}),
    // forward_headers: "true", // 필요 없으면 비활성화
  };
  const qs = new URLSearchParams(params);

  const ctrl = new AbortController();
  const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, { method:"GET", headers, signal: ctrl.signal });
    if (!res.ok) {
      const body = await res.text().catch(()=> "");
      throw new Error(`ScrapingBee ${res.status} ${body.slice(0,200)}`);
    }
    return await res.text();
  } finally { clearTimeout(t); }
}

// ---------- 파싱 ----------
function parseInfo(html){
  const prices = [];
  let title = null, currency = "KRW", provider = "none";

  const toNum = v => {
    const s = String(v ?? "").replace(/[^0-9.]/g, "");
    const n = s ? Number(s) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
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

  // og/title
  const og = html.match(/<meta property="og:title" content="([^"]+)"/i) || html.match(/<meta name="title" content="([^"]+)"/i);
  if (!title && og?.[1]) { title = og[1]; provider = provider === "none" ? "meta" : provider; }
  if (!title){
    const t = html.match(/<title>([^<]+)<\/title>/i);
    if (t?.[1]) { title = t[1].trim(); provider = provider === "none" ? "title" : provider; }
  }

  // __NUXT__
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  if (nuxt){
    try{
      const s = JSON.stringify(JSON.parse(nuxt[1]));
      if (!title) title = s.match(/"productName"\s*:\s*"([^"]+)"/)?.[1] || s.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || title;

      const keys = ["couponPrice","finalPrice","discountedPrice","salePrice","lowPrice","price","totalPrice","optionPrice","dealPrice","memberPrice","cardPrice","instantDiscountPrice"];
      keys.forEach(k => {
        const re = new RegExp('"' + k + '"\\s*:\\s*("?[-\\d\\.,]+"?)', 'gi');
        pullAll(s, re);
      });
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
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
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
    /"totalPrice"\s*:\s*("?[\d,\.]+"?)/gi
  ].forEach(re => pushAll(re));

  return Array.from(out);
}
