// netlify/functions/create-deeplink.js
const crypto = require("crypto");
const axios = require("axios");

const HOST = "https://api-gateway.coupang.com";
const PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

const ACCESS = process.env.COUPANG_ACCESS_KEY;
const SECRET = process.env.COUPANG_SECRET_KEY;

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";

function utcSignedDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()).slice(2) +
    p(d.getUTCMonth() + 1) +
    p(d.getUTCDate()) + "T" +
    p(d.getUTCHours()) +
    p(d.getUTCMinutes()) +
    p(d.getUTCSeconds()) + "Z"
  );
}
function buildAuth(method, path, query = "") {
  const datetime = utcSignedDate();
  const message = `${datetime}${method.toUpperCase()}${path}${query}`;
  const signature = crypto.createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
  const header = `CEA algorithm=HmacSHA256,access-key=${ACCESS},signed-date=${datetime},signature=${signature}`;
  return { header, datetime, message, signature };
}

// --- 짧은링크 해제: HEAD → GET → 본문 파싱(meta/js/a[href]/패턴) ---
async function resolveShortIfNeeded(inputUrl) {
  const isShort = /^https?:\/\/(link\.coupang\.com|coupa\.ng)\//i.test(inputUrl);
  if (!isShort) return inputUrl;

  let cur = inputUrl;
  for (let attempt = 0; attempt < 6; attempt++) {
    // 1) HEAD
    let r = await axios.head(cur, {
      maxRedirects: 0,
      validateStatus: s => s >= 200 && s < 400,
      timeout: 15000,
      headers: { "User-Agent": UA_MOBILE }
    }).catch(e => e?.response);

    // 2) GET(헤더에 Location 없는 케이스)
    if (!r || !r.headers?.location) {
      r = await axios.get(cur, {
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
        timeout: 15000,
        headers: { "User-Agent": UA_MOBILE }
      }).catch(e => e?.response);
    }

    if (r && r.headers?.location) {
      cur = new URL(r.headers.location, cur).toString();
      if (/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(cur)) return cur;
      continue;
    }

    // 3) 자동 리다이렉트 따라가며 최종 URL/본문 확보
    try {
      const followed = await axios.get(cur, {
        maxRedirects: 5,
        timeout: 15000,
        headers: { "User-Agent": UA_MOBILE }
      });
      const finalUrl =
        followed?.request?.res?.responseUrl ||
        followed?.request?.responseURL ||
        cur;

      if (/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(finalUrl)) return finalUrl;

      // 4) 본문 파싱
      const html = String(followed?.data || "");
      // meta refresh
      let m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)["']/i);
      if (m) {
        cur = new URL(m[1], finalUrl).toString();
      } else {
        // js redirect
        m = html.match(/location\.(?:href|replace)\(\s*['"]([^'"]+)['"]\s*\)/i);
        if (m) {
          cur = new URL(m[1], finalUrl).toString();
        } else {
          // 앵커 링크
          m = html.match(/href=["'](https?:\/\/(?:www\.|m\.)?coupang\.com\/[^"']+)["']/i);
          if (m) {
            cur = m[1];
          } else {
            // 제품 URL 패턴
            m = html.match(/https?:\/\/(?:www\.|m\.)?coupang\.com\/vp\/products\/\d+[^"'<>\s]*/i);
            if (m) cur = m[0];
            else return finalUrl; // 더 이상 불가
          }
        }
      }
      if (/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(cur)) return cur;
      // 아니면 루프 계속
    } catch {
      return cur;
    }
  }
  return cur;
}

// --- productId 추출 ---
function extractProductId(url) {
  const m = url.match(/\/products\/(\d+)/);
  return m ? m[1] : null;
}

// --- 모바일 상품페이지 파싱(이름/가격) ---
async function fetchProductInfo(productId) {
  const mobileUrl = `https://m.coupang.com/vp/products/${productId}`;
  const { data: html } = await axios.get(mobileUrl, {
    timeout: 15000,
    headers: { "User-Agent": UA_MOBILE }
  });

  let name = null;
  const og = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
  if (og) name = og[1];
  if (!name) {
    const m = html.match(/"productName"\s*:\s*"([^"]+)"/i);
    if (m) name = m[1];
  }
  if (name) name = name.replace(/\s*\|.*$/, "").trim();

  const prices = [];
  const rx = /"(salePrice|discountedPrice|discountPrice|originPrice|price|unitPrice|wowPrice)"\s*:\s*(\d{2,})/gi;
  let mm;
  while ((mm = rx.exec(html)) !== null) {
    const v = parseInt(mm[2], 10);
    if (Number.isFinite(v)) prices.push(v);
  }
  const price = prices.length ? Math.min(...prices) : null;

  return { name, price, productId, source: "mobile", url: mobileUrl };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success:false, error:{ code:"METHOD_NOT_ALLOWED", message:"POST only" }}) };
  }

  // body
  let url = "";
  try {
    const body = JSON.parse(event.body || "{}");
    url = (body.url || "").trim();
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"BAD_JSON", message:"Invalid JSON body" }}) };
  }
  if (!url) return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"URL_REQUIRED", message:"url required" }}) };

  // 1) 짧은 → 원본
  let finalUrl;
  try { finalUrl = await resolveShortIfNeeded(url); }
  catch (e) {
    return { statusCode: 502, body: JSON.stringify({ success:false, error:{ code:"RESOLVE_FAILED", message:String(e?.message || e) }, input:{ url } }) };
  }

  // 2) 도메인 확인( www / m 허용 )
  if (!/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(finalUrl)) {
    return { statusCode: 400, body: JSON.stringify({
      success:false,
      error:{ code:"INVALID_URL", message:"쿠팡 상품 원본 URL로 해제되지 않았습니다." },
      input:{ url, finalUrl }
    })};
  }

  // 3) 상품명/가격
  let info = null;
  const productId = extractProductId(finalUrl);
  if (productId) {
    try { info = await fetchProductInfo(productId); } catch { info = null; }
  }

  // 4) 딥링크 생성
  const { header, datetime, message, signature } = buildAuth("POST", PATH, "");
  try {
    const resp = await axios.post(`${HOST}${PATH}`, { coupangUrls: [finalUrl] }, {
      headers: { Authorization: header, "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true
    });

    if (debug) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({
          success: resp.status === 200 && resp.data?.data?.length > 0,
          upstreamStatus: resp.status,
          upstreamData: resp.data,
          debug: { datetime, message, signature: signature.slice(0,16)+"..." },
          input: { url, finalUrl, productId },
          info
        })
      };
    }

    if (resp.status === 200 && resp.data?.data?.length) {
      const item = resp.data.data[0];
      const link = item?.shortenUrl || item?.landingUrl || null;
      return { statusCode: 200, body: JSON.stringify({ success:true, link, info }) };
    }

    return { statusCode: 502, body: JSON.stringify({ success:false, reason:"UPSTREAM_ERROR", status: resp.status, data: resp.data, input:{ url, finalUrl }, info }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ success:false, error:{ code:"UPSTREAM_ERROR", message:String(e?.response?.data || e.message) }, input:{ url, finalUrl }, info }) };
  }
};
