// Netlify Function — FAST+ (<=6s 목표, 짧은 렌더 보조)
const API = "https://app.scrapingbee.com/api/v1/";
const { SCRAPINGBEE_KEY, SCRAPINGBEE_PREMIUM } = process.env;

const CORS = {
  "Access-Control-Allow-Origin":"*",
  "Access-Control-Allow-Methods":"POST, OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type",
};

exports.handler = async (event) => {
  try{
    if (event.httpMethod === "OPTIONS") return { statusCode:200, headers:CORS, body:"" };
    if (event.httpMethod !== "POST") return { statusCode:405, headers:CORS, body:"POST only" };
    if (!SCRAPINGBEE_KEY) return resp(500, { success:false, error:"Missing SCRAPINGBEE_KEY" });

    const { url:raw } = JSON.parse(event.body||"{}");
    if (!raw) return resp(400, { success:false, error:"url required" });

    const url = normalize(raw);

    // 1) 정적(빠름)
    let html = await getBee(url, { render_js:false, timeout:2500, block_resources:true }).catch(()=> "");
    let parsed = parse(html);
    if (parsed.title && (parsed.price || parsed.price === null)) {
      return resp(200, ok(raw, url, parsed, "fast-static"));
    }

    // 2) 짧은 렌더(제목 우선) — 3s, 프리미엄 있으면 사용
    html = await getBee(url, { render_js:true, timeout:3000, premium_proxy: !!SCRAPINGBEE_PREMIUM, block_resources:true }).catch(()=> "");
    parsed = mergePrefTitle(parsed, parse(html)); // 기존 결과에 제목만 보강
    return resp(200, ok(raw, url, parsed, "fast+render"));
  }catch(e){
    return resp(200, { success:false, error:String(e?.message||e) });
  }
};

function resp(code, body){ return { statusCode:code, headers:CORS, body:JSON.stringify(body) }; }
function ok(inputUrl, finalUrl, {title, price}, mode){
  return { success:true, inputUrl, finalUrl, title: title||null, price: Number.isFinite(price)?price:null, currency:"KRW", provider:"coupang", mode };
}
function normalize(u){ const m=String(u).match(/\/products\/(\d{6,})/); return m ? `https://www.coupang.com/vp/products/${m[1]}` : u; }

// ScrapingBee 호출(필요한 필드만)
async function getBee(url, opt){
  const qs = new URLSearchParams({
    api_key: SCRAPINGBEE_KEY,
    url,
    render_js: opt.render_js ? "true" : "false",
    block_resources: opt.block_resources ? "true" : "false",
    country_code: "kr",
    timeout: String(opt.timeout || 3000),
    ...(opt.premium_proxy ? { premium_proxy: "true" } : {})
  }).toString();
  const r = await fetch(API + "?" + qs);
  const t = await r.text();
  if (!r.ok) throw new Error(`Bee ${r.status} ${t}`);
  return t;
}

// 제목/가격 파싱(강화)
function parse(html){
  const title =
    rx1(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) ||
    rx1(html, /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)/i) ||
    rx1(html, /<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)/i) ||
    rx1(html, /id=["']productTitle["'][^>]*>([^<]+)/i) ||
    rx1Json(html, /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, o=>o?.name) || null;

  const nums = uniqNums(
    []
      .concat(rxAllNums(html, /<meta[^>]+property=["']product:price:amount["'][^>]+content=["']?(\d[\d,.]*)/gi))
      .concat(rxAllNums(html, /"finalPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
      .concat(rxAllNums(html, /"discountPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
      .concat(rxAllNums(html, /"salePrice"\s*:\s*"?(\d[\d,]*)"?/gi))
      .concat(rxAllNums(html, /"wowPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
      .concat(rxAllNums(html, /"rocketCardPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
      .concat(rxAllNums(html, /"couponPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
      .concat(rxAllNums(html, /"lowestPrice"\s*:\s*"?(\d[\d,]*)"?/gi))
      .concat(rxAllNums(html, /"price"\s*:\s*"?(\d[\d,]*)"?/gi))
      .concat(rxAllJson(html, /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, (obj)=>{
        const arr=[]; const offer=obj?.offers||obj?.aggregateOffer||obj?.offers?.[0];
        if (offer?.price) arr.push(toNum(offer.price));
        if (offer?.lowPrice) arr.push(toNum(offer.lowPrice));
        return arr.filter(Boolean);
      }))
  ).filter(n=>n>0);
  const price = nums.length ? Math.min(...nums) : null;

  return { title, price };
}

function mergePrefTitle(a,b){ return { title: b.title || a.title || null, price: a.price ?? b.price ?? null }; }

// helpers
function rx1(s,re){ const m=re.exec(s||""); return m ? sanitize(m[1]) : null; }
function rxAllNums(s,re){ const out=[]; let m; while((m=re.exec(s||""))){ const n=toNum(m[1]); if(n) out.push(n);} return out; }
function rx1Json(s,re,picker){ let m; while((m=re.exec(s||""))){ try{ const o=JSON.parse(m[1]); const v=picker(o); if(v) return sanitize(v);}catch{}} return null; }
function rxAllJson(s,re,picker){ const out=[]; let m; while((m=re.exec(s||""))){ try{ const o=JSON.parse(m[1]); const v=picker(o); if(Array.isArray(v)) out.push(...v); else if(v) out.push(v);}catch{}} return out; }
function toNum(x){ if(x==null) return null; const n=Number(String(x).replace(/[^\d.]/g,"")); return Number.isFinite(n)?Math.round(n):null; }
function uniqNums(a){ const s=new Set(),o=[]; for(const n of a){ if(n==null) continue; if(!s.has(n)){ s.add(n); o.push(n);} } return o; }
function sanitize(t){ return String(t||"").replace(/\s+/g," ").trim(); }


