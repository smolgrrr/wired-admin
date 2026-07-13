# Managed wallet decision: Blink

Wired selected Blink for the initial managed-wallet canary after comparing it
with myLNbits/Spark, direct Spark, Strike, OpenNode, Voltage, Alby Hub, ZBD, and
uncontracted public LNbits instances.

| Criterion | Blink decision evidence |
|---|---|
| Fixed and variable cost | No published subscription fee; outgoing Lightning is advertised at routing cost, approximately 0.02%. |
| NIP-57 invoices | The current public GraphQL schema exposes caller-supplied `descriptionHash` through `lnInvoiceCreateOnBehalfOfRecipient`. |
| Settlement and recovery | Invoice status can be queried by payment hash; outgoing transactions can be recovered by the exact BOLT11 payment request. |
| Fees and reconciliation | `lnInvoiceFeeProbe` quotes fees and transaction records expose final status, settlement amount, fee, and ID. |
| Node, channels, liquidity | Blink operates the Lightning infrastructure; Wired manages none of these. |
| Custody and uptime | Blink is custodial and publishes service status, but Wired retains its own authoritative liability ledger and caps the hot balance. |
| Approval and jurisdiction | Blink's terms require approval for third-party payment facilitation. The Wired operator reports that approval has been obtained. |
| Exportability | GraphQL transaction and invoice history support reconciliation/export; the provider-neutral wallet contract preserves migration. |
| Operational complexity | One server-side GraphQL adapter and one scoped API key; no sidecar, seed, node, or LNbits instance. |

OpenNode was excluded because its documented invoice API does not accept an
arbitrary NIP-57 description hash. Free/public LNbits instances were excluded
because their custody, recovery, and uptime terms are unsuitable for creator
liabilities. Strike and Voltage require business access or custom pricing;
direct Spark has low published fees but adds key and sidecar operations.

Primary sources: [Blink API](https://dev.blink.sv/),
[Blink authentication](https://dev.blink.sv/api/auth),
[Blink GraphQL reference](https://dev.blink.sv/public-api-reference.html), and
[Blink terms](https://www.blink.sv/en/terms-conditions).
