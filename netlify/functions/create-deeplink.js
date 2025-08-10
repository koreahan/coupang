// netlify/functions/create-deeplink.js
const crypto = require("crypto");
const axios = require("axios");

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
