const axios = require("axios");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ success: false, error: "POST only" })
    };
  }

  let url = "";
  try {
    const body = JSON.parse(event.body || "{}");
    const raw = (body.url || "").trim();
    // 입력에서 첫 번째 http(s) URL만 추출
    const match = raw.match(/https?:\/\/\S+/);
    if (match) url = match[0];
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: "Invalid JSON or URL" })
    };
  }

  if (!url) {
    return {
      statusCode: 400,
      body: JSON.stringify({ success: false, error: "URL required" })
    };
  }

  try {
    const resp = await axios.get(url, { timeout: 15000 });
    const html = resp.data;

    // 상품명 추출
    let nameMatch = html.match(/<meta property=\"og:title\" content=\"([^\"]+)\"/i);
    if (!nameMatch) {
      nameMatch = html.match(/<title>([^<]+)<\/title>/i);
    }
    const name = nameMatch ? nameMatch[1].trim() : "상품명 없음";

    // 가격 추출 (원 단위 숫자만)
    let priceMatch = html.match(/"price":\s*"?([0-9]+)"?/i);
    let price = priceMatch ? parseInt(priceMatch[1], 10) : null;

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        info: {
          name,
          price,
          formattedPrice: price ? price.toLocaleString("ko-KR") + "원" : null
        }
      })
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: e.message })
    };
  }
};
