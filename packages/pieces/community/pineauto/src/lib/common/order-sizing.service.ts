import { OrderlyEnvironment } from './orderly-config';
import { OrderlyHttpClient } from './orderly-http';
import {
  extractAvailableBalance,
  extractAvailableBalanceFromBalances,
  extractBalanceFromHoldings,
  fetchAccountBalances,
  fetchAccountInfo,
  fetchClientHolding,
} from './orderly-account.service';
import { fetchReferencePrice } from './orderly-price.service';
import { TradingViewOrderEvent } from './tradingview.types';

export interface OrderSizingResult {
  quantity: number;
  referencePrice?: number;
  availableBalance?: number;
  quoteAsset?: string | null;
  notional?: number;
  fallbackQuantity?: number;
  leverageApplied: number;
}

export async function resolveOrderSizing(params: {
  environment: OrderlyEnvironment;
  client: OrderlyHttpClient;
  event: TradingViewOrderEvent;
  quoteAsset: string | null;
}): Promise<OrderSizingResult> {
  const { environment, client, event, quoteAsset } = params;
  const leverageApplied = Math.max(1, Number(event.leverage) || 1);

  if (event.qtyMode === 'fixed') {
    const adjustedQty = applyQuantityStep(event.qty, determineFlexibleQuantityStep(event.qty));
    const fallbackQuantity = applyQuantityStep(event.qty, determineStrictQuantityStep(event.qty) ?? event.qty);
    const notional = adjustedQty * leverageApplied;

    return {
      quantity: adjustedQty,
      referencePrice: undefined,
      quoteAsset,
      fallbackQuantity,
      leverageApplied,
      notional,
    };
  }

  const referencePrice = await fetchReferencePrice({
    environment,
    symbol: event.symbol,
  });

  const accountInfo = await fetchAccountInfo({ client, environment });
  let availableBalance = extractAvailableBalance(accountInfo, quoteAsset);

  if (availableBalance == null) {
    const balances = await fetchAccountBalances({ client, environment });
    availableBalance = extractAvailableBalanceFromBalances(balances, quoteAsset);
  }

  if (availableBalance == null) {
    const holdings = await fetchClientHolding({ client, environment });
    availableBalance = extractBalanceFromHoldings(holdings, quoteAsset);
  }

  if (availableBalance == null || availableBalance <= 0) {
    throw new Error('Unable to determine available collateral from account info or balance endpoints.');
  }

  const notional = availableBalance * (event.qty / 100) * leverageApplied;
  if (!Number.isFinite(notional) || notional <= 0) {
    throw new Error('Calculated notional value is invalid. Check balance percent and leverage settings.');
  }

  const rawQuantity = notional / referencePrice;
  const flexibleStep = determineFlexibleQuantityStep(undefined);
  const strictStep = determineStrictQuantityStep(undefined);
  const quantity = applyQuantityStep(rawQuantity, flexibleStep);
  const fallbackQuantity = strictStep ? applyQuantityStep(rawQuantity, strictStep) : undefined;

  return {
    quantity,
    referencePrice,
    availableBalance,
    quoteAsset,
    notional,
    fallbackQuantity,
    leverageApplied,
  };
}

export function determineFlexibleQuantityStep(referenceQuantity?: number): number {
  const strictStep = determineStrictQuantityStep(referenceQuantity);
  if (!strictStep) {
    return 0.001;
  }

  if (strictStep >= 1) {
    return strictStep;
  }

  return Math.min(strictStep, 0.001);
}

export function determineStrictQuantityStep(referenceQuantity?: number): number | null {
  if (!referenceQuantity || referenceQuantity === 0) {
    return null;
  }

  const qtyString = referenceQuantity.toString();
  if (qtyString.includes('e')) {
    return null;
  }

  const decimals = qtyString.split('.')[1]?.length ?? 0;
  return decimals > 0 ? Math.pow(10, -decimals) : 1;
}

export function applyQuantityStep(quantity: number, step: number): number {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return quantity;
  }

  if (!step || step <= 0) {
    return quantity;
  }

  const multiplier = Math.floor(quantity / step);
  const adjusted = multiplier * step;

  const decimals = step >= 1 ? 0 : Math.min(8, Math.abs(Math.log10(step)));
  if (adjusted > 0) {
    return Number(adjusted.toFixed(decimals));
  }

  return Number(step.toFixed(decimals));
}

export function parseQuoteAsset(symbol: string): string | null {
  if (!symbol || typeof symbol !== 'string') {
    return null;
  }

  const parts = symbol.split('_');
  if (parts.length >= 3) {
    return parts[parts.length - 1];
  }

  return null;
}

export function normalizeNumber(value: number, dp: number): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}
