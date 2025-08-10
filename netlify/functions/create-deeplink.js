// netlify/functions/create-deeplink.js
const crypto = require("crypto");
const axios = require("axios");

// ▼▼▼ (추가) cheerio는 있으면 사용, 없으면 정규식 폴백
let cheerio = null;
try { cheerio = require("cheerio"); } catch (_) { /* optional */ }
// ▲▲▲ (추가)

const HOST = "https://api-gateway.coupang.com";
const PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

const ACCESS = process.env.COUPANG_ACCESS_KEY;
const SECRET = process.env.COUPANG_SECRET_KEY;

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

// --- short 링크 해제 (link.coupang.com → www.coupang.com) ---
async function resolveShortIfNeeded(inputUrl) {
  const isShort = /^https?:\/\/link\.coupang\.com\//i.test(inputUrl);
  if (!isShort) return inputUrl;

  // 최대 5번까지 30x 따라감(HEAD → Location)
  let cur = inputUrl;
  for (let i = 0; i < 5; i++) {
    // redirects를 우리가 직접 따라가기 위해 3xx만 허용
    const r = await axios
      .head(cur, {
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
        timeout: 15000
      })
      .catch((e) => e?.response);

    if (!r) break;

    const loc = r.headers?.location;
    if (!loc) break;

    // 상대경로 대비
    cur = new URL(loc, cur).toString();

    // 원본 상품 도메인으로 오면 종료
    if (/^https?:\/\/(www\.)?coupang\.com\//i.test(cur)) {
      return cur;
    }
  }
  // 못 풀어도 일단 현재값 반환(하단에서 한 번 더 검증)
  return cur;
}

/* =========================
   (추가) 상품명·가격 추출 유틸
   - cheerio가 있으면 DOM처럼 파싱
   - 없으면 정규식 폴백
   ========================= */

const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1";
const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

async function fetchHtml(url, mobileFirst = true) {
  const headersMobile = {
    "User-Agent": UA_MOBILE,
    "Referer": "https://m.coupang.com/",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept": "text/html,application/xhtml+xml"
  };
  const headersDesktop = {
    "User-Agent": UA_DESKTOP,
    "Referer": "https://www.coupang.com/",
    "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    "Accept": "text/html,application/xhtml+xml"
  };

  const targets = mobileFirst
    ? [url.replace("://www.", "://m."), url.replace("://m.", "://www.")]
    : [url.replace("://m.", "://www."), url.replace("://www.", "://m.")];

  // m → www 순으로 시도
  for (let i = 0; i < targets.length; i++) {
    try {
      const hdr = i === 0 ? headersMobile : headersDesktop;
      const { data } = await axios.get(targets[i], { timeout: 12000, headers: hdr, responseType: "text" });
      if (typeof data === "string" && data.length > 0) return data;
    } catch (_) {}
  }
  return "";
}

