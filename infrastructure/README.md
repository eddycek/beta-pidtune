# FPVPIDlab Infrastructure

Cloud infrastructure for FPVPIDlab backend services. All services run on **Cloudflare** (Workers, R2, D1).

All resources are managed via **Terraform** with state in Cloudflare R2. CI/CD deploys automatically on merge to main.

## Services

| Service | Status | Description | Design Doc |
|---------|--------|-------------|------------|
| **Telemetry Worker** | Live (dev + prod) | Upload, diagnostics, admin stats, cron report | [TELEMETRY.md](./TELEMETRY.md), [design doc](../docs/complete/TELEMETRY_COLLECTION.md) |
| **License Worker** | Live (dev + prod) | License key validation (Ed25519), beta program | [docs/LICENSE_KEY_SYSTEM.md](../docs/LICENSE_KEY_SYSTEM.md) |
| **Payment Worker** | Planned | Stripe checkout + invoice generation | [docs/PAYMENT_AND_INVOICING.md](../docs/PAYMENT_AND_INVOICING.md) |

## Environments

| | Dev | Prod |
|---|---|---|
| Telemetry Worker | `telemetry-dev.fpvpidlab.app` | `telemetry.fpvpidlab.app` |
| License Worker | `license-dev.fpvpidlab.app` | `license.fpvpidlab.app` |
| Telemetry R2 | `pidlab-telemetry-dev` | `pidlab-telemetry` |
| License D1 | `pidlab-license-dev` | `pidlab-license` |
| Cron trigger | Disabled | Daily 07:00 UTC |
| Terraform state | `pidlab-tfstate` → `dev/terraform.tfstate` | `pidlab-tfstate` → `prod/terraform.tfstate` |

Data is fully isolated — dev and prod never share a bucket or database.

## Quick Links

- [API Endpoints](./ENDPOINTS.md) — Telemetry + License worker endpoints, R2 storage layout
- [Deployment & CI/CD](./DEPLOYMENT.md) — Pipeline, GitHub secrets, bootstrap, manual deploy
- [Environment Variables](./ENV-VARS.md) — Worker env vars, secret rotation
- [Admin Scripts](./SCRIPTS.md) — License keys, telemetry analytics, diagnostics, health checks
- [Telemetry Privacy Policy](./TELEMETRY.md)

## Directory Structure

