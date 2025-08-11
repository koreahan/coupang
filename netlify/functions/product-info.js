// netlify/functions/product-info.js
const axios = require("axios");

// 짧은 링크 해제(최대 1.5s씩)
async function resolveShortIfNeeded(inputUrl, timeoutMs){
  const isShort = /^https?:\/\/(link\.coupang\.com|coupa\.ng)\//i.test(inputUrl);
  if(!isShort) return inputUrl;
  let cur = inputUrl;
  for(let i=0;i<5;i++){
    const r = await axios.head(cur,{
      maxRedirects:0, validateStatus:s=>s>=200&&s<400, timeout:Math.min(1500,timeoutMs)
    }).catch(e=>e?.response);
    if(!r) break;
    const loc = r.headers?.location; if(!loc) break;
    cur = new URL(loc,cur).toString();
    if(/^https?:\/\/(www\.)?coupang\.com\//i.test(cur)) return cur;
  }
  return cur;
}
function extractProductId(url){ const m=url.match(/\/products\/(\d+)/); return m?m[1]:null; }

async function fetchProductInfo(productId, timeoutMs){
  const mobileUrl = `https://m.coupang.com/vp/products/${productId}`;
  const html = (await axios.get(mobileUrl,{ timeout:timeoutMs })).data;

  // 이름
  let name=null;
  const og = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  if(og) name=og[1];
  if(!name){
    const m1 = html.match(/"productName"\s*:\s*"([^"]+)"/i);
    const m2 = html.match(/<title>([^<]+)<\/title>/i);
    name = (m1&&m1[1]) || (m2&&m2[1]) || null;
  }

  // 가격(키 확장)
  const prices=[]; 
  const priceRegex=/"(salePrice|discountedPrice|price|unitPrice|originPrice|salePriceDisplay)"\s*:\s*"?(\d{2,})"?/gi;
  let mm; while((mm=priceRegex.exec(html))!==null){ const v=parseInt(mm[2],10); if(Number.isFinite(v)) prices.push(v); }
  const ogPrice = html.match(/property=["']og:price:amount["']\s+content=["'](\d+)["']/i);
  if(ogPrice) prices.push(parseInt(ogPrice[1],10));
  const price = prices.length ? Math.min(...prices) : null;

  return { name, price, productId, mobileUrl };
}

exports.handler = async (event)=>{
  if(event.httpMethod!=="POST")
    return { statusCode:405, body:JSON.stringify({ success:false, error:{ code:"METHOD_NOT_ALLOWED", message:"POST only" }}) };

  const qs = event.queryStringParameters || {};
  const timeoutMs = qs.fast==="1" ? 6000 : 9000;

  let url=""; try{ const b=JSON.parse(event.body||"{}"); url=String(b.url||"").trim(); }
  catch{ return { statusCode:400, body:JSON.stringify({ success:false, error:{ code:"BAD_JSON", message:"Invalid JSON body" }}) }; }
  if(!url) return { statusCode:400, body:JSON.stringify({ success:false, error:{ code:"URL_REQUIRED", message:"url required" }}) };

  let finalUrl; try{ finalUrl=await resolveShortIfNeeded(url,timeoutMs); }
  catch(e){ return { statusCode:502, body:JSON.stringify({ success:false, error:{ code:"RESOLVE_FAILED", message:String(e?.message||e) }, input:{ url } }) }; }

  if(!/^https?:\/\/(www\.)?coupang\.com\//i.test(finalUrl))
    return { statusCode:400, body:JSON.stringify({ success:false, error:{ code:"INVALID_URL", message:"쿠팡 상품 원본 URL이 아닙니다." }, input:{ url, finalUrl } }) };

  const productId = extractProductId(finalUrl);
  if(!productId)
    return { statusCode:400, body:JSON.stringify({ success:false, error:{ code:"NO_PRODUCT_ID", message:"productId 추출 실패" }, input:{ url, finalUrl } }) };

  try{
    const info = await fetchProductInfo(productId, timeoutMs);
    return { statusCode:200, body:JSON.stringify({
      success:true,
      info:{
        name: info.name || null,
        price: Number.isFinite(info.price) ? info.price : null,
        productId: info.productId,
        sourceUrl: finalUrl,
        mobileUrl: info.mobileUrl
      }
    })};
  }catch(e){
    return { statusCode:502, body:JSON.stringify({ success:false, error:{ code:"FETCH_FAILED", message:String(e?.message||e) }, input:{ url, finalUrl, productId } }) };
  }
};
