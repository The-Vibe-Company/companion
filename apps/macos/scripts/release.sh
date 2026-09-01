#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MACOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_PATH="$MACOS_DIR/../ios/Companion.xcworkspace"
EXPORT_OPTIONS_PATH="$MACOS_DIR/Config/ExportOptions.plist"

: "${ASC_KEY_ID:?ASC_KEY_ID is required}"
: "${ASC_ISSUER_ID:?ASC_ISSUER_ID is required}"
: "${MACOS_PROVISIONING_PROFILE_SPECIFIER:?MACOS_PROVISIONING_PROFILE_SPECIFIER is required}"

BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M%S)}"
if [[ ! "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "BUILD_NUMBER must contain digits only" >&2
  exit 1
fi

if [[ -n "${RELEASE_OUTPUT_DIR:-}" ]]; then
  OUTPUT_DIR="$RELEASE_OUTPUT_DIR"
else
  OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/companion-macos-release.XXXXXX")"
fi
mkdir -p "$OUTPUT_DIR"

ARCHIVE_PATH="$OUTPUT_DIR/CompanionMac-${BUILD_NUMBER}.xcarchive"
EXPORT_PATH="$OUTPUT_DIR/export-${BUILD_NUMBER}"
if [[ -e "$ARCHIVE_PATH" || -e "$EXPORT_PATH" ]]; then
  echo "Release output already exists for build $BUILD_NUMBER in $OUTPUT_DIR" >&2
  exit 1
fi

KEY_TEMP_DIR=""
cleanup_key() {
  if [[ -n "$KEY_TEMP_DIR" ]]; then
    rm -f "$KEY_TEMP_DIR/AuthKey_${ASC_KEY_ID}.p8"
    rmdir "$KEY_TEMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup_key EXIT

if [[ -n "${ASC_KEY_PATH:-}" ]]; then
  KEY_PATH="$ASC_KEY_PATH"
elif [[ -n "${ASC_KEY_P8:-}" ]]; then
  KEY_TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/companion-asc-key.XXXXXX")"
  KEY_PATH="$KEY_TEMP_DIR/AuthKey_${ASC_KEY_ID}.p8"
  umask 077
  printf '%s\n' "$ASC_KEY_P8" > "$KEY_PATH"
else
  echo "ASC_KEY_PATH or ASC_KEY_P8 is required" >&2
  exit 1
fi

if [[ ! -r "$KEY_PATH" ]]; then
  echo "App Store Connect API key is not readable" >&2
  exit 1
fi

AUTH_ARGS=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$KEY_PATH"
  -authenticationKeyID "$ASC_KEY_ID"
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
)

SIGNING_ARGS=(
  CODE_SIGN_STYLE=Manual
  "CODE_SIGN_IDENTITY=Apple Distribution"
  "PROVISIONING_PROFILE_SPECIFIER=$MACOS_PROVISIONING_PROFILE_SPECIFIER"
)

echo "Archiving Companion for macOS 2.0.0 ($BUILD_NUMBER)..."
xcodebuild archive \
  -workspace "$WORKSPACE_PATH" \
  -scheme CompanionMac \
  -configuration Release \
  -destination "generic/platform=macOS" \
  -archivePath "$ARCHIVE_PATH" \
  "${AUTH_ARGS[@]}" \
  "${SIGNING_ARGS[@]}" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  2>&1 | tee "$OUTPUT_DIR/archive.log"

echo "Uploading Companion for macOS 2.0.0 ($BUILD_NUMBER) to App Store Connect..."
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS_PATH" \
  -exportPath "$EXPORT_PATH" \
  "${AUTH_ARGS[@]}" \
  2>&1 | tee "$OUTPUT_DIR/export.log"

echo "Upload accepted for Companion for macOS 2.0.0 ($BUILD_NUMBER)."
echo "Release output: $OUTPUT_DIR"
