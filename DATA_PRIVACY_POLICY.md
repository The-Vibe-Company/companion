# Data Privacy & Exfiltration Prevention Policy

## Overview

This project has a strict policy: **No user data is transmitted to external services without explicit user consent.**

## Pre-Commit Verification

A pre-commit hook (`scripts/check-no-data-exfiltration.sh`) automatically checks all staged code before commits to prevent data exfiltration.

### What the check does:

1. **Scans for external API calls** - Detects `fetch()` and `axios` calls to non-localhost URLs
2. **Validates against whitelist** - Only approved external services are allowed
3. **Checks for analytics imports** - Prevents unauthorized analytics libraries
4. **Prevents suspicious patterns** - Looks for data transmission patterns

## Approved External Services

The following external services are whitelisted and approved for communication:

| Service | URL | Purpose | Policy |
|---------|-----|---------|--------|
| **Linear** | `api.linear.app` | Issue tracking integration (opt-in) | Only when user explicitly configures |
| **Anthropic** | `api.anthropic.com` | Model availability & usage limits | Only with user's Anthropic API key |

## Disabled Services

The following services have been **completely disabled** to protect user privacy:

| Service | Status | Details |
|---------|--------|---------|
| **PostHog** | 🔴 Disabled | Analytics removed from `web/src/analytics.ts` |
| All other analytics | 🔴 Disabled | No telemetry collection |

### PostHog Removal Details

- Removed all `posthog` imports and initialization
- All analytics functions are now no-ops (empty operations)
- No events, errors, or page views are sent
- Existing code that calls `captureEvent()` etc. works but does nothing

## For Developers

### Adding New External Service Calls

If you need to add communication with an external service:

1. **Whitelist the service** in `scripts/check-no-data-exfiltration.sh`
   ```bash
   APPROVED_HOSTS=(
     'api.example.com'  # Add your service here
   )
   ```

2. **Document why** in this file under "Approved External Services"

3. **Get explicit user consent** - Services that transmit user data must have:
   - Clear UI disclosure
   - User opt-in/opt-out controls
   - Documented privacy implications

4. **Never transmit without consent**
   - Chat history ❌
   - User code ❌
   - Project files ❌
   - Session IDs (identifiable) ❌

### Legitimate External Calls

Some services require external calls but are designed for privacy:

- **Linear API** - Only credentials you provide, only issues you explicitly interact with
- **Anthropic API** - Only your own API key, no third-party tracking

## Testing the Check

Run the pre-commit check manually:

```bash
bash scripts/check-no-data-exfiltration.sh
```

Force a commit without the check (not recommended):

```bash
git commit --no-verify
```

## Privacy Guarantees

Users can trust that:

✅ Chat conversations stay local (unless Linear integration is explicitly used)
✅ No analytics or telemetry collection
✅ No user behavior tracking
✅ No background data transmission
✅ API keys are never shared with third parties
✅ All checks are open source and auditable

## Questions?

For privacy concerns or suggestions, please review:
- This file: `DATA_PRIVACY_POLICY.md`
- Pre-commit script: `scripts/check-no-data-exfiltration.sh`
- Analytics configuration: `web/src/analytics.ts`
