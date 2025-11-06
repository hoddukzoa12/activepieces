import { createPiece } from "@activepieces/pieces-framework";
import { createOrder } from './lib/actions/create-order';
import { closePosition } from './lib/actions/close-position';
import { setLeverageAction } from './lib/actions/set-leverage';
import { createAlgoOrderAction } from './lib/actions/create-algo-order';
import { tradingviewwebhook } from "./lib/triggers/tradingviewwebhook";
import { pineautoAuth, PineautoAuthType } from "./lib/common/orderly-auth";

export { pineautoAuth, PineautoAuthType };

export const pineauto = createPiece({
  displayName: "Pineauto",
  auth: pineautoAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: "https://logo.pineauto.app/Pavicon.png",
  authors: ["hoddukzoa"],
  actions: [
    createOrder,
    closePosition,
    setLeverageAction,
    createAlgoOrderAction,
  ],
  triggers: [tradingviewwebhook],
});
