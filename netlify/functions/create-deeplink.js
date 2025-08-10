// netlify/functions/create-deeplink.js
const crypto = require("crypto");
const axios = require("axios");

const HOST = "https://api-gateway.coupang.com";
const PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

const ACCESS = process.env.COUPANG_ACCESS_KEY;
const SECRET = process.env.COUPANG_SECRET_KEY;

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

// ---------- utils ----------
function utcSignedDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return (
    String(d.getUTCFullYear()).slice(2) +
    p(d.getUTCMonth()+1) + p(d.getUTCDate()) +
    "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z"
  );
}
function buildAuth(method, path, query="") {
  const datetime = utcSignedDate();
  const message = `${datetime}${method.toUpperCase()}${path}${query}`;
  const signature = crypto.createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
  const header = `CEA algorithm=HmacSHA256,access-key=${ACCESS},signed-date=${datetime},signature=${signature}`;
  return { header, datetime, message, signature };
}
const withDeadline = (p, ms) =>
  Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error("TIMEOUT")), ms))]);

// ---------- short link resolver (강화) ----------
async function resolveShortIfNeeded(inputUrl) {
  const isShort = /^https?:\/\/(link\.coupang\.com|coupa\.ng)\//i.test(inputUrl);
  if (!isShort) return inputUrl;

  let cur = inputUrl;
  for (let i = 0; i < 6; i++) {
    // 1) HEAD
    let r = await axios.head(cur, {
      maxRedirects: 0,
      validateStatus: s => s >= 200 && s < 400,
      timeout: 7000,
      headers: { "User-Agent": UA_MOBILE }
    }).catch(e => e?.response);

    // 2) GET (HEAD에 Location 없는 케이스)
    if (!r || !r.headers?.location) {
      r = await axios.get(cur, {
        maxRedirects: 0,
        validateStatus: s => s >= 200 && s < 400,
        timeout: 7000,
        headers: { "User-Agent": UA_MOBILE }
      }).catch(e => e?.response);
    }

    if (r?.headers?.location) {
      cur = new URL(r.headers.location, cur).toString();
      if (/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(cur)) return cur;
      continue;
    }

    // 3) 자동 리다이렉트 따라가며 최종 URL/본문 확보 후 파싱
    try {
      const followed = await axios.get(cur, {
        maxRedirects: 5,
        timeout: 8000,
        headers: { "User-Agent": UA_MOBILE }
      });
      const finalUrl =
        followed?.request?.res?.responseUrl ||
        followed?.request?.responseURL ||
        cur;

      if (/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(finalUrl)) return finalUrl;

      const html = String(followed?.data || "");
      // meta refresh
      let m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*url=([^"'>\s]+)["']/i);
      if (m) cur = new URL(m[1], finalUrl).toString();
      else {
        // js redirect
        m = html.match(/location\.(?:href|replace)\(\s*['"]([^'"]+)['"]\s*\)/i);
        if (m) cur = new URL(m[1], finalUrl).toString();
        else {
          // a[href]
          m = html.match(/href=["'](https?:\/\/(?:www\.|m\.)?coupang\.com\/[^"']+)["']/i);
          if (m) cur = m[1];
          else {
            // 제품 URL 패턴
            m = html.match(/https?:\/\/(?:www\.|m\.)?coupang\.com\/vp\/products\/\d+[^"'<>\s]*/i);
            if (m) cur = m[0];
            else return finalUrl;
          }
        }
      }
      if (/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(cur)) return cur;
    } catch {
      return cur;
    }
  }
  return cur;
}

// ---------- product info ----------
function extractProductId(url) {
  const m = url.match(/\/products\/(\d+)/);
  return m ? m[1] : null;
}
const toInt = (s) => {
  if (s == null) return null;
  const m = String(s).replace(/[^\d]/g, "");
  return m ? parseInt(m,10) : null;
};
function pickNameAndPriceFromHtml(html) {
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
  const jsonPriceKeys =
    /"(finalPrice|salePrice|discountedPrice|discountPrice|originPrice|price|unitPrice|wowPrice|minPrice|maxPrice|pcPrice|mobilePrice)"\s*:\s*(\d{2,})/gi;
  let m;
  while ((m = jsonPriceKeys.exec(html)) !== null) {
    const v = parseInt(m[2], 10);
    if (Number.isFinite(v)) nums.push(v);
  }
  const metaPrice = html.match(/<meta[^>]+property=["']og:product:price:amount["'][^>]+content=["']([^"']+)["']/i);
  if (metaPrice) nums.push(toInt(metaPrice[1]));
  const domStrong = html.match(/<span[^>]*class=["'][^"']*(?:total-price|sale|price)[^"']*["'][^>]*>\s*<strong[^>]*>([^<]+)<\/strong>/i);
  if (domStrong) nums.push(toInt(domStrong[1]));
  const domPlain = html.match(/<span[^>]*class=["'][^"']*prod-price__price[^"']*["'][^>]*>([^<]+)<\/span>/i);
  if (domPlain) nums.push(toInt(domPlain[1]));

  const priceCandidates = nums.filter(n => Number.isFinite(n) && n > 0);
  const price = priceCandidates.length ? Math.min(...priceCandidates) : null;

  return { name, price };
}
async function fetchProductInfo(productId) {
  // 1) 모바일
  try {
    const mobileUrl = `https://m.coupang.com/vp/products/${productId}`;
    const { data: mhtml } = await axios.get(mobileUrl, {
      timeout: 12000,
      headers: {
        "User-Agent": UA_MOBILE,
        "Referer": "https://m.coupang.com/",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml"
      },
      responseType: "text"
    });
    const { name, price } = pickNameAndPriceFromHtml(mhtml);
    if (name || price) return { name, price, productId, source: "mobile", url: mobileUrl };
  } catch {}

  // 2) 데스크톱 폴백
  const desktopUrl = `https://www.coupang.com/vp/products/${productId}`;
  const { data: dhtml } = await axios.get(desktopUrl, {
    timeout: 12000,
    headers: {
      "User-Agent": UA_DESKTOP,
      "Referer": "https://www.coupang.com/",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
      "Accept": "text/html,application/xhtml+xml"
    },
    responseType: "text"
  });

  // __NEXT_DATA__
  try {
    const m = dhtml.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]+?)<\/script>/i);
    if (m) {
      const next = JSON.parse(m[1]);
      const raw = JSON.stringify(next);
      const nameMatch = raw.match(/"productName"\s*:\s*"([^"]+)"/i);
      const priceMatch = raw.match(/"(finalPrice|salePrice|discountPrice|price)"\s*:\s*(\d{2,})/i);
      const name = nameMatch ? nameMatch[1].replace(/\s*\|.*$/, "").trim() : null;
      const price = priceMatch ? parseInt(priceMatch[2], 10) : null;
      if (name || price) return { name, price, productId, source: "desktop-next", url: desktopUrl };
    }
  } catch {}

  const { name, price } = pickNameAndPriceFromHtml(dhtml);
  return { name, price, productId, source: "desktop-html", url: desktopUrl };
}

// ---------- main handler ----------
exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success:false, error:{ code:"METHOD_NOT_ALLOWED", message:"POST only" }}) };
  }

  // body
  let url = "";
  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
    url = (body.url || "").trim();
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"BAD_JSON", message:"Invalid JSON body" }}) };
  }
  if (!url) return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"URL_REQUIRED", message:"url required" }}) };

  // 1) 짧은→원본
  let finalUrl;
  try { finalUrl = await resolveShortIfNeeded(url); }
  catch (e) {
    return { statusCode: 502, body: JSON.stringify({ success:false, error:{ code:"RESOLVE_FAILED", message:String(e?.message || e) }, input:{ url } }) };
  }

  // 2) 쿠팡 도메인 검사 (www/m 허용)
  if (!/^https?:\/\/(?:www\.|m\.)?coupang\.com\//i.test(finalUrl)) {
    return { statusCode: 400, body: JSON.stringify({
      success:false,
      error:{ code:"INVALID_URL", message:"쿠팡 상품 원본 URL로 해제되지 않았습니다." },
      input:{ url, finalUrl }
    })};
  }

  // 3) info(2.5초 제한)
  let info = null;
  let productId = extractProductId(finalUrl);
  if (productId) {
    try { info = await withDeadline(fetchProductInfo(productId), 2500); }
    catch { info = null; }
  }

  // 4) 딥링크 생성
  const { header, datetime, message, signature } = buildAuth("POST", PATH, "");
  let resp;
  try {
    resp = await axios.post(`${HOST}${PATH}`, { coupangUrls: [finalUrl] }, {
      headers: { Authorization: header, "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true
    });
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ success:false, error:{ code:"UPSTREAM_ERROR", message:String(e?.response?.data || e.message) }, input:{ url, finalUrl, productId }, info }) };
  }

  // 폴백: API가 준 landingUrl에서 productId를 다시 뽑아 info 없을 때 재시도(1회)
  if ((!info || (!info.name && !info.price)) && resp?.data?.data?.[0]?.landingUrl) {
    const landing = resp.data.data[0].landingUrl;
    const pid2 = extractProductId(landing);
    if (pid2 && pid2 !== productId) {
      productId = pid2;
      try { info = await withDeadline(fetchProductInfo(pid2), 2500); }
      catch {}
    }
  }

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
    const deeplink = item?.shortenUrl || item?.landingUrl || null;
    return { statusCode: 200, body: JSON.stringify({ success:true, deeplink, info }) };
  }

  return { statusCode: 502, body: JSON.stringify({ success:false, reason:"UPSTREAM_ERROR", status: resp.status, data: resp.data, input:{ url, finalUrl, productId }, info }) };
};
