// Netlify Function v1 (Node 18+)
// 쿠팡 상품명/최저가 추출 (딥링크와 무관, 빠름+안정)
// - 빠른 경로: 비렌더 → 모바일 비렌더 → (필요시) 렌더
// - 모바일(m.coupang.com) 일원화로 DOM/JSON 구조 안정화
// - 4중 파서(JSON-LD → __NUXT__ → meta → 전역패턴), 충분조건 충족 즉시 탈출
// - 429 직렬화 큐 + 지수 백오프
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ===== 동시성 429 방지: 서버 측 직렬화 큐 =====
let _queue = Promise.resolve();
function withQueue(fn) {
  const run = _queue.then(fn, fn);
  _queue = run.catch(() => {}); // 실패해도 다음 작업 흐름 유지
  return run;
}

exports.handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS, body: "" };
    }
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, headers: CORS, body: "POST only" };
    }

    const { url } = JSON.parse(event.body || "{}");
    if (!url) return json({ success:false, error:"No URL provided" }, 400);

    const finalUrl = await normalizeUrl(url);

    // 직렬화: 외부 프록시 429 완화
    const result = await withQueue(async () => {
      const html = await getHtmlFast(finalUrl); // ✅ 빠른 경로 우선
      const parsed = parseAll(html);

      // 충분조건(제목 + 최소 1개 가격) 만족 시 그대로 반환
      if (parsed.title && parsed.minPrice != null) {
        return { html, parsed };
      }

      // 부족하면 점진적 승급 렌더 시도 (모바일 → 데스크톱)
      const html2 = await getHtmlRendered(finalUrl, { mobile:true, premium:true });
      const p2 = parseAll(html2);
      if (p2.title && p2.minPrice != null) return { html: html2, parsed: p2 };

      const html3 = await getHtmlRendered(finalUrl, { mobile:false, premium:true });
      const p3 = parseAll(html3);
      return { html: html3, parsed: p3 };
    });

    const { parsed, html } = result;
    return json({
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: parsed.minPrice != null ? String(parsed.minPrice) : null, // 숫자 문자열
      currency: parsed.currency ?? "KRW",
      provider: parsed.provider ?? null,
      debug: { priceCandidates: parsed.priceCandidates.slice(0, 20), htmlBytes: html.length, stages: parsed.stages }
    });
  } catch (err) {
    return json({ success:false, error:String(err?.message || err) }, 500);
  }
};

function json(obj, code=200){
  return { statusCode: code, headers: { "Content-Type":"application/json", ...CORS }, body: JSON.stringify(obj) };
}

// ---------- URL 정규화(짧은링크 해체 + 추적 제거 + itemId/vendorItemId 보존 + 모바일 일원화) ----------
async function normalizeUrl(input){
  let u = String(input || "").trim();

  // link.coupang.com 짧은링크 → 원본으로 (HEAD, redirect 수동 추적)
  if (/\/\/link\.coupang\.com/i.test(u)) {
    const r = await fetch(u, { method: "HEAD", redirect: "manual" });
    const loc = r.headers.get("location");
    if (loc) u = loc;
  }

  const url = new URL(u);

  // 중요한 SKU 파라미터 백업
  const itemId = url.searchParams.get("itemId");
  const vendorItemId = url.searchParams.get("vendorItemId");

  // 추적 파라미터 제거
  [
    "redirect","src","addtag","itime","lptag","wTime","wPcid","wRef","traceid",
    "pageType","pageValue","spec","ctag","mcid","placementid","clickBeacon",
    "campaignid","puidType","contentcategory","imgsize","pageid","tsource",
    "deviceid","token","contenttype","subid","sig","impressionid","campaigntype",
    "puid","requestid","ctime","contentkeyword","portal","landing_exp","subparam"
  ].forEach(p => url.searchParams.delete(p));

  // 제품 경로 파싱
  const m = url.pathname.match(/\/(vp\/)?products\/(\d+)/);
  const pid = m?.[2];
  if (!pid) return url.toString();

  // ✅ 모바일 도메인으로 일원화 (DOM/JSON 구조가 더 단순하고 가벼움)
  const out = new URL(`https://m.coupang.com/vp/products/${pid}`);
  if (itemId) out.searchParams.set("itemId", itemId);
  if (vendorItemId) out.searchParams.set("vendorItemId", vendorItemId);
  return out.toString();
}

