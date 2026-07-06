# Deployment & CI/CD

## CI/CD Pipeline

```
PR opened/updated (trigger paths: infrastructure/terraform/**,
infrastructure/telemetry-worker/src/**, infrastructure/license-worker/src/**,
.github/workflows/infrastructure.yml)
  └─ build telemetry worker → deploy dev → plan prod

Merge to main (same trigger paths)
  └─ build telemetry worker → deploy dev → deploy prod
```

Note: changes outside these paths (e.g. `infrastructure/*.md`, `infrastructure/scripts/`) do **not** trigger the pipeline.

- **`build-worker`**: `esbuild` compiles telemetry worker TypeScript source into bundle
- **`deploy-dev`** (PR + main): `terraform apply` to dev — immediate feedback on PRs (skips fork PRs)
- **`plan-prod`** (PR only, internal): `terraform plan` for prod — review before merge
- **`deploy-prod`** (main push): `terraform apply` to prod (runs after dev succeeds)
- **Concurrency groups**: `deploy-dev` and `deploy-prod` serialize to prevent state corruption

GitHub environments `dev` and `prod` can have protection rules (e.g. required approval for prod).

Workflow file: `.github/workflows/infrastructure.yml`

## GitHub Secrets

13 secrets in GitHub repo settings (`Settings → Secrets and variables → Actions`):

### `CLOUDFLARE_PROVISIONING`

Cloudflare API token used by Terraform provider to manage all infrastructure resources.

- **Used by**: `terraform apply` (CI/CD deploy-dev, deploy-prod jobs)
- **Scope**: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, Workers Routes Edit, D1 Edit, DNS Edit, Account Settings Read, User Details Read
- **CF token name**: `pidlab-infra-provisioning`
- **Created in**: Cloudflare Dashboard → My Profile → API Tokens → "Edit Cloudflare Workers" template + R2 Storage Edit + D1 Edit + DNS Edit

### `TERRAFORM_STATE_R2_ACCESS_KEY_ID` + `TERRAFORM_STATE_R2_SECRET_ACCESS_KEY`

S3-compatible R2 credentials for Terraform backend. Terraform stores its state file (`terraform.tfstate`) in the `pidlab-tfstate` R2 bucket — these credentials allow reading and writing that state.

- **Used by**: `terraform init` (CI/CD all jobs that run Terraform)
- **Scope**: R2 Object Read & Write on all buckets (Terraform also manages telemetry buckets)
- **CF token name**: `pidlab-terraform-r2-v2`
- **Created in**: Cloudflare Dashboard → R2 → Manage R2 API Tokens → Object Read & Write, All buckets

### `TELEMETRY_ADMIN_KEY_DEV` + `TELEMETRY_ADMIN_KEY_PROD`

API keys for authenticating requests to `/admin/stats/*` endpoints on telemetry Workers. Each environment has its own key. Passed to Workers as `ADMIN_KEY` secret binding via Terraform.

- **Used by**: Terraform (injected as Worker secret), admin shell scripts (`scripts/telemetry-*.sh`)
- **Scope**: Only used within Worker runtime — no Cloudflare API access
- **Generated with**: `openssl rand -hex 32`

### `RESEND_API_KEY`

Resend email delivery API key for daily telemetry cron report, diagnostic report notifications, and beta program emails.

- **Used by**: Terraform (telemetry Worker) + `wrangler secret put` in CI (license Worker)
- **Scope**: Resend email sending only
- **Created in**: resend.com dashboard

### `TELEMETRY_REPORT_EMAIL`

Recipient email address for telemetry cron reports and diagnostic report notifications.

- **Used by**: Terraform (injected as `REPORT_EMAIL` Worker secret on telemetry Worker)
- **Scope**: Email "To" address for cron reports and diagnostic notifications

### `TELEMETRY_REPORT_FROM_EMAIL`

Verified sender address for telemetry Worker email delivery (e.g. `noreply@fpvpidlab.app`).

- **Used by**: Terraform (injected as `REPORT_FROM_EMAIL` Worker secret on telemetry Worker)
- **Scope**: Email "From" address for cron reports and diagnostic notifications

### `LICENSE_RESEND_FROM_EMAIL`

Verified sender address for license Worker email delivery (e.g. `noreply@fpvpidlab.app`).

