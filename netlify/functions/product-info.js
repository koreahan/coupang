// netlify/functions/product-info.js
const axios = require("axios");

const UA_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
  "Referer": "https://m.coupang.com/"
};

// 짧은 링크(link.coupang.com, coupa.ng) → 원본
async function resolveShortIfNeeded(inputUrl) {
  const isShort = /^https?:\/\/(link\.coupang\.com|coupa\.ng)\//i.test(inputUrl);
  if (!isShort) return inputUrl;

  let cur = inputUrl;

  // 1) HEAD로 최대 5회
  for (let i = 0; i < 5; i++) {
    const resp = await axios
      .head(cur, {
        headers: UA_HEADERS,
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
        timeout: 1500
      })
      .catch(e => e?.response);
    if (!resp) break;
    const loc = resp.headers?.location;
    if (!loc) break;
    cur = new URL(loc, cur).toString();
    if (/^https?:\/\/(www\.)?coupang\.com\//i.test(cur)) return cur;
  }

  // 2) GET 한 번 더(일부 케이스는 GET만 통과)
  try {
    const g = await axios.get(cur, {
      headers: UA_HEADERS,
      maxRedirects: 5,
      timeout: 2500,
      validateStatus: s => s >= 200 && s < 400
    });
    if (g.request?.res?.responseUrl) {
      const final = g.request.res.responseUrl;
      if (/^https?:\/\/(www\.)?coupang\.com\//i.test(final)) return final;
    }
  } catch {}

  return cur;
}

function extractProductId(url) {
  const m = url.match(/\/products\/(\d+)/);
  return m ? m[1] : null;
}

async function fetchHtml(url, timeoutMs, overrideUA) {
  const headers = overrideUA ? overrideUA : UA_HEADERS;
  const resp = await axios.get(url, {
    headers,
    maxRedirects: 5,
    timeout: timeoutMs,
    validateStatus: s => s >= 200 && s < 400
  });
  return String(resp.data || "");
}

function parseInfoFromHtml(html) {
  // 이름
  let name = null;
  const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if (og) name = og[1];
  if (!name) {
    const j1 = html.match(/"productName"\s*:\s*"([^"]+)"/i);
    if (j1) name = j1[1];
  }
  if (!name) {
    const t1 = html.match(/<title>([^<]+)<\/title>/i);
    if (t1) name = t1[1];
  }

  // 가격
  const prices = [];
  const jsonRe =
    /"(salePrice|discountedPrice|price|unitPrice|originPrice|finalPrice|lowestPrice|couponPrice)"\s*:\s*"?(\d{2,})"?/gi;
  let m;
  while ((m = jsonRe.exec(html)) !== null) {
    const v = parseInt(m[2], 10);
    if (Number.isFinite(v)) prices.push(v);
  }
  const ogPrice = html.match(/property=["']og:price:amount["']\s+content=["'](\d+)["']/i);
  if (ogPrice) prices.push(parseInt(ogPrice[1], 10));
  const textRe = />(\d{1,3}(?:,\d{3})+)\s*원?/g;
  let tm;
  while ((tm = textRe.exec(html)) !== null) {
    const v = parseInt(tm[1].replace(/,/g, ""), 10);
    if (Number.isFinite(v)) prices.push(v);
  }
  const price = prices.length ? Math.min(...prices) : null;

  return { name, price };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ success: false, error: { code: "METHOD_NOT_ALLOWED", message: "POST only" } })
    };
  }

  let url = "";
  try {
    const body = JSON.parse(event.body || "{}");
    url = String(body.url || "").trim();
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: { code: "BAD_JSON", message: "Invalid JSON body" } }) };
  }
  if (!url) {
    return { statusCode: 400, body: JSON.stringify({ success: false, error: { code: "URL_REQUIRED", message: "url required" } }) };
  }

  try {
    const finalUrl = await resolveShortIfNeeded(url);
    if (!/^https?:\/\/(www\.)?coupang\.com\//i.test(finalUrl)) {
      return {
        statusCode: 200, // 프런트가 흐름 유지할 수 있게 200
        body: JSON.stringify({ success: false, reason: "INVALID_URL", input: { url, finalUrl } })
      };
    }

    const productId = extractProductId(finalUrl);
    if (!productId) {
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, reason: "NO_PRODUCT_ID", input: { url, finalUrl } })
      };
    }

    // 단계별로 2.5초씩 시도: m → www(모바일 UA) → www(데스크탑 UA)
    let html = "";
    try {
      html = await fetchHtml(`https://m.coupang.com/vp/products/${productId}`, 2500);
    } catch {}
    if (!html) {
      try {
        html = await fetchHtml(`https://www.coupang.com/vp/products/${productId}`, 2500);
      } catch {}
    }
    if (!html) {
      try {
        html = await fetchHtml(
          `https://www.coupang.com/vp/products/${productId}`,
          2500,
          {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
            "Accept": "text/html,*/*",
            "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            "Referer": "https://www.coupang.com/"
          }
        );
      } catch {}
    }

    if (!html) {
      // 끝까지 실패 -> 성공 false로 돌려주되 200
      return {
        statusCode: 200,
        body: JSON.stringify({ success: false, reason: "FETCH_TIMEOUT_OR_BLOCKED", input: { url, finalUrl, productId } })
      };
    }

    const { name, price } = parseInfoFromHtml(html);
    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        info: {
          name: name || null,
          price: Number.isFinite(price) ? price : null,
          productId,
          sourceUrl: finalUrl
        }
      })
    };
  } catch (e) {
    return {
      statusCode: 200,
      body: JSON.stringify({ success: false, reason: "UNEXPECTED", error: String(e) })
    };
  }
};