// ---------- 스크래핑: 빠른 경로(비렌더) → 필요 시 렌더 ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getHtmlFast(finalUrl) {
  // 1) 비렌더 데스크톱(짧게) → 2) 비렌더 모바일(짧게), 둘 다 실패/불충분 시 상위에서 렌더 승급
  const steps = [
    { render:false, headers: desktopHeaders(), timeout: 5000, premium:false },
    { render:false, headers: mobileHeaders(),  timeout: 6000, premium:false },
  ];

  let lastErr;
  for (const s of steps) {
    try {
      const html = await scrapeWithScrapingBee(finalUrl, s.timeout, s.headers, s.render, s.premium);
      if (isBlocked(html)) throw new Error('BLOCKED_PAGE');
      if (html.length < 1500) throw new Error('EMPTY_PAGE');
      return html;
    } catch (e) {
      lastErr = e;
      // 비렌더는 바로 다음 스텝으로
    }
  }
  // 마지막 에러를 올려보내 렌더 승급 유도
  throw lastErr || new Error('FAST_PATH_FAILED');
}

async function getHtmlRendered(finalUrl, { mobile=true, premium=true } = {}) {
  // 렌더 2회 재시도, 429만 지수 백오프
  const headers = mobile ? mobileHeaders() : desktopHeaders();
  let attempt = 0, lastErr;
  while (attempt < 2) {
    try {
      const html = await scrapeWithScrapingBee(finalUrl, 12000, headers, true, premium);
      if (isBlocked(html) || html.length < 2000) throw new Error('BLOCKED_OR_EMPTY');
      return html;
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || e);
      if (msg.includes('HTTP_429')) {
        await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s
        attempt++;
        continue;
      }
      break; // 기타 에러는 즉시 중단
    }
  }
  throw lastErr || new Error('RENDERED_PATH_FAILED');
}

function isBlocked(html){
  return /access denied|액세스가 거부|request was blocked|403 forbidden|Sorry!\s*Access\s*denied|Bot\s*Detection/i.test(html || "");
}

function desktopHeaders(){ return {
  "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept":"text/html,application/xhtml+xml"
};}
function mobileHeaders(){ return {
  "User-Agent":"Mozilla/5.0 (Linux; Android 13; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Mobile Safari/537.36",
  "Accept-Language":"ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept":"text/html,application/xhtml+xml"
};}

async function scrapeWithScrapingBee(url, timeoutMs, headers, render=true, premium=false){
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  const params = {
    api_key: apiKey,
    url,
    render_js: render ? "true" : "false",
    country_code: "kr",
    // 렌더 시 컨텐츠 안정화(모바일은 빠르게 로드됨)
    ...(render ? { wait:"2000", wait_for:'meta[property="og:title"], script[type="application/ld+json"]' } : {}),
    ...(premium ? { premium_proxy:"true" } : {}),
    forward_headers: "true",
    block_ads: "true",
  };
  const qs = new URLSearchParams(params);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, { method:"GET", headers, signal: ctrl.signal });
    const text = await res.text();
    if (res.status === 429) throw new Error('HTTP_429 ' + text.slice(0,180));
    if (!res.ok)  throw new Error(`ScrapingBee ${res.status} ${text.slice(0,180)}`);
    return text;
  } finally { clearTimeout(t); }
}

