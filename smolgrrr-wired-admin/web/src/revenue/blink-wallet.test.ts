import assert from "node:assert/strict";
import test from "node:test";
import { BlinkWallet } from "./blink-wallet.js";

type GraphqlRequest = {
  operationName?: string;
  query: string;
  variables: Record<string, unknown>;
};

test("Blink adapter creates exact description-hash invoices and recovers outgoing payments by BOLT11", async () => {
  const requests: Array<{ body: GraphqlRequest; headers: Headers }> = [];
  let invoiceCreated = false;
  let paymentSent = false;
  const fakeFetch: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as GraphqlRequest;
    requests.push({ body, headers: new Headers(init?.headers) });

    if (body.operationName === "FindBlinkInvoiceByExternalId") {
      return Response.json({
        data: {
          me: {
            defaultAccount: {
              id: "account-id",
              wallets: [{
                id: "wallet-id",
                invoices: {
                  edges: invoiceCreated ? [{
                    cursor: "invoice-cursor",
                    node: {
                      externalId: "zap-1",
                      paymentHash: "ab".repeat(32),
                      paymentRequest: "lnbc21incoming",
                      paymentStatus: "PENDING",
                      satoshis: 21,
                    },
                  }] : [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              }],
            },
          },
        },
      });
    }
    if (body.operationName === "CreateBlinkInvoice") {
      invoiceCreated = true;
      return Response.json({
        data: {
          lnInvoiceCreateOnBehalfOfRecipient: {
            invoice: {
              externalId: "zap-1",
              paymentHash: "ab".repeat(32),
              paymentRequest: "lnbc21incoming",
              paymentStatus: "PENDING",
              satoshis: 21,
            },
            errors: [],
          },
        },
      });
    }
    if (body.operationName === "LookupBlinkInvoice") {
      return Response.json({
        data: {
          me: {
            defaultAccount: {
              id: "account-id",
              wallets: [{
                id: "wallet-id",
                invoiceByPaymentHash: {
                  paymentHash: "ab".repeat(32),
                  paymentStatus: "PAID",
                  satoshis: 21,
                },
              }],
            },
          },
        },
      });
    }
    if (body.operationName === "ProbeBlinkFee") {
      return Response.json({ data: { lnInvoiceFeeProbe: { amount: 2, errors: [] } } });
    }
    if (body.operationName === "SendBlinkPayment") {
      paymentSent = true;
      return Response.json({
        data: {
          lnInvoicePaymentSend: {
            status: "SUCCESS",
            transaction: {
              id: "blink-transaction-id",
              direction: "SEND",
              settlementAmount: -21,
              settlementFee: -2,
              status: "SUCCESS",
            },
            errors: [],
          },
        },
      });
    }
    if (body.operationName === "LookupBlinkPayment") {
      return Response.json({
        data: {
          me: {
            defaultAccount: {
              id: "account-id",
              wallets: [{
                id: "wallet-id",
                transactionsByPaymentRequest: paymentSent ? [
                  {
                    id: "failed-attempt",
                    direction: "SEND",
                    settlementAmount: -21,
                    settlementFee: 0,
                    status: "FAILURE",
                  },
                  {
                    id: "blink-transaction-id",
                    direction: "SEND",
                    settlementAmount: -21,
                    settlementFee: -2,
                    status: "SUCCESS",
                  },
                ] : [],
              }],
            },
          },
        },
      });
    }
    return Response.json({ errors: [{ message: `unexpected operation ${body.operationName}` }] });
  };
  const wallet = new BlinkWallet({
    endpoint: "https://api.blink.example/graphql",
    apiKey: "blink-secret",
    walletId: "wallet-id",
    accountId: "account-id",
    fetchImplementation: fakeFetch,
  });

  const invoice = await wallet.createInvoice({
    amountMsat: 21_000,
    descriptionHash: "cd".repeat(32),
    idempotencyKey: "zap-1",
  });
  assert.equal(invoice.invoice, "lnbc21incoming");
  assert.deepEqual(
    requests.find(({ body }) => body.operationName === "CreateBlinkInvoice")?.body.variables,
    {
      input: {
        recipientWalletId: "wallet-id",
        amount: 21,
        descriptionHash: "cd".repeat(32),
        externalId: "zap-1",
      },
    },
  );
  assert.equal((await wallet.createInvoice({
    amountMsat: 21_000,
    descriptionHash: "cd".repeat(32),
    idempotencyKey: "zap-1",
  })).paymentHash, invoice.paymentHash);
  assert.equal(requests.filter(({ body }) => body.operationName === "CreateBlinkInvoice").length, 1);
  assert.equal((await wallet.lookupInvoice(invoice.paymentHash)).status, "settled");
  assert.equal(await wallet.estimateFeeMsat("lnbc21creator"), 2_000);

  const payment = await wallet.payInvoice({
    invoice: "lnbc21creator",
    idempotencyKey: "payout-1",
    amountMsat: 21_000,
  });
  assert.deepEqual(payment, {
    paymentId: "blink-transaction-id",
    status: "succeeded",
    amountMsat: 21_000,
    feeMsat: 2_000,
  });
  assert.deepEqual(await wallet.lookupPayment({
    paymentId: "payout-1",
    expectedAmountMsat: 21_000,
    invoice: "lnbc21creator",
  }), payment);

  for (const request of requests) {
    assert.equal(request.headers.get("X-API-KEY"), "blink-secret");
  }
});

test("Blink adapter does not claim a payment succeeded when the provider has no transaction", async () => {
  const wallet = new BlinkWallet({
    endpoint: "https://api.blink.example/graphql",
    apiKey: "blink-secret",
    walletId: "wallet-id",
    fetchImplementation: async () => Response.json({
      data: {
        me: {
          defaultAccount: {
            id: "account-id",
            wallets: [{ id: "wallet-id", transactionsByPaymentRequest: [] }],
          },
        },
      },
    }),
  });

  assert.deepEqual(await wallet.lookupPayment({
    paymentId: "payout-1",
    expectedAmountMsat: 21_000,
    invoice: "lnbc21creator",
  }), {
    paymentId: "payout-1",
    status: "not_found",
    amountMsat: 21_000,
  });
});
