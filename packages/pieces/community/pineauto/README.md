# Pineauto Piece

**Languages**: [English](README.md) | [한국어](README.ko.md)

This community piece connects TradingView alerts to Orderly Network via Pineauto, handling everything from plain market orders to algo TP/SL workflows.

## Architecture

- `src/lib/triggers/tradingviewwebhook.ts` – Receives TradingView alerts, validates the shared secret, normalizes the payload, and queues events for downstream actions.
- `src/lib/actions/create-order.ts` – Consumes queued events, optionally looks up positions/leverage, and submits either standard (`POST /v1/order`) or algo (`POST /v1/algo/order`) requests.
- `src/lib/common/orderly-auth.ts` – Activepieces CustomAuth used by both trigger and action; validation hits `/v1/client/info`.
- `src/lib/common/orderly-http.ts` – Shared HTTP client that applies Orderly headers (`orderly-timestamp`, `orderly-signature`, etc.).
- `src/lib/common/orderly-account.service.ts` – Reusable helpers for balance/holding queries.
- `src/lib/common/order-sizing.service.ts` – Converts TradingView sizing instructions into concrete quantities (fixed or percent-of-balance).
- `src/lib/common/tradingview-event.service.ts` – Validates incoming alert fields (`action`, `qtyMode`, `algo`, …) and manages the event queue.
- Additional services (to be extended):  
  - `orderly-position.service.ts` – Lookup/normalize existing perp positions (`GET /v1/position/{symbol}`).  
  - `orderly-leverage.service.ts` – Fetch/update per-symbol or global leverage (`GET/POST /v1/client/leverage`).  
  - `orderly-algo-order.service.ts` – Build TP/SL payloads for `/v1/algo/order`.

> ℹ️ The queueing model allows triggers to fire ahead of actions; the action reads the next event if no manual override JSON is supplied.

## Runtime Flow

1. **TradingView Alert → Trigger**  
   - The Pine Script alert posts JSON like:
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
   - `action` drives intent (`enter_long`, `exit_long`, `enter_short`, `exit_short`). When absent, the legacy `side` field is used.
   - Trigger stores the event in the flow-scoped queue.

2. **Create Order Action**  
   - Pulls the next event unless `order_event_override` (manual JSON) is supplied.
   - Optional behaviours (configurable via future props):
     - **Position-aware exits**: if `exitQuantityMode === "auto"` the action will call `/v1/position/{symbol}` and size a `reduce_only` order that closes the active leg.
     - **Leverage control**: if no leverage override is provided, fetch current leverage via `GET /v1/client/leverage`; if the user requests a change, call `POST /v1/client/leverage` before trading.
     - **Algo trading**: if `algo.enabled` is true, build `child_orders` and call `/v1/algo/order` (STOP, TP_SL, POSITIONAL_TP_SL, BRACKET, etc.). Otherwise fall back to standard market orders.
   - Returns enriched metadata: order/algo IDs, position snapshots (if fetched), leverage before/after adjustments, etc.

3. **Order Execution & Response**  
   - Standard and algo orders both leverage the same signing client and retry logic.  
   - Errors from Orderly (400/401/429/503) are handled with descriptive messages; insufficient-position scenarios are detected during sizing when auto exits are enabled.

## Alert JSON Guidelines

- Always include `symbol`, `qtyMode`, and `qty`.
- Prefer `action` over `side`; the action automatically derives direction/behaviour.
- Use `exitQuantityMode: "auto"` to close the active perp leg; use `"manual"` (or omit) to respect the provided `qty`.
- Wrap TP/SL inputs under the `algo` block—when disabled or omitted the flow issues simple market orders.
- Optional fields like `clientOrderId`, `orderType`, `leverage` remain backward compatible.

### Pine Script v5 Example

