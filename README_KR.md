# KUHOT Deeplink Gate v003

서버(Render)가 아니라 Netlify 한 곳에서만 Coupang Partners Deeplink API를 호출하기 위한 안전 게이트입니다.

## 포함 파일

- `netlify.toml`
- `package.json`
- `public/index.html`
- `netlify/functions/ping.js`
- `netlify/functions/create-deeplink.js`

## 환경변수

Netlify Site settings → Environment variables:

```text
COUPANG_ACCESS_KEY=...
COUPANG_SECRET_KEY=...
COUPANG_SUB_ID=...   # 선택
DEEPLINK_MAX_PER_MIN=50
DEEPLINK_MIN_INTERVAL_MS=1200
DEEPLINK_SUCCESS_CACHE_MS=86400000
DEEPLINK_FAIL_CACHE_MS=600000
DEEPLINK_RATE_COOLDOWN_MS=60000
DEEPLINK_RESOLVE_SHORT_LINKS=true
DEEPLINK_RESOLVE_TIMEOUT_MS=8000
```

## 배포 후 안전 확인

쿠팡 API 호출 없음:

```powershell
Invoke-WebRequest "https://coupanga.netlify.app/.netlify/functions/ping"
Invoke-WebRequest "https://coupanga.netlify.app/.netlify/functions/create-deeplink" -Method GET
```

## 실제 변환 호출

딥링크 제한이 풀린 뒤 1건만 테스트하세요.

```powershell
$body = @{ url = "https://www.coupang.com/vp/products/6269223291?itemId=17905188990&vendorItemId=85067938409" } | ConvertTo-Json -Compress
Invoke-RestMethod `
  -Uri "https://coupanga.netlify.app/.netlify/functions/create-deeplink" `
  -Method Post `
  -ContentType "application/json" `
  -Body $body
```

## 정책

- 서버(Render)는 쿠팡/파트너스 API 호출 금지
- Netlify 게이트 1곳만 딥링크 API 호출
- 1요청당 API 최대 1회
- 1분 50회 이상이면 API 호출하지 않고 원본 링크 반환
- rate limit 감지 시 쿨다운 동안 API 호출 0회
- 실패해도 링크를 비우지 않고 원본 링크 반환

## 주의

Netlify Functions의 메모리 캐시/카운터는 warm instance 기준입니다. 여러 인스턴스가 동시에 뜨는 고트래픽 환경에서는 완전한 글로벌 제한을 위해 Redis/Netlify Blobs 같은 공유 저장소가 필요합니다.


## v002 변경

- PowerShell `curl.exe -d $body`에서 JSON 따옴표가 깨져도 URL을 최대한 복구합니다.
- `application/json`, `application/x-www-form-urlencoded`, plain URL 입력을 모두 허용합니다.
- `/api/ping`, `/api/create-deeplink` redirect를 포함했습니다.


## v003 변경

- `link.coupang.com/a/...` 단축링크를 Deeplink API에 그대로 넣으면 Coupang upstream이 `rCode: 400 / url convert failed`를 반환할 수 있어, API 호출 전 `HEAD` 1회로 원본 `coupang.com` 상품 URL을 해제합니다.
- 단축링크 해제는 성공/실패 캐시를 사용합니다.
- 단축링크 해제가 실패하면 Deeplink API를 호출하지 않고 원본 링크 fallback을 반환합니다.
- 여전히 Deeplink API는 1요청당 최대 1회만 호출합니다.
