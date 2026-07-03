// netlify/functions/ping.js

exports.handler = async () => {
  const hasAccessKey = Boolean(process.env.COUPANG_ACCESS_KEY);
  const hasSecretKey = Boolean(process.env.COUPANG_SECRET_KEY);
  const hasSubId = Boolean(process.env.COUPANG_SUB_ID);

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify({
      success: true,
      service: "coupangga-deeplink-gate",
      functionsAlive: true,
      hasEnv: hasAccessKey && hasSecretKey,
      env: {
        accessKey: hasAccessKey,
        secretKey: hasSecretKey,
        subId: hasSubId
      }
    })
  };
};
