# Budgefi product and system map

This document is the canonical map of what Budgefi currently does, which data is authoritative, and where the product intentionally stops. UI copy must not claim more than the implementation described here.

## Product contract

Budgefi is a household financial-operations workspace. It combines a conservative cash plan with source health, evidence-backed exception review, manual fallback, and a durable record of what changed. It never counts credit availability as cash, never counts expected income before it arrives, never moves money, and never claims to contact or cancel a merchant.

The current acquisition wedge is financial integrity: show whether source data is current, detect supported discrepancies, preserve evidence, collect a decision, and keep the outcome visible. The implemented detector is intentionally narrow: exact duplicate posted debits on the same account, within two days, after excluding pending replacements, transfers, savings round-ups, credits, samples, and known investment labels.

## User journey and routes

| Route | Responsibility | Authoritative state | Failure behavior |
| --- | --- | --- | --- |
| `/` | Public explanation and trust model | Static product copy | Always available |
| `/sign-in`, `/sign-up`, `/forgot-password` | Clerk authentication inside Budgefi framing | Clerk session | Clerk errors remain in the auth surface; no fake success |
| `/onboarding` | Household context, optional connection/manual choice, AI-assisted editable draft, plan and notification setup | Server bootstrap plus identity/household/revision-scoped temporary draft | Stale or cross-identity drafts are discarded; bank sync may continue in background |
| `/today` | Safe-to-use result, source confidence, current exception and next commitments | Latest server calculation snapshot | Money is hidden when no confirmed server/cache state exists; cached native state is read-only |
| `/review` | Current actionable exception queue | Active server cases | Closed/expired cases do not appear as current work |
| `/review/:id` | Evidence and user decision | Append-only evidence snapshots plus versioned case | Terminal cases reject new decisions |
| `/plan` | Current cash, guardrails and commitments | Canonical plan, accounts and commitments | Optimistic conflicts reload canonical state |
| `/activity` | Audit events and active upcoming commitments | Append-only activity plus active commitments | This is not a complete bank-statement view |
| `/connections` | Plaid health, refresh, repair, removal and account inclusion | Connections, accounts and leased sync jobs | Requests enqueue durable work and return a visible pending state |
| `/manual` | Manual cash, transaction and commitment fallback | Same canonical ledger as connected data, with manual provenance | Validation is local and server-side; failed writes reconcile from server |
| `/more` | Navigation to account, source, security and privacy controls | Mixed, each destination owns its data | Unsupported household invitations are not presented as functional |
| `/settings/*` | Plan, notification, security and deletion controls | Server preferences and native secure settings | Destructive operations require explicit confirmation |

## Canonical data flow

1. Clerk proves a user identity; the API provisions or resolves a private household.
2. Every request runs through a restricted database login, assumes `budgefi_app`, and establishes user and household context inside one transaction.
3. PostgreSQL row-level security is the second authorization boundary. Canonical ledger tables force RLS. A small allowlist of operational queue/cache tables keeps RLS enabled but permits their owner-controlled `SECURITY DEFINER` functions to discover global work.
4. Money is stored and calculated as integer USD minor units. The server owns projections and calculation snapshots; the client only previews drafts.
5. Every accepted mutation is idempotent, version checked where a user can overwrite state, audited, and increments the household data revision.
6. The client ignores older revisions, serializes mutations, and reloads canonical state after a rejected write.

## Source ingestion

Manual data and Plaid data enter the same accounts, balance observations and financial transaction ledger with explicit provenance. Plaid Link exchanges its public token on the server, encrypts the access token with versioned AES-256-GCM keys, stores the connection, and enqueues initial synchronization. The browser request does not wait for account/transaction history.

Webhooks are signature and body-hash verified, deduplicated, and passed to a narrow database function that never reveals tenant identity to the request server. The function converts verified events into coalesced durable jobs or fixed connection-state changes. A dedicated scheduled Cloud Run job leases Plaid work, paginates from the committed cursor, reconciles accounts and transaction revisions, refreshes exceptions, persists a calculation snapshot, and updates connection health. Lease recovery, retry backoff and dead-letter state make host loss recoverable.

Disconnect immediately excludes connected accounts from new plans and enqueues provider revocation. The token is erased only after Plaid confirms removal or reports it already removed.

## Background operations

- `budgefi-plaid-sync`: restricted application database role; schedules and processes Plaid sync/revocation jobs.
- `budgefi-maintenance`: distinct worker database role; prunes expired AI analyses, creates notifications, delivers APNs/email jobs, and finalizes confirmed account deletions.
- API instances do not own polling loops in production. Cloud Scheduler invokes both finite jobs, so scale-to-zero cannot suspend durable work.
- `deploy/gcp-plaid-worker.sh` is the checked-in deployment contract for the finite Plaid job and its scheduler. It references Secret Manager values and an immutable backend image; it does not contain credentials.

## Security and privacy invariants

- Provider and Clerk secrets never enter frontend bundles.
- Plaid and push tokens are encrypted at rest and redacted from logs/exports.
- New connected accounts are excluded from planning until the user includes them.
- Append-only activity, revisions, calculation evidence and case evidence reject ordinary update/delete.
- Onboarding drafts expire after seven days and are bound to authentication subject, household and server revision.
- Account deletion transfers household ownership before revoking a departing owner and finalizes only after provider access is revoked.
- Native cached financial state is encrypted/size-bounded, identity scoped and read-only while offline.

## Deliberate limits and open product work

The following are not currently complete and must not be marketed as complete:

- Merchant cancellation, negotiation, charge dispute or verified savings execution.
- General anomaly detection beyond the supported duplicate-debit rule.
- Household invitations, reimbursements, permissions UI and a multiple-household selector.
- Automatic matching of a paid transaction to a commitment occurrence; users currently maintain commitment dates.
- Persisted future-income schedules; expected income is onboarding context and is never included in available cash.
- CSV import, complete statement browsing/search and accounting-grade reporting.
- Android FCM delivery. iOS APNs/email require provider configuration and device validation.
- Money movement, investment trading, debt optimization or financial advice.

## Change checklist

Before changing a flow, verify: identity and household scope; idempotency; expected version; household revision; integer-money validation; provenance; append-only evidence; offline behavior; retry/lease behavior for external calls; deletion/export inclusion; honest copy; and both manual and connected paths. Schema changes require a forward-only migration and a fresh-database integration test. External provider work must be durable before the HTTP response reports acceptance.
