# Pineauto Piece

**언어**: [English](README.md) | [한국어](README.ko.md)

이 커뮤니티 피스는 TradingView 알림을 Pineauto를 통해 Orderly Network에 연결하여, 기본 시장가 주문부터 알고리즘 TP/SL 워크플로우까지 모든 것을 처리합니다.

## 아키텍처

- `src/lib/triggers/tradingviewwebhook.ts` – TradingView 알림을 수신하고, 공유 시크릿을 검증하며, 페이로드를 정규화하여 다운스트림 액션을 위한 이벤트를 큐에 저장합니다.
- `src/lib/actions/create-order.ts` – 큐에 저장된 이벤트를 소비하고, 선택적으로 포지션/레버리지를 조회하며, 표준(`POST /v1/order`) 또는 알고(`POST /v1/algo/order`) 요청을 제출합니다.
- `src/lib/common/orderly-auth.ts` – 트리거와 액션 모두에서 사용되는 Activepieces CustomAuth; 검증은 `/v1/client/info`를 호출합니다.
- `src/lib/common/orderly-http.ts` – Orderly 헤더(`orderly-timestamp`, `orderly-signature` 등)를 적용하는 공유 HTTP 클라이언트.
- `src/lib/common/orderly-account.service.ts` – 잔고/보유 쿼리를 위한 재사용 가능한 헬퍼.
- `src/lib/common/order-sizing.service.ts` – TradingView 사이징 지시를 구체적인 수량(고정 또는 잔고 퍼센트)으로 변환합니다.
- `src/lib/common/tradingview-event.service.ts` – 들어오는 알림 필드(`action`, `qtyMode`, `algo`, …)를 검증하고 이벤트 큐를 관리합니다.
- 추가 서비스 (확장 예정):
  - `orderly-position.service.ts` – 기존 영구 포지션 조회/정규화 (`GET /v1/position/{symbol}`).
  - `orderly-leverage.service.ts` – 심볼별 또는 글로벌 레버리지 가져오기/업데이트 (`GET/POST /v1/client/leverage`).
  - `orderly-algo-order.service.ts` – `/v1/algo/order`를 위한 TP/SL 페이로드 구축.

> ℹ️ 큐잉 모델은 트리거가 액션보다 먼저 실행될 수 있도록 허용합니다; 수동 오버라이드 JSON이 제공되지 않으면 액션이 다음 이벤트를 읽습니다.

## 런타임 플로우

1. **TradingView 알림 → 트리거**
   - Pine Script 알림이 다음과 같은 JSON을 전송합니다:
     ```json
     {
       "action": "exit_long",
       "symbol": "PERP_BTC_USDC",
       "qtyMode": "percent",
       "qty": 50,
       "leverage": 3,
       "exitQuantityMode": "auto",
       "algo": {
         "enabled": true,
         "algoType": "TP_SL",
         "triggerPriceType": "MARK_PRICE",
         "tpPrice": 3518.4,
         "slPrice": 3313.4,
         "reduceOnly": true
       }
     }
     ```
   - `action`이 의도를 결정합니다 (`enter_long`, `exit_long`, `enter_short`, `exit_short`). 없는 경우 레거시 `side` 필드가 사용됩니다.
   - 트리거는 이벤트를 플로우 범위 큐에 저장합니다.

2. **주문 생성 액션**
   - `order_event_override` (수동 JSON)가 제공되지 않으면 다음 이벤트를 가져옵니다.
   - 선택적 동작 (향후 props를 통해 구성 가능):
     - **포지션 인식 청산**: `exitQuantityMode === "auto"`인 경우 액션이 `/v1/position/{symbol}`을 호출하고 활성 레그를 닫는 `reduce_only` 주문의 크기를 결정합니다.
     - **레버리지 제어**: 레버리지 오버라이드가 제공되지 않으면 `GET /v1/client/leverage`를 통해 현재 레버리지를 가져옵니다; 사용자가 변경을 요청하면 거래 전에 `POST /v1/client/leverage`를 호출합니다.
     - **알고 거래**: `algo.enabled`가 true이면 `child_orders`를 구축하고 `/v1/algo/order` (STOP, TP_SL, POSITIONAL_TP_SL, BRACKET 등)를 호출합니다. 그렇지 않으면 표준 시장가 주문으로 돌아갑니다.
   - 향상된 메타데이터 반환: 주문/알고 ID, 포지션 스냅샷 (가져온 경우), 조정 전후 레버리지 등.

