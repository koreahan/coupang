# NETLIFY_KUHOT_DeeplinkGate_v004_QueuedWaitNoRetry

스크래퍼/에뮬 자동 반송에서 파트너스 링크가 간헐적으로 원본으로 나오는 문제를 줄이기 위한 Deeplink Gate입니다.

핵심 변경:
- MIN_INTERVAL / INFLIGHT 상태에서 즉시 원본 fallback 하지 않음
- API 슬롯이 날 때까지 최대 `DEEPLINK_QUEUE_WAIT_MS` 대기. 기본값 3000ms이며, PC/에뮬 10초 대기 안에 끝나도록 권장값도 3000ms입니다
- 재시도 없음
- API 호출은 요청당 1회만
- product URL은 `productId + itemId + vendorItemId`만 남겨 정리 후 변환

권장 환경변수:
```
DEEPLINK_MAX_PER_MIN=30
DEEPLINK_MIN_INTERVAL_MS=2200
DEEPLINK_QUEUE_WAIT_MS=3000
DEEPLINK_RATE_COOLDOWN_MS=600000
DEEPLINK_FAIL_CACHE_MS=600000
DEEPLINK_SUCCESS_CACHE_MS=86400000
```

GET `/api/create-deeplink`에서 `version=v004-queued-wait-no-retry` 확인.