- **Used by**: Wrangler (injected as `RESEND_FROM_EMAIL` Worker secret on license Worker)
- **Scope**: Email "From" address for beta program emails

### `LICENSE_ED25519_PRIVATE_KEY` + `LICENSE_ED25519_PUBLIC_KEY`

Ed25519 keypair for signing and verifying license tokens. The private key signs license objects on activation; the public key is bundled in the Electron app for offline verification.

- **Used by**: Terraform (injected as Worker secret bindings `ED25519_PRIVATE_KEY`, `ED25519_PUBLIC_KEY`)
- **Scope**: License signing/verification only (no Cloudflare API access)
- **Generated with**: `infrastructure/scripts/generate-ed25519-keypair.sh`
- **CRITICAL**: Cannot be rotated without invalidating all issued licenses. Back up in 1Password.

### `LICENSE_ADMIN_KEY_DEV` + `LICENSE_ADMIN_KEY_PROD`

API keys for authenticating requests to `/admin/keys/*` endpoints on license Workers. Each environment has its own key. Passed to Workers as `ADMIN_KEY` secret binding via Terraform.

- **Used by**: Terraform (injected as Worker secret), admin shell scripts (`infrastructure/scripts/generate-key.sh`, etc.)
- **Scope**: Only used within Worker runtime — no Cloudflare API access
- **Generated with**: `openssl rand -hex 32`

## Bootstrap (One-Time Setup)

Three R2 buckets were created manually via `wrangler` CLI (chicken-and-egg — Terraform can't manage its own state bucket):

```bash
# Already done:
npx wrangler r2 bucket create pidlab-tfstate        # Terraform state
npx wrangler r2 bucket create pidlab-telemetry-dev   # Dev telemetry data
npx wrangler r2 bucket create pidlab-telemetry       # Prod telemetry data
```

After bootstrap, everything is managed by Terraform + CI/CD. No more manual commands.

## Manual Operations

All manual operations require secrets from `.env.local` in the **repo root**. First-time setup:

```bash
cp env.template .env.local
# Fill in real values from 1Password (vault: FPVPIDlab Infrastructure)
```

Admin scripts auto-load `.env.local` and default to **dev** environment. To target prod:

```bash
PIDLAB_ENV=prod ./infrastructure/scripts/generate-key.sh user@example.com
```

### Deploy infrastructure manually

Normally CI/CD handles this on merge to main. Use this for emergency fixes or debugging.

```bash
source .env.local
cd infrastructure/terraform

# 1. Build telemetry worker bundle
cd ../telemetry-worker && npm install && npx esbuild src/index.ts --bundle --format=esm --outfile=../terraform/worker-bundle.js && cd ../terraform

# 2a. Deploy DEV
terraform init -backend-config=backend-dev.hcl
export TF_VAR_admin_key="$TELEMETRY_ADMIN_KEY_DEV"
export TF_VAR_license_admin_key="$LICENSE_ADMIN_KEY_DEV"
terraform apply -var-file=dev.tfvars

# 2b. Deploy license worker via wrangler (not terraform) + apply D1 migrations
cd ../license-worker && npm install && npx wrangler deploy
npx wrangler d1 execute pidlab-license-dev --file=src/schema.sql --remote
npx wrangler d1 execute pidlab-license-dev --file=src/migration-beta.sql --remote || echo "Migration already applied"
cd ../terraform

# 2c. Deploy PROD
terraform init -reconfigure -backend-config=backend-prod.hcl
export TF_VAR_admin_key="$TELEMETRY_ADMIN_KEY_PROD"
export TF_VAR_license_admin_key="$LICENSE_ADMIN_KEY_PROD"
terraform apply -var-file=prod.tfvars
cd ../license-worker && npx wrangler deploy --env prod
npx wrangler d1 execute pidlab-license --env prod --file=src/schema.sql --remote
npx wrangler d1 execute pidlab-license --env prod --file=src/migration-beta.sql --remote || echo "Migration already applied"
cd ../terraform
```

The D1 migration steps mirror CI (`.github/workflows/infrastructure.yml` — "Deploy license worker + D1 migrations"): `schema.sql` is idempotent (CREATE TABLE IF NOT EXISTS), `migration-beta.sql` is allowed to fail when already applied.
