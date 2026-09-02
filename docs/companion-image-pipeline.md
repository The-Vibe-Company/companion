# Companion image pipeline (design)

Status: phase 1 implemented; phases 2 and 3 remain follow-up work.

## Problem

Companion creation is slow and fragile, and every modification to the provisioning path
regresses something. The root cause is architectural: the runtime Box image is not an
entity. Its state lives only in an ascii.dev snapshot name (a content hash) plus
in-memory baker state plus shell markers inside a Box. Nobody can answer "what is the
state of image X?" by reading PostgreSQL.

Consequences observed over ~28 fix/perf commits:

- The baker retries failures on a fixed 30 s loop forever, silently (`companionRuntimeBaker.ts`).
- A Companion create that does not see a ready image within 10 s falls back to a full
  cold install (~300 s). The first Companion after any pin bump always pays this.
- Races between the baker and concurrent Box creates required a chain of patches
  ("tolerate image warmup races", "attest image-owned autoresearch Pi", "repair
  autoresearch snapshot attestation") plus a 5k-line diagnostic subsystem.
- Shell-label contracts are fail-open: an unlabeled `ensure-pi-layout.sh` success parses
  as `"base"` (full reinstall), so truncated output causes repeated expensive relayouts.

## Industry convergence

Every comparable system converged on the same model; we are on the abandoned one:

| Pattern | E2B | Morph | OpenHands | HCP Packer | Us today |
| --- | --- | --- | --- | --- | --- |
| Image = declarative, versioned registry entity with published status | templates | templates | image tags | registry | hash in a name |
| Create references an explicit image id | yes | `snapshot_id` | tag | channel | heuristic fallback after 10 s |
| Async build with published progress/events | build events | build events | — | webhook | silent retry loop |
| Setup cached per step | template build | step cache | layer cache | builder | full reinstall on ambiguity |

E2B documents explicitly that declarative template builds beat captured live snapshots
for cold start; snapshots should be reserved for checkpointing a running Box, not for
distributing the base environment.

## Design principles

1. Everything that exists is a durable row whose desired state and observed state are
   separated; everything touching Box/Pi is an idempotent reconciler between the two.
2. Fail closed: unreadable output or ambiguous provider responses become explicit,
   persisted errors — never silent fallbacks.
3. One typed contract module per cross-layer concept; no duplicated strings, names, or
   SQL bodies across api/runtime/worker/migrations.
4. Every entry point carries a client idempotency key.

## Phase 1 — the image registry

New table `companion_images` (infrastructure-level, not tenant-scoped: digests are
content-derived and shared across organizations):

```
digest            text PK      -- full layout identity marker hash
image_name        text UNIQUE  -- ascii.dev snapshot name
status            requested | building | ready | failed
parent_image_name text         -- clone parent used by the bake
build_box_id      text
build_delete_intent_at timestamptz -- durable write intent before irreversible DELETE
build_delete_operation_id text -- accepted provider DELETE, resumed without replay
attempt_count     int
last_error_code / last_error_message
claimed_at / claim_epoch / claim_actor_id   -- monotonic fenced single-builder lease
requested_at / building_at / ready_at
created_at / updated_at
```

Semantics:

- Any actor needing an image upserts `(digest → requested)` if no ready row exists.
  This is idempotent and race-free (upsert).
- A builder loop in `apps/runtime` claims only its exact configured `(digest, image_name)`
  via compare-and-set lease (epoch), drives the existing bake steps, and persists
  every transition: `building`, per-attempt errors with capped exponential backoff,
  terminal `ready` or `failed`.
- Backoff uses jittered `[1m, 5m, 15m, 60m]` bases, max 4 attempts, then `failed`. The
  next-attempt instant is durable, and the dedicated builder poll never occupies a Turn/lane slot.
  A request after a ten-minute terminal cooldown starts a fresh four-attempt cycle. Failure is
  visible in operational image health while Box creation immediately cold-installs.
- Phase 1 does not prune provider snapshots. Deleting a snapshot while its registry row remains
  `ready` would publish a false clone source. Registry-aware retention/garbage collection belongs
  to phase 3; until then, a provider snapshot-limit error fails visibly and creation takes the
  explicit cold-install path.
- `build_box_id` is cleared only after provider deletion succeeds behind the active epoch fence.
  Runtime stores `build_delete_intent_at` before issuing the irreversible call, then stores an
  accepted operation in `build_delete_operation_id` before polling. Takeover resumes a known
  operation. If the accepted response or its checkpoint is lost, takeover performs only read-only
  absence reconciliation and never replays `DELETE`; the baker Box's bounded TTL supplies eventual
  cleanup. A failed or blocked cleanup leaves the intent and both pointers durable. An expired
  fourth attempt is reclaimable for cleanup and terminal settlement, but can never start a fifth
  bake.
- `claim_epoch` is monotonic for the lifetime of a digest row and is never reset on settlement;
  otherwise a stale writer from attempt 1 could become valid again when a later claim reused 1.

### Builder contract

`packages/companion-runtime/src/imageRegistry.ts` exposes a store-agnostic service:

- `requestImage({ digest, imageName })` — idempotent upsert to `requested`.
- `claimImageBuild({ executorId, digest, imageName })` — leases only that exact claimable row
  (`requested`, or `building` past its lease, or `failed`-retryable past its backoff)
  using `FOR UPDATE SKIP LOCKED` + epoch CAS, returning any durable baker Box pointer and a
  cleanup-only recovery flag.
- `recordBuildOutcome(...)` — persists transition with epoch fence; stale epochs are
  no-ops (same fencing as operations).
- `authorizeSnapshotPublication(...)` — proves the exact epoch and baker Box still have enough
  lease headroom immediately before the bounded provider snapshot write.

Consistent with every other Runtime v2 surface, no process role holds table privileges
on `companion_images`. All access crosses narrow SECURITY DEFINER functions installed by
migration 0123 and granted to the dedicated runtime role only; the role verifier's
"no public relation privileges" invariant stays intact.

### What changes for creation

- `createGenerationBox` reads the registry once and clones only when the exact digest is already
  published `ready`. Missing, `requested`, `building`, stale, failed, or unreadable image state
  selects cold installation immediately; a Turn never waits for an image-builder deadline.
- Cold install is an attributed normal path: every create
  that cold-installs despite a snapshot source is logged with a `fallbackReason`
  (`image_missing`, `image_build_pending`, `image_build_stale`, `image_build_failed`,
  `image_registry_unavailable`, or `unknown_snapshot_fallback`)
  and counted so `/healthz` (`image.cold_fallback_count`) surfaces a degraded launch path. The
  registry-driven builder is supervised: a dead builder loop fails `/healthz` (`checks.image_builder`),
  and a `failed` digest is reported (`image.status`) without flipping health, since creates still
  succeed via the fallback. Image state never becomes a member-visible chat failure.
- The in-process baker class is retired: its infinite retry loop and sticky-resolution
  heuristics are deleted; only the single-attempt `bakeCompanionRuntimeImageOnce` unit
  remains, executed by the registry-driven builder under its lease. The diagnostic
  startup-autoresearch harness (`scripts/box-startup-research`) was removed with it.

## Self-hosted Pi bundle (Phase 1-B)

The cold-install path — `npm i -g @earendil-works/pi-coding-agent`, four `pi install`
runs, and a qmd install — is the dominant contributor to the ~300 s install, and its
duration and success depend on whatever a public npm registry serves at boot. Phase 1-B
replaces it with a self-hosted, content-addressed artifact.

- `packages/box-runtime/src/piBundle.ts` holds the single-source pins (`COMPANION_PI_BUNDLE`:
  `piVersion`, the four extension `packages`, `qmdPackage`, `nodeMajor`, `sha256`, `bundleFormat`).
  The artifact is `pi-bundles/companion-pi-bundle-<sha12>.tar.gz`, a tarball carrying `pi/` (the Pi
  prefix tree), `pi-agent-dir/` (the four installed extensions), and `tools/` (the qmd prefix tree),
  stored in the existing skill-archives bucket — no dedicated bucket and never a public one.
- Bundle mode turns on when `COMPANION_PI_BUNDLE_ENABLED=true` and the runtime's `S3_*`
  configuration is complete. At staging time `apps/runtime/src/piBundlePresigner.ts` mints a
  presigned GET URL (1 h expiry, fresh per layout script generation, since stagings can be hours
  apart) and injects it into the script. The layout script then
  `curl`s that URL (retrying, with a `node` fetch fallback), verifies it with `sha256sum -c`
  against the pin, `tar`-extracts it into `~/.companion/dist/<sha12>/`, checks the Box's Node major
  against `nodeMajor`, and wires PATH (`dist/<sha12>/pi/bin` first, `pi-agent-dir` → `~/.companion/pi`,
  `tools` → `~/.companion/tools`). Nothing is fetched from npm.
- The three failure points print a fixed marker as their last stderr line —
  `companion-bundle-download-failed`, `companion-bundle-checksum-mismatch`,
  `companion-bundle-node-mismatch` — which `#applyPiLayout` maps to the stable codes
  `pi_bundle_download_failed`, `pi_bundle_checksum_mismatch`, `pi_bundle_node_mismatch`. The layout
  marker is never written on failure, so the Box relayouts cleanly on its next wake.
- `COMPANION_PI_INSTALL_COMMAND` stays the dev/emergency escape hatch and behaves exactly as before
  when no bundle is configured. When both are set, the bundle wins. Bundle identity is folded into
  the base layout marker as `:bundle=<sha12>`; the escape-hatch marker omits it, so identities never
  collide. The presigned URL never reaches any identity or marker — only the sha does. A new bundle
  sha is a new base marker: warm Boxes relayout once at their next health tick
  and the registry re-bakes. `disk_layout_version` stays 14 — no migration.
- Build and publish: `scripts/build-pi-bundle.sh` (reads the pins from `piBundle.ts`, builds the
  three trees, smoke-tests, tars, prints the sha256) and `.github/workflows/pi-bundle.yml` (builds on
  the pinned Node major, uploads to S3 at the content-addressed key with `scripts/upload-pi-bundle.mjs`).
  A CI guard (`pnpm pi-bundle:check`) HEADs the object derived from the pin with the S3 SDK (the
  bucket is not public) so a pin cannot merge before its artifact exists; it skips gracefully while
  the sha is still the placeholder or the S3 credentials are not configured.

The deterministic simulator still proves image state, fencing, and fallback call counts, but it
does not execute this installation. Box Lab supplies that missing boundary with the actual generated
layout script on isolated Linux `x86_64`: the cold-install scenario exercises the npm fallback from
a blank Box, and `pnpm box:lab:smoke -- --scenario bundle` builds the pinned archive inside that
Box, computes its checksum there, injects the resulting plan, and proves download, checksum,
Node-major validation, extraction, marker identity, start, archive/resume, and snapshot clone. No
repository or Mac-host archive is mounted into the Box. The local Box Lab smoke uses the
deterministic model endpoint inside a Lima VM or OCI systemd container; no bundle or lifecycle
command touches the host service manager. This deliberately slow acceptance is run as the final
local validation after the fast suites and is not part of CI. The live canary remains responsible
only for ascii.dev snapshot/API drift.

## Phase 2 — staged, proven checkpoints

Generalize the `companion_operations.checkpoint` mechanism to staging itself: each
staging step is `(name, guard, idempotent action, persisted proof)`. Crash recovery =
read proofs, execute first unproven step. Shell markers remain only as caches; proofs
live in PostgreSQL.

## Phase 3 — shared contracts

- Single module for generation names, provider event schemas, and all timing constants
  with documented interactions.
- SQL functions migrated by diff (`CREATE OR REPLACE`), never re-declared wholesale.
- Registry-aware provider snapshot retention and garbage collection: mark old rows unavailable
  before deletion, fence against current creation reads, and reconcile provider inventory.

## Migration plan

Phase 1 ships additively: new table, new registry service, builder switched to it,
baker heuristics retired. No legacy data migration is needed — images rebuild from
content identity on demand. Phases 2–3 follow incrementally; each phase must keep
`pnpm verify:change` green including the deterministic Box/Pi E2E matrix covering image ready /
building / failed / concurrent create / crash at each checkpoint. A change to the generated layout,
Pi/bundle pins, image lifecycle adapter, or Box Lab also requires `pnpm box:lab:smoke` as the final
local validation; the provider canary is not a substitute for that contained installation test.
