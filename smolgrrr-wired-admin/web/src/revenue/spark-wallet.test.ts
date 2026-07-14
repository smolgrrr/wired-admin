import assert from "node:assert/strict";
import test from "node:test";
import type {
  CreateLightningInvoiceParams,
  PayLightningInvoiceParams,
} from "@buildonspark/spark-sdk";
import {
  BitcoinNetwork,
  CurrencyUnit,
  LightningReceiveRequestStatus,
  LightningSendRequestStatus,
  SparkUserRequestType,
} from "@buildonspark/spark-sdk/types";
import { SparkWallet } from "./spark-wallet.js";

test("Spark adapter creates description-hash invoices and recovers idempotent payments after restart", async () => {
  const createInvoiceInputs: unknown[] = [];
  const payInputs: unknown[] = [];
  let paymentSent = false;
  const receiveRequest = {
    id: "spark-receive-1",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    network: BitcoinNetwork.MAINNET,
    typename: "LightningReceiveRequest",
    status: LightningReceiveRequestStatus.INVOICE_CREATED,
    invoice: {
      encodedInvoice: "lnbc21incoming",
      bitcoinNetwork: BitcoinNetwork.MAINNET,
      paymentHash: "ab".repeat(32),
      amount: { originalValue: 21, originalUnit: CurrencyUnit.SATOSHI },
      createdAt: "2026-07-14T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  const sendRequest = {
    id: "spark-send-1",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    network: BitcoinNetwork.MAINNET,
    typename: "LightningSendRequest",
    status: LightningSendRequestStatus.TRANSFER_COMPLETED,
    encodedInvoice: "lnbc14creator",
    idempotencyKey: "payout-1",
    fee: { originalValue: 1, originalUnit: CurrencyUnit.SATOSHI },
  };
  const client = {
    createLightningInvoice: async (input: CreateLightningInvoiceParams) => {
      createInvoiceInputs.push(input);
      return receiveRequest;
    },
    getLightningReceiveRequest: async (id: string) => id === receiveRequest.id
      ? { ...receiveRequest, status: LightningReceiveRequestStatus.TRANSFER_COMPLETED }
      : null,
    getLightningSendFeeEstimate: async () => 1,
    payLightningInvoice: async (input: PayLightningInvoiceParams) => {
      payInputs.push(input);
      paymentSent = true;
      return sendRequest;
    },
    getLightningSendRequest: async (id: string) => id === sendRequest.id ? sendRequest : null,
    getUserRequests: async (input: { types: SparkUserRequestType[] }) => ({
      entities: input.types.includes(SparkUserRequestType.LIGHTNING_SEND)
        ? (paymentSent ? [sendRequest] : [])
        : [receiveRequest],
      count: 1,
      pageInfo: { hasNextPage: false },
      typename: "SparkWalletUserToUserRequestsConnection",
    }),
  };
  const createWallet = () => new SparkWallet({
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    clientFactory: async () => client,
  });
  const wallet = createWallet();

  const invoice = await wallet.createInvoice({
    amountMsat: 21_000,
    descriptionHash: "cd".repeat(32),
    idempotencyKey: "zap-1",
  });
  assert.deepEqual(createInvoiceInputs, [{
    amountSats: 21,
    descriptionHash: "cd".repeat(32),
    includeSparkAddress: false,
    includeSparkInvoice: false,
  }]);
  assert.deepEqual(invoice, {
    paymentHash: "ab".repeat(32),
    invoice: "lnbc21incoming",
    amountMsat: 21_000,
    status: "pending",
  });
  assert.equal((await wallet.lookupInvoice(invoice.paymentHash)).status, "settled");
  assert.equal(await wallet.estimateFeeMsat("lnbc14creator"), 1_000);

  const payment = await wallet.payInvoice({
    invoice: "lnbc14creator",
    idempotencyKey: "payout-1",
    amountMsat: 14_000,
  });
  assert.deepEqual(payInputs, [{
    invoice: "lnbc14creator",
    maxFeeSats: 5,
    preferSpark: false,
    idempotencyKey: "payout-1",
  }]);
  assert.deepEqual(payment, {
    paymentId: "spark-send-1",
    status: "succeeded",
    amountMsat: 14_000,
    feeMsat: 1_000,
  });

  const restartedWallet = createWallet();
  assert.deepEqual(await restartedWallet.lookupPayment({
    paymentId: "payout-1",
    expectedAmountMsat: 14_000,
    invoice: "lnbc14creator",
  }), payment);
});

test("Spark adapter reports a provider-confirmed missing payment without sending it", async () => {
  let paymentAttempts = 0;
  const wallet = new SparkWallet({
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    clientFactory: async () => ({
      createLightningInvoice: async () => { throw new Error("unused"); },
      getLightningReceiveRequest: async () => null,
      getLightningSendFeeEstimate: async () => 1,
      payLightningInvoice: async () => {
        paymentAttempts += 1;
        throw new Error("must not send during lookup");
      },
      getLightningSendRequest: async () => null,
      getUserRequests: async () => ({
        entities: [],
        count: 0,
        pageInfo: { hasNextPage: false },
        typename: "SparkWalletUserToUserRequestsConnection",
      }),
    }),
  });

  assert.deepEqual(await wallet.lookupPayment({
    paymentId: "payout-missing",
    expectedAmountMsat: 14_000,
    invoice: "lnbc14creator",
  }), {
    paymentId: "payout-missing",
    status: "not_found",
    amountMsat: 14_000,
  });
  assert.equal(paymentAttempts, 0);
});

test("Spark adapter waits for transfer completion before finalizing the routing fee", async () => {
  const baseRequest = {
    id: "spark-send-final-fee",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    network: BitcoinNetwork.MAINNET,
    typename: "LightningSendRequest",
    encodedInvoice: "lnbc14creator",
    idempotencyKey: "payout-final-fee",
  };
  const intermediate = {
    ...baseRequest,
    status: LightningSendRequestStatus.LIGHTNING_PAYMENT_SUCCEEDED,
    fee: { originalValue: 0, originalUnit: CurrencyUnit.MILLISATOSHI },
  };
  const completed = {
    ...baseRequest,
    status: LightningSendRequestStatus.TRANSFER_COMPLETED,
    fee: { originalValue: 2_000, originalUnit: CurrencyUnit.MILLISATOSHI },
  };
  let sent = false;
  const wallet = new SparkWallet({
    mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    clientFactory: async () => ({
      createLightningInvoice: async () => { throw new Error("unused"); },
      getLightningReceiveRequest: async () => null,
      getLightningSendFeeEstimate: async () => 2,
      payLightningInvoice: async () => {
        sent = true;
        return intermediate;
      },
      getLightningSendRequest: async (id) => sent && id === completed.id ? completed : null,
      getUserRequests: async () => ({
        entities: [],
        count: 0,
        pageInfo: { hasNextPage: false },
        typename: "SparkWalletUserToUserRequestsConnection",
      }),
    }),
  });

  assert.deepEqual(await wallet.payInvoice({
    invoice: "lnbc14creator",
    idempotencyKey: "payout-final-fee",
    amountMsat: 14_000,
  }), {
    paymentId: "spark-send-final-fee",
    status: "pending",
    amountMsat: 14_000,
    feeMsat: 0,
  });
  assert.deepEqual(await wallet.lookupPayment({
    paymentId: "spark-send-final-fee",
    expectedAmountMsat: 14_000,
    invoice: "lnbc14creator",
  }), {
    paymentId: "spark-send-final-fee",
    status: "succeeded",
    amountMsat: 14_000,
    feeMsat: 2_000,
  });
});
