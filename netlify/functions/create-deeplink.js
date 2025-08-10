const crypto = require("crypto");
const axios = require("axios");

const HOST = "https://api-gateway.coupang.com";
const PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

const ACCESS = process.env.COUPANG_ACCESS_KEY;
const SECRET = process.env.COUPANG_SECRET_KEY;

function utcSignedDate() {
  const d = new Date();
  const p = n => String(n).padStart(2, "0");
  return String(d.getUTCFullYear()).slice(2) + p(d.getUTCMonth()+1) + p(d.getUTCDate()) +
         "T" + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + "Z";
}
function buildAuth(method, path, query="") {
  const datetime = utcSignedDate();
  const message = `${datetime}${method.toUpperCase()}${path}${query}`;
  const signature = crypto.createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
  const header = `CEA algorithm=HmacSHA256,access-key=${ACCESS},signed-date=${datetime},signature=${signature}`;
  return { header, datetime, message, signature };
}

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const debug = qs.debug === "1";

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ success:false, error:{ code:"METHOD_NOT_ALLOWED", message:"POST only" }}) };
  }

  let url = "";
  try {
    const body = JSON.parse(event.body || "{}");
    url = (body.url || "").trim();
  } catch {
    return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"BAD_JSON", message:"Invalid JSON body" }}) };
  }
  if (!url) return { statusCode: 400, body: JSON.stringify({ success:false, error:{ code:"URL_REQUIRED", message:"url required" }}) };

  // ★ 짧은링크/원본링크 그대로 전달
  const { header, datetime, message, signature } = buildAuth("POST", PATH, "");

  try {
    const resp = await axios.post(`${HOST}${PATH}`, { coupangUrls: [url] }, {
      headers: { "Authorization": header, "Content-Type": "application/json" },
      timeout: 15000,
      validateStatus: () => true
    });

    if (debug) {
      return {
        statusCode: resp.status,
        body: JSON.stringify({
          success: resp.status === 200,
          upstreamStatus: resp.status,
          upstreamData: resp.data,
          debug: { datetime, message, signature: signature.slice(0,16)+"..." },
          input: { url }
        })
      };
    }

    if (resp.status === 200 && resp.data?.data?.length) {
      const item = resp.data.data[0];
      const link = item?.shortenUrl || item?.landingUrl || null;
      return { statusCode: 200, body: JSON.stringify({ success:true, link, raw: resp.data }) };
    }
    return { statusCode: 502, body: JSON.stringify({ success:false, reason:"UPSTREAM_ERROR", status: resp.status, data: resp.data }) };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ success:false, error:String(e?.response?.data || e.message), input:{ url } }) };
  }
};
