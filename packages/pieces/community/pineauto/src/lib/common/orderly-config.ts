export enum OrderlyEnvironment {
  MAINNET = 'mainnet',
  TESTNET = 'testnet',
}

export const ORDERLY_ENDPOINTS: Record<OrderlyEnvironment, string> = {
  [OrderlyEnvironment.MAINNET]: 'https://api.orderly.org',
  [OrderlyEnvironment.TESTNET]: 'https://testnet-api.orderly.org',
};

export function resolveOrderlyBaseUrl(environment: OrderlyEnvironment): string {
  return ORDERLY_ENDPOINTS[environment] ?? ORDERLY_ENDPOINTS[OrderlyEnvironment.TESTNET];
}
