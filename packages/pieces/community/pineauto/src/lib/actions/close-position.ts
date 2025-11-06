import { createAction, Property } from '@activepieces/pieces-framework';
import { PineautoAuthType } from '../common/orderly-auth';
import { createOrderlyClientFromAuth, buildOrderlyUrl } from '../common/orderly-http';
import { OrderlyEnvironment } from '../common/orderly-config';
import {
  getPosition,
  calculateCloseQuantity,
  getCloseSide,
  CloseMode,
  Position,
} from '../common/orderly-position.service';
import { normalizeNumber } from '../common/order-sizing.service';
import {
  consumeQueuedTradingViewEvent,
  ensureTradingViewOrderEvent,
} from '../common/tradingview-event.service';

interface ClosePositionProps {
  symbol?: string;
  close_mode: string;
  quantity?: number;
  percentage?: number;
  use_market: boolean;
  price?: number;
  event_override?: unknown;
}

export const closePosition = createAction({
  name: 'close_position',
  displayName: 'Close Position',
  description: 'Close all or part of an open position on Orderly Network',
  props: {
    symbol: Property.ShortText({
      displayName: 'Symbol (Optional)',
      description: 'Trading pair (e.g., PERP_BTC_USDC). Leave empty to use symbol from TradingView event.',
      required: false,
    }),
    close_mode: Property.StaticDropdown({
      displayName: 'Close Mode',
      description: 'How much of the position to close',
      required: true,
      defaultValue: 'FULL',
      options: {
        options: [
          { label: 'Full Position', value: 'FULL' },
          { label: 'Partial (Fixed Quantity)', value: 'PARTIAL' },
          { label: 'Partial (Percentage)', value: 'PERCENT' },
        ],
      },
    }),
    quantity: Property.Number({
      displayName: 'Quantity',
      description: 'Quantity to close (for PARTIAL mode)',
      required: false,
    }),
    percentage: Property.Number({
      displayName: 'Percentage',
      description: 'Percentage of position to close, 0-100 (for PERCENT mode)',
      required: false,
    }),
    use_market: Property.Checkbox({
      displayName: 'Use Market Order',
      description: 'Use MARKET order (immediate execution). If unchecked, uses LIMIT order.',
      required: false,
      defaultValue: true,
    }),
    price: Property.Number({
      displayName: 'Limit Price',
      description: 'Price for LIMIT order (only if Use Market Order is unchecked)',
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
    const props = context.propsValue as ClosePositionProps;
    const auth = context.auth as PineautoAuthType;
    const environment = auth.environment ?? OrderlyEnvironment.TESTNET;

    const client = await createOrderlyClientFromAuth({
      accountId: auth.account_id,
      environment,
      secretKey: auth.secret_key,
    });

    // Determine symbol: props override > event > error
    let symbol = props.symbol;

    if (!symbol) {
      // Try to get symbol from TradingView event
      const overrideEvent =
        props.event_override && Object.keys(props.event_override as Record<string, unknown>).length > 0
          ? ensureTradingViewOrderEvent(props.event_override)
          : null;

      // Consume from 'close_position' queue specifically for action-based routing
      const event = overrideEvent ?? (await consumeQueuedTradingViewEvent(context, 'close_position'));

      if (event?.symbol) {
        symbol = event.symbol;
        logger.info?.('[pineauto] Symbol from close_position event', { symbol });
      }
    }

    if (!symbol) {
      throw new Error(
        '❌ No symbol provided and no close_position event found in queue.\n\n' +
          'Expected action field: "close_position", "exit_long", or "exit_short"\n' +
          'Either provide symbol in action props or ensure TradingView webhook sends correct action field.',
      );
    }

    logger.info?.('[pineauto] Processing close position', { symbol });

    // Fetch current position
    logger.info?.(`[pineauto] Fetching position for ${symbol}...`);
    const position = await getPosition({ client, environment, symbol });

    if (!position) {
      return {
        success: false,
        message: `ℹ️ No open position found for ${symbol}`,
        symbol,
        position_found: false,
      };
    }

    if (position.position_qty === 0) {
      return {
        success: false,
        message: `ℹ️ Position for ${symbol} is already closed (quantity: 0)`,
        symbol,
        position_found: true,
        position_qty: 0,
      };
    }

    // Calculate close quantity
    const closeMode = props.close_mode as CloseMode;
    const closeQty = calculateCloseQuantity({
      position,
      closeMode,
      quantity: props.quantity,
      percentage: props.percentage,
    });

    if (closeQty == null || closeQty <= 0) {
      throw new Error('❌ Invalid close quantity. Check your close mode and parameters.');
    }

    // Determine side (opposite of position)
    const side = getCloseSide(position);
    const orderType = props.use_market ? 'MARKET' : 'LIMIT';

    // Build order payload
    const orderPayload: Record<string, unknown> = {
      symbol,
      side,
      order_type: orderType,
      type: orderType,
      order_quantity: normalizeNumber(closeQty, 6),
      quantity: normalizeNumber(closeQty, 6),
      reduce_only: true, // Always use reduce_only for closing positions
    };

    if (!props.use_market && props.price) {
      orderPayload['order_price'] = props.price;
      orderPayload['price'] = props.price;
    } else if (!props.use_market) {
      // Use mark price as default for LIMIT orders
      orderPayload['order_price'] = position.mark_price;
      orderPayload['price'] = position.mark_price;
    }

    logger.info?.('[pineauto] Closing position...', {
      symbol,
      closeMode,
      closeQty,
      side,
      orderType,
    });

    // Send close order
    try {
      const response = await client.post(buildOrderlyUrl(environment, '/v1/order'), {
        body: JSON.stringify(orderPayload),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let errorMessage = 'Close position request failed';

        if (response.status === 400) {
          errorMessage = 'Invalid order parameters for closing position';
        } else if (response.status === 401) {
          errorMessage = 'Authentication failed. Please verify your Orderly credentials.';
        } else if (response.status === 403) {
          errorMessage = 'Account lacks permission or is not activated.';
        } else if (response.status === 429) {
          errorMessage = 'Rate limit exceeded. Please wait and try again.';
        }

        logger.error?.(`[pineauto] ❌ ${errorMessage}`, {
          status: response.status,
          body: errorBody,
        });

        throw new Error(`❌ ${errorMessage}`);
      }

      const result = (await response.json()) as { data?: Record<string, unknown>; [key: string]: unknown };
      const orderData = (result.data ?? result) as Record<string, unknown>;
      const orderId = orderData['order_id'] ?? result['order_id'] ?? null;
      const orderStatus = orderData['order_status'] ?? result['order_status'] ?? 'PENDING';

      // Calculate estimated PnL
      const estimatedPnL = position.position_qty > 0
        ? closeQty * (position.mark_price - position.average_open_price)
        : closeQty * (position.average_open_price - position.mark_price);

      logger.info?.('[pineauto] ✅ Position close order created.', { orderId, orderStatus });

      return {
        success: true,
        message: `✅ ${closeMode === 'FULL' ? 'Full' : 'Partial'} position close order created for ${symbol}`,
        order_id: orderId,
        status: orderStatus,
        symbol,
        side,
        close_mode: closeMode,
        close_quantity: normalizeNumber(closeQty, 6),
        original_position_qty: position.position_qty,
        position_side: position.position_qty > 0 ? 'LONG' : 'SHORT',
        average_entry_price: position.average_open_price,
        mark_price: position.mark_price,
        estimated_pnl: normalizeNumber(estimatedPnL, 2),
        timestamp: new Date().toISOString(),
        raw_response: orderData,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error?.('[pineauto] ❌ Failed to close position', { error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  },
});
