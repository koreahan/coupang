// 제품 정보
const productInfo = {
    originalUrl: "YOUR_COUPANG_URL" // 실제 쿠팡 상품 URL
};

// HTML에 최종 결과 표시
async function displayFinalResult() {
    const container = document.getElementById('product-container');
    container.innerHTML = '<h3>정보를 가져오는 중...</h3>';

    try {
        const [deeplinkResponse, productInfoResponse] = await Promise.all([
            fetch('/.netlify/functions/create-deeplink', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: productInfo.originalUrl })
            }).then(res => res.json()),

            fetch('/.netlify/functions/product-info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: productInfo.originalUrl })
            }).then(res => res.json())
        ]);
        
        if (!deeplinkResponse.success || !productInfoResponse.success) {
            console.error("API 호출 실패:", deeplinkResponse.error || productInfoResponse.error);
            container.innerHTML = `<h3>정보를 가져오는 데 실패했습니다.</h3><p>${deeplinkResponse.error || productInfoResponse.error}</p>`;
            return;
        }

        const htmlContent = `
            <h3>【쿠팡】 ${productInfoResponse.title || '제품명 없음'}</h3>
            <p><strong>가격</strong>: ${productInfoResponse.price || '가격 정보 없음'}</p>
            <p><strong>원본 링크</strong>: <a href="${deeplinkResponse.originalLink}" target="_blank">${deeplinkResponse.originalLink}</a></p>
            <p><strong>짧은 링크</strong>: <a href="${deeplinkResponse.shortLink}" target="_blank">${deeplinkResponse.shortLink}</a></p>
        `;
        container.innerHTML = htmlContent;
    } catch (error) {
        console.error("Netlify Function 호출 중 오류 발생:", error);
        container.innerHTML = `<h3>오류 발생</h3><p>${error.message}</p>`;
    }
}

// 스크립트 로드 완료 시 함수 실행
window.onload = displayFinalResult;

