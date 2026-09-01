# Companion for iOS

Companion is a native SwiftUI app for iOS 26 and later. It replaces the former Expo client and
keeps the existing `dev.companion.mobile` App Store Connect identity.

The canonical source repository for the native app is
[`The-Vibe-Company/companion`](https://github.com/The-Vibe-Company/companion).

The iOS app is another complete Companion client, not a reduced mobile product. It uses the same
`/v1` API and is intended to reach feature parity with the current browser experience, including
Skills, Plugins, MCP connections, files, routines, triggers, sharing, settings, and every Companion
control-plane workflow. Do not create mobile-only endpoints or send a client-surface discriminator
to request a smaller capability set.

The app target lives in `Companion/`. Models, networking, authentication, session state,
synchronization, and on-device projection persistence belong in the zero-dependency `CompanionKit`
Swift package. The committed Xcode project uses
file-system-synchronized groups, so adding a Swift file does not require a project-file edit.

The approved iOS visual language and journeys live in `docs/ios-design.md`. The native roster uses
one vector `CharacterMark` everywhere: one of eight shapes, one of eleven system colors, and two
white eyes. Mouth and accessory indexes remain transport-compatible but are not rendered or
selectable. Creation asks only for a name, optional title, shape, and color, then opens the chat.

The native roster groups Companions into collapsible, owner-scoped sections and keeps Unassigned at
the bottom. Every section uses flat 36pt-mark rows with a title, one-line preview, hierarchical
timestamp followed by an 8pt runtime-status dot in a fixed trailing slot, and unread dot; there is no automatic grid threshold. The same 8pt
status dot trails the Companion name inside the chat-header pill. Running is green, Pi-acknowledged
replying uses a restrained green pulse, runtime error is red, and every other projected lifecycle
state is gray. Reduce Motion keeps replying as a static green dot. Both surfaces consume the runtime
fields already present in the ordinary Companion list projection and add no fetch or polling loop. Native
Move to/New Section flows use the shared section API. Deleting a section only unassigns its members.
Single tap opens the chat. Long press exposes Settings, Duplicate, Move to, and Delete; trailing swipe exposes Move,
member-private notification mute, and owner-only delete.

After the first successful roster read, native iOS restores the member-and-organization-scoped
Companion roster from a protected, backup-excluded SQLite snapshot before its first roster frame.
The one-time empty-cache path uses stable row skeletons; later launches keep cached rows visible
offline and revalidate with one `GET /v1/companions/sync` request. Its opaque cursor returns only
changed Companion/section projections, deletion tombstones, and current ID order. Entering the
foreground runs the same delta revalidation. The most recently active Companion's bounded 250-entry
transcript tail is prefetched, and every successfully synchronized thread tail is persisted. The
live synchronized thread remains complete in memory; only the on-device restore tail is bounded.
Prefetch/background reads preserve unread state. Chat installs that read-only cached projection
immediately, then calls
`GET /v1/companions/:id/thread-delta`; fresh metadata is required before send, attachment,
transcription, or decision controls become active, and the visible chat explicitly clears unread.
Legacy cached thread cursors that exceed the transport-safe request budget are omitted so the app
can recover with one complete synchronization instead of sending an oversized URL. A proxy
`414`/`431` response receives the same single no-cursor recovery attempt.
SQLite never stores attachment bytes and is purged for that member/workspace scope on logout or
invalid session.

The native roster can request Owner-only durable deletion. A confirmed deletion removes the Companion from the
local roster immediately while the durable request runs; request failure restores the row, and a
later roster poll may honestly reintroduce a Companion the control plane still returns. Each roster
row opens the Companion's chat directly; Settings in its long-press menu opens the one details page. That page owns the character,
name, instructions, provider and model, routines and run history, notifications, Skills, plugins,
selected MCP accounts, triggers, runtime restart controls, and Owner-only deletion. The chat header
pill opens the same page, while its explicit **Open chat** action replaces the detail route so chat
and detail do not accumulate duplicate cycles. Identity editing keeps the shared shape and color
character picker; Viewer access remains read-only. Opening a thread advances that member's unread
watermark, so there is no separate Mark as read command; Mark as unread remains available through
the existing member-state endpoint. The current list contract projects unread as a Boolean, so
native iOS shows one accessible unread indicator rather than inventing an exact message count.
The existing projection returns only the viewing member's private account ids. Owner-only MCP
attachment changes use the existing `selected_mcp_account_ids` replacement update and never disable
or delete the underlying Plugins connection; Editors and Viewers retain the documented read-only
rules. Routine rows open newest-first durable run history, including status, outcome, timestamps,
bounded internal transcript pages, and safe errors. A routine-origin chat entry is a compact
clickable marker instead of a prompt bubble; it opens that exact run, while surfaced `relay` and
`notify` outputs remain ordinary main-thread history. These reads use the shared bounded API,
remain available to Viewers, and never wake Box or Pi. The details page queues the existing Pi-only
restart. Trigger rows are a distinct result surface beside plugins: they show provider, notify/relay
mode, remote registration state, retry failures, and newest-first fire history with bounded received
payloads. Trigger provider accounts connect once at member level and are immediately usable by every
Companion without an attachment step. GitHub and Sentry normally share their encrypted MCP OAuth
credential; Linear and supported fallbacks use one encrypted member-level API key. Creation and chat
approval let Companion register the remote webhook end to end, without a callback-URL prompt or
manual provider-console setup. The platform URL and secret rotation remain collapsed technical controls for editors only. The
details page queues the existing Pi-only restart as **Restart Companion** and the existing full-Box
restart as **Restart server**; both are
confirmed, idempotent lifecycle intents whose PostgreSQL-projected queued/stopping/starting/completed
state is polled without contacting Box or Pi. Viewer sees the page read-only, including redacted
unavailable plugin selections, and never receives mutation or restart controls. The
native thread renders every durable decision request. Owner and Editor can answer `ask_user`,
approve or deny asynchronous Companion control changes for models, OAuth, routines, triggers, and
peer grants, and handle historical shell/file and legacy proposal
requests without leaving iOS. An interrupted turn is equally explicit for Owner, Editor, and Viewer:
iOS shows its automatic cleanup state, makes clear that the ambiguous prompt is never replayed, and
keeps the composer available while later messages continue in order. The compatibility Retry API
remains transport-compatible for older clients but the current app requires no manual recovery
control. Routine run history polls every four seconds while that exact run's cleanup is pending or
running and preserves transcript pages already loaded by the member. After cleanup, the occurrence
remains durable history without a persistent conversation-tail card. The roster also manages model
providers and MCP plugins. Provider
connections support encrypted API keys plus the shared Claude authorization-code and Codex device
flows. The live server catalog includes Claude, Codex, Kimi, Moonshot, z.ai, OpenAI API, and Google
Gemini; the app renders that catalog rather than maintaining a divergent mobile allowlist. Members
can connect multiple labeled accounts for each product-owned plugin category — Linear, GitHub,
Notion, Conductor, Slack, Gmail, and Sentry — through the existing brokered OAuth flow. Gmail can search and
read email, then create drafts for review in Gmail; it never sends mail. Custom MCP plugins remain
available over HTTP or a Box command with an optional encrypted credential, using the same shared
endpoints and transports as the browser client.

The chat composer also supports iOS-only voice transcription when the API deployment has a non-empty
`COMPANION_GEMINI_TRANSCRIPTION_API_KEY`. That API-only setting enables the capability globally;
the thread payload exposes only `transcription_available`, and the app omits the microphone entirely
when it is false or absent. When an Owner or Editor taps the microphone in an accessible thread,
the app records 16 kHz mono AAC locally. Stopping uploads that one `.m4a` recording to
`POST /v1/companions/:id/transcriptions`; the route reauthorizes access before reading it, loads a
bounded window of recent durable dialogue, and returns the contextualized final transcript. The
editable message field changes only after processing succeeds. The long-lived key never enters the
app binary or API response. Audio, the bounded context copy, and the provider response live only for
that API request and never persist in PostgreSQL, object storage, Box, Pi, or the transcript. The
provider-neutral recording surface discloses that audio and recent conversation are processed and
requires the standard iOS microphone permission.

This is client dictation into an ordinary text message, not Companion voice mode: it creates no
audio message or runtime capability and makes no Box/Pi change. Linux/static quality checks verify
the privacy wiring, while CompanionKit's multipart request tests and the native app build run
in the existing macOS 26 **Apple Quality** job. Rendered UI validation stays local and manual. No
Google key is required for those deterministic tests. A real end-to-end transcription remains a
manual provider check with the owner-supplied key stored only in the API deployment environment.

The API uses one stateless `gemini-3.7-flash` request with low thinking. It sends no tool configuration
or retained interaction id. Recent user/assistant entries are limited to 12 and 24,000 characters
and serialized as untrusted reference data in the one audio request, never as provider conversation
turns. The compressed recording is limited to 8 MB, keeping the complete inline request below the
provider's 20 MB ceiling. Recordings stop automatically after nine minutes. During the native-client
rollout, the API also retains the deprecated `POST /transcription-sessions` exchange so an installed
older build continues to work; the current client neither calls nor exposes that contract.

Push Notifications are requested immediately after the first active session. Debug registers
`dev.companion.mobile.dev` with the APNs sandbox; Release registers `dev.companion.mobile` with
production APNs. A tap waits for session and roster restoration, verifies the workspace and current
access, then opens the existing chat. Foreground alerts include banner, Notification Center list,
and sound unless that chat is already open. The app deliberately uses no numeric badge.
Every Companion event alert also carries `content-available: 1`, allowing the application callback
to invalidate the matching cached roster/thread projection while preserving the existing visible
alert pipeline. Notification delivery is queued until an active session can bind that invalidation
to the correct member/workspace cache scope.
Reply pushes also carry the Companion's four cosmetic icon indexes and `mutable-content: 1`. The
embedded Notification Service Extension projects `shape` and `color` from the nested
`companion_icon` dictionary into the same flat CharacterMark geometry used by the app, renders its
two white eyes into a PNG locally, then
uses it as the sender image for Apple's communication-notification treatment. No avatar endpoint,
credential, or network request is involved. If intent enrichment cannot finish, the extension
returns the same title/body with the PNG as a standard attachment; if the extension itself times
out, iOS displays the original plain alert. Mouth and accessory indexes remain payload-compatible
but cannot affect the notification image. Decision and failure alerts remain plain notifications.

Long-term native work is guided by the repo-local `ios-product-dev`, `swiftui-expert-dev`,
`design-frontend-dev`, and `xcodebuildmcp-cli` skills. Their iOS-specific packages are mirrored
byte-for-byte under `.agents/skills/` and `.claude/skills/` so Agents and Claude follow the same
product, architecture, accessibility, and verification rules.

## Local development

Start the repository stack with the default Conductor run, then run `pnpm ios:dev` from a Conductor
terminal. The launcher derives the API URL from `CONDUCTOR_PORT + 1`, builds the Debug app, and
starts it in an iOS simulator with a launch-argument override. It stays a terminal command because
Conductor Run actions are intentionally nonconcurrent for this repository.

```bash
pnpm ios:dev
```

Run package tests with:

```bash
xcodebuildmcp swift-package test --package-path apps/ios/CompanionKit
```

Release builds ignore launch arguments and environment variables and always use
`https://api.thecompanion.sh`.

### Live Box cycle from Conductor

Use the **iOS (live Box)** run when you want the complete local control plane with a real
box.ascii.dev Box and a real z.ai reply. Add these launcher-only values to the workspace `.env`:

```bash
BOX_API_KEY=<ascii.dev-key>
COMPANION_IOS_LOCAL_ZAI_API_KEY=<z.ai-key>
```

`COMPANION_BOX_API_KEY` is also accepted instead of `BOX_API_KEY`. Conductor copies `.env` files
into new workspaces through its standard file-copy behavior. The repository run mode is
`nonconcurrent`, so Conductor permits only one Run action at a time; the existing stack launcher
lock also refuses a duplicate stack inside the same workspace. There is no additional PID or lock
mechanism for iOS.

Select **iOS (live Box)** in Conductor, or run `pnpm ios:live` from a local macOS workspace. The
launcher forces live Box mode, starts PostgreSQL, API, worker, runtime, and web, waits for API and
runtime health, connects z.ai through the ordinary `/v1/companion-providers/zai` route, and then
builds and opens the Debug app through XcodeBuildMCP. It deliberately does not create a Companion.
Sign in with `admin@thevibecompany.co` / `adminadmin` unless `COMPANION_SEED_EMAIL` or
`COMPANION_SEED_PASSWORD` overrides the local seed.

Use this manual production-like check:

1. Confirm z.ai is connected under Providers, then create a Companion in the app.
2. Send a message and wait for the real Box/Pi/z.ai response.
3. Close and reopen the app with `pnpm ios:dev`; confirm the roster and thread return before and
   after fresh synchronization.
4. With the stack still running, stop exactly that Companion from a Conductor terminal:

   ```bash
   pnpm ios:live:stop -- --companion "Exact Companion name or id"
   ```

5. Confirm the app projects `stopped`, send another message, and verify the existing Box resumes
   and replies. Then exercise **Restart Companion** and **Restart server** in settings.
6. Delete the Companion in the app when cleanup is wanted and wait for it to disappear; this is the
   product path that permanently deletes its Box.

Stopping the Run keeps `.conductor-pg/` and the live Companion durable for the next launch. Do not
use Conductor Archive while retaining a live Companion: archive removes the workspace database,
whereas permanent live Box deletion must be requested from the app first.

## External authorization and Universal Links

Google sign-in and curated plugin authorization open in the device's default browser. Each Google
flow adds a cryptographically random native state to the existing callback URL and keeps that value
in memory until the matching callback arrives. A plugin flow binds the callback to the exact
`redirect_uri` and signed provider `state` returned by the authenticated start response. The
authorization code, signed state, PKCE values, and callback cookie remain owned by the existing API
contract; native iOS keeps only the short-lived callback handoff in memory.

Production plugin callbacks use
`https://thecompanion.sh/v1/companion-plugins/oauth/callback`, and the completion response must
redirect only to `https://thecompanion.sh/companions` with the documented OAuth result marker. The
committed AASA and production entitlement cover that signed domain. Local Conductor uses HTTP on a
loopback address, which cannot deliver an Apple Universal Link to the app; this production-signed
build therefore does not claim native plugin callback support for arbitrary self-hosted domains.
The client accepts a non-production origin only when the authenticated start response supplies that
exact origin; HTTP loopback still cannot deliver a Universal Link. Supporting a self-hosted native
callback would require a separately coordinated client policy, HTTPS domain, AASA document,
entitlement, and signed build.

The app entitlement includes `applinks:thecompanion.sh`. Release and Debug provisioning profiles
must be regenerated with Associated Domains enabled for their respective bundle IDs, and the
Apple team must be `K28B69CWQ7`. Production DNS/TLS must serve the committed AASA document at
`https://thecompanion.sh/.well-known/apple-app-site-association` with `application/json` and the
exact callback component. Verify Universal Link routing on a physical signed build; simulator
testing does not prove the production profile, entitlement, or AASA association.

The Debug-only `-companion-appearance-demo`, `-companion-plugins-multi-account-demo`, `-glass-chat-demo`, `-glass-chat-thinking-demo`, `-companion-queued-demo`, `-markdown-table-demo`,
`-glass-management-demo`, `-glass-management-demo-plugins`,
`-companion-icon-demo`, `-companion-create-demo`, `-companion-decision-demo`, `-companion-interruption-demo`,
`-companion-transcript-window-demo`,
`-companion-detail-demo`, and
`-companion-roster-demo` launch arguments
open deterministic showcases without requiring a server or account. Add `-companion-reduce-motion`
alongside `-companion-icon-demo` to force the gallery's Reduce Motion path. The detail demo accepts
`COMPANION_DETAIL_DEMO_ACCESS=owner|editor|viewer` for deterministic role and deletion UI tests.
The creation demo supplies deterministic provider and create responses so the shared identity icon gallery
can be exercised without an account or server.
The appearance demo persists through the same System / Black preference as Settings and shows a
snapshot-friendly roster card, both chat bubbles, and the primary CTA while the app-wide palette changes.
The multi-account plugins demo renders Linear with two connected accounts plus the add-account chip,
so their shared chip fill and primary text treatment can be inspected without a server.
The decision demo accepts `COMPANION_DECISION_DEMO_ACCESS=owner|editor|viewer` for the matching
decision controls. Set `COMPANION_DECISION_DEMO_FAIL_ONCE=<request-id>` to exercise a failed
submission followed by an enabled retry.
Add `-markdown-table-dark-demo` alongside `-markdown-table-demo` to exercise the table gallery with
the adaptive Companion color tokens in dark appearance.
The interruption demo shows a deterministic running automatic recovery, including the no-replay
promise and automatic FIFO continuation, with no manual Retry or Cancel action.
Set `COMPANION_TRANSCRIPT_DEMO_SHORT=1` with `-companion-transcript-window-demo` to exercise the
same mixed chat surface in a short thread; the default fixture keeps the 120-entry load-more path.
Set `COMPANION_TRANSCRIPT_DEMO_STAGED_POLL=1` with `-companion-transcript-window-demo` to stage a
deterministic active assistant-tail arrival on the first poll after tapping `Stage reply`; this lets
the native UI regression leave the tail before exercising the unseen-reply pill.
The queued-message demo accepts `COMPANION_QUEUED_DEMO_ACCESS=owner|editor|viewer`; set
`COMPANION_QUEUED_DEMO_FAIL_ONCE=1` to verify that a failed removal remains retryable.
The roster demo accepts the equivalent `COMPANION_ROSTER_DEMO_ACCESS` value and simulates immediate
removal, restoration after a lost first deletion response, and a same-key `202` retry. These
arguments are excluded from Release behavior.
The detail demo accepts `COMPANION_DETAIL_DEMO_EMPTY=skills|triggers` to show one absorbed resource
card's deterministic empty state.
Combine `-glass-chat-demo -glass-chat-thinking-demo` to keep the composer-adjacent thinking status
visible and connect its tap target to the demo reply's collapsed reasoning disclosure.
Combine `-companion-roster-demo -companion-notification-demo` to inject a version-1 response payload
and verify deferred navigation to Luna's chat without contacting APNs.

Native chat layout regressions use the deterministic transcript-window demo for focused local and
manual UI verification. Apple Quality's iOS path stays below five minutes by running the
`CompanionKit` behavior tests and compiling the complete app for a generic iOS Simulator
destination without booting one or invoking XCUITests. Its separate conditional skill path keeps
the Darwin-only private-transport guard.
The poll-stability assertion launches that fixture, observes the latest entry across one real
four-second poll, and verifies that the latest entry remains hittable without a scroll-to-bottom
overlay. Initial placement is the loaded scroll view's role-scoped bottom layout anchor; it is not
an imperative request and does not apply again when poll, markdown, composer, or safe-area changes
resize the content. Every later scroll decision is delegated to the shared
`CompanionScrollCoordinator`, so repeated unchanged snapshots do not compete with the rendered
viewport.
Linux quality still protects the keyboard-dismissal gesture mechanics without launching the app;
the rendered fixture remains local and manual. It focuses the composer, taps a message, verifies
the keyboard disappears, and then opens a tool card to prove message controls still receive their
taps. The focus change is intentionally silent; dismissing a keyboard does not produce haptic
feedback.
The same fixture can switch between Luna and Orbit to verify that the roster-scoped, in-memory
reading-position store restores the first visible message without animated hydration. CompanionKit
tests cover per-Companion isolation and window restoration; the rendered switch-and-return check
remains available for local interactive verification.

Every persisted user and Companion message is parsed through the same native rich-text renderer.
It preserves headings, bold/emphasis, inline and block code, lists, quotes, tables, and emoji while
turning bare HTTP(S) URLs and Markdown links into adaptive system-blue actions. Links open through
the shared external URL launcher and use the native Open / Copy long-press menu. Black appearance
uses the lighter dark-surface blue without changing the inverted member-bubble contrast. The
Computer screen is only the ephemeral remote desktop and does not render a second transcript.

Queued messages stay collapsed above the composer until opened. Owner and Editor can remove an
unstarted queued turn through the shared cancel route; Viewer remains read-only. The shared `/v1`
contract does not expose a queued-message edit mutation, so iOS does not offer editing or invent a
mobile-only replacement endpoint. This interaction follow-up calls that action Delete in the queue
and still sends the existing cancel request; cancel-and-resend is not an edit. Reply or thread
actions and regenerate are deliberately out of scope here and remain unavailable until the shared
contract provides those mutations.

## TestFlight release

The `iOS TestFlight` workflow archives and uploads the Release app only after the matching `CI`
workflow succeeds for an iOS change on `main`. It checks out that exact approved commit on the
macOS 26 runner, verifies the complete approved push range, and checks the iPhoneOS 26 SDK before
signing. It has no arbitrary-ref manual dispatch; an existing delivery can be retried from its
GitHub Actions run. The workflow uses the protected `ios-testflight` environment and the
`ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`,
`IOS_DISTRIBUTION_P12`, `IOS_DISTRIBUTION_P12_PASSWORD`, `IOS_PROVISIONING_PROFILE`, and
`IOS_NOTIFICATION_EXTENSION_PROVISIONING_PROFILE` secrets. The signing certificate and profiles
are installed only for the release job and removed afterward.

The archive embeds `CompanionNotificationService` with production bundle id
`dev.companion.mobile.notifyextension` (Debug uses the containing app prefix
`dev.companion.mobile.dev.notifyextension`). The app profile must include Push Notifications and
Communication Notifications; the extension needs its own App Store distribution profile. The
extension has no separate entitlement file and makes no network request.

Before distributing a push-enabled build, enable Push Notifications and Communication Notifications
on the app App ID, register the extension App ID, and replace both provisioning-profile secrets with
matching regenerated profiles. Deploy migrations 0124 and 0131 before that build, and configure the
worker-only `COMPANION_APNS_KEY_ID`, `COMPANION_APNS_TEAM_ID`, and base64-encoded
`COMPANION_APNS_PRIVATE_KEY_BASE64`. Validate background, terminated, foreground, decision,
failure, and tap routing on a physical/TestFlight device with Apple's Push Notification Console. Removing all
three worker variables is the push rollback; turns and the iOS app continue to function.

If the matching `main` CI fails, no TestFlight delivery is created. A later successful CI run for
an unrelated change does not retroactively release the earlier iOS commit; land the CI fix with an
iOS-path follow-up so the approved push is explicitly eligible for a new upload.

For an authorized local release, provide the same App Store Connect credentials without copying the
private key into the repository:

```bash
ASC_KEY_ID="<key-id>" \
ASC_ISSUER_ID="<issuer-id>" \
ASC_KEY_PATH="/secure/path/AuthKey_<key-id>.p8" \
IOS_PROVISIONING_PROFILE_SPECIFIER="Companion Native App Store 2026-08-24" \
IOS_NOTIFICATION_EXTENSION_PROVISIONING_PROFILE_SPECIFIER="Companion Notification Service App Store 2026-08-26" \
bash apps/ios/scripts/release.sh
```

The build number defaults to the current UTC second in `YYYYMMDDHHMMSS` form and can be overridden
with `BUILD_NUMBER`. A successful export uploads to App Store Connect; it never submits the build
for App Store review.
