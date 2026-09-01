# Companion for macOS

CompanionMac is a native SwiftUI client for macOS 14 and later. It shares the zero-dependency
`CompanionKit` package with the iOS app and uses the same Better Auth session, models, polling, and
`/v1` API. It is a desktop-shaped first-party client, not a port of the phone layout and not a
reduced capability surface.

The main window uses a Mac-native three-zone layout. The left sidebar renders the shared owner
section projection and Companion rows, the center keeps the selected durable chat, and a persistent
right inspector renders that Companion's identity, character, Intelligence, routines and private
run history, Skills, triggers, connected accounts, instructions, notifications, and runtime
controls. Compact windows may collapse the inspector from the chat header. The window restores its
frame, while SwiftUI's split and inspector columns retain native resizing behavior.

Both native clients use the same `CompanionKit` theme, vector `CharacterMark`, status projection,
link policy, models, and API routes. The Mac chat follows the iOS two-sided 18-point bubble grammar,
approval/file/link cards, terse composer, and green/replying/gray/error dots without adding a
second visual or capability contract. The Appearance menu switches between System and Black OLED.

## Desktop access

An Owner or Editor can open the selected running Companion's Box desktop from chat. CompanionMac
calls `POST /v1/companions/:id/runtime/desktop` through `CompanionKit`, receives one fresh
`desktop_url`, and presents that URL in a dedicated native window backed by `WKWebView`.

`desktop_url` is a short-lived, secret-bearing handoff to the same Lux-driven Box screen used by
the web client. Its `transport` is `vnc` when Box can provide the firewall-friendly WebSocket
stream and otherwise `webrtc`; `automation` is `lux`. A null URL with `provisioning: true` means an
already-running Box is still preparing the desktop. Every reconnect mints a new URL. The app keeps
the URL in memory only, never logs or persists it, and never uses desktop access to start or wake a
Box. Viewer requests remain unavailable before any Box contact.

## Local build

Open `apps/ios/Companion.xcworkspace` and select the `CompanionMac` scheme. Debug accepts
`COMPANION_API_URL` for a local stack; Release always uses `https://api.thecompanion.sh`.

The repository's local Apple tooling policy requires XcodeBuildMCP for interactive discovery,
build, test, launch, screenshot, and UI inspection. Apple CI continues to use native `swift test`
and `xcodebuild` commands. Changes under `apps/macos/` select the Mac path in the existing five-minute
Apple Quality job, which tests `CompanionKit` and the `CompanionMac` scheme without booting a
simulator or running UI tests.

## TestFlight distribution

Release uses the existing `dev.companion.mobile` identity and App Store Connect record `6804447784`
so Companion is one multi-platform iOS + macOS app. It keeps the production API pinned to
`https://api.thecompanion.sh`, enables App Sandbox and hardened runtime, and declares no non-exempt
encryption. Debug keeps the registered development identity and local API override.

The `Release: macOS TestFlight` workflow archives and uploads only the exact `main` commit already
approved by CI, and only when that approved push changes `apps/macos/**`. It uses the protected
`macos-testflight` environment and a dedicated Apple Distribution certificate plus Mac App Store
provisioning profile. The workflow uploads to App Store Connect; it never submits an App Store
version for review. See `docs/DEPLOYER-MACOS-TESTFLIGHT.md` for credential setup, reruns, and manual
verification.
