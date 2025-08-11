// Netlify Function v1 (Node 18+)
// 쿠팡 상품명/최저가 파싱 - 안정판 (ScrapingBee 400 fix)
const API = "https://app.scrapingbee.com/api/v1/";
const { SCRAPINGBEE_KEY, SCRAPINGBEE_PREMIUM } = process.env;

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
    if (!SCRAPINGBEE_KEY) {
      return resp(500, { success: false, error: "Missing SCRAPINGBEE_KEY" });
    }

    const { url: raw } = JSON.parse(event.body || "{}");
    if (!raw) return resp(400, { success: false, error: "url required" });

    const url = normalizeCoupangUrl(raw);

    // 429 방지: 순차 + 지수 백오프 (문제된 cache/headers 제거)
    const fetchBeeHtml = async (ua, attempt = 1) => {
      const qs = new URLSearchParams({
        api_key: SCRAPINGBEE_KEY,
        url,
        render_js: "true",
        block_resources: "false",
        country_code: "kr",
        wait_for: "meta[property='og:title']",
        premium_proxy: SCRAPINGBEE_PREMIUM ? "true" : "false",
        timeout: "20000",
        // device 파라미터는 일부 플랜에서만 동작할 수 있어 안전하게 분기
        ...(ua === "mobile" ? { window_width: "390", window_height: "844" } : {})
      }).toString();

      const res = await fetch(API + "?" + qs);
      const text = await res.text();

      if (res.status === 429 && attempt < 3) {
        const wait = 600 * Math.pow(2, attempt - 1);
        await new Promise((r) => setTimeout(r, wait));
        return fetchBeeHtml(ua, attempt + 1);
      }
      if (!res.ok) throw new Error(`ScrapingBee ${res.status} ${text}`);
      return text;
    };

    let html = "";
    try {
      html = await fetchBeeHtml("mobile");
    } catch {
      html = await fetchBeeHtml("desktop");
    }

    // 제목
    const title =
      pickFirst([
        rx1(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i),
        rx1(html, /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i),
        rx1(html, /id=["']productTitle["'][^>]*>([^<]+)/i),
        rx1Json(html, /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (o) => o?.name),
      ]) || null;

    // 가격 후보 → 최저가
    const priceCandidates = uniqNums(
      []
        .concat(rxAllNums(html, /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']?(\d[\d,.]*)/gi))
        .concat(rxAllNums(html, /"discountPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
        .concat(rxAllNums(html, /"salePrice"\s*:\s*"?(\d[\d,]*)"?/gi))
        .concat(rxAllNums(html, /"wowPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
        .concat(rxAllNums(html, /"rocketCardPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
        .concat(rxAllNums(html, /"price"\s*:\s*"?(\d[\d,]*)"?/gi))
        .concat(
          rxAllJson(html, /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (obj) => {
            const arr = [];
            const offer = obj?.offers || obj?.aggregateOffer || obj?.offers?.[0];
            if (offer?.price) arr.push(toNum(offer.price));
            if (offer?.lowPrice) arr.push(toNum(offer.lowPrice));
            return arr.filter(Boolean);
          })
        )
    ).filter((n) => n > 0);

    const price = priceCandidates.length ? Math.min(...priceCandidates) : null;

    return resp(200, {
      success: true,
      inputUrl: raw,
      finalUrl: url,
      title,
      price,
      currency: "KRW",
      provider: "coupang",
      notes: price ? undefined : "no_price_matched_fallback",
    });
  } catch (e) {
    return resp(200, { success: false, error: String(e?.message || e) });
  }
};

// ---------- helpers ----------
function resp(code, body) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(body) };
}
function normalizeCoupangUrl(u) {
  const m = String(u).match(/\/products\/(\d{6,})/);
  if (m) return `https://www.coupang.com/vp/products/${m[1]}`;
  return u;
}
function rx1(s, re) { const m = re.exec(s || ""); return m ? sanitize(m[1]) : null; }
function rxAllNums(s, re) { const out=[]; let m; while((m=re.exec(s||""))){ const n=toNum(m[1]); if(n) out.push(n);} return out; }
function rx1Json(s, re, picker) { let m; while((m=re.exec(s||""))){ try{ const o=JSON.parse(m[1]); const v=picker(o); if(v) return sanitize(v);}catch{}} return null; }
function rxAllJson(s, re, picker) { const out=[]; let m; while((m=re.exec(s||""))){ try{ const o=JSON.parse(m[1]); const v=picker(o); if(Array.isArray(v)) out.push(...v); else if(v) out.push(v);}catch{}} return out; }
function toNum(x){ if(x==null) return null; const n=Number(String(x).replace(/[^\d.]/g,"")); return Number.isFinite(n)?Math.round(n):null; }
function uniqNums(a){ const s=new Set(), o=[]; for(const n of a){ if(n==null) continue; if(!s.has(n)){ s.add(n); o.push(n);} } return o; }
function pickFirst(a){ for(const v of a) if(v) return v; return null; }
function sanitize(t){ return String(t||"").replace(/\s+/g," ").trim(); }
