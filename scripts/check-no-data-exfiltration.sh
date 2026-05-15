#!/bin/bash

# Pre-commit hook: Check for data exfiltration to external servers
# This script prevents commits that contain patterns suggesting data is being sent to external services

set -e

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

ERRORS=0

# Get staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx|js|jsx)$' || true)

if [ -z "$STAGED_FILES" ]; then
  exit 0
fi

echo "🔍 Checking for data exfiltration patterns..."

# Patterns that indicate data being sent to external servers
# These are patterns that would be suspicious
FORBIDDEN_PATTERNS=(
  # Fetch/axios to non-localhost/relative URLs
  'fetch\s*\(\s*["\x27]https?:\/\/(?!localhost|127\.0\.0\.1)'
  'axios\s*\.\s*(get|post|put|patch|delete)\s*\(\s*["\x27]https?:\/\/(?!localhost|127\.0\.0\.1)'

  # New external API calls (excluding already approved ones)
  # This is a whitelist approach - only approved external services

  # Suspicious data transmission patterns
  'new\s+URL\s*\(\s*["\x27]https?:\/\/(?!localhost|127\.0\.0\.1).*api'
  'FormData.*append.*token'
  'new\s+XMLHttpRequest.*open.*https?:\/\/(?!localhost|127\.0\.0\.1)'
)

# Whitelist of approved external services
APPROVED_HOSTS=(
  'api\.linear\.app'           # Linear API - explicitly approved when user configures it
  'api\.anthropic\.com'        # Anthropic API - for models and usage
  'us\.i\.posthog\.com'        # PostHog - now disabled, but approval for historical code
)

check_files() {
  local pattern=$1
  local file_list=$2

  while IFS= read -r file; do
    if [ -z "$file" ]; then
      continue
    fi

    # Skip test files and node_modules
    if [[ "$file" =~ \.test\.(ts|tsx|js|jsx)$ ]] || [[ "$file" =~ node_modules ]]; then
      continue
    fi

    # Check if pattern exists in the file
    if grep -E "$pattern" "$file" > /dev/null 2>&1; then
      # Check against whitelist
      local is_approved=0
      for approved in "${APPROVED_HOSTS[@]}"; do
        if grep -E "$pattern" "$file" | grep -q "$approved"; then
          is_approved=1
          break
        fi
      done

      if [ $is_approved -eq 0 ]; then
        echo -e "${RED}❌ Potential data exfiltration in: $file${NC}"
        echo -e "   Pattern: $pattern"
        grep -n -E "$pattern" "$file" | head -3 || true
        ERRORS=$((ERRORS + 1))
      fi
    fi
  done <<< "$file_list"
}

# Check for new external API calls (excluding Analytics which is now disabled)
echo "📋 Scanning for external API calls..."
EXTERNAL_API_PATTERN='fetch\s*\(\s*["\x27](https?:\/\/[^"'"'"']*)?'

while IFS= read -r file; do
  if [ -z "$file" ] || [[ "$file" =~ \.test\.(ts|tsx|js|jsx)$ ]]; then
    continue
  fi

  # Find all fetch calls with external URLs
  while IFS= read -r line; do
    if [[ $line =~ https?:\/\/ ]]; then
      # Extract the URL
      URL=$(echo "$line" | grep -oE 'https?://[^"'"'"'/)]+' | head -1)

      # Check if it's an approved host
      local is_approved=0
      for approved in "${APPROVED_HOSTS[@]}"; do
        if [[ "$URL" =~ $approved ]]; then
          is_approved=1
          break
        fi
      done

      # Check for analytics imports (now disabled)
      if [[ "$file" == "web/src/analytics.ts" ]]; then
        is_approved=1  # analytics.ts is the place to disable analytics
      fi

      if [ $is_approved -eq 0 ] && [[ ! "$URL" =~ ^https?://(localhost|127\.0\.0\.1) ]]; then
        echo -e "${RED}❌ New external API call detected in: $file${NC}"
        echo -e "   URL: $URL"
        echo -e "   If this is intentional, add the host to APPROVED_HOSTS in this script"
        ERRORS=$((ERRORS + 1))
      fi
    fi
  done < <(grep -n "fetch\s*(" "$file" 2>/dev/null | grep "https://" || true)
done <<< "$STAGED_FILES"

# Check for suspicious new imports
echo "📦 Checking for suspicious imports..."
SUSPICIOUS_IMPORTS=(
  'import.*posthog'
  'import.*segment'
  'import.*sentry'
  'import.*datadog'
  'import.*mixpanel'
  'import.*amplitude'
  'import.*rudderstack'
)

while IFS= read -r file; do
  if [ -z "$file" ] || [[ "$file" =~ \.test\.(ts|tsx|js|jsx)$ ]]; then
    continue
  fi

  # Skip analytics.ts (it's where we disable these)
  if [[ "$file" == "web/src/analytics.ts" ]]; then
    continue
  fi

  for import in "${SUSPICIOUS_IMPORTS[@]}"; do
    if grep -E "$import" "$file" > /dev/null 2>&1; then
      echo -e "${RED}❌ Suspicious import in: $file${NC}"
      echo -e "   Pattern: $import"
      echo -e "   Analytics libraries should only be in web/src/analytics.ts"
      ERRORS=$((ERRORS + 1))
    fi
  done
done <<< "$STAGED_FILES"

# Final report
echo ""
if [ $ERRORS -eq 0 ]; then
  echo -e "${GREEN}✅ No data exfiltration patterns detected${NC}"
  exit 0
else
  echo -e "${RED}❌ Found $ERRORS potential data exfiltration issue(s)${NC}"
  echo -e "${YELLOW}⚠️  If these are legitimate (e.g., approved services), update the whitelist${NC}"
  exit 1
fi
