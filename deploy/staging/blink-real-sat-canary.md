# Blink real-sat canary

This runbook validates one 29-sat NIP-57 zap and its 20-sat creator payout on
staging. Passing it does not enable production.

## Fixed safety envelope

- Blink API key scopes: `READ`, `RECEIVE`, and `WRITE`; rotate the key
  immediately after the canary.
- Blink account and BTC wallet IDs must match the configured staging values.
- Blink balance before the test: at most 71 sats, keeping the balance at or below
  the 100-sat cap after receiving the 29-sat zap. Do not add funds merely to make
  a failed payout pass.
- Use a fresh `/app/data/revenue-blink-canary.sqlite` ledger. Preserve the old
  FakeWallet database unchanged and never use it for a real payout.
- One new Wired staging post, one saved creator Lightning address, one 29-sat
  zap, and one expected 20-sat payout.
- `STAGING_REVENUE_MAX_SENDABLE_MSAT=29000` and
  `STAGING_REVENUE_MAX_ROUTING_FEE_MSAT=5000`.
- Stage 1 has `STAGING_REVENUE_SEND_PAYOUTS=false`. Stage 2 changes only that
  variable to `true` after the incoming movement reconciles.

At 29 sats, the ledger should allocate 20,300 msat to the creator and 8,700
msat to Wired. Blink pays the whole-sat creator portion (20 sats); the remaining
300 msat stays available for later aggregation. The routing fee is charged to
Wired's ledger balance and may not exceed 5 sats.

## Stop conditions

Set `STAGING_REVENUE_ACCEPT_INVOICES=false` and
`STAGING_REVENUE_SEND_PAYOUTS=false`, then redeploy immediately if any of these
occur:

- the adapter reports an unexpected account, wallet, currency, or missing scope;
- operator status has an alert before the canary;
- a request above 29 sats produces an invoice;
- the 29-sat invoice does not settle within two minutes after payment;
- no valid kind-9735 receipt is published within two reconciliation cycles;
- the creator/Wired split differs from 20,300/8,700 msat;
- the fee probe exceeds 5 sats;
- a payout remains ambiguous for two reconciliation cycles;
- Blink and Wired disagree on payment hash, amount, status, fee, or transaction ID;
- the Blink balance exceeds the 100-sat exposure cap.

Do not retry an ambiguous payout manually and do not switch to FakeWallet while
a real creator balance is available or reserved.

## Stage 1: receive and reconcile

1. Before deployment, run this read-only Blink query with the staged API key and
   record the result. Require the expected account ID, BTC wallet ID,
   `walletCurrency: BTC`, balance no greater than 71 sats, and exactly the needed
   `READ`, `RECEIVE`, and `WRITE` scopes:

   ```graphql
   query WiredCanaryPreflight {
     authorization { scopes }
     me { defaultAccount { id wallets { id walletCurrency balance } } }
   }
   ```

   The 2026-07-13 operator preflight passed with the expected IDs, BTC currency,
   all three scopes, and a zero-sat balance.
2. Deploy Blink with payouts disabled and the isolated canary database. Confirm
   operator status has no alerts and zero enrollments, invoices, payouts, and
   creator/Wired balances.
3. In the Wired staging client, save the creator Lightning address and publish
   one public post. Confirm its public event contains only normal NIP-57 data.
4. Zap that post exactly 29 sats from a separate wallet.
5. In Blink, record the incoming invoice payment hash, amount, and paid status.
6. Reconcile Wired and verify one 29,000-msat settled invoice, a valid public
   receipt, 20,300 msat creator-available, 8,700 msat Wired revenue, and no
   payout transaction.
7. Back up the revenue SQLite database before enabling payouts.

## Stage 2: release one payout

1. Set `STAGING_REVENUE_SEND_PAYOUTS=true` and redeploy without changing any
   other canary bound.
2. Allow at most two reconciliation cycles.
3. Verify the creator received exactly 20 sats and the 300-msat remainder is
   still available in Wired's ledger.
4. Match Wired's provider payment ID, amount, final status, and fee to Blink's
   transaction record. Confirm creator available/reserved/paid balances are
   respectively 300/0/20,000 msat.
5. Set payouts back to `false`, rotate the Blink key, replace the staging secret,
   and run one read-only account/wallet/scope check with the new key.

## Rollback and liability recovery

If the incoming zap settles but the payout cannot be proven final, leave the
20,300 msat creator liability reserved or available in Wired's durable ledger,
disable new invoices and payouts, and export the Blink transaction history plus
a revenue database backup. Resolve the exact BOLT11 invoice by payment request;
never create a replacement payout until Blink proves the original absent.

If Blink must be replaced, keep new invoices and payouts disabled, reconcile all
pending and ambiguous records, fund the replacement wallet for the recorded
creator liabilities plus a bounded fee reserve, change only the wallet backend
configuration, and resume payouts before accepting new invoices.
