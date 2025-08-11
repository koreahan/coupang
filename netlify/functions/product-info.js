// Netlify Function v1 (Node 18+)
// 쿠팡 상품명/최저가 추출 API (정규화 + 빠른/안정 스크랩 + 최저가 보장)
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
    if (!url) return json({ success: false, error: "No URL provided" });

    const finalUrl = await normalizeUrl(url);
    const html = await getFastestHtml(finalUrl);
    const parsed = parseInfo(html) || {};

    return json({
      success: true,
      finalUrl,
      title: parsed.title ?? null,
      price: parsed.price ?? null,           // ← 항상 "최저가(정수, 원)" 반환
      currency: parsed.currency ?? "KRW",
      provider: parsed.provider ?? "coupang",
    });
  } catch (err) {
    return json({ success: false, error: String((err && err.message) || err) });
  }
};

function json(obj, code = 200) {
  return {
    statusCode: code,
    headers: { "Content-Type": "application/json", ...CORS },
    body: JSON.stringify(obj),
  };
}

// ---------- URL 정규화 ----------
// 짧은링크 해제 → 쿼리 제거 → /vp/products/{id} 형태로 통일
async function normalizeUrl(input) {
  let u = String(input || "").trim();

  // link.coupang.com 딥링크면 실제 상품 주소로 1회 해제
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

  const m = url.pathname.match(/\/(vp\/)?products\/(\d{6,})/);
  return m ? `https://www.coupang.com/vp/products/${m[2]}` : url.toString();
}

// ---------- 스크랩 (빠른/안정) ----------
async function getFastestHtml(finalUrl) {
  const attempts = [
    // 빠른 렌더(모바일) – 6.5s
    () => scrapeWithScrapingBee(finalUrl, 6500, mobileHeaders(), true),
    // 빠른 렌더(데스크톱) – 6.5s
    () => scrapeWithScrapingBee(finalUrl, 6500, desktopHeaders(), true),
    // 비렌더(데스크톱) – 2.5s (메타/JSON-LD만으로도 되는 케이스)
    () => scrapeWithScrapingBee(finalUrl, 2500, desktopHeaders(), false),
  ];

  const settled = await Promise.allSettled(attempts.map(fn => fn()));
  const ok = settled.find(r => r.status === "fulfilled");
  if (ok) return ok.value;

  const reasons = settled
    .map(r => (r.status === "rejected" ? String(r.reason) : ""))
    .filter(Boolean);
  throw new Error("All attempts failed: " + reasons.join(" | "));
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

async function scrapeWithScrapingBee(url, timeoutMs, headers, render = true) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");

  const params = {
    api_key: apiKey,
    url,
    render_js: render ? "true" : "false",
    ...(process.env.SCRAPINGBEE_PREMIUM === "1" ? { premium_proxy: "true" } : {}),
    country_code: "kr",
    ...(render
      ? { wait_for: 'meta[property="og:title"],script[type="application/ld+json"]' }
      : {}),
    forward_headers: "true", // 요청의 헤더를 대상 사이트로 전달
  };
  const qs = new URLSearchParams(params);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
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

// ---------- 파서 (최저가 보장) ----------
function toNum(x){ if(x==null) return null; const n = +String(x).replace(/[^\d]/g,""); return Number.isFinite(n) ? n : null; }
function uniqNums(arr){ const s=new Set(), out=[]; for(const n of arr){ if(n==null) continue; if(!s.has(n)){ s.add(n); out.push(n);} } return out; }

function parseInfo(html) {
  // JSON-LD 블록(배열/@graph 포함) 수집
  const ldBlocks = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .filter(Boolean)
    .flatMap(o => Array.isArray(o) ? o : (o['@graph'] ? o['@graph'] : [o]));

  let title = null;
  const prices = [];

  // 1) JSON-LD Product
  for (const o of ldBlocks) {
    if (o && (o['@type'] === 'Product' || o.name)) {
      if (!title && o.name) title = String(o.name).trim();
      const offers = Array.isArray(o.offers) ? o.offers[0] : o.offers;
      if (offers) {
        if (offers.price) prices.push(toNum(offers.price));
        if (offers.lowPrice) prices.push(toNum(offers.lowPrice));
      }
    }
  }

  // 2) 메타/타이틀 보강
  if (!title) {
    title =
      (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i)?.[1]) ||
      (html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i)?.[1]) ||
      (html.match(/<title>([^<]+)<\/title>/i)?.[1]) || null;
    if (title) title = title.replace(/\s*-\s*쿠팡.*$/,'').trim();
  }

  // 3) 페이지 내 JSON/속성에서 가격 후보 더 긁기 (최저가 선택)
  const addNums = (re) => { let m; while ((m = re.exec(html))) prices.push(toNum(m[1])); };
  addNums(/"finalPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"discountPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"salePrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"wowPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"rocketCardPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"couponPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"lowestPrice"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/"price"\s*:\s*"?([\d,\.]+)"?/gi);
  addNums(/data-price="([\d\.]+)"/gi);

  const cand = uniqNums(prices).filter(n => Number.isFinite(n) && n>0);
  const price = cand.length ? Math.min(...cand) : null;

  return { title: title || null, price, currency: 'KRW', provider: 'coupang' };
}
