// netlify/functions/product-info.js
// 역할: 쿠팡 원본/짧은 링크를 받아 상품명(name)과 가격(price)을 반환
// 주의: create-deeplink.js는 건드리지 않습니다 (딥링크는 기존 로직 그대로)

const axios = require("axios");

// 짧은 링크 해제 (link.coupang.com, coupa.ng 등)
async function resolveShortIfNeeded(inputUrl, timeoutMs) {
  const isShort =
    /^https?:\/\/(link\.coupang\.com|coupa\.ng)\//i.test(inputUrl);
  if (!isShort) return inputUrl;

  let cur = inputUrl;
  for (let i = 0; i < 5; i++) {
    const r = await axios
      .head(cur, {
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        timeout: timeoutMs,
      })
      .catch((e) => e?.response);

    if (!r) break;
    const loc = r.headers?.location;
    if (!loc) break;
    cur = new URL(loc, cur).toString();

    // 원본 상품 도메인으로 오면 종료
    if (/^https?:\/\/(www\.)?coupang\.com\//i.test(cur)) return cur;
  }
  return cur; // 못 풀어도 일단 반환
}

// www.coupang.com URL에서 productId 추출
function extractProductId(url) {
  const m = url.match(/\/products\/(\d+)/);
  return m ? m[1] : null;
}

// 모바일 상품페이지에서 이름/가격 파싱
async function fetchProductInfo(productId, timeoutMs) {
  const mobileUrl = `https://m.coupang.com/vp/products/${productId}`;
  const html = (await axios.get(mobileUrl, { timeout: timeoutMs })).data;

  // 1) 상품명: og:title 또는 JSON 영역
  let name = null;
  const og = html.match(
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i
  );
  if (og) name = og[1];

  if (!name) {
    const m = html.match(/"productName"\s*:\s*"([^"]+)"/i);
    if (m) name = m[1];
  }

  // 2) 가격: 가능한 키들에서 숫자 수집 → 최솟값 사용
  const prices = [];
  const priceRegex =
    /"(salePrice|discountedPrice|price|unitPrice|originPrice)"\s*:\s*(\d{2,})/gi;
  let mm;
  while ((mm = priceRegex.exec(html)) !== null) {
    const v = parseInt(mm[2], 10);
    if (Number.isFinite(v)) prices.push(v);
  }
  const price = prices.length ? Math.min(...prices) : null;

  return { name, price, productId, mobileUrl };
}

exports.handler = async (event) => {
  // GET으로 열어보면 405 (정상)
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({
        success: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "POST only" },
      }),
    };
  }

  // fast=1 이면 타임아웃 짧게
  const qs = event.queryStringParameters || {};
  const timeoutMs = qs.fast === "1" ? 3500 : 7000;

  // body 파싱
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

  if (!url) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: { code: "URL_REQUIRED", message: "url required" },
      }),
    };
  }

  // 1) 짧은 → 원본으로
  let finalUrl = url;
  try {
    finalUrl = await resolveShortIfNeeded(url, timeoutMs);
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        success: false,
        error: { code: "RESOLVE_FAILED", message: String(e?.message || e) },
        input: { url, finalUrl: null },
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

  // 2) productId 추출
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

  // 3) 모바일 페이지에서 파싱
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