3. **주문 실행 및 응답**
   - 표준 및 알고 주문 모두 동일한 서명 클라이언트와 재시도 로직을 활용합니다.
   - Orderly의 오류(400/401/429/503)는 설명적인 메시지로 처리됩니다; 자동 청산이 활성화된 경우 사이징 중 불충분한 포지션 시나리오가 감지됩니다.

## 알림 JSON 가이드라인

- 항상 `symbol`, `qtyMode`, `qty`를 포함하세요.
- `side`보다 `action`을 선호하세요; action은 자동으로 방향/동작을 도출합니다.
- 활성 영구 레그를 닫으려면 `exitQuantityMode: "auto"`를 사용하세요; 제공된 `qty`를 존중하려면 `"manual"` (또는 생략)을 사용하세요.
- TP/SL 입력을 `algo` 블록 아래에 래핑하세요—비활성화되거나 생략되면 플로우가 단순 시장가 주문을 발행합니다.
- `clientOrderId`, `orderType`, `leverage`와 같은 선택적 필드는 이전 버전과 호환됩니다.

### Pine Script v5 예제

```pinescript
//@version=5
indicator("PineAuto", overlay=true)

long = ta.crossover(ta.sma(close, 14), ta.sma(close, 28))
exit = ta.crossunder(ta.sma(close, 14), ta.sma(close, 28))

buildAlert(action) =>
    json.format(
      "{\"action\":\"{0}\",\"symbol\":\"PERP_BTC_USDC\",\"qtyMode\":\"percent\",\"qty\":50,\"exitQuantityMode\":\"auto\",\"algo\":{\"enabled\":true,\"algoType\":\"TP_SL\",\"triggerPriceType\":\"MARK_PRICE\",\"tpPrice\":{1},\"slPrice\":{2},\"reduceOnly\":true}}",
      action,
      close * 1.03,
      close * 0.97
    )

if long
    alert(buildAlert("enter_long"), alert.freq_once_per_bar_close)
if exit
    alert(buildAlert("exit_long"), alert.freq_once_per_bar_close)
```

> 알림 JSON을 간결하게 유지하세요—TradingView는 알림 본문 크기를 제한합니다.

## 개발

```bash
nx build pieces-pineauto
```

변경 후 위 명령을 실행하여 피스가 성공적으로 컴파일되는지 확인하세요.

## 사용 참고 사항

- Orderly 자격 증명을 한 번 연결하면 트리거와 액션 모두 동일한 CustomAuth를 공유합니다.
- 트리거가 알림을 큐에 저장하므로 액션이 수동 JSON 매핑 없이 실행될 수 있습니다.
- `order_event_override`는 수동 테스트 전용입니다.

## 새로운 액션 (v0.1.0+)

### 포지션 청산 (Close Position)
Orderly Network에서 열린 포지션의 전부 또는 일부를 청산합니다.

**기능**:
- 전량 청산, 수량별 부분 청산, 또는 퍼센트 기반 청산
- MARKET 또는 LIMIT 주문 지원
- 자동 방향 감지 (포지션 방향의 반대로 청산)
- 예상 손익(PnL) 반환

**예제**: BTC 포지션의 50% 청산
```json
{
  "symbol": "PERP_BTC_USDC",
  "close_mode": "PERCENT",
  "close_percentage": 50,
  "use_market": true
}
```

### 레버리지 설정 (Set Leverage)
거래 전 심볼의 레버리지를 동적으로 조정합니다.

**기능**:
- 1배에서 50배까지 레버리지 설정 (심볼별 최대값 의존)
- 현재 레버리지의 선택적 검증
- 거래 전 레버리지 구성
- 속도 제한 (60초당 5개 요청)

**예제**: BTC에 10배 레버리지 설정
```json
{
  "symbol": "PERP_BTC_USDC",
  "leverage": 10
}
```

### 알고 주문 생성 (Create Algo Order)
자동 이익실현 및 손절매와 함께 알고리즘 주문을 생성합니다.

