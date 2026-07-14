import { FakeWallet } from "./fake-wallet.js";
import { LnbitsWallet } from "./lnbits-wallet.js";
import { SparkWallet } from "./spark-wallet.js";
import type { RevenueWallet } from "./wallet.js";

type WalletConfig = {
  backend: string;
  nodeEnv: string;
  allowFakeInProduction?: boolean;
  lnbitsEndpoint?: string;
  lnbitsInvoiceKey?: string;
  lnbitsAdminKey?: string;
  lnbitsWebhookUrl?: string;
  spark?: {
    mnemonic?: string;
    network?: string;
    accountNumber?: number;
    maxFeeSats?: number;
  };
};

export function createWalletFromConfig(input: WalletConfig): RevenueWallet {
  if (input.backend === "spark") {
    const network = String(input.spark?.network || "MAINNET").trim().toUpperCase();
    if (network !== "MAINNET" && network !== "REGTEST" && network !== "SIGNET" && network !== "TESTNET") {
      throw new Error(`unsupported Spark network: ${network}`);
    }
    return new SparkWallet({
      mnemonic: input.spark?.mnemonic || "",
      network,
      accountNumber: input.spark?.accountNumber ?? (network === "REGTEST" ? 0 : 1),
      maxFeeSats: input.spark?.maxFeeSats ?? 5,
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
