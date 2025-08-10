// netlify/functions/product-info.js
const axios = require("axios");

// 1) 입력 텍스트에서 첫 번째 http(s) URL만 추출
function extractFirstUrl(input) {
  if (!input) return "";
  const m = String(input).match(/https?:\/\/[^\s]+/);
  return m ? m[0] : "";
}

// 2) 짧은 링크 해제: HEAD 우선, 실패 시 GET 1회
async function resolveCoupangUrl(inputUrl) {
  const isShort = /^https?:\/\/(link\.coupang\.com|coupa\.ng)\//i.test(inputUrl);
  if (!isShort) return inputUrl;

  let cur = inputUrl;

  const h = await axios.head(cur, {
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400,
    timeout: 10000
  }).catch(e => e?.response);
  let loc = h?.headers?.location;
  if (loc) return new URL(loc, cur).toString();

  const g = await axios.get(cur, {
    maxRedirects: 0,
    validateStatus: s => s >= 200 && s < 400,
    timeout: 10000
  }).catch(e => e?.response);
  loc = g?.headers?.location;
  return loc ? new URL(loc, cur).toString() : cur;
}

// 3) HTML 가져오기(모바일 우선 → 데스크톱 폴백)
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

async function fetchHtmlBoth(url) {
  try {
    const mUrl = url.replace("://www.", "://m.");
    const { data } = await axios.get(mUrl, {
      timeout: 12000,
      headers: {
        "User-Agent": UA_MOBILE,
        "Referer": "https://m.coupang.com/",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml"
      },
      responseType: "text"
    });
    if (typeof data === "string" && data) return { html: data, from: "m" };
  } catch {}

  const wUrl = url.replace("://m.", "://www.");
  const { data } = await axios.get(wUrl, {
    timeout: 12000,
    headers: {
      "User-Agent": UA_DESKTOP,
      "Referer": "https://www.coupang.com/",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept": "text/html,application/xhtml+xml"
    },
    responseType: "text"
  });
  return { html: data, from: "www" };
}

// 4) 이름/가격 파싱(정규식, 유지보수 쉬움)
const toInt = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/[^\d]/g, "");
  return m ? parseInt(m, 10) : null;
};

function parseNamePrice(html) {
  let name = null;

  const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (og) name = og[1];
  if (!name) {
    const pn = html.match(/"productName"\s*:\s*"([^"]+)"/i);
    if (pn) name = pn[1];
  }
  if (!name) {
    const tt = html.match(/<title>([^<]+)<\/title>/i);
    if (tt) name = tt[1];
  }
  if (name) name = name.replace(/\s*\|.*$/, "").trim();

  const nums = [];
  const keyRx = /"(finalPrice|salePrice|discountedPrice|discountPrice|originPrice|price|unitPrice|wowPrice|minPrice|maxPrice|pcPrice|mobilePrice)"\s*:\s*(\d{2,})/gi;
  let m;
  while ((m = keyRx.exec(html)) !== null) {
    const v = parseInt(m[2], 10);
    if (Number.isFinite(v)) nums.push(v);
  }
  const metaAmt = html.match(/<meta[^>]+property=["']og:product:price:amount["'][^>]+content=["']([^"']+)["']/i);
  if (metaAmt) nums.push(toInt(metaAmt[1]));
  const domStrong = html.match(/<span[^>]*class=["'][^"']*(?:total-price|sale|price)[^"']*["'][^>]*>\s*<strong[^>]*>([^<]+)<\/strong>/i);
  if (domStrong) nums.push(toInt(domStrong[1]));
  const domPlain = html.match(/<span[^>]*class=["'][^"']*prod-price__price[^"']*["'][^>]*>([^<]+)<\/span>/i);
  if (domPlain) nums.push(toInt(domPlain[1]));

  const candidates = nums.filter(n => Number.isFinite(n) && n > 0);
  const price = candidates.length ? Math.min(...candidates) : null;

  return { name: name || null, price: price ?? null };
}

// 5) Netlify handler
exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success:false, error:{ code:"METHOD_NOT_ALLOWED", message:"POST only" } }) };
  }

  // 입력에서 첫 번째 URL만 추출
  let url = "";
  try {
    const body = JSON.parse(event.body || "{}");
    url = extractFirstUrl((body.url || "").trim());
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"BAD_JSON", message:"Invalid JSON body" } }) };
  }
  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"URL_REQUIRED", message:"Valid URL required" } }) };
  }

  // 짧은 링크 해제
  let finalUrl = url;
  try { finalUrl = await resolveCoupangUrl(url); } catch {}

  // 쿠팡 도메인만 허용(www/m)
  if (!/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(finalUrl)) {
    return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"INVALID_URL", message:"쿠팡 상품 URL이 아닙니다." }, input:{ url, finalUrl } }) };
  }

  // HTML 가져와 파싱
  try {
    const { html, from } = await fetchHtmlBoth(finalUrl);
    if (!html) {
      return { statusCode: 502, body: JSON.stringify({ success:false, error:{ code:"FETCH_FAILED", message:"상품 페이지를 불러오지 못했습니다." }, input:{ url, finalUrl } }) };
    }

    const info = parseNamePrice(html);
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        info: {
          name: info.name,
          price: info.price,
          formattedPrice: Number.isFinite(info.price) ? info.price.toLocaleString("ko-KR") + "원" : null
        },
        source: from,
        input: { url, finalUrl }
      })
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ success:false, error:{ code:"PARSE_FAILED", message:String(e?.message || e) }, input:{ url, finalUrl } }) };
  }
};
