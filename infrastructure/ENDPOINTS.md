# API Endpoints

All endpoints use JSON request/response bodies unless noted.

**Authentication methods:**
- `X-Admin-Key` header — admin API key (per-environment, per-worker)
- `X-Installation-Id` header — anonymous installation UUID (for user-scoped operations)

---

## Telemetry Worker Endpoints

**Base URL**: `telemetry-dev.fpvpidlab.app` (dev) / `telemetry.fpvpidlab.app` (prod)

### Public Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/collect` | None | Upload telemetry bundle (gzip, rate-limited 1/hr) |
| `GET` | `/health` | None | Health check |

### Diagnostic Report Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/diagnostic` | None | Submit diagnostic report bundle (rate-limited 5/hr) |
| `PATCH` | `/v1/diagnostic/{reportId}` | `X-Installation-Id` | Add user details (email, note) to existing auto-report |
| `PUT` | `/v1/diagnostic/{reportId}/bbl` | `X-Installation-Id` | Upload BBL flight data for a report (max 50 MB) |

### Diagnostic Admin Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/admin/diagnostics` | `X-Admin-Key` | List reports (`?status=new\|reviewing\|resolved\|needs-bbl&limit=50`) |
| `GET` | `/admin/diagnostics/summary` | `X-Admin-Key` | Report counts by status (for cron email) |
| `GET` | `/admin/diagnostics/{reportId}` | `X-Admin-Key` | Full bundle + metadata |
| `GET` | `/admin/diagnostics/{reportId}/bbl` | `X-Admin-Key` | Download BBL file |
| `PATCH` | `/admin/diagnostics/{reportId}` | `X-Admin-Key` | Update status, resolution, internal note |

### Telemetry Admin Stats Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/admin/stats` | `X-Admin-Key` | Summary: installs, active 24h/7d/30d, modes, platforms |
| `GET` | `/admin/stats/app-versions` | `X-Admin-Key` | FPVPIDlab app version distribution |
| `GET` | `/admin/stats/versions` | `X-Admin-Key` | Betaflight firmware version distribution |
| `GET` | `/admin/stats/drones` | `X-Admin-Key` | Drone sizes + flight style distribution |
| `GET` | `/admin/stats/quality` | `X-Admin-Key` | Quality score histogram (5 buckets) + average |
| `GET` | `/admin/stats/sessions` | `X-Admin-Key` | Tuning sessions: total, per-mode, top installations |
| `GET` | `/admin/stats/features` | `X-Admin-Key` | Feature adoption rates (analysis, snapshots, history) |
| `GET` | `/admin/stats/blackbox` | `X-Admin-Key` | Blackbox: total logs, compression, storage types |
| `GET` | `/admin/stats/profiles` | `X-Admin-Key` | Profile count distribution + average per install |
| `GET` | `/admin/stats/full` | `X-Admin-Key` | All of the above in a single response |
| `GET` | `/admin/stats/rules` | `X-Admin-Key` | Rule effectiveness: fire/apply rates, avg delta (v2) |
| `GET` | `/admin/stats/metrics` | `X-Admin-Key` | Metric distributions: noise, overshoot, bandwidth (v2) |
| `GET` | `/admin/stats/verification` | `X-Admin-Key` | Verification success rates by tuning mode (v2) |
| `GET` | `/admin/stats/convergence` | `X-Admin-Key` | Quality score convergence across sessions (v2) |
| `GET` | `/admin/stats/errors` | `X-Admin-Key` | Aggregated error metrics from structured events (v3) |
| `GET` | `/admin/events` | `X-Admin-Key` | Events for specific installation (`?id=UUID`) |

---

## License Worker Endpoints

**Base URL**: `license-dev.fpvpidlab.app` (dev) / `license.fpvpidlab.app` (prod)

### Public Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/license/activate` | None | Activate key + bind machine, returns signed license |
| `POST` | `/license/validate` | None | Periodic validation (revocation sync) |
| `POST` | `/license/reset` | None | Self-service machine reset (key + email required) |
| `GET` | `/health` | None | Health check |

### Beta Program Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/beta` | None | Public beta signup form (HTML page) |
| `POST` | `/beta/signup` | None | Process signup submission (email, drone info, experience) |
| `GET` | `/beta/thankyou` | None | Confirmation page after signup |
| `GET` | `/admin/beta` | None | Admin dashboard HTML shell (public page — data endpoints below require auth) |
| `GET` | `/admin/beta/list` | `X-Admin-Key` | List beta applications (JSON, `?status=pending\|approved\|rejected`) |
| `PUT` | `/admin/beta/{id}/approve` | `X-Admin-Key` | Approve application — auto-generates tester license key + sends email |
| `PUT` | `/admin/beta/{id}/reject` | `X-Admin-Key` | Reject application — sends rejection email |

### Admin Key Management Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/admin/keys/generate` | `X-Admin-Key` | Generate new license key |
| `GET` | `/admin/keys` | `X-Admin-Key` | List keys (`?status=active\|revoked&type=paid\|tester&email=X`) |
| `GET` | `/admin/keys/{id}` | `X-Admin-Key` | Key details |
| `PUT` | `/admin/keys/{id}/revoke` | `X-Admin-Key` | Revoke a key |
| `PUT` | `/admin/keys/{id}/reset` | `X-Admin-Key` | Admin reset machine binding |
| `GET` | `/admin/keys/stats` | `X-Admin-Key` | Aggregate statistics |

---

## R2 Storage Layout

```
pidlab-telemetry[-dev]/
├── {installationId}/
│   ├── latest.json                 ← Most recent telemetry bundle (overwritten each upload)
│   └── metadata.json               ← { firstSeen, lastSeen, uploadCount }
├── diagnostics/
│   ├── _rate/{installationId}.json  ← Rate limit timestamps
│   └── {reportId}/
│       ├── bundle.json              ← Full diagnostic bundle
│       ├── metadata.json            ← Status, resolution, preview
│       └── flight.bbl               ← BBL flight data (optional, 30-day retention)
└── ...
```