```
infrastructure/
├── README.md
├── ENDPOINTS.md                   ← API endpoint reference
├── DEPLOYMENT.md                  ← CI/CD pipeline + manual deploy
├── ENV-VARS.md                    ← Worker environment variables
├── SCRIPTS.md                     ← Admin CLI scripts reference
├── terraform/                     ← Infrastructure-as-code
│   ├── main.tf                    ← R2 bucket, Worker, cron, DNS
│   ├── backend-dev.hcl            ← Backend config: dev state key
│   ├── backend-prod.hcl           ← Backend config: prod state key
│   ├── dev.tfvars                 ← Dev variables (non-secret)
│   ├── prod.tfvars                ← Prod variables (non-secret)
│   ├── terraform.tfvars.example   ← Full template (local use)
│   ├── build-worker.sh            ← Build TS → JS bundle
│   └── .gitignore                 ← Excludes state, secrets, bundle
├── telemetry-worker/              ← CF Worker TypeScript source
│   ├── wrangler.toml              ← Local dev + manual deploy
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts               ← Router + CORS + cron entry
│       ├── types.ts               ← Env bindings, bundle schema
│       ├── upload.ts              ← POST /v1/collect
│       ├── diagnostic.ts          ← Diagnostic reports + BBL upload + admin review
│       ├── admin.ts               ← GET /admin/stats/*
│       ├── validation.ts          ← UUID, schema, rate-limit
│       └── cron.ts                ← Daily report → Resend email
├── license-worker/                ← CF Worker for license key management
│   ├── wrangler.toml
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts               ← Router + CORS
│       ├── types.ts               ← Env bindings, D1 row types
│       ├── admin.ts               ← 10 admin routes (keys: generate, list, get, revoke, reset, stats; beta: dashboard, list, approve, reject)
│       ├── license.ts             ← Public endpoints (activate, validate, self-reset)
│       ├── beta.ts                ← Beta program: signup form handling, approve/reject logic
│       ├── betaPages.ts           ← Beta HTML pages (signup form, thank-you, admin dashboard shell)
│       ├── email.ts               ← Beta program emails via Resend (approval, rejection)
│       ├── crypto.ts              ← Ed25519 sign/verify via WebCrypto
│       ├── keygen.ts              ← FPVPIDLAB-XXXX-XXXX-XXXX key generation
│       ├── validation.ts          ← Input validation
│       ├── schema.sql             ← D1 database schema
│       └── migration-beta.sql     ← D1 migration: beta whitelist column (idempotent in CI)
├── scripts/                       ← Admin CLI tools (auto-source .env.local)
│   ├── _env.sh                    ← Shared env loader
│   ├── generate-ed25519-keypair.sh ← Generate license signing keypair
│   ├── generate-key.sh            ← Generate a license key
│   ├── list-keys.sh               ← List keys with filters
│   ├── revoke-key.sh              ← Revoke a key
│   ├── reset-key.sh               ← Reset machine binding
│   ├── key-stats.sh               ← License key statistics
│   ├── telemetry-full.sh           ← Full telemetry dump (all data)
│   ├── telemetry-stats.sh         ← Summary (installs, active, modes)
│   ├── app-versions.sh            ← App version distribution
│   ├── telemetry-bf-versions.sh   ← BF firmware versions
│   ├── telemetry-drones.sh        ← Drone sizes + flight styles
│   ├── telemetry-quality.sh       ← Quality score histogram
│   ├── telemetry-sessions.sh      ← Tuning sessions breakdown
│   ├── telemetry-features.sh      ← Feature adoption rates
│   ├── telemetry-blackbox.sh      ← Blackbox usage
│   ├── telemetry-profiles.sh      ← Profile count distribution
│   ├── telemetry-rules.sh         ← Rule effectiveness (v2)
│   ├── telemetry-metrics.sh       ← Metric distributions (v2)
│   ├── telemetry-verification.sh  ← Verification success rates (v2)
│   ├── telemetry-convergence.sh   ← Quality score convergence (v2)
│   ├── telemetry-errors.sh        ← Error breakdown from structured events (v3)
│   ├── telemetry-events.sh        ← Raw structured events by installation (v3)
│   ├── diagnostic-list.sh         ← List diagnostic reports
│   ├── diagnostic-review.sh       ← Mark report as reviewing
│   ├── diagnostic-resolve.sh      ← Resolve report with message
│   └── diagnostic-note.sh         ← Add internal note to report
└── payment-worker/                ← (planned)

.github/workflows/
└── infrastructure.yml             ← CI/CD: build → deploy dev (PR+main) → plan+deploy prod (main)
```

## Stack

| Component | Service | Free Tier |
|-----------|---------|-----------|
| API endpoints | CF Workers | 100K req/day |
| Telemetry storage | CF R2 | 10 GB, 1M writes/month |
| Terraform state | CF R2 | (shared bucket) |
| License database | CF D1 (SQLite) | 5 GB, 5M reads/day |
| Email reports | Resend | 3K emails/month |
| Payments | Stripe | Pay-as-you-go |
| IaC | Terraform + Cloudflare provider | Free |
| CI/CD | GitHub Actions | 2,000 min/month |

**Estimated cost**: $0/month up to ~5,000 active users.

## Client-Side Integration

The Electron app's `TelemetryManager` (`src/main/telemetry/`) handles:
- Bundle assembly from local managers (profiles, tuning history, blackbox, snapshots)
- FC serial anonymization (SHA-256 salted with installation ID)
- gzip compression + `net.fetch` POST with retry (1s/2s/4s)
- Daily heartbeat on app start, post-session trigger, manual "Send Now"
- Default URL: `TELEMETRY.UPLOAD_URL` in `src/shared/constants.ts` (prod)
- **Override**: `TELEMETRY_URL` env var points app to dev Worker
