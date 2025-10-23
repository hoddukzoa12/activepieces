# Pineauto Piece

This community piece connects TradingView alerts to the Orderly Network through Pineauto.

## Architecture

- `src/lib/actions/create-order.ts` – Orchestrates sizing, retry logic, and submits POST `/v1/order`.
- `src/lib/common/orderly-auth.ts` – Defines the custom Activepieces authentication and validation against `/v1/client/info`.
- `src/lib/common/orderly-http.ts` – Handles Orderly API signing (`orderly-*` headers) and low-level HTTP requests.
- `src/lib/common/orderly-account.service.ts` – Fetches account/balance/holding data and extracts usable collateral.
- `src/lib/common/orderly-price.service.ts` – Resolves reference prices using Orderly public endpoints.
- `src/lib/common/order-sizing.service.ts` – Converts TradingView sizing instructions into executable quantities (fixed/percent).
- `src/lib/common/tradingview-event.service.ts` – Validates and normalizes TradingView webhook payloads.
- `src/lib/triggers/tradingviewwebhook.ts` – Webhook trigger that authenticates TradingView payloads and emits normalized events.

## Development

```bash
nx build pieces-pineauto
```

Run the command above after making changes to ensure the piece compiles successfully.

## Usage Notes

- Connect your Orderly credentials once; both the TradingView trigger and Create Order action share the same connection.
- The TradingView trigger automatically queues incoming alerts so the Create Order action can consume them—no manual JSON mapping is required.
- The optional **Order Event Override** field in the action is only for manual testing when you are not running the trigger.
