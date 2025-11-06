export interface TradingViewOrderEvent {
  symbol: string;
  leverage: number;
  side: 'buy' | 'sell';
  qtyMode: 'percent' | 'fixed';
  qty: number;
  clientOrderId?: string;
  rawPayload?: unknown;
  emittedAt?: number;

  // Action routing (default: 'order')
  action?: 'order' | 'close_position' | 'set_leverage' | 'create_algo';

  // Position closing parameters
  close_mode?: 'FULL' | 'PARTIAL' | 'PERCENT';
  close_percentage?: number;

  // Algo order parameters
  algo_type?: 'TP_SL' | 'POSITIONAL_TP_SL' | 'BRACKET';
  tp_price?: number;
  sl_price?: number;
  tp_offset_percentage?: number;
  sl_offset_percentage?: number;
  tp_pnl?: number;
  sl_pnl?: number;

  // Position-aware order parameters
  position_aware?: boolean;

  // Auto TP/SL for regular orders
  with_tpsl?: boolean;
}
