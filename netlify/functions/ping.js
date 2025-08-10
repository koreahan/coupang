exports.handler = async () => {
  const hasEnv = Boolean(
    process.env.COUPANG_ACCESS_KEY &&
    process.env.COUPANG_SECRET_KEY &&
    process.env.COUPANG_SUB_ID
  );

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ success: true, hasEnv })
  };
};