// ---------- 파싱(다중 소스 수집 + 최소값 결정) ----------
function parseAll(html){
  const stages = [];
  const prices = new Set();
  let title = null, currency = "KRW", provider = "none";

  const toNum = v => {
    const s = String(v ?? "").replace(/[^0-9.]/g, "");
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null; // 원단위 반올림
  };
  const push = v => { const n = toNum(v); if (n) prices.add(n); };
  const pullAll = (src, re) => { for (const m of src.matchAll(re)) push(m[1] ?? m[0]); };

  // 1) JSON-LD (가장 신뢰)
  try {
    const reLd = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    const blocks = [...html.matchAll(reLd)]
      .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
      .filter(Boolean)
      .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));
    const prods = blocks.filter(o => o && (o['@type']==='Product' || (Array.isArray(o['@type']) && o['@type'].includes('Product')) || o.name));
    if (prods.length){
      provider = "json-ld";
      const p0 = prods.find(p => p?.name);
      if (p0?.name) title = cleanTitle(p0.name);
      for (const p of prods){
        const offers = Array.isArray(p.offers) ? p.offers : (p.offers ? [p.offers] : []);
        for (const ofr of offers){
          if (ofr?.priceCurrency) currency = ofr.priceCurrency;
          [ofr?.price, ofr?.lowPrice, ofr?.highPrice].forEach(push);
          const ps = ofr?.priceSpecification;
          (Array.isArray(ps) ? ps : ps ? [ps] : []).forEach(s => [s?.price, s?.minPrice, s?.maxPrice].forEach(push));
        }
      }
      stages.push("json-ld");
    }
  } catch {}

  // 2) __NUXT__ (모바일/데스크톱 공통으로 자주 있음)
  try{
    const reNuxt = /window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/;
    const nuxt = html.match(reNuxt)?.[1];
    if (nuxt){
      const s = JSON.stringify(JSON.parse(nuxt)); // JSON 안정화
      if (!title) {
        const n1 = s.match(/"productName"\s*:\s*"([^"]+)"/);
        const n2 = s.match(/"name"\s*:\s*"([^"]+)"/);
        title = cleanTitle(n1?.[1] || n2?.[1] || title);
      }
      // 다양한 가격 키들 전체 수집
      [
        "couponPrice","finalPrice","discountedPrice","salePrice","lowPrice",
        "price","totalPrice","optionPrice","dealPrice","memberPrice","cardPrice","instantDiscountPrice"
      ].forEach(k => pullAll(s, new RegExp(`"${k}"\\s*:\\s*("?\\d[\\d,\\.]*"?)`, "gi")));
      provider = provider === "none" ? "__NUXT__" : provider;
      stages.push("__NUXT__");
    }
  } catch {}

  // 3) META (og:title / title)
  try {
    if (!title){
      const m1 = html.match(/<meta property="og:title" content="([^"]+)"/i);
      const m2 = html.match(/<meta name="title" content="([^"]+)"/i);
      title = cleanTitle(m1?.[1] || m2?.[1] || title);
      if (title) { provider = provider === "none" ? "meta" : provider; stages.push("meta"); }
    }
    // 일부 페이지는 price meta 제공
    const mp1 = html.match(/<meta property="product:price:amount" content="([^"]+)"/i);
    const mp2 = html.match(/<meta property="og:price:amount" content="([^"]+)"/i);
    [mp1?.[1], mp2?.[1]].forEach(push);
  } catch {}

  // 4) 전역 패턴 (DOM 스캔)
  try {
    const patterns = [
      /data-rt-price="([\d,\.]+)"/gi,
      /data-price="([\d,\.]+)"/gi,
      /class="total-price[^"]*">[\s\S]*?([\d,\.]+)\s*원/gi,
      /class="prod-price[^"]*">[\s\S]*?([\d,\.]+)\s*원/gi,
      /aria-label="가격\s*([\d,\.]+)\s*원"/gi,
      /"price"\s*:\s*("?[\d,\.]+"?)/gi,
      /"finalPrice"\s*:\s*("?[\d,\.]+"?)/gi,
      /"salePrice"\s*:\s*("?[\d,\.]+"?)/gi,
      /"lowPrice"\s*:\s*("?[\d,\.]+"?)/gi,
      /"totalPrice"\s*:\s*("?[\d,\.]+"?)/gi,
    ];
    for (const re of patterns) {
      for (const m of html.matchAll(re)) push(m[1] ?? m[0]);
    }
    stages.push("global-scan");
  } catch {}

  // 후보 정리 후 최저가 선정
  const priceCandidates = [...prices].filter(n => n > 0 && n < 100000000); // 1억 상한 안전필터
  const minPrice = priceCandidates.length ? Math.min(...priceCandidates) : null;

  return {
    title: title || null,
    currency,
    provider,
    minPrice,
    priceCandidates,
    stages
  };
}

function cleanTitle(t){
  if (!t) return t;
  let s = t.trim();
  // 사이트 접미사 제거
  s = s.replace(/\s*:\s*쿠팡\s*$/, "").replace(/\s*\|\s*쿠팡\s*$/, "");
  s = s.replace(/–\s*쿠팡\s*$/, "");
  return s;
}