```pinescript
//@version=5
indicator("PineAuto", overlay=true)

long = ta.crossover(ta.sma(close, 14), ta.sma(close, 28))
exit = ta.crossunder(ta.sma(close, 14), ta.sma(close, 28))

buildAlert(action) =>
    json.format(
      "{{\"action\":\"{0}\",\"symbol\":\"PERP_BTC_USDC\",\"qtyMode\":\"percent\",\"qty\":50,\"exitQuantityMode\":\"auto\",\"algo\":{{\"enabled\":true,\"algoType\":\"TP_SL\",\"triggerPriceType\":\"MARK_PRICE\",\"tpPrice\":{1},\"slPrice\":{2},\"reduceOnly\":true}}}}",
      action,
      close * 1.03,
      close * 0.97
    )

if long
    alert(buildAlert("enter_long"), alert.freq_once_per_bar_close)
if exit
    alert(buildAlert("exit_long"), alert.freq_once_per_bar_close)
```

> Keep the alert JSON compact—TradingView limits alert body size.

## Development

```bash
nx build pieces-pineauto
```

Run the command above after making changes to ensure the piece compiles successfully.

## Usage Notes

- Connect your Orderly credentials once; both trigger and action share the same CustomAuth.
- The trigger queues alerts so the action can run without manual JSON mapping.
- `order_event_override` is strictly for manual testing.

## New Actions (v0.1.0+)

### Close Position
Close all or part of an open position on Orderly Network.

**Features**:
- Full position close, partial close by quantity, or percentage-based close
- Supports MARKET or LIMIT orders
- Automatic side detection (closes opposite to position direction)
- Returns estimated PnL

**Example**: Close 50% of BTC position
```json
{
  "symbol": "PERP_BTC_USDC",
  "close_mode": "PERCENT",
  "close_percentage": 50,
  "use_market": true
}
```

### Set Leverage
Dynamically adjust leverage for a symbol before trading.

**Features**:
- Set leverage from 1x to 50x (symbol-dependent maximum)
- Optional validation of current leverage
- Pre-trade leverage configuration
- Rate-limited (5 requests per 60 seconds)

**Example**: Set 10x leverage for BTC
```json
{
  "symbol": "PERP_BTC_USDC",
  "leverage": 10
}
```

### Create Algo Order
Create algorithmic orders with automatic take-profit and stop-loss.

**Features**:
- **TP/SL**: Standard take-profit/stop-loss orders
- **POSITIONAL_TP_SL**: Auto-sized based on current position
- **BRACKET**: Entry order with attached TP/SL

**Offset Calculation**: Automatically calculates TP/SL prices from mark price
- `tp_offset_percentage`: 5 → 5% profit target
- `sl_offset_percentage`: 2 → 2% stop loss

**Example**: Create TP/SL with 5% profit, 2% stop
```json
{
  "symbol": "PERP_BTC_USDC",
  "side": "BUY",
  "algo_type": "POSITIONAL_TP_SL",
  "tp_offset_percentage": 5,
  "sl_offset_percentage": 2
}
```

## Advanced Features

### Position-Aware Trading (Create Order)
The `create-order` action now supports position-aware sizing:

**New Parameters**:
- `position_aware`: Enable position-based quantity calculation
- `close_percentage`: Percentage of position to close (0-100)
- `set_leverage`: Leverage to set before placing order
- `with_tpsl`: Auto-create TP/SL after order success
- `tp_offset_percentage` / `sl_offset_percentage`: TP/SL offset percentages

**Example Workflow**:
1. Set leverage to 10x
2. Place market order
3. Automatically attach 5% TP and 2% SL

## Pine Script Examples

### Example 1: Close 50% of Position
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

### Example 2: Set Leverage Before Entry
```pinescript
//@version=5
strategy("Leverage Control", overlay=true)

entry_signal = ta.crossover(ta.sma(close, 14), ta.sma(close, 28))

if entry_signal
    // First set leverage
    alert(
      '{"action":"set_leverage","symbol":"PERP_BTC_USDC","leverage":10}',
      alert.freq_once_per_bar_close
    )
    // Then place order (in next bar or separate flow)
    alert(
      '{"action":"order","symbol":"PERP_BTC_USDC","side":"buy","qty_mode":"percent","qty":20}',
      alert.freq_once_per_bar_close
    )
```

