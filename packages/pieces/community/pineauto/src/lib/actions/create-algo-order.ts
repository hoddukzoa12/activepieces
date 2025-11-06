import { createAction, Property } from '@activepieces/pieces-framework';
import { PineautoAuthType } from '../common/orderly-auth';
import { createOrderlyClientFromAuth } from '../common/orderly-http';
import { OrderlyEnvironment } from '../common/orderly-config';
import {
  createTPSL,
  createBracketOrder,
  AlgoOrderType,
  OrderSide,
} from '../common/orderly-algo-order.service';
import { getMarkPrice } from '../common/orderly-price.service';
import {
  consumeQueuedTradingViewEvent,
  ensureTradingViewOrderEvent,
} from '../common/tradingview-event.service';
import { normalizeNumber } from '../common/order-sizing.service';

interface CreateAlgoOrderProps {
  symbol?: string;
  algo_type: string;
  side?: string;
  quantity?: number;
  use_positional: boolean;
  tp_price?: number;
  sl_price?: number;
  tp_offset_percentage?: number;
  sl_offset_percentage?: number;
  entry_price?: number;
  event_override?: unknown;
}

export const createAlgoOrderAction = createAction({
  name: 'create_algo_order',
  displayName: 'Create Algo Order',
  description: 'Create algorithmic orders (TP/SL, POSITIONAL_TP_SL, BRACKET) on Orderly Network',
  props: {
    symbol: Property.ShortText({
      displayName: 'Symbol (Optional)',
      description: 'Trading pair (e.g., PERP_BTC_USDC). Leave empty to use from TradingView event.',
      required: false,
    }),
    algo_type: Property.StaticDropdown({
      displayName: 'Algo Order Type',
      description: 'Type of algorithmic order to create',
      required: true,
      defaultValue: 'TP_SL',
      options: {
        options: [
          { label: 'TP/SL (Standard)', value: 'TP_SL' },
          { label: 'TP/SL (Positional)', value: 'POSITIONAL_TP_SL' },
          { label: 'BRACKET (Entry + TP + SL)', value: 'BRACKET' },
        ],
      },
    }),
    side: Property.StaticDropdown({
      displayName: 'Side (Optional)',
      description: 'Order side. Leave empty to use from TradingView event.',
      required: false,
      options: {
        options: [
          { label: 'Buy', value: 'BUY' },
          { label: 'Sell', value: 'SELL' },
        ],
      },
    }),
    quantity: Property.Number({
      displayName: 'Quantity (Optional)',
      description: 'Order quantity. Not required for POSITIONAL_TP_SL.',
      required: false,
    }),
    use_positional: Property.Checkbox({
      displayName: 'Use Positional (Auto-size)',
      description: 'Automatically size TP/SL based on current position (makes quantity optional)',
      required: false,
      defaultValue: false,
    }),
    tp_price: Property.Number({
      displayName: 'Take Profit Price',
      description: 'Price to trigger take profit. Leave empty to use offset percentage.',
      required: false,
    }),
    sl_price: Property.Number({
      displayName: 'Stop Loss Price',
      description: 'Price to trigger stop loss. Leave empty to use offset percentage.',
      required: false,
    }),
    tp_offset_percentage: Property.Number({
      displayName: 'TP Offset %',
      description: 'Take profit as % above/below mark price (e.g., 5 = 5% above for BUY, 5% below for SELL)',
      required: false,
    }),
    sl_offset_percentage: Property.Number({
      displayName: 'SL Offset %',
      description: 'Stop loss as % below/above mark price (e.g., 2 = 2% below for BUY, 2% above for SELL)',
      required: false,
    }),
    entry_price: Property.Number({
      displayName: 'Entry Price (BRACKET only)',
      description: 'Entry price for BRACKET orders',
      required: false,
    }),
    event_override: Property.Json({
      displayName: 'Event Override (optional)',
      description: 'Use only when testing without the TradingView trigger.',
      required: false,
    }),
  },

  async run(context) {
    if (!context.auth) {
      throw new Error('Authentication is required. Please connect your Orderly account.');
    }

    const logger = (context as unknown as { logger?: Console }).logger ?? console;
    const props = context.propsValue as CreateAlgoOrderProps;
    const auth = context.auth as PineautoAuthType;
    const environment = auth.environment ?? OrderlyEnvironment.TESTNET;

    const client = await createOrderlyClientFromAuth({
      accountId: auth.account_id,
      environment,
      secretKey: auth.secret_key,
    });

    // Determine parameters: props > event > error
    let symbol = props.symbol;
    let side = props.side;
    let quantity = props.quantity;
    let tpPrice = props.tp_price;
    let slPrice = props.sl_price;
    let tpOffsetPct = props.tp_offset_percentage;
    let slOffsetPct = props.sl_offset_percentage;

    // Try to get from TradingView event
    const overrideEvent =
      props.event_override && Object.keys(props.event_override as Record<string, unknown>).length > 0
        ? ensureTradingViewOrderEvent(props.event_override)
        : null;

    const event = overrideEvent ?? (await consumeQueuedTradingViewEvent(context));

    if (event) {
      if (!symbol && event.symbol) symbol = event.symbol;
      if (!side && event.side) side = event.side === 'buy' ? 'BUY' : 'SELL';
      if (quantity == null && 'qty' in event && event.qty != null) quantity = event.qty;
      if (tpPrice == null && 'tp_price' in event && event.tp_price != null) tpPrice = Number(event.tp_price);
      if (slPrice == null && 'sl_price' in event && event.sl_price != null) slPrice = Number(event.sl_price);
      if (tpOffsetPct == null && 'tp_offset_percentage' in event) tpOffsetPct = Number(event.tp_offset_percentage);
      if (slOffsetPct == null && 'sl_offset_percentage' in event) slOffsetPct = Number(event.sl_offset_percentage);
    }

    // Validate required fields
    if (!symbol) {
      throw new Error('❌ Symbol is required for algo order.');
    }

    if (!side) {
      throw new Error('❌ Side (BUY/SELL) is required for algo order.');
    }

    const algoType = props.algo_type as AlgoOrderType;
    const usePositional = props.use_positional || algoType === 'POSITIONAL_TP_SL';

    // For BRACKET orders, entry price is required
    if (algoType === 'BRACKET' && !props.entry_price) {
      throw new Error('❌ Entry price is required for BRACKET orders.');
    }

    // Calculate TP/SL prices from offset percentages if needed
    let finalTpPrice = tpPrice;
    let finalSlPrice = slPrice;

    if ((tpOffsetPct != null || slOffsetPct != null) && (finalTpPrice == null || finalSlPrice == null)) {
      logger.info?.(`[pineauto] Fetching mark price for ${symbol} to calculate offset prices...`);
      const markPrice = await getMarkPrice({ client, environment, symbol });

      if (!markPrice) {
        throw new Error(`❌ Failed to fetch mark price for ${symbol}. Cannot calculate offset prices.`);
      }

      logger.info?.(`[pineauto] Mark price: ${markPrice}`);

      if (tpOffsetPct != null && finalTpPrice == null) {
        // For BUY: TP is above mark price (+%)
        // For SELL: TP is below mark price (-%)
        const multiplier = side === 'BUY' ? (1 + tpOffsetPct / 100) : (1 - tpOffsetPct / 100);
        finalTpPrice = normalizeNumber(markPrice * multiplier, 2);
        logger.info?.(`[pineauto] Calculated TP price from ${tpOffsetPct}% offset: ${finalTpPrice}`);
      }

      if (slOffsetPct != null && finalSlPrice == null) {
        // For BUY: SL is below mark price (-%)
        // For SELL: SL is above mark price (+%)
        const multiplier = side === 'BUY' ? (1 - slOffsetPct / 100) : (1 + slOffsetPct / 100);
        finalSlPrice = normalizeNumber(markPrice * multiplier, 2);
        logger.info?.(`[pineauto] Calculated SL price from ${slOffsetPct}% offset: ${finalSlPrice}`);
      }
    }

    // Validate at least one TP or SL is provided
    if (!finalTpPrice && !finalSlPrice) {
      throw new Error('❌ At least one of Take Profit or Stop Loss must be provided (price or offset %).');
    }

    // Create algo order based on type
    logger.info?.(`[pineauto] Creating ${algoType} order for ${symbol}...`);

    let result;

    if (algoType === 'BRACKET') {
      if (!finalTpPrice || !finalSlPrice || !props.entry_price || !quantity) {
        throw new Error('❌ BRACKET orders require entry price, TP price, SL price, and quantity.');
      }

      result = await createBracketOrder({
        client,
        environment,
        symbol,
        side: side as OrderSide,
        entryPrice: props.entry_price,
        takeProfitPrice: finalTpPrice,
        stopLossPrice: finalSlPrice,
        quantity,
      });
    } else {
      result = await createTPSL({
        client,
        environment,
        symbol,
        side: side as OrderSide,
        takeProfitPrice: finalTpPrice,
        stopLossPrice: finalSlPrice,
        quantity,
        usePositional,
      });
    }

    if (!result) {
      throw new Error(
        `❌ Failed to create ${algoType} order. Check error logs for details. Common issues: invalid parameters, insufficient balance, or position not found (for POSITIONAL).`,
      );
    }

    logger.info?.('[pineauto] ✅ Algo order created successfully.');

    return {
      success: true,
      message: `✅ ${algoType} order created successfully for ${symbol}`,
      order_id: result.order_id,
      algo_type: result.algo_type,
      symbol: result.symbol,
      side: result.side,
      status: result.status,
      quantity: result.quantity ?? null,
      take_profit_price: finalTpPrice ?? null,
      stop_loss_price: finalSlPrice ?? null,
      entry_price: props.entry_price ?? null,
      tp_offset_percentage: tpOffsetPct ?? null,
      sl_offset_percentage: slOffsetPct ?? null,
      is_positional: usePositional,
      child_orders: result.child_orders ?? [],
      timestamp: new Date().toISOString(),
      raw_response: result,
    };
  },
});
