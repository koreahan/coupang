// netlify/functions/product-info.js  (Node 18+ 권장: fetch 내장)

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
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ success:false, error:"No URL" }) };
    }

    const finalUrl = await normalizeUrl(url);
    const html = await getFastestHtml(finalUrl); // 렌더링/모바일 병렬 시도
    const parsed = parseInfo(html) || {};

    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json", ...CORS },
      body: JSON.stringify({
        success: true,
        finalUrl,
        title: parsed.title || null,
        price: parsed.price || null,
        currency: parsed.currency || "KRW",
      }),
    };
  } catch (err) {
    return {
      statusCode: 200,
      headers: { "Content-Type":"application/json", ...CORS },
      body: JSON.stringify({ success:false, error: String(err && err.message || err) }),
    };
  }
};

// ---------- helpers ----------

async function normalizeUrl(input){
  let u = input.trim();

  // 짧은링크면 서버에서만 해제
  if (u.includes("link.coupang.com")) {
    const r = await fetch(u, { method:"HEAD", redirect:"manual" });
    const loc = r.headers.get("location");
    if (loc) u = loc;
  }

  const url = new URL(u);
  ["redirect","src","addtag","itime","lptag","wTime","wPcid","wRef","traceid","pageType","pageValue","spec","ctag","mcid"]
    .forEach(p=>url.searchParams.delete(p));

  const m = url.pathname.match(/\/(vp\/)?products\/(\d+)/);
  return m ? `https://www.coupang.com/vp/products/${m[2]}` : url.toString();
}

async function getFastestHtml(finalUrl){
  // 두 번 다른 UA/타임아웃으로 병렬 → 먼저 성공한 것 사용
  const attempts = [
    () => scrapeWithScrapingBee(finalUrl, 6000, desktopHeaders()),
    () => scrapeWithScrapingBee(finalUrl, 6000, mobileHeaders()),
  ];
  return Promise.any(attempts.map(fn => fn()));
}

function desktopHeaders(){
  return {
    "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };
}
function mobileHeaders(){
  return {
    "User-Agent":"Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
    "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  };
}

async function scrapeWithScrapingBee(url, timeoutMs, headers){
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  const qs = new URLSearchParams({
    api_key: apiKey,
    url,
    render_js: "true",
    premium_proxy: "true",
    country_code: "kr",
    wait: "networkidle",
    wait_for: 'meta[property="og:title"]',
    forward_headers: "true",
  });

  const ctrl = new AbortController();
  const timer = setTimeout(()=>ctrl.abort(), timeoutMs);

  const r = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, {
    method: "GET",
    signal: ctrl.signal,
    headers,
  }).finally(()=>clearTimeout(timer));

  if (!r.ok) throw new Error(`ScrapingBee ${r.status}`);
  return r.text();
}

function parseInfo(html){
  // 1) JSON-LD(Product)
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m=>{try{return JSON.parse(m[1]);}catch{return null;}})
    .find(o=>o && (o["@type"]==="Product" || o.name));
  if (ld){
    const price = ld?.offers?.price ?? ld?.offers?.lowPrice ?? null;
    const currency = ld?.offers?.priceCurrency ?? "KRW";
    if (ld.name && price) return { title: ld.name, price: String(price), currency };
  }
  // 2) og:title
  const og = html.match(/<meta property="og:title" content="([^"]+)"/);

  // 3) __NUXT__ 안 가격 백업
  let price, currency="KRW";
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  if (nuxt) try {
    const s = JSON.stringify(JSON.parse(nuxt[1]));
    price = (s.match(/"salePrice"\s*:\s*(\d+)/)?.[1]) || (s.match(/"price"\s*:\s*(\d+)/)?.[1]);
  } catch {}

  return { title: og?.[1] || null, price: price || null, currency };
}
