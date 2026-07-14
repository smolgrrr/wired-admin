import assert from "node:assert/strict";
import test from "node:test";
import { FakeWallet } from "./fake-wallet.js";
import { createWalletFromConfig } from "./wallet-factory.js";

test("FakeWallet exposes deterministic invoice settlement and outgoing payment behavior", async () => {
  const wallet = new FakeWallet();
  const invoice = await wallet.createInvoice({
    amountMsat: 42_000,
    descriptionHash: "ab".repeat(32),
    idempotencyKey: "zap:1",
  });

  assert.equal((await wallet.lookupInvoice(invoice.paymentHash)).status, "pending");
  await wallet.settleInvoice(invoice.paymentHash);
  assert.deepEqual(await wallet.lookupInvoice(invoice.paymentHash), {
    paymentHash: invoice.paymentHash,
    amountMsat: 42_000,
    status: "settled",
    settledAt: 1,
  });

  const payment = await wallet.payInvoice({
    invoice: "fake-invoice:creator:20000",
    idempotencyKey: "payout:1",
    amountMsat: 20_000,
  });
  assert.deepEqual(payment, {
    paymentId: "fake-payment:payout:1",
    status: "succeeded",
    amountMsat: 20_000,
    feeMsat: 0,
  });
  assert.deepEqual(await wallet.payInvoice({
    invoice: "fake-invoice:creator:20000",
    idempotencyKey: "payout:1",
    amountMsat: 20_000,
  }), payment);
});

test("FakeWallet cannot be configured in production", () => {
  assert.throws(
    () => createWalletFromConfig({ backend: "fake", nodeEnv: "production" }),
    /FakeWallet is disabled in production/,
  );
});

test("Spark can be selected as the managed revenue wallet", () => {
  const wallet = createWalletFromConfig({
    backend: "spark",
    nodeEnv: "production",
    spark: {
      mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      network: "MAINNET",
      accountNumber: 0,
      maxFeeSats: 5,
    },
  });

  assert.equal(wallet.backend, "spark");
});
