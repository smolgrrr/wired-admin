import { BlinkWallet } from "./blink-wallet.js";
import { FakeWallet } from "./fake-wallet.js";
import { LnbitsWallet } from "./lnbits-wallet.js";
import type { RevenueWallet } from "./wallet.js";

type WalletConfig = {
  backend: string;
  nodeEnv: string;
  allowFakeInProduction?: boolean;
  lnbitsEndpoint?: string;
  lnbitsInvoiceKey?: string;
  lnbitsAdminKey?: string;
  lnbitsWebhookUrl?: string;
  blink?: {
    endpoint?: string;
    apiKey?: string;
    walletId?: string;
    accountId?: string;
  };
};

export function createWalletFromConfig(input: WalletConfig): RevenueWallet {
  if (input.backend === "blink") {
    return new BlinkWallet({
      endpoint: input.blink?.endpoint || "https://api.blink.sv/graphql",
      apiKey: input.blink?.apiKey || "",
      walletId: input.blink?.walletId || "",
      ...(input.blink?.accountId ? { accountId: input.blink.accountId } : {}),
    });
  }
  if (input.backend === "lnbits") {
    return new LnbitsWallet({
      endpoint: input.lnbitsEndpoint || "",
      invoiceKey: input.lnbitsInvoiceKey || "",
      adminKey: input.lnbitsAdminKey || "",
      ...(input.lnbitsWebhookUrl ? { webhookUrl: input.lnbitsWebhookUrl } : {}),
    });
  }
  if (input.backend === "fake") {
    if (input.nodeEnv === "production" && !input.allowFakeInProduction) {
      throw new Error("FakeWallet is disabled in production; configure a managed wallet backend");
    }
    return new FakeWallet();
  }
  throw new Error(`unsupported revenue wallet backend: ${input.backend}`);
}