### Example 3: Auto TP/SL with Offsets
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

### Example 4: Bracket Order
```pinescript
//@version=5
strategy("Bracket Entry", overlay=true)

entry_price = close
tp_price = close * 1.05  // 5% profit
sl_price = close * 0.98  // 2% loss

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

## Action-Based Automatic Routing (v0.2.0+)

### Overview
TradingView webhook events are automatically routed to the correct Activepieces action based on the `action` field. This allows a **single webhook URL** to handle all trading signals.

### Standard Action Types

| action | Routes To | Description |
|--------|-----------|-------------|
| `order` (default) | Create Order | Place standard market order |
| `close_position` | Close Position | Close all or part of position |
| `set_leverage` | Set Leverage | Update leverage setting |
| `create_algo` | Create Algo Order | Create TP/SL or BRACKET order |

### User-Friendly Action Aliases

For better readability in Pine Script, use these action names:

| Friendly Name | Maps To | Description |
|---------------|---------|-------------|
| `enter_long` | `order` | Long position entry |
| `enter_short` | `order` | Short position entry |
| `exit_long` | `close_position` | Close long position |
| `exit_short` | `close_position` | Close short position |

### Single Webhook URL Flow

```
TradingView Alert → Single Webhook URL
  ↓
[Trigger] Auto-routes based on action field
  ├─ action: "enter_long" → order_queue → Create Order Action
  ├─ action: "exit_long" → close_position_queue → Close Position Action
  ├─ action: "set_leverage" → set_leverage_queue → Set Leverage Action
  └─ action: "create_algo" → create_algo_queue → Create Algo Order Action
```

### Pine Script Example: Enter/Exit with Single Webhook

```pinescript
//@version=5
strategy("Auto Enter/Exit", overlay=true)

fastMA = ta.sma(close, 14)
slowMA = ta.sma(close, 28)

longEntry = ta.crossover(fastMA, slowMA)
longExit = ta.crossunder(fastMA, slowMA)

// Single webhook URL handles both enter and exit!
if longEntry
    alert('{"action":"enter_long","symbol":"PERP_BTC_USDC","side":"buy","qty_mode":"percent","qty":20}',
          alert.freq_once_per_bar_close)

if longExit
    alert('{"action":"exit_long","symbol":"PERP_BTC_USDC"}',
          alert.freq_once_per_bar_close)
```

### Migration from v0.1.x

**No changes required!** Events without an `action` field default to `'order'` for full backward compatibility.

**Recommended**: Add `action` field to new alerts for clarity:
```json
// Before (still works)
{"symbol":"PERP_BTC_USDC","side":"buy","qty_mode":"percent","qty":20}

// After (recommended)
{"action":"enter_long","symbol":"PERP_BTC_USDC","side":"buy","qty_mode":"percent","qty":20}
```

## Changelog

### v0.2.0 (2025-01-06)
- 🚀 **Automatic action-based routing** - Single webhook URL handles all signals
- ✨ User-friendly action aliases: `enter_long`, `exit_long`, `enter_short`, `exit_short`
- 🔄 Smart queue routing based on `action` field
- ✅ **100% backward compatible** - Events without `action` field default to `order`
- 🛡️ Action validation with helpful error messages
- 📚 Updated documentation with single webhook URL examples
- 🔧 Enhanced logging for debugging action routing

### v0.1.0 (2025-01-05)
- ✨ Added `close-position` action for position management
- ✨ Added `set-leverage` action for dynamic leverage control
- ✨ Added `create-algo-order` action for TP/SL and BRACKET orders
- ✨ Extended `create-order` with position-aware sizing and auto TP/SL
- ✨ Added action routing via `action` field in webhook events
- 📚 Updated documentation with Pine Script examples
- 🔧 Added comprehensive TypeScript types for algo orders

### v0.0.16
- 🐛 Fixed npm dependency issues
- 📦 Added cryptographic dependencies (@noble/ed25519, bs58)

### v0.0.1
- 🎉 Initial release with basic market order functionality