**기능**:
- **TP/SL**: 표준 이익실현/손절매 주문
- **POSITIONAL_TP_SL**: 현재 포지션 기반 자동 사이징
- **BRACKET**: TP/SL이 첨부된 진입 주문

**오프셋 계산**: 마크 가격으로부터 TP/SL 가격을 자동으로 계산
- `tp_offset_percentage`: 5 → 5% 이익 목표
- `sl_offset_percentage`: 2 → 2% 손절

**예제**: 5% 이익, 2% 손절로 TP/SL 생성
```json
{
  "symbol": "PERP_BTC_USDC",
  "side": "BUY",
  "algo_type": "POSITIONAL_TP_SL",
  "tp_offset_percentage": 5,
  "sl_offset_percentage": 2
}
```

## 고급 기능

### 포지션 인식 거래 (주문 생성)
`create-order` 액션은 이제 포지션 인식 사이징을 지원합니다:

**새로운 파라미터**:
- `position_aware`: 포지션 기반 수량 계산 활성화
- `close_percentage`: 청산할 포지션 퍼센트 (0-100)
- `set_leverage`: 주문 전 설정할 레버리지
- `with_tpsl`: 주문 성공 후 자동 TP/SL 생성
- `tp_offset_percentage` / `sl_offset_percentage`: TP/SL 오프셋 퍼센트

**예제 워크플로우**:
1. 레버리지를 10배로 설정
2. 시장가 주문 실행
3. 자동으로 5% TP 및 2% SL 첨부

## Pine Script 예제

### 예제 1: 포지션의 50% 청산
```pinescript
//@version=5
strategy("Auto Close 50%", overlay=true)

exit_signal = ta.crossunder(ta.sma(close, 14), ta.sma(close, 28))

if exit_signal
    alert(
      '{"action":"close_position","symbol":"PERP_BTC_USDC","close_mode":"PERCENT","close_percentage":50}',
      alert.freq_once_per_bar_close
    )
```

### 예제 2: 진입 전 레버리지 설정
```pinescript
//@version=5
strategy("Leverage Control", overlay=true)

entry_signal = ta.crossover(ta.sma(close, 14), ta.sma(close, 28))

if entry_signal
    // 먼저 레버리지 설정
    alert(
      '{"action":"set_leverage","symbol":"PERP_BTC_USDC","leverage":10}',
      alert.freq_once_per_bar_close
    )
    // 그 다음 주문 실행 (다음 바 또는 별도 플로우)
    alert(
      '{"action":"order","symbol":"PERP_BTC_USDC","side":"buy","qty_mode":"percent","qty":20}',
      alert.freq_once_per_bar_close
    )
```

### 예제 3: 오프셋을 이용한 자동 TP/SL
```pinescript
//@version=5
strategy("Auto TP/SL", overlay=true)

long_signal = ta.crossover(ta.sma(close, 14), ta.sma(close, 28))

if long_signal
    alert(
      '{"action":"create_algo","symbol":"PERP_BTC_USDC","side":"BUY","algo_type":"POSITIONAL_TP_SL","tp_offset_percentage":5,"sl_offset_percentage":2}',
      alert.freq_once_per_bar_close
    )
```

### 예제 4: 브래킷 주문
```pinescript
//@version=5
strategy("Bracket Entry", overlay=true)

entry_price = close
tp_price = close * 1.05  // 5% 이익
sl_price = close * 0.98  // 2% 손실

long_signal = ta.crossover(ta.sma(close, 14), ta.sma(close, 28))

if long_signal
    alert(
      str.format(
        '{{"action":"create_algo","symbol":"PERP_BTC_USDC","side":"BUY","algo_type":"BRACKET","entry_price":{0},"tp_price":{1},"sl_price":{2},"quantity":0.1}}',
        entry_price, tp_price, sl_price
      ),
      alert.freq_once_per_bar_close
    )
```

## 액션 기반 자동 라우팅 (v0.2.0+)

### 개요
TradingView 웹훅 이벤트는 `action` 필드를 기반으로 자동으로 올바른 Activepieces 액션으로 라우팅됩니다. 이를 통해 **단일 웹훅 URL**로 모든 거래 시그널을 처리할 수 있습니다.

### 표준 액션 타입

