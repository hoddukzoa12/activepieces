import { createAction, Property } from '@activepieces/pieces-framework';
import { PineautoAuthType } from '../common/orderly-auth';
import { createOrderlyClientFromAuth } from '../common/orderly-http';
import { OrderlyEnvironment } from '../common/orderly-config';
import {
  getLeverage,
  setLeverage,
  validateLeverage,
  LEVERAGE_CONSTRAINTS,
} from '../common/orderly-leverage.service';
import {
  consumeQueuedTradingViewEvent,
  ensureTradingViewOrderEvent,
} from '../common/tradingview-event.service';

interface SetLeverageProps {
  symbol?: string;
  leverage?: number;
  validate_current: boolean;
  event_override?: unknown;
}

export const setLeverageAction = createAction({
  name: 'set_leverage',
  displayName: 'Set Leverage',
  description: 'Update leverage setting for a symbol on Orderly Network',
  props: {
    symbol: Property.ShortText({
      displayName: 'Symbol (Optional)',
      description: 'Trading pair (e.g., PERP_BTC_USDC). Leave empty to use symbol from TradingView event.',
      required: false,
    }),
    leverage: Property.Number({
      displayName: 'Leverage (Optional)',
      description: `Leverage value (${LEVERAGE_CONSTRAINTS.MIN}-${LEVERAGE_CONSTRAINTS.MAX}x). Leave empty to use from TradingView event.`,
      required: false,
    }),
    validate_current: Property.Checkbox({
      displayName: 'Fetch Current Leverage',
      description: 'Retrieve and display current leverage setting before updating',
      required: false,
      defaultValue: true,
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
    const props = context.propsValue as SetLeverageProps;
    const auth = context.auth as PineautoAuthType;
    const environment = auth.environment ?? OrderlyEnvironment.TESTNET;

    const client = await createOrderlyClientFromAuth({
      accountId: auth.account_id,
      environment,
      secretKey: auth.secret_key,
    });

    // Determine symbol and leverage: props > event > error
    let symbol = props.symbol;
    let leverage = props.leverage;

    if (!symbol || leverage == null) {
      // Try to get from TradingView event
      const overrideEvent =
        props.event_override && Object.keys(props.event_override as Record<string, unknown>).length > 0
          ? ensureTradingViewOrderEvent(props.event_override)
          : null;

      const event = overrideEvent ?? (await consumeQueuedTradingViewEvent(context));

      if (event) {
        if (!symbol && event.symbol) {
          symbol = event.symbol;
        }
        if (leverage == null && 'leverage' in event) {
          leverage = Number(event.leverage);
        }
      }
    }

    if (!symbol) {
      throw new Error(
        '❌ Symbol is required. Either provide it in the action props or trigger from TradingView webhook with symbol.',
      );
    }

    if (leverage == null || !Number.isFinite(leverage)) {
      throw new Error(
        '❌ Leverage is required. Either provide it in the action props or trigger from TradingView webhook with leverage field.',
      );
    }

    // Validate leverage value
    const validation = validateLeverage(leverage);
    if (!validation.valid) {
      throw new Error(`❌ Invalid leverage: ${validation.error}`);
    }

    // Optionally fetch current leverage
    let currentLeverage: number | null = null;
    if (props.validate_current) {
      logger.info?.(`[pineauto] Fetching current leverage for ${symbol}...`);
      const currentSetting = await getLeverage({ client, environment, symbol });

      if (currentSetting) {
        currentLeverage = currentSetting.leverage ?? currentSetting.current_leverage ?? null;
        logger.info?.(`[pineauto] Current leverage: ${currentLeverage}x`);

        if (currentLeverage === leverage) {
          return {
            success: true,
            message: `ℹ️ Leverage for ${symbol} is already set to ${leverage}x (no change needed)`,
            symbol,
            current_leverage: currentLeverage,
            requested_leverage: leverage,
            changed: false,
          };
        }
      }
    }

    // Set new leverage
    logger.info?.(`[pineauto] Setting leverage for ${symbol} to ${leverage}x...`);
    const result = await setLeverage({ client, environment, symbol, leverage });

    if (!result) {
      throw new Error(
        `❌ Failed to set leverage for ${symbol}. Check error logs for details. Common issues: insufficient margin, position too large for requested leverage, or rate limit exceeded.`,
      );
    }

    const newLeverage = result.leverage ?? result.current_leverage ?? leverage;

    logger.info?.('[pineauto] ✅ Leverage updated successfully.');

    return {
      success: true,
      message: `✅ Leverage for ${symbol} updated to ${newLeverage}x`,
      symbol,
      previous_leverage: currentLeverage,
      new_leverage: newLeverage,
      requested_leverage: leverage,
      changed: currentLeverage !== newLeverage,
      max_leverage: result.max_leverage ?? null,
      timestamp: new Date().toISOString(),
      raw_response: result,
    };
  },
});
