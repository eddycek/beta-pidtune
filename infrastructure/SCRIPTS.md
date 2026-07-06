# Admin Scripts

Admin scripts in `infrastructure/scripts/` auto-load secrets from `.env.local` in the repo root and prompt for environment (dev/prod) on startup.

All scripts default to **dev**. To target **prod**, either select "2" in the prompt or:

```bash
PIDLAB_ENV=prod ./infrastructure/scripts/generate-key.sh
```

## License Key Management

```bash
# Generate a new license key (interactive — asks for email, type, note)
./infrastructure/scripts/generate-key.sh

# List all keys
./infrastructure/scripts/list-keys.sh

# List with filters
./infrastructure/scripts/list-keys.sh --status active
./infrastructure/scripts/list-keys.sh --type tester

# View key statistics
./infrastructure/scripts/key-stats.sh

# Revoke a key (interactive — asks for key ID)
./infrastructure/scripts/revoke-key.sh

# Reset machine binding (interactive — asks for key ID)
./infrastructure/scripts/reset-key.sh
```

## Telemetry Analytics

```bash
# Everything in one call
./infrastructure/scripts/telemetry-full.sh

# Individual endpoints:
./infrastructure/scripts/telemetry-stats.sh         # Installs, active 24h/7d/30d, modes, platforms
./infrastructure/scripts/app-versions.sh             # FPVPIDlab app version distribution
./infrastructure/scripts/telemetry-bf-versions.sh    # Betaflight firmware versions
./infrastructure/scripts/telemetry-drones.sh         # Drone sizes + flight styles
./infrastructure/scripts/telemetry-quality.sh        # Quality score histogram + average
./infrastructure/scripts/telemetry-sessions.sh       # Tuning sessions: total, per-mode, top users
./infrastructure/scripts/telemetry-features.sh       # Feature adoption (analysis, snapshots, history)
./infrastructure/scripts/telemetry-blackbox.sh       # Blackbox: logs downloaded, compression, storage
./infrastructure/scripts/telemetry-profiles.sh       # Profile count distribution

# V2 analytics (requires v2 bundles with per-session data):
./infrastructure/scripts/telemetry-rules.sh          # Rule effectiveness: fire/apply rates, avg delta
./infrastructure/scripts/telemetry-metrics.sh         # Metric distributions: noise, overshoot, bandwidth
./infrastructure/scripts/telemetry-verification.sh    # Verification success rates by tuning mode
./infrastructure/scripts/telemetry-convergence.sh     # Quality score convergence across sessions

# V3 analytics (requires v3 bundles with structured events):
./infrastructure/scripts/telemetry-errors.sh           # Error breakdown: types, unique installs, funnel dropoff
./infrastructure/scripts/telemetry-events.sh           # Raw structured events by installation
```

## Diagnostic Report Management

```bash
# List reports (default: all, filter by status)
./infrastructure/scripts/diagnostic-list.sh
./infrastructure/scripts/diagnostic-list.sh --status new

# Mark report as reviewing
./infrastructure/scripts/diagnostic-review.sh <reportId>

# Resolve report (resolution required: fixed | user-error | known-limitation | wontfix;
# optional message sends email to user if they provided one)
./infrastructure/scripts/diagnostic-resolve.sh <reportId> fixed "Fixed in v0.2.0 — LPF1 threshold adjusted"

# Add internal note (not visible to user)
./infrastructure/scripts/diagnostic-note.sh <reportId> "Reproducible with RPM filter disabled"
```

Or use the `/diagnose` Claude Code skill: `/diagnose <reportId>` (investigates bundle, cross-references code, proposes fix).

## Health Checks

```bash
curl -sf https://telemetry-dev.fpvpidlab.app/health
curl -sf https://license-dev.fpvpidlab.app/health
```

## Ed25519 Keypair

```bash
# Generate new Ed25519 keypair (one-time, output goes to 1Password + GitHub secrets)
./infrastructure/scripts/generate-ed25519-keypair.sh
```
