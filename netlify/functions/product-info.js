// Netlify Function v1 (Node 18+)
// 쿠팡 상품명/최저가 파싱 - 429 방지 + 최저가 로직 강화
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

    // HTML 가져오기 (429 방지: 순차 + 백오프 + Bee 캐시)
    const fetchBeeHtml = async (ua, attempt = 1) => {
      const qs = new URLSearchParams({
        api_key: SCRAPINGBEE_KEY,
        url,
        render_js: "true",
        block_resources: "false",
        country_code: "kr",
        wait_for: "meta[property='og:title']",
        device: ua,
        premium_proxy: SCRAPINGBEE_PREMIUM ? "true" : "false",
        timeout: "20000",
        cache: "86400", // 하루 캐시
        headers: JSON.stringify({
          "Accept-Language": "ko-KR,ko;q=0.9",
          "User-Agent":
            ua === "mobile"
              ? "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Mobile"
              : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36",
        }),
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

    // 제목 추출
    const title =
      pickFirst([
        rx1(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i),
        rx1(html, /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i),
        rx1(html, /id=["']productTitle["'][^>]*>([^<]+)/i),
        rx1Json(html, /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (obj) => obj?.name),
      ]) || null;

    // 가격 후보 모으기
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
function rx1(s, re) {
  const m = re.exec(s || "");
  return m ? sanitize(m[1]) : null;
}
function rxAllNums(s, re) {
  const out = [];
  let m;
  while ((m = re.exec(s || ""))) {
    const n = toNum(m[1]);
    if (n) out.push(n);
  }
  return out;
}
function rx1Json(s, re, picker) {
  let m;
  while ((m = re.exec(s || ""))) {
    try {
      const obj = JSON.parse(m[1]);
      const picked = picker(obj);
      if (picked) return sanitize(picked);
    } catch {}
  }
  return null;
}
function rxAllJson(s, re, picker) {
  const out = [];
  let m;
  while ((m = re.exec(s || ""))) {
    try {
      const obj = JSON.parse(m[1]);
      const val = picker(obj);
      if (Array.isArray(val)) out.push(...val);
      else if (val) out.push(val);
    } catch {}
  }
  return out;
}
function toNum(x) {
  if (x == null) return null;
  const n = Number(String(x).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : null;
}
function uniqNums(arr) {
  const set = new Set();
  const out = [];
  for (const n of arr) {
    if (n == null) continue;
    if (!set.has(n)) {
      set.add(n);
      out.push(n);
    }
  }
  return out;
}
function pickFirst(arr) {
  for (const v of arr) if (v) return v;
  return null;
}
function sanitize(t) {
  return String(t || "").replace(/\s+/g, " ").trim();
}
