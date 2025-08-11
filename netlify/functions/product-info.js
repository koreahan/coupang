import fetch from "node-fetch";

export default async (req, res) => {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.status(200).end();
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");

  try {
    const { url } = req.body;
    if (!url) throw new Error("No URL provided");

    const finalUrl = await normalizeUrl(url);
    const html = await getFastestHtml(finalUrl);

    const parsed = parseInfo(html) || {};
    res.json({
      success: true,
      title: parsed.title || null,
      price: parsed.price || null,
      currency: parsed.currency || "KRW",
      finalUrl
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
};

// 짧은링크 정규화
async function normalizeUrl(input) {
  let u = input.trim();
  if (u.includes("link.coupang.com")) {
    const head = await fetch(u, { method: "HEAD", redirect: "manual" });
    const loc = head.headers.get("location");
    if (loc) u = loc;
  }
  const url = new URL(u);
  ["redirect","src","addtag","itime","lptag","wTime","wPcid","wRef","traceid","pageType","pageValue","spec","ctag","mcid"]
    .forEach(p=>url.searchParams.delete(p));
  const m = url.pathname.match(/\/(vp\/)?products\/(\d+)/);
  return m ? `https://www.coupang.com/vp/products/${m[2]}` : u;
}

// 병렬 요청 → 가장 빠른 HTML 반환
async function getFastestHtml(finalUrl) {
  const providers = [
    () => scrapeWithScrapingBee(finalUrl, 3000, false),
    () => scrapeWithScrapingBee(finalUrl, 8000, true),
  ];
  return Promise.any(providers.map(fn => fn()));
}

// ScrapingBee 호출
async function scrapeWithScrapingBee(url, timeoutMs, render) {
  const apiKey = process.env.SCRAPINGBEE_KEY;
  const qs = new URLSearchParams({
    api_key: apiKey,
    url,
    country_code: "kr",
    render_js: render ? "true" : "false"
  });
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  const r = await fetch(`https://app.scrapingbee.com/api/v1?${qs}`, { signal: ctrl.signal });
  clearTimeout(id);
  if (!r.ok) throw new Error("ScrapingBee failed");
  return r.text();
}

// 파싱 로직
function parseInfo(html) {
  // JSON-LD
  const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(m => { try { return JSON.parse(m[1]); } catch { return null; } })
    .find(o => o && (o["@type"] === "Product" || o.name));
  if (ld) {
    const price = ld.offers?.price ?? ld.offers?.lowPrice;
    const currency = ld.offers?.priceCurrency ?? "KRW";
    return { title: ld.name, price: String(price), currency };
  }
  // og:title
  const og = html.match(/<meta property="og:title" content="([^"]+)"/);
  // __NUXT__ JSON
  const nuxt = html.match(/window\.__NUXT__\s*=\s*(\{[\s\S]*?\});/);
  let price, currency = "KRW";
  if (nuxt) try {
    const data = JSON.parse(nuxt[1]);
    const s = JSON.stringify(data);
    const m = s.match(/"salePrice"\s*:\s*(\d+)/) || s.match(/"price"\s*:\s*(\d+)/);
    if (m) price = m[1];
  } catch {}
  return { title: og?.[1] || null, price: price || null, currency };
}
