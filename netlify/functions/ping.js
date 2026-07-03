const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "" };
  }

  const hasAccessKey = Boolean(process.env.COUPANG_ACCESS_KEY);
  const hasSecretKey = Boolean(process.env.COUPANG_SECRET_KEY);
  const hasSubId = Boolean(process.env.COUPANG_SUB_ID);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
    body: JSON.stringify({
      success: true,
      ok: true,
      service: "kuhot-deeplink-gate",
      version: "v003-safe50-shortlink-resolve",
      functionsAlive: true,
      hasEnv: hasAccessKey && hasSecretKey,
      env: {
        accessKey: hasAccessKey,
        secretKey: hasSecretKey,
        subId: hasSubId
      },
      policy: {
        serverPartnersQuery: false,
        maxPerMinute: Number(process.env.DEEPLINK_MAX_PER_MIN || 50),
        directMaxAttemptsPerRequest: 1,
        netlifyRetry: false,
        resolveRetry: false,
        fallbackOriginal: true
      },
      time: new Date().toISOString()
    })
  };
};
