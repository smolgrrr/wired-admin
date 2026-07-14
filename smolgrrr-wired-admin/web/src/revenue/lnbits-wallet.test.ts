import assert from "node:assert/strict";
import test from "node:test";
import { LnbitsWallet } from "./lnbits-wallet.js";

test("LNbits adapter creates description-hash invoices and pays with separated keys", async () => {
  const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> | null }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, ...(init ? { init } : {}), body });
    if (url.includes("external_id=")) return Response.json([]);
    if (init?.method === "POST" && body?.out === false) {
      return Response.json({ payment_hash: "hash-in", payment_request: "lnbc21incoming" });
    }
    if (init?.method === "POST" && body?.out === true) {
      return Response.json({ payment_hash: "hash-out", checking_id: "checking-out", fee: -12 });
    }
    if (url.endsWith("/hash-in")) {
      return Response.json({ paid: true, pending: false, amount: 21_000 });
    }
    return Response.json({ paid: true, pending: false, amount: -21_000, fee: -12 });
  };
  const wallet = new LnbitsWallet({
    endpoint: "https://lnbits.example",
    invoiceKey: "invoice-key",
    adminKey: "admin-key",
    webhookUrl: "https://wired.example/api/revenue/wallet/webhook",
    fetchImplementation: fakeFetch,
  });

  const invoice = await wallet.createInvoice({
    amountMsat: 21_000,
    descriptionHash: "ab".repeat(32),
    idempotencyKey: "zap-1",
  });
  assert.equal(invoice.invoice, "lnbc21incoming");
  const createRequest = requests.find((request) => request.body?.out === false);
  assert.deepEqual(createRequest?.body, {
    out: false,
    amount: 21,
    memo: "",
    description_hash: "ab".repeat(32),
    external_id: "zap-1",
    webhook: "https://wired.example/api/revenue/wallet/webhook",
  });
  assert.equal((createRequest?.init?.headers as Record<string, string>)["X-Api-Key"], "invoice-key");
  assert.equal((await wallet.lookupInvoice("hash-in")).status, "settled");

  const payment = await wallet.payInvoice({
    invoice: "lnbc21creator",
    idempotencyKey: "payout-1",
    amountMsat: 21_000,
  });
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.feeMsat, 12);
  const payRequest = requests.find((request) => request.body?.out === true);
  assert.deepEqual(payRequest?.body, {
    out: true,
    bolt11: "lnbc21creator",
    extra: { wired_idempotency_key: "payout-1" },
    external_id: "payout-1",
  });
  assert.equal((payRequest?.init?.headers as Record<string, string>)["X-Api-Key"], "admin-key");

  const lookedUp = await wallet.lookupPayment({
    paymentId: "payout-1",
    invoice: "lnbc21creator",
  });
  assert.equal(lookedUp.status, "succeeded");
  assert.ok(requests.some((request) => /external_id=payout-1$/.test(request.url)));
});
