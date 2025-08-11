// netlify/functions/product-info.js
// 역할: 쿠팡 원본/짧은 링크 → productId → 모바일 페이지에서 name/price 파싱
// 변경점: 모바일 UA/ko-KR 헤더, 리다이렉트 허용, 가격/이름 정규식 보강

const axios = require("axios");

// 공통 헤더 (모바일 환경 흉내)
const UA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
};

async function resolveShortIfNeeded(inputUrl, timeoutMs) {
  const isShort = /^https?:\/\/(link\.coupang\.com|coupa\.ng)\//i.test(inputUrl);
  if (!isShort) return inputUrl;

  let cur = inputUrl;
  for (let i = 0; i < 5; i++) {
    const r = await axios
      .head(cur, {
        headers: UA_HEADERS,
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        timeout: Math.min(1500, timeoutMs),
      })
      .catch((e) => e?.response);
    if (!r) break;
    const loc = r.headers?.location;
    if (!loc) break;
    cur = new URL(loc, cur).toString();
    if (/^https?:\/\/(www\.)?coupang\.com\//i.test(cur)) return cur;
  }
  return cur;
}

function extractProductId(url) {
  const m = url.match(/\/products\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchProductInfo(productId, timeoutMs) {
  const mobileUrl = `https://m.coupang.com/vp/products/${productId}`;

  const resp = await axios.get(mobileUrl, {
    headers: UA_HEADERS,
    maxRedirects: 5,
    timeout: timeoutMs,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const html = resp.data || "";

  // ---------- 이름 추출 ----------
  let name = null;

  // 1) og:title
  const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (og) name = og[1];

  // 2) JSON 키
  if (!name) {
    const m1 = html.match(/"productName"\s*:\s*"([^"]+)"/i);
    if (m1) name = m1[1];
  }

  // 3) <title>
  if (!name) {
    const m2 = html.match(/<title>([^<]+)<\/title>/i);
    if (m2) name = m2[1];
  }

  // ---------- 가격 추출 ----------
  const prices = [];

  // JSON 숫자들
  const priceJsonRegex =
    /"(salePrice|discountedPrice|price|unitPrice|originPrice|salePriceDisplay|couponPrice|finalPrice|lowestPrice)"\s*:\s*"?(\d{2,})"?/gi;
  let mm;
  while ((mm = priceJsonRegex.exec(html)) !== null) {
    const v = parseInt(mm[2], 10);
    if (Number.isFinite(v)) prices.push(v);
  }

  // og:price:amount
  const ogPrice = html.match(/property=["']og:price:amount["']\s+content=["'](\d+)["']/i);
  if (ogPrice) prices.push(parseInt(ogPrice[1], 10));

  // 화면 노출 숫자(3자리콤마) 백업 플랜
  // ex) <strong class="...">12,340</strong>
  const textPriceRegex = />(\d{1,3}(?:,\d{3})+)\s*원?</g;
  let t;
  while ((t = textPriceRegex.exec(html)) !== null) {
    const v = parseInt(t[1].replace(/,/g, ""), 10);
    if (Number.isFinite(v)) prices.push(v);
  }

  // 최솟값(보수적으로)
  const price = prices.length ? Math.min(...prices) : null;

  return { name, price, productId, mobileUrl };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({
        success: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "POST only" },
      }),
    };
  }

  const qs = event.queryStringParameters || {};
  // Netlify 10초 제한 안 넘게 9초(기본) / fast=1 이면 6초
  const timeoutMs = qs.fast === "1" ? 6000 : 9000;

  let url = "";
  try {
    const body = JSON.parse(event.body || "{}");
    url = String(body.url || "").trim();
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: { code: "BAD_JSON", message: "Invalid JSON body" },
      }),
    };
  }
  if (!url)
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: { code: "URL_REQUIRED", message: "url required" },
      }),
    };

  // 1) 짧은 → 원본
  let finalUrl;
  try {
    finalUrl = await resolveShortIfNeeded(url, timeoutMs);
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        success: false,
        error: { code: "RESOLVE_FAILED", message: String(e?.message || e) },
        input: { url },
      }),
    };
  }

  if (!/^https?:\/\/(www\.)?coupang\.com\//i.test(finalUrl)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: {
          code: "INVALID_URL",
          message: "쿠팡 상품 원본 URL이 아닙니다.",
        },
        input: { url, finalUrl },
      }),
    };
  }

  // 2) productId
  const productId = extractProductId(finalUrl);
  if (!productId) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: { code: "NO_PRODUCT_ID", message: "productId 추출 실패" },
        input: { url, finalUrl },
      }),
    };
  }

  // 3) 파싱
  try {
    const info = await fetchProductInfo(productId, timeoutMs);
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        info: {
          name: info.name || null,
          price: Number.isFinite(info.price) ? info.price : null,
          productId: info.productId,
          sourceUrl: finalUrl,
          mobileUrl: info.mobileUrl,
        },
      }),
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        success: false,
        error: { code: "FETCH_FAILED", message: String(e?.message || e) },
        input: { url, finalUrl, productId },
      }),
    };
  }
};
