export type WalletInvoice = {
  paymentHash: string;
  invoice: string;
  amountMsat: number;
  status: "pending" | "settled" | "expired";
  settledAt?: number;
};

export type WalletPayment = {
  paymentId: string;
  status: "pending" | "succeeded" | "failed" | "unknown";
  amountMsat: number;
  feeMsat?: number;
  failureReason?: string;
};

export interface RevenueWallet {
  readonly backend: string;
  createInvoice(input: { amountMsat: number; descriptionHash: string }): Promise<WalletInvoice>;
  lookupInvoice(paymentHash: string): Promise<Omit<WalletInvoice, "invoice">>;
  estimateFeeMsat(invoice: string): Promise<number>;
  payInvoice(input: {
    invoice: string;
    idempotencyKey: string;
    amountMsat: number;
  }): Promise<WalletPayment>;
  lookupPayment(paymentId: string): Promise<WalletPayment>;
}
