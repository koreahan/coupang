// Netlify Function for Product Scraping (Node 18+)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, code=200){
  return { statusCode: code, headers: { "Content-Type": "application/json", ...CORS }, body: JSON.stringify(obj) };
}

async function normalizeUrl(input){
    let u = String(input || "").trim();
    if (u.includes("link.coupang.com")) {
      const r = await fetch(u, { method: "HEAD", redirect: "manual" });
      const loc = r.headers.get("location");
      if (loc) u = loc;
    }
    const url = new URL(u);
    const itemId = url.searchParams.get("itemId");
    const vendorItemId = url.searchParams.get("vendorItemId");
    [
      "redirect","src","addtag","itime","lptag","wTime","wPcid","wRef","traceid",
      "pageType","pageValue","spec","ctag","mcid","placementid","clickBeacon",
      "campaignid","puidType","contentcategory","imgsize","pageid","tsource",
      "deviceid","token","contenttype","subid","sig","impressionid","campaigntype",
      "puid","requestid","ctime","contentkeyword","portal","landing_exp","subparam"
    ].forEach(p => url.searchParams.delete(p));
    const m = url.pathname.match(new RegExp("\\/(vp\\/)?products\\/(\\d+)"));
    if (!m) return url.toString();
    const out = new URL(`https://www.coupang.com/vp/products/${m[2]}`);
    if (itemId) out.searchParams.set("itemId", itemId);
    if (vendorItemId) out.searchParams.set("vendorItemId", vendorItemId);
    return out.toString();
}
  
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  
async function getFastestHtml(finalUrl) {
    const ladder = [
        { render: false, timeout: 8000, premium: false }, // 렌더링 없이 빠른 시도 (가장 빠르고 안정적)
        { render: true, timeout: 15000, premium: true }, // 실패 시, 프리미엄 프록시로 재시도
    ];

    let lastErr;
    for (const step of ladder) {
        try {
            const html = await scrapeWithScrapingBee(finalUrl, step);
            if (/Sorry!\s*Access\s*denied/i.test(html) || html.length < 2000) {
                throw new Error('BLOCKED_PAGE');
            }
            return html;
        } catch (e) {
            lastErr = e;
            const msg = String(e?.message || e);
            if (msg.includes('HTTP_429')) {
                console.warn('ScrapingBee 429 에러 발생. 다음 스크래핑 단계로 넘어갑니다.');
            }
        }
    }
    throw lastErr || new Error('All attempts failed');
}
  
async function scrapeWithScrapingBee(url, options){
    const apiKey = process.env.SCRAPINGBEE_KEY;
    if (!apiKey) throw new Error("Missing SCRAPINGBEE_KEY");
    const params = new URLSearchParams({
      api_key: apiKey,
      url,
      render_js: options.render ? "true" : "false",
      country_code: "kr",
      ...(options.render ? { wait: "3000", wait_for: 'meta[property="og:title"]' } : {}),
      ...(options.premium ? { premium_proxy: "true" } : {}),
      forward_headers: "true",
    });
    const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36" };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), options.timeout);
    try {
      const res = await fetch(`https://app.scrapingbee.com/api/v1?${params.toString()}`, { headers, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429) throw new Error('HTTP_429 ' + text);
      if (!res.ok) throw new Error(`ScrapingBee ${res.status} ${text.slice(0,300)}`);
      return text;
    } finally { clearTimeout(t); }
}

function parseInfo(html){
    const prices = [];
    let title = null, currency = "KRW", provider = "none";
    const toNum = v => {
      const s = String(v ?? "").replace(/[^0-9.]/g, "");
      const n = s ? Number(s) : NaN;
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    const push = v => { const n = toNum(v); if (n) prices.push(n); };
  
    const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
    if (ldMatch) {
      try {
        const data = JSON.parse(ldMatch[1]);
        const productData = data['@graph']?.find(o => o['@type'] === 'Product') || data;
        if (productData) {
          title = productData.name;
          const offers = Array.isArray(productData.offers) ? productData.offers : (productData.offers ? [productData.offers] : []);
          offers.forEach(o => {
            if (o.priceCurrency) currency = o.priceCurrency;
            push(o.price);
          });
          provider = "json-ld";
        }
      } catch {}
    }
  
    const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/i);
    if (!title && ogTitleMatch) {
      title = ogTitleMatch[1];
      provider = provider === "none" ? "meta-og" : provider;
    }
    
    if (!title) {
      const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
      if (titleMatch && !/Sorry!\s*Access\s*denied/i.test(titleMatch[1])) {
        title = titleMatch[1];
        provider = provider === "none" ? "meta-title" : provider;
      }
    }
  
    const pricePatterns = [
      /data-rt-price="([\d,.]+)"/gi, /data-price="([\d,.]+)"/gi,
      /class="total-price[^"]*">[\s\S]*?([\d,.]+)\s*원/gi,
      /class="prod-price[^"]*">[\s\S]*?([\d,.]+)\s*원/gi,
      /aria-label="가격\s*([\d,.]+)\s*원"/gi,
    ];
    if (prices.length === 0) {
      const fallbackPrices = new Set();
      pricePatterns.forEach(re => {
        for (const m of html.matchAll(re)) {
          const n = toNum(m[1]);
          if (n) fallbackPrices.add(n);
        }
      });
      prices.push(...fallbackPrices);
      if (prices.length > 0 && provider === "none") provider = "html-fallback";
    }
  
    const minPrice = prices.length ? Math.min(...prices) : null;
    return { title, price: minPrice != null ? String(minPrice) : null, currency, provider };
}

exports.handler = async (event) => {
    try {
        if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers: CORS, body: "" };
        if (event.httpMethod !== "POST") return { statusCode: 405, headers: CORS, body: "POST only" };

        const { url } = JSON.parse(event.body || "{}");
        if (!url) return json({ success: false, error: "No URL provided" }, 400);

        const finalUrl = await normalizeUrl(url);
        const html = await getFastestHtml(finalUrl);
        const parsed = parseInfo(html);

        return json({
            success: true,
            title: parsed.title,
            price: parsed.price,
            currency: parsed.currency,
        });
    } catch (err) {
        return json({ success: false, error: String(err?.message || err) }, 500);
    }
};
