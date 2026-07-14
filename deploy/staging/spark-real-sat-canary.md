# Spark real-sat canary

This canary proves the staged NIP-57 flow with a bounded Spark hot wallet while
preserving Wired's existing accounting ledger.

## Preconditions

- Store a staging-only Spark mnemonic in `STAGING_REVENUE_SPARK_MNEMONIC`.
- Set `STAGING_REVENUE_WALLET_BACKEND=spark`, `STAGING_REVENUE_SPARK_NETWORK=MAINNET`,
  and keep both fee limits at 5 sats.
- Keep `STAGING_REVENUE_SEND_PAYOUTS=false` for the first deployment.
- Retain the existing `STAGING_REVENUE_DATABASE_FILE` value so prior creator
  liabilities remain visible.

## Procedure

1. Deploy and confirm `/api/revenue/operator/status` reports `walletBackend: spark`.
2. Create a small Spark funding invoice and pay it from an external Lightning
   wallet. Fund enough to cover every existing creator liability plus routing
   fees; 100 sats is the default staging bound.
3. Reconcile the wallet balance and existing ledger liabilities, then set
   `STAGING_REVENUE_SEND_PAYOUTS=true` and redeploy.
4. Confirm any previously deferred eligible payout completes exactly once.
5. Publish an enrolled staged post and zap it for 21 sats from a NIP-57 client.
6. Verify the incoming invoice settled, one kind `9735` receipt was published to
   `wss://staging.wiredsignal.online`, the creator received 14 sats, Wired's
   ledger retained 6.3 sats less the actual routing fee, and 0.7 sats remained
   available to the creator for a future aggregated payout.
7. Confirm a restart and reconciliation do not create a second payout.

Stop the canary by disabling new invoices and payouts if Spark reports an amount,
invoice, or payment status that disagrees with Wired's ledger. Never retry an
ambiguous payout until Spark has either found the request by its idempotency key
or the configured not-found grace period has elapsed.