function parseByRegex(html) {
  const toInt = s => {
    if (s == null) return null;
    const m = String(s).replace(/[^\d]/g, "");
    return m ? parseInt(m, 10) : null;
  };

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
  const rx = /"(finalPrice|salePrice|discountedPrice|discountPrice|originPrice|price|unitPrice|wowPrice|minPrice|maxPrice|pcPrice|mobilePrice)"\s*:\s*(\d{2,})/gi;
  let m;
  while ((m = rx.exec(html)) !== null) {
    const v = parseInt(m[2], 10);
    if (Number.isFinite(v)) nums.push(v);
  }
  const metaAmt = html.match(/<meta[^>]+property=["']og:product:price:amount["'][^>]+content=["']([^"']+)["']/i);
  if (metaAmt) nums.push(toInt(metaAmt[1]));
  const domStrong = html.match(/<span[^>]*class=["'][^"']*(?:total-price|sale|price)[^"']*["'][^>]*>\s*<strong[^>]*>([^<]+)<\/strong>/i);
  if (domStrong) nums.push(toInt(domStrong[1]));
  const domPlain = html.match(/<span[^>]*class=["'][^"']*prod-price__price[^"']*["'][^>]*>([^<]+)<\/span>/i);
  if (domPlain) nums.push(toInt(domPlain[1]));

  const priceCandidates = nums.filter(n => Number.isFinite(n) && n > 0);
  const price = priceCandidates.length ? Math.min(...priceCandidates) : null;

  return { name, price };
}

function parseByCheerio(html) {
  if (!cheerio) return null; // cheerio가 없으면 사용 안 함
  const $ = cheerio.load(html);

  // (쿠팡 구조 바뀌면 여기만 손보면 됨)
  let name =
    $("h2.prod-buy-header__title").first().text().trim() ||
    $("h1.prod-buy-header__title").first().text().trim() ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $("title").first().text().trim() ||
    null;
  if (name) name = name.replace(/\s*\|.*$/, "").trim();

  let priceText =
    $("span.total-price > strong").first().text().trim() ||
    $("span.prod-price__price").first().text().trim() ||
    $('meta[property="og:product:price:amount"]').attr("content")?.trim() ||
    null;

  const toInt = s => (s ? parseInt(String(s).replace(/[^\d]/g, ""), 10) : null);
  const price = toInt(priceText);

  // cheerio로 못 뽑았으면 null 반환해서 정규식 폴백 사용
  if (!name && !price) return null;
  return { name: name || null, price: Number.isFinite(price) ? price : null };
}

async function getInfo(finalUrl) {
  const html = await fetchHtml(finalUrl, true);
  if (!html) return { name: null, price: null };

  // 1) cheerio 우선
  const dom = parseByCheerio(html);
  if (dom && (dom.name || dom.price)) return dom;

  // 2) 정규식 폴백
  return parseByRegex(html);
}

/* ========================= */

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({
        success: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "POST only" }
      })
    };
  }

  // body 파싱
  let url = "";
  try {
    const body = JSON.parse(event.body || "{}");
    url = (body.url || "").trim();
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: { code: "BAD_JSON", message: "Invalid JSON body" }
      })
    };
  }
  if (!url) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: { code: "URL_REQUIRED", message: "url required" }
      })
    };
  }

  // ★ 짧은링크면 먼저 원본으로 해제
  let finalUrl;
  try {
    finalUrl = await resolveShortIfNeeded(url);
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        success: false,
        error: { code: "RESOLVE_FAILED", message: String(e?.message || e) },
        input: { url, finalUrl: null }
      })
    };
  }

  // 원본 도메인 검증 (쿠팡 상품 URL만 허용)
  if (!/^https?:\/\/(www\.)?coupang\.com\//i.test(finalUrl)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        success: false,
        error: {
          code: "INVALID_URL",
          message: "쿠팡 상품 원본 URL로 해제되지 않았습니다."
        },
        input: { url, finalUrl }
      })
    };
  }

  // ▼▼▼ (추가) info=1 요청일 때만 상품명/가격을 수집
  const wantInfo = qs.info === "1";
  let info = null;
  if (wantInfo) {
    try {
      info = await getInfo(finalUrl);
    } catch { info = null; }
  }
  // ▲▲▲ (추가)

  // 서명 빌드 (쿼리 없음)
  const { header, datetime, message, signature } = buildAuth("POST", PATH, "");

  try {
    const resp = await axios.post(
      `${HOST}${PATH}`,
      { coupangUrls: [finalUrl] }, // ★ 원본 URL로 전송
      {
        headers: {
          Authorization: header,
          "Content-Type": "application/json"
        },
        timeout: 15000,
        validateStatus: () => true
      }
    );

    // ▼▼▼ (추가) info=1 이고 업스트림 성공이면 상품템플릿 포함해서 조기 반환
    if (wantInfo && resp && resp.status === 200 && resp.data?.data?.length) {
      const item = resp.data.data[0];
      const link = item?.shortenUrl || item?.landingUrl || null;

      const name = info?.name || "상품명 없음";
      const priceTxt = Number.isFinite(info?.price) ? info.price.toLocaleString("ko-KR") + "원" : "가격 정보 없음";
      const template = `【쿠팡】${name}
가격: ${priceTxt}
링크: ${link}

※ 모든 핫딜은 카드 할인 및 쿠폰 적용가 기준입니다.
※ 이 포스팅은 쿠팡파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다. 구입 시 제품 가격에는 아무런 영향이 없습니다.`;

      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, link, raw: resp.data, info, template })
      };
    }
    // ▲▲▲ (추가)

    // debug 모드 응답
    if (debug) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({
          success: resp.status === 200 && resp.data?.data?.length > 0,
          upstreamStatus: resp.status,
          upstreamData: resp.data,
          debug: {
            datetime,
            message,
            signature: signature.slice(0, 16) + "..."
          },
          input: { url, finalUrl }
        })
      };
    }

    if (resp.status === 200 && resp.data?.data?.length) {
      const item = resp.data.data[0];
      const link = item?.shortenUrl || item?.landingUrl || null;
      return {
        statusCode: 200,
        body: JSON.stringify({ success: true, link, raw: resp.data })
      };
    }

    // 업스트림이 200인데 rCode 400 같은 경우를 위해 원문 그대로 반환
    return {
      statusCode: 502,
      body: JSON.stringify({
        success: false,
        reason: "UPSTREAM_ERROR",
        status: resp.status,
        data: resp.data,
        input: { url, finalUrl }
      })
    };
  } catch (e) {
    return {
      statusCode: 502,
      body: JSON.stringify({
        success: false,
        error: {
          code: "UPSTREAM_ERROR",
          message: String(e?.response?.data || e.message)
        },
        input: { url, finalUrl }
      })
    };
  }
};
