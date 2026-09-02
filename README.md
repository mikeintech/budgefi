# Budgefi

Budgefi is a mobile-first financial-operations app with one React product for the web plus Capacitor iOS/Android shells. Its implemented core is a household-scoped PostgreSQL ledger with exact integer-money planning, manual entry, optional real Plaid synchronization, provenance, account coverage, notification preferences/delivery jobs, export and deletion workflows, optimistic concurrency, idempotent writes, row-level security, and append-only calculation evidence.

## Current scope

The web product is deployed as an early production candidate, while local and synthetic test modes remain available for development. It supports fully manual data, Clerk-backed just-in-time user/household provisioning, and an opt-in Plaid Link + Transactions Sync path. New Plaid accounts are excluded from planning until the user explicitly includes them. Disconnect immediately excludes the accounts, durably queues Plaid `/item/remove`, erases the access-token envelope after confirmation, and retains historical ledger records.

It does **not** yet provide CSV import, Android FCM delivery, money movement, merchant contact, or merchant cancellation verification. The implemented real-data exception workflow conservatively detects exact duplicate posted debits, stores evidence, and records the user's decision; broader anomaly detection remains out of scope. See [docs/PRODUCT_ARCHITECTURE.md](docs/PRODUCT_ARCHITECTURE.md) for the route-by-route product contract and explicit limits.

## Requirements

- Node.js 22–24
- npm
- PostgreSQL 17, or Docker with Compose

## First run with Docker PostgreSQL

```sh
npm install
docker compose up -d --wait postgres
cp .env.example .env
set -a; source .env; set +a
npm run db:migrate
npm run db:seed
npm run dev:local
```

Open `http://localhost:4411`. The API is at `http://localhost:4422/v1`; health is `GET /v1/health`.

`dev:local` starts the API and web app together but intentionally does not mutate the database schema. Run migrations explicitly before startup so schema changes remain reviewable.

## Existing PostgreSQL

Create an empty database, export `DATABASE_URL` and `ALLOW_DEV_AUTH=true`, then run:

```sh
npm run db:migrate
npm run db:seed
npm run dev:local
```

Local auth is fail-closed unless `ALLOW_DEV_AUTH=true` is explicit. When `.env.local` contains Clerk keys, `dev:local` uses real Clerk sessions and no longer accepts the development identity header. Production refuses to start without `CLERK_SECRET_KEY` or `CLERK_JWT_KEY`, plus `CLERK_AUTHORIZED_PARTIES` (or `WEB_ORIGIN`).

To link a Clerk application, run `clerk auth login`, `clerk link`, and `clerk env pull`. The CLI writes ignored secrets to `.env.local`; never commit that file. Web sign-in and sign-up use Clerk's official embedded components on splat routes. Native builds use a system authentication session and a one-use, 60-second Clerk sign-in ticket; no password or verification code enters Budgefi.

The API disables Clerk frontend self-delete for every authenticated user so account removal always runs Budgefi's Plaid-revocation and data-deletion workflow. Configure a Clerk `user.deleted` webhook at `https://<api-host>/v1/clerk/webhook` and store its signing secret as `CLERK_WEBHOOK_SIGNING_SECRET`. The verified webhook is an idempotent backstop for identities removed outside Budgefi; raw webhook payloads and Clerk user IDs are not retained.

## Real Plaid Sandbox

Real Plaid is disabled by default. Add Sandbox credentials and a 32-byte local encryption key to `.env`:

```sh
PLAID_ENABLED=true
PLAID_ENV=sandbox
PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_sandbox_secret
PLAID_TOKEN_ENCRYPTION_KEY="$(openssl rand -base64 32)"
PLAID_ACTIVE_TOKEN_KEY_ID=local-v1
```

Then migrate and restart `npm run dev:local`. The onboarding and Accounts & data pages use official Plaid Link. Public tokens are exchanged only by the API; access tokens are stored in AES-256-GCM envelopes bound to the Item, environment, connection, and key version. For webhook testing, expose only `/v1/plaid/webhook` through an HTTPS tunnel and set `PLAID_WEBHOOK_URL` before creating the Link token. Never put Plaid secrets or the encryption key in a `VITE_` variable.

With the Plaid-enabled API running, validate the real Sandbox network contract and automatic cleanup with:

```sh
set -a; source .env; set +a
npm run test:plaid:sandbox
```

This opt-in smoke test creates a First Platypus Item through Plaid's real Sandbox API, sends its public token through Budgefi's exchange/sync path, requires healthy initial synchronization and conservative account exclusion, then revokes the Item in `finally`.

## Verification

```sh
npm run check
```

The gate runs frontend/backend typechecks, domain/auth tests, a fresh isolated PostgreSQL 17 cluster, every migration, seed validation, migration tests, API/RLS/idempotency/concurrency tests, a clean browser journey with reload-persistence assertions, and the production frontend build. Set `POSTGRES_BIN` if PostgreSQL 17 binaries are in a nonstandard directory.

