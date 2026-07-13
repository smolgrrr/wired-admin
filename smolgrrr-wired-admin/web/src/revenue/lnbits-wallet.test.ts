import assert from "node:assert/strict";
import test from "node:test";
import { LnbitsWallet } from "./lnbits-wallet.js";

test("LNbits adapter creates description-hash invoices and pays with separated keys", async () => {
  const requests: Array<{ url: string; init?: RequestInit; body: Record<string, unknown> | null }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    requests.push({ url, ...(init ? { init } : {}), body });
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

  const invoice = await wallet.createInvoice({ amountMsat: 21_000, descriptionHash: "ab".repeat(32) });
  assert.equal(invoice.invoice, "lnbc21incoming");
  assert.deepEqual(requests[0]?.body, {
    out: false,
    amount: 21,
    memo: "",
    description_hash: "ab".repeat(32),
    webhook: "https://wired.example/api/revenue/wallet/webhook",
  });
  assert.equal((requests[0]?.init?.headers as Record<string, string>)["X-Api-Key"], "invoice-key");
  assert.equal((await wallet.lookupInvoice("hash-in")).status, "settled");

  const payment = await wallet.payInvoice({
    invoice: "lnbc21creator",
    idempotencyKey: "payout-1",
    amountMsat: 21_000,
  });
  assert.equal(payment.status, "succeeded");
  assert.equal(payment.feeMsat, 12);
  assert.deepEqual(requests[2]?.body, {
    out: true,
    bolt11: "lnbc21creator",
    extra: { wired_idempotency_key: "payout-1" },
    external_id: "payout-1",
  });
  assert.equal((requests[2]?.init?.headers as Record<string, string>)["X-Api-Key"], "admin-key");

  const lookedUp = await wallet.lookupPayment("payout-1");
  assert.equal(lookedUp.status, "succeeded");
  assert.match(requests[3]?.url || "", /external_id=payout-1$/);
});
