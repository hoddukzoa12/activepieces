import { PieceAuth, Property } from '@activepieces/pieces-framework';
import { OrderlyEnvironment, resolveOrderlyBaseUrl } from './orderly-config';
import { createOrderlyClientFromAuth } from './orderly-http';

export type PineautoAuthType = {
  environment: OrderlyEnvironment;
  account_id: string;
  public_key: string;
  secret_key: string;
};

export const pineautoAuth = PieceAuth.CustomAuth({
  description: 'Enter your PineAuto API credentials for Orderly Network.',
  props: {
    environment: Property.StaticDropdown({
      displayName: 'Environment',
      description: 'Select Orderly Network environment.',
      required: true,
      defaultValue: OrderlyEnvironment.TESTNET,
      options: {
        options: [
          { label: 'Mainnet', value: OrderlyEnvironment.MAINNET },
          { label: 'Testnet', value: OrderlyEnvironment.TESTNET },
        ],
      },
    }),
    account_id: Property.ShortText({
      displayName: 'Account ID',
      description: 'Your Orderly account ID (e.g., 0x1234...).',
      required: true,
    }),
    public_key: PieceAuth.SecretText({
      displayName: 'Public Key',
      description: 'Your Orderly public key.',
      required: true,
    }),
    secret_key: PieceAuth.SecretText({
      displayName: 'Secret Key',
      description: 'Your Orderly secret key (Base58 encoded).',
      required: true,
    }),
  },
  validate: async ({ auth }) => {
    try {
      const typedAuth = auth as PineautoAuthType;
      const client = await createOrderlyClientFromAuth({
        accountId: typedAuth.account_id,
        environment: typedAuth.environment,
        secretKey: typedAuth.secret_key,
      });
      const baseUrl = resolveOrderlyBaseUrl(typedAuth.environment);

      const response = await client.get(new URL('/v1/client/info', baseUrl));
      if (response.ok) {
        return { valid: true };
      }

      const errorBody = await response.text();
      return {
        valid: false,
        error: `Authentication failed: ${errorBody}`,
      };
    } catch (error) {
      return {
        valid: false,
        error: `Invalid credentials: ${error}`,
      };
    }
  },
  required: true,
});