The deterministic provider double follows Plaid's public testing conventions and drives the same service/database path without network flakiness. Integration tests assert concurrent first-user provisioning, server-side token exchange, ciphertext at rest, pending-to-posted revisions, account reconciliation, sync convergence, webhook signature/body verification and deduplication, revocation, RLS, account inclusion, manual fallback, and reload persistence without using personal financial data.

## Native iOS and Android

The native shells preserve the same web codebase while adding safe-area navigation, app lifecycle/network handling, privacy-screen protection, biometric/passcode app lock, device-secure preferences, APNs registration, deep-link routing, offline read-only cache behavior, native export sharing, and native icon/splash assets.

For a native build, configure `VITE_NATIVE_API_BASE_URL`, `VITE_PUBLIC_APP_URL`, and the exact HTTPS `VITE_NATIVE_AUTH_URL` route, then run:

```sh
npm run build:native
npm run native:ios
```

Set the Netlify build variables `APPLE_TEAM_ID` and `ANDROID_SHA256_FINGERPRINTS` (one or more colon-delimited release certificate fingerprints, comma-separated). `npm run build:netlify` then generates the final Apple Universal Links and Android App Links files from those verified signing identities; `npm run app-links:check` validates a generated pair. Never publish template values or a debug certificate as a production association. Configure the same associated domain in the Apple Developer account and Android manifest. Debug uses APNs sandbox; Release uses APNs production. A full iOS Archive/device check requires the complete Xcode installation, an Apple team, signing profile, App Store Connect record, and APNs key.

## Architecture

- React + Vite mobile client
- Capacitor 8 native shells for iOS and Android
- NestJS on Fastify with strict Zod contracts
- PostgreSQL 17 and Kysely
- Clerk session-token validation with authorized-party checks and just-in-time private household provisioning; explicit local development identity only when Clerk is absent
- Modular-monolith boundary; exact USD minor units; canonical server calculations
- Plaid Link, AES-256-GCM token envelopes, cursor-based Transactions Sync, signed webhook ingestion, durable leased jobs, update mode, and provider revocation
- APNs/email notification generation and delivery worker with encrypted device tokens, retries, leases, suppression, and endpoint lifecycle controls

The database migration role creates the narrow `budgefi_app` role. Runtime requests switch to that restricted role before resolving or provisioning a principal and set household context in the same transaction. Canonical ledger tables force RLS. A small audited allowlist of operational queue/cache tables keeps RLS enabled while owner-controlled `SECURITY DEFINER` functions discover global work; non-owner runtime roles remain policy-bound and cannot read another tenant. JIT provisioning and background actor resolution are narrowly exposed; the app role still cannot read the global users table directly.

The production API requires `RUNTIME_DATABASE_URL` for a separate non-owner, non-superuser, non-`BYPASSRLS` LOGIN role that is a member of `budgefi_app`. The worker requires a distinct `WORKER_DATABASE_URL` login that is a member only of `budgefi_worker`. `DATABASE_URL` remains migration-only. Both processes query PostgreSQL role metadata at startup and fail closed when privileges are broader or narrower than their intended capability. Integration tests run the complete API through a restricted login rather than the migration owner.

On iOS, Clerk and Plaid open through `ASWebAuthenticationSession`; Android uses a Custom Tab. Clerk returns a state-checked, one-use, 60-second ticket that is consumed by the app's Clerk client. Plaid uses Hosted Link, binds the returned Link token to the tenant session by hash, and resolves the result server-side through `/link/token/get`. Web keeps the existing Clerk and Plaid web components.

Plaid public-token exchange is a one-time provider operation crossing a database boundary. Budgefi compensates ordinary post-exchange persistence failures by removing the newly created Item and can recover stale attempts before provider consumption. A hard process or host loss after Plaid consumes the public token but before the local connection commits cannot be made atomic across Plaid and PostgreSQL. Production operations must alert on failed/stale Link sessions, reconcile orphan Items with Plaid support telemetry, and provide a clean relink path; the app never treats that state as connected.

## Production blockers

Do not use production financial data or submit to App Review yet. Before launch, run the new system-session callbacks on signed devices, move server token keys to KMS/HSM-backed envelope encryption, add Android FCM delivery, host the authenticated API/worker and HTTPS webhook endpoint, publish the real associated-domain files, configure Clerk Native Applications plus Clerk/Plaid/APNs/email production providers, centralize redacted monitoring and dead-letter alerts, drill backups/restores and key rotation, and perform device/simulator, load/chaos, privacy, threat-model, penetration, incident-response, and App Store review checks. The current encrypted, size-bounded offline cache is suitable for development validation but still requires a device-level security review.