| action | 라우팅 대상 | 설명 |
|--------|-----------|------|
| `order` (기본값) | Create Order | 표준 시장가 주문 실행 |
| `close_position` | Close Position | 포지션 전부 또는 일부 청산 |
| `set_leverage` | Set Leverage | 레버리지 설정 업데이트 |
| `create_algo` | Create Algo Order | TP/SL 또는 BRACKET 주문 생성 |

### 사용자 친화적 액션 별칭

Pine Script에서 더 나은 가독성을 위해 다음 액션 이름을 사용하세요:

| 친화적 이름 | 매핑 대상 | 설명 |
|-------------|---------|------|
| `enter_long` | `order` | 롱 포지션 진입 |
| `enter_short` | `order` | 숏 포지션 진입 |
| `exit_long` | `close_position` | 롱 포지션 청산 |
| `exit_short` | `close_position` | 숏 포지션 청산 |

### 단일 웹훅 URL 플로우

```
TradingView 알림 → 단일 웹훅 URL
  ↓
[트리거] action 필드 기반 자동 라우팅
  ├─ action: "enter_long" → order_queue → Create Order 액션
  ├─ action: "exit_long" → close_position_queue → Close Position 액션
  ├─ action: "set_leverage" → set_leverage_queue → Set Leverage 액션
  └─ action: "create_algo" → create_algo_queue → Create Algo Order 액션
```

### Pine Script 예제: 단일 웹훅으로 진입/청산

```pinescript
//@version=5
strategy("Auto Enter/Exit", overlay=true)

fastMA = ta.sma(close, 14)
slowMA = ta.sma(close, 28)

longEntry = ta.crossover(fastMA, slowMA)
longExit = ta.crossunder(fastMA, slowMA)

// 단일 웹훅 URL이 진입과 청산 모두 처리!
if longEntry
    alert('{"action":"enter_long","symbol":"PERP_BTC_USDC","side":"buy","qty_mode":"percent","qty":20}',
          alert.freq_once_per_bar_close)

if longExit
    alert('{"action":"exit_long","symbol":"PERP_BTC_USDC"}',
          alert.freq_once_per_bar_close)
```

### v0.1.x로부터 마이그레이션

**변경 불필요!** `action` 필드가 없는 이벤트는 완전한 하위 호환성을 위해 기본적으로 `'order'`로 설정됩니다.

**권장사항**: 명확성을 위해 새 알림에 `action` 필드 추가:
```json
// 이전 (여전히 작동)
{"symbol":"PERP_BTC_USDC","side":"buy","qty_mode":"percent","qty":20}

// 이후 (권장)
{"action":"enter_long","symbol":"PERP_BTC_USDC","side":"buy","qty_mode":"percent","qty":20}
```

## 변경 로그

### v0.2.0 (2025-01-06)
- 🚀 **자동 액션 기반 라우팅** - 단일 웹훅 URL로 모든 시그널 처리
- ✨ 사용자 친화적 액션 별칭: `enter_long`, `exit_long`, `enter_short`, `exit_short`
- 🔄 `action` 필드 기반 스마트 큐 라우팅
- ✅ **100% 하위 호환** - `action` 필드가 없는 이벤트는 기본값 `order`
- 🛡️ 유용한 에러 메시지와 함께 액션 검증
- 📚 단일 웹훅 URL 예제로 문서 업데이트
- 🔧 액션 라우팅 디버깅을 위한 향상된 로깅

### v0.1.0 (2025-01-05)
- ✨ 포지션 관리를 위한 `close-position` 액션 추가
- ✨ 동적 레버리지 제어를 위한 `set-leverage` 액션 추가
- ✨ TP/SL 및 BRACKET 주문을 위한 `create-algo-order` 액션 추가
- ✨ 포지션 인식 사이징 및 자동 TP/SL로 `create-order` 확장
- ✨ 웹훅 이벤트에서 `action` 필드를 통한 액션 라우팅 추가
- 📚 Pine Script 예제로 문서 업데이트
- 🔧 알고 주문을 위한 포괄적인 TypeScript 타입 추가

### v0.0.16
- 🐛 npm 의존성 문제 수정
- 📦 암호화 의존성 추가 (@noble/ed25519, bs58)

### v0.0.1
- 🎉 기본 시장가 주문 기능으로 초기 릴리스
