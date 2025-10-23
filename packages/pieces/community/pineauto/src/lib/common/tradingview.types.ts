export interface TradingViewOrderEvent {
  symbol: string;
  leverage: number;
  side: 'buy' | 'sell';
  qtyMode: 'percent' | 'fixed';
  qty: number;
  clientOrderId?: string;
  rawPayload?: unknown;
  emittedAt?: number;
}
