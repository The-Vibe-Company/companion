# Changelog

## [0.61.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.60.1...the-companion-v0.61.0) (2026-02-24)


### Features

* **web:** add auth, PWA, process panel, editor/files, page redesigns, and theme polish ([#396](https://github.com/The-Vibe-Company/companion/issues/396)) ([cb2f101](https://github.com/The-Vibe-Company/companion/commit/cb2f101d7c2764fbaa0d582ed1022763706c9283))

## [0.60.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.60.0...the-companion-v0.60.1) (2026-02-24)


### Bug Fixes

* **agents:** add resilient webhook copy URL behavior ([#400](https://github.com/The-Vibe-Company/companion/issues/400)) ([07bbf9b](https://github.com/The-Vibe-Company/companion/commit/07bbf9b8e63ec9e20f0bb4ac52fd6d0d18614f71))

## [0.60.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.59.0...the-companion-v0.60.0) (2026-02-24)


### Features

* **agents:** add reusable agent system with triggers, MCP, and scheduling ([#397](https://github.com/The-Vibe-Company/companion/issues/397)) ([1849d5d](https://github.com/The-Vibe-Company/companion/commit/1849d5d7c2a2b3d4036f8b2aebd1adc84f14258e))


### Bug Fixes

* **ci:** rewrite coverage gate to enforce 80% on new/changed files ([#399](https://github.com/The-Vibe-Company/companion/issues/399)) ([e257897](https://github.com/The-Vibe-Company/companion/commit/e257897674024a5cad12f3468c73a7e2f9d7c799))

## [0.59.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.58.2...the-companion-v0.59.0) (2026-02-22)


### Features

* **diff:** use git diff as source of truth; show A/M/D status icons and deleted files ([#385](https://github.com/The-Vibe-Company/companion/issues/385)) ([d1e0db5](https://github.com/The-Vibe-Company/companion/commit/d1e0db5f9b94bd5fe055455bf6b4f69714e350f5))
* **web:** improve streaming reliability and session branching controls ([#381](https://github.com/The-Vibe-Company/companion/issues/381)) ([200ab34](https://github.com/The-Vibe-Company/companion/commit/200ab34f42969e09c1a1e9bbb0ba6df44b791a6e))


### Bug Fixes

* **codex:** normalize rate-limit reset timestamps ([#386](https://github.com/The-Vibe-Company/companion/issues/386)) ([f361696](https://github.com/The-Vibe-Company/companion/commit/f3616960e48dcddccc48c956621c819568157e49))

## [0.58.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.58.1...the-companion-v0.58.2) (2026-02-21)


### Bug Fixes

* **editor:** replace vscode tab with codemirror behind settings ([#372](https://github.com/The-Vibe-Company/companion/issues/372)) ([52bc626](https://github.com/The-Vibe-Company/companion/commit/52bc626fdb1a27a06c2e13a2ef6aa59a4f0da9f9))

## [0.58.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.58.0...the-companion-v0.58.1) (2026-02-20)


### Bug Fixes

* **sidebar:** prevent hover overlay and restore archived click ([#370](https://github.com/The-Vibe-Company/companion/issues/370)) ([56abbc1](https://github.com/The-Vibe-Company/companion/commit/56abbc1ca11b5ff34d0a2c1350740d697640b6d9))

## [0.58.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.57.0...the-companion-v0.58.0) (2026-02-20)


### Features

* **sidebar:** redesign session items with status-first layout ([#368](https://github.com/The-Vibe-Company/companion/issues/368)) ([7287cfc](https://github.com/The-Vibe-Company/companion/commit/7287cfcb54cadbc35f1dff2ea7f0e42042b89124))

## [0.57.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.56.1...the-companion-v0.57.0) (2026-02-20)


### Features

* **sidebar:** redesign left sidebar navigation and sessions list ([#365](https://github.com/The-Vibe-Company/companion/issues/365)) ([000a748](https://github.com/The-Vibe-Company/companion/commit/000a7483c4fe7ad1df9dc8b1fa98ff0740c1c303))

## [0.56.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.56.0...the-companion-v0.56.1) (2026-02-19)


### Bug Fixes

* **topbar:** improve diff badge contrast in dark mode ([#359](https://github.com/The-Vibe-Company/companion/issues/359)) ([a995aa1](https://github.com/The-Vibe-Company/companion/commit/a995aa1568576905c6b6e9702b5b5f5cc3ca4527))

## [0.56.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.55.4...the-companion-v0.56.0) (2026-02-19)


### Features

* **editor:** move VS Code editor to dedicated tab with host fallback ([#358](https://github.com/The-Vibe-Company/companion/issues/358)) ([c169027](https://github.com/The-Vibe-Company/companion/commit/c169027ae77f28b9d491c4172b1e01e2af95c3a7))
* **session:** add VS Code editor pane beside shell ([#354](https://github.com/The-Vibe-Company/companion/issues/354)) ([ab10a8d](https://github.com/The-Vibe-Company/companion/commit/ab10a8d09f200ba38a3ee3138505a868b94ace25))


### Bug Fixes

* **settings:** open update overlay on update restart ([#356](https://github.com/The-Vibe-Company/companion/issues/356)) ([2c7989e](https://github.com/The-Vibe-Company/companion/commit/2c7989ee8242c95eebced7cc712a0191271f79e9))

## [0.55.4](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.55.3...the-companion-v0.55.4) (2026-02-19)


### Bug Fixes

* **linear:** add server-side cache to prevent API rate limiting ([#352](https://github.com/The-Vibe-Company/companion/issues/352)) ([843b585](https://github.com/The-Vibe-Company/companion/commit/843b5857a3aefd5ee304fa05aa60fa09d8add1b9))

## [0.55.3](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.55.2...the-companion-v0.55.3) (2026-02-19)


### Bug Fixes

* **update:** add full-screen overlay with auto-refresh after update ([#349](https://github.com/The-Vibe-Company/companion/issues/349)) ([f988b14](https://github.com/The-Vibe-Company/companion/commit/f988b142ea5458cb6654211a24e7cd02d7ee02da))

## [0.55.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.55.1...the-companion-v0.55.2) (2026-02-19)


### Bug Fixes

* **server:** map container repo root to host path ([#348](https://github.com/The-Vibe-Company/companion/issues/348)) ([c29f967](https://github.com/The-Vibe-Company/companion/commit/c29f9671d4dcdda876a999906f0e6fd63da8bd27))

## [0.55.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.55.0...the-companion-v0.55.1) (2026-02-19)


### Bug Fixes

* **linear:** show only active issues and prioritize backlog ([#346](https://github.com/The-Vibe-Company/companion/issues/346)) ([c2a6e1a](https://github.com/The-Vibe-Company/companion/commit/c2a6e1a0b8d22d032b516a186d5e23db906fdfc2))

## [0.55.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.54.1...the-companion-v0.55.0) (2026-02-19)


### Features

* **ui:** make right sidebar modular with inline configuration ([#345](https://github.com/The-Vibe-Company/companion/issues/345)) ([a9a7905](https://github.com/The-Vibe-Company/companion/commit/a9a7905374e2dcf0c173b3fa9f04a7f209f75a6f))


### Bug Fixes

* **homepage:** restore linear issue branch auto-selection ([#342](https://github.com/The-Vibe-Company/companion/issues/342)) ([01936e4](https://github.com/The-Vibe-Company/companion/commit/01936e4de89bd925c71d13034c91c95560b5e517))

## [0.54.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.54.0...the-companion-v0.54.1) (2026-02-19)


### Bug Fixes

* **server:** resolve branch from containerized session git state ([#340](https://github.com/The-Vibe-Company/companion/issues/340)) ([304092d](https://github.com/The-Vibe-Company/companion/commit/304092df1c2e3ce8eceaa3c2c39917beb94b2cdb))

## [0.54.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.53.1...the-companion-v0.54.0) (2026-02-19)


### Features

* **integrations:** associate Linear ticket with session in TaskPanel ([#333](https://github.com/The-Vibe-Company/companion/issues/333)) ([943bf36](https://github.com/The-Vibe-Company/companion/commit/943bf36cd3f8fbdfc3f73fa48e7d9cd76fd12ea4))
* **integrations:** attach Linear project to git repo and show recent issues on homepage ([#331](https://github.com/The-Vibe-Company/companion/issues/331)) ([54239d7](https://github.com/The-Vibe-Company/companion/commit/54239d76f12cc7fea06f76ecd4957b8c06a50f05))
* **integrations:** auto-transition Linear issue to In Progress on session launch ([#332](https://github.com/The-Vibe-Company/companion/issues/332)) ([1df0c8c](https://github.com/The-Vibe-Company/companion/commit/1df0c8cb1d9c82f2756047af661611640de42836))


### Bug Fixes

* **ui:** hide Linear context bar when Linear is not configured ([#339](https://github.com/The-Vibe-Company/companion/issues/339)) ([cd4f55f](https://github.com/The-Vibe-Company/companion/commit/cd4f55f83d9ca166368680c6303c93c3b354f782))

## [0.53.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.53.0...the-companion-v0.53.1) (2026-02-19)


### Bug Fixes

* **server:** base new branches on origin/{defaultBranch} instead of stale local ref ([#334](https://github.com/The-Vibe-Company/companion/issues/334)) ([0a736f4](https://github.com/The-Vibe-Company/companion/commit/0a736f4f224db0a79aaca329a70f24f7b7e1b5e7))

## [0.53.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.52.0...the-companion-v0.53.0) (2026-02-19)


### Features

* **linear:** auto-create recommended branch when starting session with Linear issue ([#329](https://github.com/The-Vibe-Company/companion/issues/329)) ([51972b7](https://github.com/The-Vibe-Company/companion/commit/51972b78b32f6a7b2701016b55bf0675a4e13bc3))

## [0.52.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.51.0...the-companion-v0.52.0) (2026-02-19)


### Features

* **codex:** add plan mode with runtime Auto↔Plan toggle ([#325](https://github.com/The-Vibe-Company/companion/issues/325)) ([21ef723](https://github.com/The-Vibe-Company/companion/commit/21ef7237b9666ebd4cc5689c5db05a4b26f10bdd))
* **integrations:** add linear setup, issue search, and startup context ([#326](https://github.com/The-Vibe-Company/companion/issues/326)) ([4612288](https://github.com/The-Vibe-Company/companion/commit/461228845965c45236c0e492f6bef50b71e80a24))


### Bug Fixes

* **integrations:** refine linear settings flow and home card UX ([#328](https://github.com/The-Vibe-Company/companion/issues/328)) ([443b3ec](https://github.com/The-Vibe-Company/companion/commit/443b3ecef48565f13d27c0a913d4504d1d0ef66e))
* **server:** prevent settings undefined overwrite crash ([#327](https://github.com/The-Vibe-Company/companion/issues/327)) ([9173ee2](https://github.com/The-Vibe-Company/companion/commit/9173ee2ed959a6333fb180d3e34f4deaa180c0d9))
* **ui:** improve thinking, tool results, and question prompts ([#321](https://github.com/The-Vibe-Company/companion/issues/321)) ([5c3dd7c](https://github.com/The-Vibe-Company/companion/commit/5c3dd7c501bc23b52c56fee6d5a3995545f8730b))

## [0.51.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.50.3...the-companion-v0.51.0) (2026-02-18)


### Features

* **prompts:** add global prompt library with @ insertion ([#319](https://github.com/The-Vibe-Company/companion/issues/319)) ([10b97b4](https://github.com/The-Vibe-Company/companion/commit/10b97b450c26e57ee0a2a5c96f42bc2c27cbb0c7))
* **server:** allow configuring session storage directory via COMPANION_SESSION_DIR ([#266](https://github.com/The-Vibe-Company/companion/issues/266)) ([3a63bc9](https://github.com/The-Vibe-Company/companion/commit/3a63bc915a16844aa2fbf33f08b60587efb9ea4a))

## [0.50.3](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.50.2...the-companion-v0.50.3) (2026-02-18)


### Bug Fixes

* **topbar:** hide context button on home page ([#317](https://github.com/The-Vibe-Company/companion/issues/317)) ([e5152e5](https://github.com/The-Vibe-Company/companion/commit/e5152e573ffc43ee5ad9aecc7bd76c937dd03d79))

## [0.50.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.50.1...the-companion-v0.50.2) (2026-02-18)


### Bug Fixes

* **topbar:** sample active tab color from underlying surface ([#315](https://github.com/The-Vibe-Company/companion/issues/315)) ([ebce0ec](https://github.com/The-Vibe-Company/companion/commit/ebce0ec12b5280ac46a8b63b4511202801009fcc))

## [0.50.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.50.0...the-companion-v0.50.1) (2026-02-18)


### Bug Fixes

* **codex:** use container cwd for docker runtime context ([#313](https://github.com/The-Vibe-Company/companion/issues/313)) ([ba6347b](https://github.com/The-Vibe-Company/companion/commit/ba6347ba90e93ba3e750b13b8687b7e428484725))

## [0.50.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.49.0...the-companion-v0.50.0) (2026-02-18)


### Features

* **docker:** background image pulls and streaming creation progress ([#311](https://github.com/The-Vibe-Company/companion/issues/311)) ([f3a7a5e](https://github.com/The-Vibe-Company/companion/commit/f3a7a5e48bbb371b828f8ffe53c8ad3448f1c07b))

## [0.49.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.48.0...the-companion-v0.49.0) (2026-02-18)


### Features

* **diff:** add diff base setting (last commit vs default branch) ([#308](https://github.com/The-Vibe-Company/companion/issues/308)) ([2a7f427](https://github.com/The-Vibe-Company/companion/commit/2a7f4271ef021db67c5b57d6509fe54853e930cc))


### Bug Fixes

* **docker:** propagate host git identity into containers ([#310](https://github.com/The-Vibe-Company/companion/issues/310)) ([81be828](https://github.com/The-Vibe-Company/companion/commit/81be828db84efb74772ef4cb89d4d83fc5b4e9f5))

## [0.48.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.47.0...the-companion-v0.48.0) (2026-02-18)


### Features

* **session-ui:** redesign tabs, terminal persistence and composer ([#306](https://github.com/The-Vibe-Company/companion/issues/306)) ([4a7fe9f](https://github.com/The-Vibe-Company/companion/commit/4a7fe9f4bdeef0dd41bb24d16dd530ed8c6e1939))


### Bug Fixes

* **ui:** dock session terminal inside workspace and prioritize docker target ([#302](https://github.com/The-Vibe-Company/companion/issues/302)) ([b3f0dd4](https://github.com/The-Vibe-Company/companion/commit/b3f0dd4196af53fd05fd8c432afdc40547a3f2c9))

## [0.47.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.46.1...the-companion-v0.47.0) (2026-02-18)


### Features

* **terminal:** add quick session terminal tabs for host and docker ([#299](https://github.com/The-Vibe-Company/companion/issues/299)) ([e4dfc51](https://github.com/The-Vibe-Company/companion/commit/e4dfc5141c54a898b0a5d4583ef3733b23a7d25d))

## [0.46.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.46.0...the-companion-v0.46.1) (2026-02-17)


### Bug Fixes

* **docker:** remove legacy companion-dev image support ([#295](https://github.com/The-Vibe-Company/companion/issues/295)) ([fe8cc2a](https://github.com/The-Vibe-Company/companion/commit/fe8cc2a57390a5ccd5e2d18605995c043cfa26b4))

## [0.46.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.45.0...the-companion-v0.46.0) (2026-02-16)


### Features

* **containers:** add Codex CLI support in Docker sessions ([#290](https://github.com/The-Vibe-Company/companion/issues/290)) ([992604b](https://github.com/The-Vibe-Company/companion/commit/992604b229542de87cacd8547c7d74955b05c5d8))


### Bug Fixes

* **sidebar:** separate scheduled runs from regular sessions ([#284](https://github.com/The-Vibe-Company/companion/issues/284)) ([cc0f042](https://github.com/The-Vibe-Company/companion/commit/cc0f042472363e40410728c550a7e6e2275ab80b))

## [0.45.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.44.1...the-companion-v0.45.0) (2026-02-16)


### Features

* **containers:** implement workspace isolation and git auth seeding in Docker sessions ([d651cc3](https://github.com/The-Vibe-Company/companion/commit/d651cc3144f65c939bdcb91f7f6900951a161552))
* **routing:** add session ID to URL hash for deep-linking ([#289](https://github.com/The-Vibe-Company/companion/issues/289)) ([ddd15ac](https://github.com/The-Vibe-Company/companion/commit/ddd15ac194390eb7b7bf4d7ff0850d71b2ff498a))
* **ui:** add full-screen session launch overlay ([#287](https://github.com/The-Vibe-Company/companion/issues/287)) ([0f31196](https://github.com/The-Vibe-Company/companion/commit/0f3119629de91271a0f3d92da2124f5028fe543b))


### Bug Fixes

* **ui:** cap textarea height and add overflow scroll for long prompts ([#285](https://github.com/The-Vibe-Company/companion/issues/285)) ([2b26bc7](https://github.com/The-Vibe-Company/companion/commit/2b26bc7b4122d22d29c821d9e1db29cce7dfbc64))

## [0.44.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.44.0...the-companion-v0.44.1) (2026-02-16)


### Bug Fixes

* **containers:** switch Docker registry from ghcr.io to Docker Hub ([525687e](https://github.com/The-Vibe-Company/companion/commit/525687e3e6d4eae3ab1125599c62881ee0ce80ac))

## [0.44.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.43.0...the-companion-v0.44.0) (2026-02-16)


### Features

* **containers:** pull Docker images from ghcr.io + session creation progress UI ([#281](https://github.com/The-Vibe-Company/companion/issues/281)) ([e87cfae](https://github.com/The-Vibe-Company/companion/commit/e87cfaed99010c37e12eca5adcaa30e8e5c07cb6))
* **containers:** replace git worktree isolation with Docker container-based sessions ([#277](https://github.com/The-Vibe-Company/companion/issues/277)) ([92a6172](https://github.com/The-Vibe-Company/companion/commit/92a6172db4bfa4bef613f21fa1bc243c848f7b9d))
* **containers:** seed git auth (gitconfig + gh token) in Docker sessions ([198be0e](https://github.com/The-Vibe-Company/companion/commit/198be0ef7465e3d355e34945fa67151e0457f096))


### Bug Fixes

* **ci:** only tag Docker image as :latest on version tags ([63ca679](https://github.com/The-Vibe-Company/companion/commit/63ca67934ab6d4a9024f5aa6031b4e059baeca79))
* **containers:** rewrite SSH git remotes to HTTPS inside containers ([6c867e3](https://github.com/The-Vibe-Company/companion/commit/6c867e36cc7b76a94c59e646ba37813b4aea651b))

## [0.43.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.42.0...the-companion-v0.43.0) (2026-02-15)


### Features

* **assistant:** add Companion — persistent AI assistant session ([#268](https://github.com/The-Vibe-Company/companion/issues/268)) ([ec0e90b](https://github.com/The-Vibe-Company/companion/commit/ec0e90b8b58f0ec09104590b182941a4d7c9b503))

## [0.42.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.41.0...the-companion-v0.42.0) (2026-02-15)


### Features

* **cron:** add scheduled task system for autonomous sessions ([#84](https://github.com/The-Vibe-Company/companion/issues/84)) ([e02c55a](https://github.com/The-Vibe-Company/companion/commit/e02c55a079bb0f81b71bc7a1fd44b23181d97bb1))

## [0.41.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.40.1...the-companion-v0.41.0) (2026-02-15)


### Features

* **server:** add always-on session recorder with line-based rotation ([#262](https://github.com/The-Vibe-Company/companion/issues/262)) ([369df07](https://github.com/The-Vibe-Company/companion/commit/369df07642f74f7abb523ed0323912f4f6b3d989))
* **ui:** enhanced tool rendering, tool_progress, and Codex session details ([#264](https://github.com/The-Vibe-Company/companion/issues/264)) ([a12963c](https://github.com/The-Vibe-Company/companion/commit/a12963cd014643fdd6785b03ad9e57016c1f7219))


### Bug Fixes

* **ui:** address review comments - stray 0 render, concurrent progress clearing ([#265](https://github.com/The-Vibe-Company/companion/issues/265)) ([6dfdee0](https://github.com/The-Vibe-Company/companion/commit/6dfdee0dbd25bc896e2c3ef37727021130da1808))

## [0.40.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.40.0...the-companion-v0.40.1) (2026-02-15)


### Reverts

* **plugins:** remove event-driven plugin runtime ([#260](https://github.com/The-Vibe-Company/companion/issues/260)) ([ea8011a](https://github.com/The-Vibe-Company/companion/commit/ea8011a714b9bdac096eb7bce8a6eca9b71e0eb1))

## [0.40.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.39.1...the-companion-v0.40.0) (2026-02-14)


### Features

* **plugins:** add event-driven plugin runtime with frontend integration ([#251](https://github.com/The-Vibe-Company/companion/issues/251)) ([fdc7418](https://github.com/The-Vibe-Company/companion/commit/fdc7418b7e0a0e17e31e0dbeaf45a7c0fad810cc))


### Bug Fixes

* **repo:** add tailored greptile code review rules ([#258](https://github.com/The-Vibe-Company/companion/issues/258)) ([2030e55](https://github.com/The-Vibe-Company/companion/commit/2030e553015800b757716393ada8fe2b1527f5bf))

## [0.39.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.39.0...the-companion-v0.39.1) (2026-02-14)


### Bug Fixes

* **ui:** keep session action controls visible on mobile ([#247](https://github.com/The-Vibe-Company/companion/issues/247)) ([209ac9a](https://github.com/The-Vibe-Company/companion/commit/209ac9a3f2d5bd99e3e2dbe46dc9eb7b10e40082))

## [0.39.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.38.0...the-companion-v0.39.0) (2026-02-14)


### Features

* **telemetry:** add posthog analytics, opt-out controls, and CI env wiring ([#238](https://github.com/The-Vibe-Company/companion/issues/238)) ([743aeab](https://github.com/The-Vibe-Company/companion/commit/743aeab86aa5b9141c86f605bbd3572694c80113))

## [0.38.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.37.2...the-companion-v0.38.0) (2026-02-13)


### Features

* **settings:** add application update controls to settings ([#234](https://github.com/The-Vibe-Company/companion/issues/234)) ([17760af](https://github.com/The-Vibe-Company/companion/commit/17760afb3cade5e325b7771cabbe0f78034512e5))


### Bug Fixes

* **landing:** focus messaging on codex, mcp, terminal and secure remote setup ([#237](https://github.com/The-Vibe-Company/companion/issues/237)) ([80759a7](https://github.com/The-Vibe-Company/companion/commit/80759a7ed3209d8aebf1e108d3e0c68d7bb8824f))

## [0.37.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.37.1...the-companion-v0.37.2) (2026-02-13)


### Bug Fixes

* **ws:** add durable replay cursors and idempotent message handling ([#232](https://github.com/The-Vibe-Company/companion/issues/232)) ([fba76e7](https://github.com/The-Vibe-Company/companion/commit/fba76e730ea5398a2df9dbda2167c32f49c7668f))

## [0.37.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.37.0...the-companion-v0.37.1) (2026-02-13)


### Bug Fixes

* **settings:** correct auto-renaming helper copy ([#230](https://github.com/The-Vibe-Company/companion/issues/230)) ([5da1586](https://github.com/The-Vibe-Company/companion/commit/5da15865508e6ae5bbcda45e149f64bc966b141c))

## [0.37.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.36.2...the-companion-v0.37.0) (2026-02-13)


### Features

* **ui:** show session name in top bar ([#228](https://github.com/The-Vibe-Company/companion/issues/228)) ([a9dc926](https://github.com/The-Vibe-Company/companion/commit/a9dc926d761c2dbbef741a2e7b05ecba29bd29b8))


### Bug Fixes

* **web:** compare file diffs against default branch ([#226](https://github.com/The-Vibe-Company/companion/issues/226)) ([b437d2c](https://github.com/The-Vibe-Company/companion/commit/b437d2c5705ee32cb4e7964dd1d33113d3470f9d))

## [0.36.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.36.1...the-companion-v0.36.2) (2026-02-13)


### Bug Fixes

* **cli-launcher:** bypass shebang to use correct Node for Codex ([#223](https://github.com/The-Vibe-Company/companion/issues/223)) ([9fe1583](https://github.com/The-Vibe-Company/companion/commit/9fe158358880789ec80ea5bd5daf738a261089dc))
* **ui:** move terminal, settings, and environments to full pages ([#224](https://github.com/The-Vibe-Company/companion/issues/224)) ([be1de35](https://github.com/The-Vibe-Company/companion/commit/be1de35e816ac782d4ba5c948f0b00abf0641f75))

## [0.36.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.36.0...the-companion-v0.36.1) (2026-02-13)


### Bug Fixes

* **cli-launcher:** pass enriched PATH to spawned CLI/Codex processes ([#221](https://github.com/The-Vibe-Company/companion/issues/221)) ([661e8b4](https://github.com/The-Vibe-Company/companion/commit/661e8b45d9909b9e59b0ecb396a4fb7a143f2816))

## [0.36.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.35.0...the-companion-v0.36.0) (2026-02-13)


### Features

* add Linux systemd support for service install/uninstall ([#169](https://github.com/The-Vibe-Company/companion/issues/169)) ([73fb3f7](https://github.com/The-Vibe-Company/companion/commit/73fb3f721efde79fec50f9c74a4f078f821c35d3))
* add MCP server management support ([#198](https://github.com/The-Vibe-Company/companion/issues/198)) ([018cf1f](https://github.com/The-Vibe-Company/companion/commit/018cf1f65ea5e281c19a39367f8cccf14ac56c1f))
* Add permission & plan approval E2E tests ([#6](https://github.com/The-Vibe-Company/companion/issues/6)) ([8590a68](https://github.com/The-Vibe-Company/companion/commit/8590a68657f0a06e94795a179ad4bbedae782c63))
* add release-please for automated npm publishing ([#24](https://github.com/The-Vibe-Company/companion/issues/24)) ([93b24ee](https://github.com/The-Vibe-Company/companion/commit/93b24ee4a12b3f32e81f59a348b25e89aaa86dce))
* allow dev server access over Tailscale/LAN ([#33](https://github.com/The-Vibe-Company/companion/issues/33)) ([9599d7a](https://github.com/The-Vibe-Company/companion/commit/9599d7ad4e2823d51c8fa262e1dcd96eeb056244))
* claude.md update ([7fa4e7a](https://github.com/The-Vibe-Company/companion/commit/7fa4e7adfdc7c409cfeed4e8a11f237ff0572234))
* **cli:** add service install/uninstall and separate dev/prod ports ([#155](https://github.com/The-Vibe-Company/companion/issues/155)) ([a4e5ba6](https://github.com/The-Vibe-Company/companion/commit/a4e5ba6ced2cc8041f61b303b0205f36e50b7594))
* **cli:** add stop and restart service commands ([#185](https://github.com/The-Vibe-Company/companion/issues/185)) ([04da8e5](https://github.com/The-Vibe-Company/companion/commit/04da8e5a3d3f0e363f662cdd6bca6145eaec479f))
* **cli:** start and stop Companion via daemon service ([#201](https://github.com/The-Vibe-Company/companion/issues/201)) ([39e2b79](https://github.com/The-Vibe-Company/companion/commit/39e2b79a6dbb70e7c7dcaf3ccbaf2116ac26b43a))
* **codex:** add offline protocol compatibility guardrails and playground coverage ([#194](https://github.com/The-Vibe-Company/companion/issues/194)) ([bf0a43e](https://github.com/The-Vibe-Company/companion/commit/bf0a43e5fdc791166e76391c0ee1ad3cf18dae10))
* Corriger menu dossier mobile et décalage clavier ([#151](https://github.com/The-Vibe-Company/companion/issues/151)) ([8068925](https://github.com/The-Vibe-Company/companion/commit/8068925f6a5ec5c6b7a40b36398bd4f9be04708d))
* e2e permissions plans ([#9](https://github.com/The-Vibe-Company/companion/issues/9)) ([53b38bf](https://github.com/The-Vibe-Company/companion/commit/53b38bfd4e773454492a3fea10e8db7ffd3fd768))
* Fix Diffs panel for worktree/relative paths and untracked files ([#165](https://github.com/The-Vibe-Company/companion/issues/165)) ([6810643](https://github.com/The-Vibe-Company/companion/commit/681064328d2bf3f4fc5c3a1867abc1536d2d54f3))
* Hide successful no-output command results ([#139](https://github.com/The-Vibe-Company/companion/issues/139)) ([a66e386](https://github.com/The-Vibe-Company/companion/commit/a66e386491e6887c5684cd70f63cc49cac0a64b7))
* **landing:** add marketing landing page for thecompanion.sh ([#128](https://github.com/The-Vibe-Company/companion/issues/128)) ([170b89c](https://github.com/The-Vibe-Company/companion/commit/170b89c72012dfb0ba68239a7665634d65275aa3))
* OpenRouter-based session auto-naming + settings page ([#168](https://github.com/The-Vibe-Company/companion/issues/168)) ([a86b1e7](https://github.com/The-Vibe-Company/companion/commit/a86b1e711ff1c38985bb3d622c6ec372a266637e))
* protocol conformance fixes and improved E2E tests ([#14](https://github.com/The-Vibe-Company/companion/issues/14)) ([51b13b9](https://github.com/The-Vibe-Company/companion/commit/51b13b9d647de6c92881b1abb61161f39152e0ef))
* Redesign README as a landing page with API-first documentation ([#7](https://github.com/The-Vibe-Company/companion/issues/7)) ([a59e1b4](https://github.com/The-Vibe-Company/companion/commit/a59e1b4604baf87faa32af7d62e4846afae49dbe))
* **sidebar:** group sound and alerts under notification ([#203](https://github.com/The-Vibe-Company/companion/issues/203)) ([0077e75](https://github.com/The-Vibe-Company/companion/commit/0077e75208e7505a53db8a829a9480a77b8c3916))
* simplified claude() API, unified endpoints, and landing page README ([#12](https://github.com/The-Vibe-Company/companion/issues/12)) ([aa2e535](https://github.com/The-Vibe-Company/companion/commit/aa2e535fe0a83b726ff2a2c08359e55973a9136b))
* The Vibe Companion complete web UI rewrite + npm package ([#23](https://github.com/The-Vibe-Company/companion/issues/23)) ([0bdc77a](https://github.com/The-Vibe-Company/companion/commit/0bdc77a81b21cd9d08ba29ea48844e73df3a1852))
* trigger release for statusline capture ([#19](https://github.com/The-Vibe-Company/companion/issues/19)) ([cedc9df](https://github.com/The-Vibe-Company/companion/commit/cedc9dfb7445344bdb43a1a756f1d2e538e08c76))
* **web:** adaptive server-side PR polling with WebSocket push ([#178](https://github.com/The-Vibe-Company/companion/issues/178)) ([57939e4](https://github.com/The-Vibe-Company/companion/commit/57939e4030a4b0e5a7dae39d93c34944e3bdff0f))
* **web:** add browser web notifications ([#191](https://github.com/The-Vibe-Company/companion/issues/191)) ([092c59a](https://github.com/The-Vibe-Company/companion/commit/092c59aff620aa2b2eac51903c01ad7cb0c4bc8e))
* **web:** add CLAUDE.md editor button in TopBar ([#170](https://github.com/The-Vibe-Company/companion/issues/170)) ([f553b9b](https://github.com/The-Vibe-Company/companion/commit/f553b9b86842f0b47c0bf24b08903e0352b7b078))
* **web:** add Clawd-inspired pixel art logo and favicon ([#70](https://github.com/The-Vibe-Company/companion/issues/70)) ([b3994ef](https://github.com/The-Vibe-Company/companion/commit/b3994eff2eac62c3cf8f40a8c31b720c910a7601))
* **web:** add component playground and ExitPlanMode display ([#36](https://github.com/The-Vibe-Company/companion/issues/36)) ([e958be7](https://github.com/The-Vibe-Company/companion/commit/e958be780f1b6e1a8f65daedbf968cdf6ef47798))
* **web:** add embedded code editor with file tree, changed files tracking, and diff view ([#81](https://github.com/The-Vibe-Company/companion/issues/81)) ([3ed0957](https://github.com/The-Vibe-Company/companion/commit/3ed095790c73edeef911ab4c73d74f1998100c5c))
* **web:** add embedded terminal in sidebar ([#175](https://github.com/The-Vibe-Company/companion/issues/175)) ([e711c5d](https://github.com/The-Vibe-Company/companion/commit/e711c5d5ef40edfa9c265642383a4c526b9b3ece))
* **web:** add git worktree support for isolated multi-branch sessions ([#64](https://github.com/The-Vibe-Company/companion/issues/64)) ([fee39d6](https://github.com/The-Vibe-Company/companion/commit/fee39d62986cd99700ba78c84a1f586331955ff8))
* **web:** add GitHub PR status to TaskPanel sidebar ([#166](https://github.com/The-Vibe-Company/companion/issues/166)) ([6ace3b2](https://github.com/The-Vibe-Company/companion/commit/6ace3b2944ec9e9082a11a45fe0798f0f5f41e55))
* **web:** add missing message-flow components to Playground ([#156](https://github.com/The-Vibe-Company/companion/issues/156)) ([ef6c27d](https://github.com/The-Vibe-Company/companion/commit/ef6c27dfa950c11b09394c74c4452c0b02aed8fb))
* **web:** add notification sound on task completion ([#99](https://github.com/The-Vibe-Company/companion/issues/99)) ([337c735](https://github.com/The-Vibe-Company/companion/commit/337c735e8267f076ada4b9ef01632d37376ec2d0))
* **web:** add OpenAI Codex CLI backend integration ([#100](https://github.com/The-Vibe-Company/companion/issues/100)) ([54e3c1a](https://github.com/The-Vibe-Company/companion/commit/54e3c1a2b359719d7983fa9ee857507e1446f505))
* **web:** add per-session usage limits with OAuth refresh and Codex support ([24ebd32](https://github.com/The-Vibe-Company/companion/commit/24ebd32f5ec617290b6b93e8bc76972a3b80d6a9))
* **web:** add permission suggestions and pending permission indicators ([10422c1](https://github.com/The-Vibe-Company/companion/commit/10422c1464b6ad4bc45eb90e6cd9ebbc0ebeac92))
* **web:** add PWA support for mobile home screen install ([#116](https://github.com/The-Vibe-Company/companion/issues/116)) ([85e605f](https://github.com/The-Vibe-Company/companion/commit/85e605fd758ee952e0d5b1dbc6f7065b514844a7))
* **web:** add update-available banner with auto-update for service mode ([#158](https://github.com/The-Vibe-Company/companion/issues/158)) ([727bd7f](https://github.com/The-Vibe-Company/companion/commit/727bd7fbd16557fd63ce41632592c1485e69713c))
* **web:** add usage limits display in session panel ([#97](https://github.com/The-Vibe-Company/companion/issues/97)) ([d29f489](https://github.com/The-Vibe-Company/companion/commit/d29f489ed9951d36ff45ec240410ffd8ffdf05eb))
* **web:** archive sessions instead of deleting them ([#56](https://github.com/The-Vibe-Company/companion/issues/56)) ([489d608](https://github.com/The-Vibe-Company/companion/commit/489d6087fc99b9131386547edaf3bd303a114090))
* **web:** enlarge homepage logo as hero element ([#71](https://github.com/The-Vibe-Company/companion/issues/71)) ([18ead74](https://github.com/The-Vibe-Company/companion/commit/18ead7436d3ebbe9d766754ddb17aa504c63703f))
* **web:** git fetch on branch picker open ([#72](https://github.com/The-Vibe-Company/companion/issues/72)) ([f110405](https://github.com/The-Vibe-Company/companion/commit/f110405edbd0f00454edd65ed72197daf0293182))
* **web:** git info display, folder dropdown fix, dev workflow ([#43](https://github.com/The-Vibe-Company/companion/issues/43)) ([1fe2069](https://github.com/The-Vibe-Company/companion/commit/1fe2069a7db17b410e383f883c934ee1662c2171))
* **web:** git worktree support with branch picker and git pull ([#65](https://github.com/The-Vibe-Company/companion/issues/65)) ([4d0c9c8](https://github.com/The-Vibe-Company/companion/commit/4d0c9c83f4fe13be863313d6c945ce0b671a7f8a))
* **web:** group sidebar sessions by project directory ([#117](https://github.com/The-Vibe-Company/companion/issues/117)) ([deceb59](https://github.com/The-Vibe-Company/companion/commit/deceb599975f53141e9c0bd6c7675437f96978b8))
* **web:** named environment profiles (~/.companion/envs/) ([#50](https://github.com/The-Vibe-Company/companion/issues/50)) ([eaa1a49](https://github.com/The-Vibe-Company/companion/commit/eaa1a497f3be61f2f71f9467e93fa2b65be19095))
* **web:** persist sessions to disk for dev mode resilience ([#45](https://github.com/The-Vibe-Company/companion/issues/45)) ([c943d00](https://github.com/The-Vibe-Company/companion/commit/c943d0047b728854f059e26facde950e08cdfe0c))
* **web:** redesign session list with avatars, auto-reconnect, and git info ([#111](https://github.com/The-Vibe-Company/companion/issues/111)) ([8a7284b](https://github.com/The-Vibe-Company/companion/commit/8a7284b3c08dc301a879924aea133945697b037a))
* **web:** replace CodeMirror editor with unified diff viewer ([#160](https://github.com/The-Vibe-Company/companion/issues/160)) ([f9b6869](https://github.com/The-Vibe-Company/companion/commit/f9b686902011ffd194a118cc1cb022bac71eaa3b))
* **web:** replace folder picker dropdown with fixed-size modal ([#76](https://github.com/The-Vibe-Company/companion/issues/76)) ([979e395](https://github.com/The-Vibe-Company/companion/commit/979e395b530cdb21e6a073ba60e33ea8ac497e2a))
* **web:** session rename persistence + auto-generated titles ([#79](https://github.com/The-Vibe-Company/companion/issues/79)) ([e1dc58c](https://github.com/The-Vibe-Company/companion/commit/e1dc58ce8ab9a619d36f2261cce89b90cfdb70d6))
* **web:** warn when branch is behind remote before session creation ([#127](https://github.com/The-Vibe-Company/companion/issues/127)) ([ef89d5c](https://github.com/The-Vibe-Company/companion/commit/ef89d5c208ca5da006aaa88b78dbd647186fb0df))


### Bug Fixes

* add web/dist to gitignore ([#2](https://github.com/The-Vibe-Company/companion/issues/2)) ([b9ac264](https://github.com/The-Vibe-Company/companion/commit/b9ac264fbb99415517636517e8f503d40fe3253d))
* always update statusLine settings on agent spawn ([#21](https://github.com/The-Vibe-Company/companion/issues/21)) ([71c343c](https://github.com/The-Vibe-Company/companion/commit/71c343cfd29fff3204ad0cc2986ff000d1be5adc))
* auto-accept workspace trust prompt and handle idle in ask() ([#16](https://github.com/The-Vibe-Company/companion/issues/16)) ([ded31b4](https://github.com/The-Vibe-Company/companion/commit/ded31b4cf9900f7ed8c3ff373ef16ae8f1e8a886))
* checkout selected branch when worktree mode is off ([#68](https://github.com/The-Vibe-Company/companion/issues/68)) ([500f3b1](https://github.com/The-Vibe-Company/companion/commit/500f3b112c5ccc646c7965344b5774efe1338377))
* **cli:** auto-update restarts service reliably via explicit systemctl/launchctl ([#208](https://github.com/The-Vibe-Company/companion/issues/208)) ([33fa67e](https://github.com/The-Vibe-Company/companion/commit/33fa67ebd75609b9a7b8700ce67b1dd949663b06))
* **cli:** expose stop/restart in help and add test ([#188](https://github.com/The-Vibe-Company/companion/issues/188)) ([c307525](https://github.com/The-Vibe-Company/companion/commit/c30752545f2137fd7c03525d5bb7f5f8851271d4))
* **cli:** fix Linux systemd service management (start, auto-restart) ([#213](https://github.com/The-Vibe-Company/companion/issues/213)) ([fc1dd65](https://github.com/The-Vibe-Company/companion/commit/fc1dd65a9fd32958d47499af1b35992a0c10fe8e))
* **cli:** refresh systemd unit file on start/restart to prevent restart loops ([#215](https://github.com/The-Vibe-Company/companion/issues/215)) ([35f80d9](https://github.com/The-Vibe-Company/companion/commit/35f80d963b1f0f0feccf7215a9bd4711b4520a12))
* **cli:** resolve binaries via user shell PATH when running as service ([#216](https://github.com/The-Vibe-Company/companion/issues/216)) ([47e4967](https://github.com/The-Vibe-Company/companion/commit/47e4967215a5bfd84c8afc2a86ce42151c73d187))
* **codex:** fix 3 critical bugs in Codex backend integration ([#147](https://github.com/The-Vibe-Company/companion/issues/147)) ([0ec92db](https://github.com/The-Vibe-Company/companion/commit/0ec92db909c7be42f94cc21d2890c9c123702dd7))
* **codex:** handle init failure gracefully and isolate per-session CODEX_HOME ([#210](https://github.com/The-Vibe-Company/companion/issues/210)) ([f4efcea](https://github.com/The-Vibe-Company/companion/commit/f4efceace6c260de92df728335678b7bded3e144))
* make service stop actually stop on macOS and refresh stale update checks ([#192](https://github.com/The-Vibe-Company/companion/issues/192)) ([f608f64](https://github.com/The-Vibe-Company/companion/commit/f608f64887bf78b2cca909aa20bd87e4a897ce94))
* remove vibe alias, update repo URLs to companion ([#30](https://github.com/The-Vibe-Company/companion/issues/30)) ([4f7b47c](https://github.com/The-Vibe-Company/companion/commit/4f7b47cba86c278e89fe81292fea9b8b3e75c035))
* scope permission requests to their session tab ([#35](https://github.com/The-Vibe-Company/companion/issues/35)) ([ef9f41c](https://github.com/The-Vibe-Company/companion/commit/ef9f41c8589e382de1db719984931bc4e91aeb11))
* show pasted images in chat history ([#32](https://github.com/The-Vibe-Company/companion/issues/32)) ([46365be](https://github.com/The-Vibe-Company/companion/commit/46365be45ae8b325100ed296617455c105d4d52e))
* **sidebar:** nest notification toggles behind disclosure ([#207](https://github.com/The-Vibe-Company/companion/issues/207)) ([87e71b8](https://github.com/The-Vibe-Company/companion/commit/87e71b8f5bf3e47c96421bca315ac412934a7dc2))
* **task-panel:** enable scrolling for long MCP sections ([#204](https://github.com/The-Vibe-Company/companion/issues/204)) ([b98abbb](https://github.com/The-Vibe-Company/companion/commit/b98abbbea4355c7e91d4dc322e53e638f4e4c542))
* track all commits in release-please, not just web/ ([#27](https://github.com/The-Vibe-Company/companion/issues/27)) ([d49f649](https://github.com/The-Vibe-Company/companion/commit/d49f64996d02807baf0482ce3c3607ae59f78638))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([e296ab0](https://github.com/The-Vibe-Company/companion/commit/e296ab0fabd6345b1f21c7094ca1f8d6f6af79cb))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([#26](https://github.com/The-Vibe-Company/companion/issues/26)) ([61eed5a](https://github.com/The-Vibe-Company/companion/commit/61eed5addd6e332fac360d9ae8239f1b0f93868e))
* use random suffixes for worktree branch names ([#88](https://github.com/The-Vibe-Company/companion/issues/88)) ([0b79f9a](https://github.com/The-Vibe-Company/companion/commit/0b79f9af172595cb84810b5d4cd65e0ed9c8e23d))
* **web:** always generate unique branch names for worktrees with forceNew ([#131](https://github.com/The-Vibe-Company/companion/issues/131)) ([cd62d4a](https://github.com/The-Vibe-Company/companion/commit/cd62d4ac8fae0b56cdef0ff850eab4a8c707f99b))
* **web:** chat scroll and composer visibility in plan mode ([#55](https://github.com/The-Vibe-Company/companion/issues/55)) ([4cff10c](https://github.com/The-Vibe-Company/companion/commit/4cff10cde297b7142c088584b6dd83060902c526))
* **web:** deduplicate messages on WebSocket reconnection ([#150](https://github.com/The-Vibe-Company/companion/issues/150)) ([a81bb3d](https://github.com/The-Vibe-Company/companion/commit/a81bb3d878957f1f18234a5f9194d1d8064f795c))
* **web:** default folder picker to home directory instead of server cwd ([#122](https://github.com/The-Vibe-Company/companion/issues/122)) ([7b8a4c7](https://github.com/The-Vibe-Company/companion/commit/7b8a4c71f32c68ffcc907269e88b3711c0d5af7a))
* **web:** enable codex web search when internet toggle is on ([#135](https://github.com/The-Vibe-Company/companion/issues/135)) ([8d9f0b0](https://github.com/The-Vibe-Company/companion/commit/8d9f0b002dcafcfc020862cb107777d75fc2580e))
* **web:** fetch and pull selected branch on session create ([#137](https://github.com/The-Vibe-Company/companion/issues/137)) ([9cdbbe1](https://github.com/The-Vibe-Company/companion/commit/9cdbbe1e151f024bd41f60e20c60e2f092ba7014))
* **web:** fix Codex approval policy and Composer mode labels ([#106](https://github.com/The-Vibe-Company/companion/issues/106)) ([fd5c2f1](https://github.com/The-Vibe-Company/companion/commit/fd5c2f15b144eb2ae9ec809fdb6ee19e797dc15a))
* **web:** fix session auto-rename and add blur-to-focus animation ([#86](https://github.com/The-Vibe-Company/companion/issues/86)) ([6d3c91f](https://github.com/The-Vibe-Company/companion/commit/6d3c91f73a65054e2c15727e90ca554af70eed28))
* **web:** fix WritableStream locked race condition in Codex adapter ([b43569d](https://github.com/The-Vibe-Company/companion/commit/b43569dbb3d154a303d60ec6bc2007b5a7bcedea))
* **web:** improve light mode contrast ([#89](https://github.com/The-Vibe-Company/companion/issues/89)) ([7ac7886](https://github.com/The-Vibe-Company/companion/commit/7ac7886fc6305e3ec45698a1c7c91b72a91c7c44))
* **web:** improve responsive design across all components ([#85](https://github.com/The-Vibe-Company/companion/issues/85)) ([0750fbb](https://github.com/The-Vibe-Company/companion/commit/0750fbbbe456d79bc104fdbdaf8f08e8795a3b62))
* **web:** isolate worktree sessions with proper branch-tracking ([#74](https://github.com/The-Vibe-Company/companion/issues/74)) ([764d7a7](https://github.com/The-Vibe-Company/companion/commit/764d7a7f5391a686408a8542421f771da341d5db))
* **web:** polyfill localStorage for Node.js 22+ ([#149](https://github.com/The-Vibe-Company/companion/issues/149)) ([602c684](https://github.com/The-Vibe-Company/companion/commit/602c6841f03677ec3f419860469e39b791968de6))
* **web:** prevent iOS auto-zoom on mobile input focus ([#102](https://github.com/The-Vibe-Company/companion/issues/102)) ([18ee23f](https://github.com/The-Vibe-Company/companion/commit/18ee23f6f1674fbcf5e1be25f8c4e23510bc12b5))
* **web:** prevent mobile keyboard layout shift and iOS zoom on branch selector ([#159](https://github.com/The-Vibe-Company/companion/issues/159)) ([4276afd](https://github.com/The-Vibe-Company/companion/commit/4276afd4390808d9d040555652c80bd1461c45b7))
* **web:** refresh git branch tracking after session start ([#195](https://github.com/The-Vibe-Company/companion/issues/195)) ([c3cb47b](https://github.com/The-Vibe-Company/companion/commit/c3cb47b56257b866b76abbb66709694cb26e0925))
* **web:** resolve [object Object] display for Codex file edit results ([#133](https://github.com/The-Vibe-Company/companion/issues/133)) ([9cc21a7](https://github.com/The-Vibe-Company/companion/commit/9cc21a78064cf07bb90174dd87bbfbd367516c90))
* **web:** resolve original repo root for worktree sessions in sidebar grouping ([#120](https://github.com/The-Vibe-Company/companion/issues/120)) ([8925ac9](https://github.com/The-Vibe-Company/companion/commit/8925ac9f540b3cd2520268539d21b0267b2dadb1))
* **web:** session reconnection with auto-relaunch and persist ([#49](https://github.com/The-Vibe-Company/companion/issues/49)) ([f58e542](https://github.com/The-Vibe-Company/companion/commit/f58e5428847a342069e6790fa7d70f190bc5f396))
* **web:** stable session ordering — sort by creation date only ([#173](https://github.com/The-Vibe-Company/companion/issues/173)) ([05c3a06](https://github.com/The-Vibe-Company/companion/commit/05c3a0652b823c5ca20b233be164a899f9920caf))
* **web:** unset CLAUDECODE env var to prevent CLI nesting guard rejec… ([#181](https://github.com/The-Vibe-Company/companion/issues/181)) ([75e264a](https://github.com/The-Vibe-Company/companion/commit/75e264a0be975dadbf3d56e64b990e0e07b12777))
* **web:** use --resume on CLI relaunch to restore conversation context ([#46](https://github.com/The-Vibe-Company/companion/issues/46)) ([3e2b5bd](https://github.com/The-Vibe-Company/companion/commit/3e2b5bdd39bd265ca5675784227a9f1b4f2a8aa3))

## [0.35.0](https://github.com/The-Vibe-Company/companion/compare/thecompanion-v0.34.5...thecompanion-v0.35.0) (2026-02-13)


### Features

* add Linux systemd support for service install/uninstall ([#169](https://github.com/The-Vibe-Company/companion/issues/169)) ([73fb3f7](https://github.com/The-Vibe-Company/companion/commit/73fb3f721efde79fec50f9c74a4f078f821c35d3))
* add MCP server management support ([#198](https://github.com/The-Vibe-Company/companion/issues/198)) ([018cf1f](https://github.com/The-Vibe-Company/companion/commit/018cf1f65ea5e281c19a39367f8cccf14ac56c1f))
* Add permission & plan approval E2E tests ([#6](https://github.com/The-Vibe-Company/companion/issues/6)) ([8590a68](https://github.com/The-Vibe-Company/companion/commit/8590a68657f0a06e94795a179ad4bbedae782c63))
* add release-please for automated npm publishing ([#24](https://github.com/The-Vibe-Company/companion/issues/24)) ([93b24ee](https://github.com/The-Vibe-Company/companion/commit/93b24ee4a12b3f32e81f59a348b25e89aaa86dce))
* allow dev server access over Tailscale/LAN ([#33](https://github.com/The-Vibe-Company/companion/issues/33)) ([9599d7a](https://github.com/The-Vibe-Company/companion/commit/9599d7ad4e2823d51c8fa262e1dcd96eeb056244))
* claude.md update ([7fa4e7a](https://github.com/The-Vibe-Company/companion/commit/7fa4e7adfdc7c409cfeed4e8a11f237ff0572234))
* **cli:** add service install/uninstall and separate dev/prod ports ([#155](https://github.com/The-Vibe-Company/companion/issues/155)) ([a4e5ba6](https://github.com/The-Vibe-Company/companion/commit/a4e5ba6ced2cc8041f61b303b0205f36e50b7594))
* **cli:** add stop and restart service commands ([#185](https://github.com/The-Vibe-Company/companion/issues/185)) ([04da8e5](https://github.com/The-Vibe-Company/companion/commit/04da8e5a3d3f0e363f662cdd6bca6145eaec479f))
* **cli:** start and stop Companion via daemon service ([#201](https://github.com/The-Vibe-Company/companion/issues/201)) ([39e2b79](https://github.com/The-Vibe-Company/companion/commit/39e2b79a6dbb70e7c7dcaf3ccbaf2116ac26b43a))
* **codex:** add offline protocol compatibility guardrails and playground coverage ([#194](https://github.com/The-Vibe-Company/companion/issues/194)) ([bf0a43e](https://github.com/The-Vibe-Company/companion/commit/bf0a43e5fdc791166e76391c0ee1ad3cf18dae10))
* Corriger menu dossier mobile et décalage clavier ([#151](https://github.com/The-Vibe-Company/companion/issues/151)) ([8068925](https://github.com/The-Vibe-Company/companion/commit/8068925f6a5ec5c6b7a40b36398bd4f9be04708d))
* e2e permissions plans ([#9](https://github.com/The-Vibe-Company/companion/issues/9)) ([53b38bf](https://github.com/The-Vibe-Company/companion/commit/53b38bfd4e773454492a3fea10e8db7ffd3fd768))
* Fix Diffs panel for worktree/relative paths and untracked files ([#165](https://github.com/The-Vibe-Company/companion/issues/165)) ([6810643](https://github.com/The-Vibe-Company/companion/commit/681064328d2bf3f4fc5c3a1867abc1536d2d54f3))
* Hide successful no-output command results ([#139](https://github.com/The-Vibe-Company/companion/issues/139)) ([a66e386](https://github.com/The-Vibe-Company/companion/commit/a66e386491e6887c5684cd70f63cc49cac0a64b7))
* **landing:** add marketing landing page for thecompanion.sh ([#128](https://github.com/The-Vibe-Company/companion/issues/128)) ([170b89c](https://github.com/The-Vibe-Company/companion/commit/170b89c72012dfb0ba68239a7665634d65275aa3))
* OpenRouter-based session auto-naming + settings page ([#168](https://github.com/The-Vibe-Company/companion/issues/168)) ([a86b1e7](https://github.com/The-Vibe-Company/companion/commit/a86b1e711ff1c38985bb3d622c6ec372a266637e))
* protocol conformance fixes and improved E2E tests ([#14](https://github.com/The-Vibe-Company/companion/issues/14)) ([51b13b9](https://github.com/The-Vibe-Company/companion/commit/51b13b9d647de6c92881b1abb61161f39152e0ef))
* Redesign README as a landing page with API-first documentation ([#7](https://github.com/The-Vibe-Company/companion/issues/7)) ([a59e1b4](https://github.com/The-Vibe-Company/companion/commit/a59e1b4604baf87faa32af7d62e4846afae49dbe))
* **sidebar:** group sound and alerts under notification ([#203](https://github.com/The-Vibe-Company/companion/issues/203)) ([0077e75](https://github.com/The-Vibe-Company/companion/commit/0077e75208e7505a53db8a829a9480a77b8c3916))
* simplified claude() API, unified endpoints, and landing page README ([#12](https://github.com/The-Vibe-Company/companion/issues/12)) ([aa2e535](https://github.com/The-Vibe-Company/companion/commit/aa2e535fe0a83b726ff2a2c08359e55973a9136b))
* The Vibe Companion complete web UI rewrite + npm package ([#23](https://github.com/The-Vibe-Company/companion/issues/23)) ([0bdc77a](https://github.com/The-Vibe-Company/companion/commit/0bdc77a81b21cd9d08ba29ea48844e73df3a1852))
* trigger release for statusline capture ([#19](https://github.com/The-Vibe-Company/companion/issues/19)) ([cedc9df](https://github.com/The-Vibe-Company/companion/commit/cedc9dfb7445344bdb43a1a756f1d2e538e08c76))
* **web:** adaptive server-side PR polling with WebSocket push ([#178](https://github.com/The-Vibe-Company/companion/issues/178)) ([57939e4](https://github.com/The-Vibe-Company/companion/commit/57939e4030a4b0e5a7dae39d93c34944e3bdff0f))
* **web:** add browser web notifications ([#191](https://github.com/The-Vibe-Company/companion/issues/191)) ([092c59a](https://github.com/The-Vibe-Company/companion/commit/092c59aff620aa2b2eac51903c01ad7cb0c4bc8e))
* **web:** add CLAUDE.md editor button in TopBar ([#170](https://github.com/The-Vibe-Company/companion/issues/170)) ([f553b9b](https://github.com/The-Vibe-Company/companion/commit/f553b9b86842f0b47c0bf24b08903e0352b7b078))
* **web:** add Clawd-inspired pixel art logo and favicon ([#70](https://github.com/The-Vibe-Company/companion/issues/70)) ([b3994ef](https://github.com/The-Vibe-Company/companion/commit/b3994eff2eac62c3cf8f40a8c31b720c910a7601))
* **web:** add component playground and ExitPlanMode display ([#36](https://github.com/The-Vibe-Company/companion/issues/36)) ([e958be7](https://github.com/The-Vibe-Company/companion/commit/e958be780f1b6e1a8f65daedbf968cdf6ef47798))
* **web:** add embedded code editor with file tree, changed files tracking, and diff view ([#81](https://github.com/The-Vibe-Company/companion/issues/81)) ([3ed0957](https://github.com/The-Vibe-Company/companion/commit/3ed095790c73edeef911ab4c73d74f1998100c5c))
* **web:** add embedded terminal in sidebar ([#175](https://github.com/The-Vibe-Company/companion/issues/175)) ([e711c5d](https://github.com/The-Vibe-Company/companion/commit/e711c5d5ef40edfa9c265642383a4c526b9b3ece))
* **web:** add git worktree support for isolated multi-branch sessions ([#64](https://github.com/The-Vibe-Company/companion/issues/64)) ([fee39d6](https://github.com/The-Vibe-Company/companion/commit/fee39d62986cd99700ba78c84a1f586331955ff8))
* **web:** add GitHub PR status to TaskPanel sidebar ([#166](https://github.com/The-Vibe-Company/companion/issues/166)) ([6ace3b2](https://github.com/The-Vibe-Company/companion/commit/6ace3b2944ec9e9082a11a45fe0798f0f5f41e55))
* **web:** add missing message-flow components to Playground ([#156](https://github.com/The-Vibe-Company/companion/issues/156)) ([ef6c27d](https://github.com/The-Vibe-Company/companion/commit/ef6c27dfa950c11b09394c74c4452c0b02aed8fb))
* **web:** add notification sound on task completion ([#99](https://github.com/The-Vibe-Company/companion/issues/99)) ([337c735](https://github.com/The-Vibe-Company/companion/commit/337c735e8267f076ada4b9ef01632d37376ec2d0))
* **web:** add OpenAI Codex CLI backend integration ([#100](https://github.com/The-Vibe-Company/companion/issues/100)) ([54e3c1a](https://github.com/The-Vibe-Company/companion/commit/54e3c1a2b359719d7983fa9ee857507e1446f505))
* **web:** add per-session usage limits with OAuth refresh and Codex support ([24ebd32](https://github.com/The-Vibe-Company/companion/commit/24ebd32f5ec617290b6b93e8bc76972a3b80d6a9))
* **web:** add permission suggestions and pending permission indicators ([10422c1](https://github.com/The-Vibe-Company/companion/commit/10422c1464b6ad4bc45eb90e6cd9ebbc0ebeac92))
* **web:** add PWA support for mobile home screen install ([#116](https://github.com/The-Vibe-Company/companion/issues/116)) ([85e605f](https://github.com/The-Vibe-Company/companion/commit/85e605fd758ee952e0d5b1dbc6f7065b514844a7))
* **web:** add update-available banner with auto-update for service mode ([#158](https://github.com/The-Vibe-Company/companion/issues/158)) ([727bd7f](https://github.com/The-Vibe-Company/companion/commit/727bd7fbd16557fd63ce41632592c1485e69713c))
* **web:** add usage limits display in session panel ([#97](https://github.com/The-Vibe-Company/companion/issues/97)) ([d29f489](https://github.com/The-Vibe-Company/companion/commit/d29f489ed9951d36ff45ec240410ffd8ffdf05eb))
* **web:** archive sessions instead of deleting them ([#56](https://github.com/The-Vibe-Company/companion/issues/56)) ([489d608](https://github.com/The-Vibe-Company/companion/commit/489d6087fc99b9131386547edaf3bd303a114090))
* **web:** enlarge homepage logo as hero element ([#71](https://github.com/The-Vibe-Company/companion/issues/71)) ([18ead74](https://github.com/The-Vibe-Company/companion/commit/18ead7436d3ebbe9d766754ddb17aa504c63703f))
* **web:** git fetch on branch picker open ([#72](https://github.com/The-Vibe-Company/companion/issues/72)) ([f110405](https://github.com/The-Vibe-Company/companion/commit/f110405edbd0f00454edd65ed72197daf0293182))
* **web:** git info display, folder dropdown fix, dev workflow ([#43](https://github.com/The-Vibe-Company/companion/issues/43)) ([1fe2069](https://github.com/The-Vibe-Company/companion/commit/1fe2069a7db17b410e383f883c934ee1662c2171))
* **web:** git worktree support with branch picker and git pull ([#65](https://github.com/The-Vibe-Company/companion/issues/65)) ([4d0c9c8](https://github.com/The-Vibe-Company/companion/commit/4d0c9c83f4fe13be863313d6c945ce0b671a7f8a))
* **web:** group sidebar sessions by project directory ([#117](https://github.com/The-Vibe-Company/companion/issues/117)) ([deceb59](https://github.com/The-Vibe-Company/companion/commit/deceb599975f53141e9c0bd6c7675437f96978b8))
* **web:** named environment profiles (~/.companion/envs/) ([#50](https://github.com/The-Vibe-Company/companion/issues/50)) ([eaa1a49](https://github.com/The-Vibe-Company/companion/commit/eaa1a497f3be61f2f71f9467e93fa2b65be19095))
* **web:** persist sessions to disk for dev mode resilience ([#45](https://github.com/The-Vibe-Company/companion/issues/45)) ([c943d00](https://github.com/The-Vibe-Company/companion/commit/c943d0047b728854f059e26facde950e08cdfe0c))
* **web:** redesign session list with avatars, auto-reconnect, and git info ([#111](https://github.com/The-Vibe-Company/companion/issues/111)) ([8a7284b](https://github.com/The-Vibe-Company/companion/commit/8a7284b3c08dc301a879924aea133945697b037a))
* **web:** replace CodeMirror editor with unified diff viewer ([#160](https://github.com/The-Vibe-Company/companion/issues/160)) ([f9b6869](https://github.com/The-Vibe-Company/companion/commit/f9b686902011ffd194a118cc1cb022bac71eaa3b))
* **web:** replace folder picker dropdown with fixed-size modal ([#76](https://github.com/The-Vibe-Company/companion/issues/76)) ([979e395](https://github.com/The-Vibe-Company/companion/commit/979e395b530cdb21e6a073ba60e33ea8ac497e2a))
* **web:** session rename persistence + auto-generated titles ([#79](https://github.com/The-Vibe-Company/companion/issues/79)) ([e1dc58c](https://github.com/The-Vibe-Company/companion/commit/e1dc58ce8ab9a619d36f2261cce89b90cfdb70d6))
* **web:** warn when branch is behind remote before session creation ([#127](https://github.com/The-Vibe-Company/companion/issues/127)) ([ef89d5c](https://github.com/The-Vibe-Company/companion/commit/ef89d5c208ca5da006aaa88b78dbd647186fb0df))


### Bug Fixes

* add web/dist to gitignore ([#2](https://github.com/The-Vibe-Company/companion/issues/2)) ([b9ac264](https://github.com/The-Vibe-Company/companion/commit/b9ac264fbb99415517636517e8f503d40fe3253d))
* always update statusLine settings on agent spawn ([#21](https://github.com/The-Vibe-Company/companion/issues/21)) ([71c343c](https://github.com/The-Vibe-Company/companion/commit/71c343cfd29fff3204ad0cc2986ff000d1be5adc))
* auto-accept workspace trust prompt and handle idle in ask() ([#16](https://github.com/The-Vibe-Company/companion/issues/16)) ([ded31b4](https://github.com/The-Vibe-Company/companion/commit/ded31b4cf9900f7ed8c3ff373ef16ae8f1e8a886))
* checkout selected branch when worktree mode is off ([#68](https://github.com/The-Vibe-Company/companion/issues/68)) ([500f3b1](https://github.com/The-Vibe-Company/companion/commit/500f3b112c5ccc646c7965344b5774efe1338377))
* **cli:** auto-update restarts service reliably via explicit systemctl/launchctl ([#208](https://github.com/The-Vibe-Company/companion/issues/208)) ([33fa67e](https://github.com/The-Vibe-Company/companion/commit/33fa67ebd75609b9a7b8700ce67b1dd949663b06))
* **cli:** expose stop/restart in help and add test ([#188](https://github.com/The-Vibe-Company/companion/issues/188)) ([c307525](https://github.com/The-Vibe-Company/companion/commit/c30752545f2137fd7c03525d5bb7f5f8851271d4))
* **cli:** fix Linux systemd service management (start, auto-restart) ([#213](https://github.com/The-Vibe-Company/companion/issues/213)) ([fc1dd65](https://github.com/The-Vibe-Company/companion/commit/fc1dd65a9fd32958d47499af1b35992a0c10fe8e))
* **cli:** refresh systemd unit file on start/restart to prevent restart loops ([#215](https://github.com/The-Vibe-Company/companion/issues/215)) ([35f80d9](https://github.com/The-Vibe-Company/companion/commit/35f80d963b1f0f0feccf7215a9bd4711b4520a12))
* **cli:** resolve binaries via user shell PATH when running as service ([#216](https://github.com/The-Vibe-Company/companion/issues/216)) ([47e4967](https://github.com/The-Vibe-Company/companion/commit/47e4967215a5bfd84c8afc2a86ce42151c73d187))
* **codex:** fix 3 critical bugs in Codex backend integration ([#147](https://github.com/The-Vibe-Company/companion/issues/147)) ([0ec92db](https://github.com/The-Vibe-Company/companion/commit/0ec92db909c7be42f94cc21d2890c9c123702dd7))
* **codex:** handle init failure gracefully and isolate per-session CODEX_HOME ([#210](https://github.com/The-Vibe-Company/companion/issues/210)) ([f4efcea](https://github.com/The-Vibe-Company/companion/commit/f4efceace6c260de92df728335678b7bded3e144))
* make service stop actually stop on macOS and refresh stale update checks ([#192](https://github.com/The-Vibe-Company/companion/issues/192)) ([f608f64](https://github.com/The-Vibe-Company/companion/commit/f608f64887bf78b2cca909aa20bd87e4a897ce94))
* remove vibe alias, update repo URLs to companion ([#30](https://github.com/The-Vibe-Company/companion/issues/30)) ([4f7b47c](https://github.com/The-Vibe-Company/companion/commit/4f7b47cba86c278e89fe81292fea9b8b3e75c035))
* scope permission requests to their session tab ([#35](https://github.com/The-Vibe-Company/companion/issues/35)) ([ef9f41c](https://github.com/The-Vibe-Company/companion/commit/ef9f41c8589e382de1db719984931bc4e91aeb11))
* show pasted images in chat history ([#32](https://github.com/The-Vibe-Company/companion/issues/32)) ([46365be](https://github.com/The-Vibe-Company/companion/commit/46365be45ae8b325100ed296617455c105d4d52e))
* **sidebar:** nest notification toggles behind disclosure ([#207](https://github.com/The-Vibe-Company/companion/issues/207)) ([87e71b8](https://github.com/The-Vibe-Company/companion/commit/87e71b8f5bf3e47c96421bca315ac412934a7dc2))
* **task-panel:** enable scrolling for long MCP sections ([#204](https://github.com/The-Vibe-Company/companion/issues/204)) ([b98abbb](https://github.com/The-Vibe-Company/companion/commit/b98abbbea4355c7e91d4dc322e53e638f4e4c542))
* track all commits in release-please, not just web/ ([#27](https://github.com/The-Vibe-Company/companion/issues/27)) ([d49f649](https://github.com/The-Vibe-Company/companion/commit/d49f64996d02807baf0482ce3c3607ae59f78638))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([e296ab0](https://github.com/The-Vibe-Company/companion/commit/e296ab0fabd6345b1f21c7094ca1f8d6f6af79cb))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([#26](https://github.com/The-Vibe-Company/companion/issues/26)) ([61eed5a](https://github.com/The-Vibe-Company/companion/commit/61eed5addd6e332fac360d9ae8239f1b0f93868e))
* use random suffixes for worktree branch names ([#88](https://github.com/The-Vibe-Company/companion/issues/88)) ([0b79f9a](https://github.com/The-Vibe-Company/companion/commit/0b79f9af172595cb84810b5d4cd65e0ed9c8e23d))
* **web:** always generate unique branch names for worktrees with forceNew ([#131](https://github.com/The-Vibe-Company/companion/issues/131)) ([cd62d4a](https://github.com/The-Vibe-Company/companion/commit/cd62d4ac8fae0b56cdef0ff850eab4a8c707f99b))
* **web:** chat scroll and composer visibility in plan mode ([#55](https://github.com/The-Vibe-Company/companion/issues/55)) ([4cff10c](https://github.com/The-Vibe-Company/companion/commit/4cff10cde297b7142c088584b6dd83060902c526))
* **web:** deduplicate messages on WebSocket reconnection ([#150](https://github.com/The-Vibe-Company/companion/issues/150)) ([a81bb3d](https://github.com/The-Vibe-Company/companion/commit/a81bb3d878957f1f18234a5f9194d1d8064f795c))
* **web:** default folder picker to home directory instead of server cwd ([#122](https://github.com/The-Vibe-Company/companion/issues/122)) ([7b8a4c7](https://github.com/The-Vibe-Company/companion/commit/7b8a4c71f32c68ffcc907269e88b3711c0d5af7a))
* **web:** enable codex web search when internet toggle is on ([#135](https://github.com/The-Vibe-Company/companion/issues/135)) ([8d9f0b0](https://github.com/The-Vibe-Company/companion/commit/8d9f0b002dcafcfc020862cb107777d75fc2580e))
* **web:** fetch and pull selected branch on session create ([#137](https://github.com/The-Vibe-Company/companion/issues/137)) ([9cdbbe1](https://github.com/The-Vibe-Company/companion/commit/9cdbbe1e151f024bd41f60e20c60e2f092ba7014))
* **web:** fix Codex approval policy and Composer mode labels ([#106](https://github.com/The-Vibe-Company/companion/issues/106)) ([fd5c2f1](https://github.com/The-Vibe-Company/companion/commit/fd5c2f15b144eb2ae9ec809fdb6ee19e797dc15a))
* **web:** fix session auto-rename and add blur-to-focus animation ([#86](https://github.com/The-Vibe-Company/companion/issues/86)) ([6d3c91f](https://github.com/The-Vibe-Company/companion/commit/6d3c91f73a65054e2c15727e90ca554af70eed28))
* **web:** fix WritableStream locked race condition in Codex adapter ([b43569d](https://github.com/The-Vibe-Company/companion/commit/b43569dbb3d154a303d60ec6bc2007b5a7bcedea))
* **web:** improve light mode contrast ([#89](https://github.com/The-Vibe-Company/companion/issues/89)) ([7ac7886](https://github.com/The-Vibe-Company/companion/commit/7ac7886fc6305e3ec45698a1c7c91b72a91c7c44))
* **web:** improve responsive design across all components ([#85](https://github.com/The-Vibe-Company/companion/issues/85)) ([0750fbb](https://github.com/The-Vibe-Company/companion/commit/0750fbbbe456d79bc104fdbdaf8f08e8795a3b62))
* **web:** isolate worktree sessions with proper branch-tracking ([#74](https://github.com/The-Vibe-Company/companion/issues/74)) ([764d7a7](https://github.com/The-Vibe-Company/companion/commit/764d7a7f5391a686408a8542421f771da341d5db))
* **web:** polyfill localStorage for Node.js 22+ ([#149](https://github.com/The-Vibe-Company/companion/issues/149)) ([602c684](https://github.com/The-Vibe-Company/companion/commit/602c6841f03677ec3f419860469e39b791968de6))
* **web:** prevent iOS auto-zoom on mobile input focus ([#102](https://github.com/The-Vibe-Company/companion/issues/102)) ([18ee23f](https://github.com/The-Vibe-Company/companion/commit/18ee23f6f1674fbcf5e1be25f8c4e23510bc12b5))
* **web:** prevent mobile keyboard layout shift and iOS zoom on branch selector ([#159](https://github.com/The-Vibe-Company/companion/issues/159)) ([4276afd](https://github.com/The-Vibe-Company/companion/commit/4276afd4390808d9d040555652c80bd1461c45b7))
* **web:** refresh git branch tracking after session start ([#195](https://github.com/The-Vibe-Company/companion/issues/195)) ([c3cb47b](https://github.com/The-Vibe-Company/companion/commit/c3cb47b56257b866b76abbb66709694cb26e0925))
* **web:** resolve [object Object] display for Codex file edit results ([#133](https://github.com/The-Vibe-Company/companion/issues/133)) ([9cc21a7](https://github.com/The-Vibe-Company/companion/commit/9cc21a78064cf07bb90174dd87bbfbd367516c90))
* **web:** resolve original repo root for worktree sessions in sidebar grouping ([#120](https://github.com/The-Vibe-Company/companion/issues/120)) ([8925ac9](https://github.com/The-Vibe-Company/companion/commit/8925ac9f540b3cd2520268539d21b0267b2dadb1))
* **web:** session reconnection with auto-relaunch and persist ([#49](https://github.com/The-Vibe-Company/companion/issues/49)) ([f58e542](https://github.com/The-Vibe-Company/companion/commit/f58e5428847a342069e6790fa7d70f190bc5f396))
* **web:** stable session ordering — sort by creation date only ([#173](https://github.com/The-Vibe-Company/companion/issues/173)) ([05c3a06](https://github.com/The-Vibe-Company/companion/commit/05c3a0652b823c5ca20b233be164a899f9920caf))
* **web:** unset CLAUDECODE env var to prevent CLI nesting guard rejec… ([#181](https://github.com/The-Vibe-Company/companion/issues/181)) ([75e264a](https://github.com/The-Vibe-Company/companion/commit/75e264a0be975dadbf3d56e64b990e0e07b12777))
* **web:** use --resume on CLI relaunch to restore conversation context ([#46](https://github.com/The-Vibe-Company/companion/issues/46)) ([3e2b5bd](https://github.com/The-Vibe-Company/companion/commit/3e2b5bdd39bd265ca5675784227a9f1b4f2a8aa3))

## [0.34.5](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.4...the-companion-v0.34.5) (2026-02-13)


### Bug Fixes

* **cli:** fix Linux systemd service management (start, auto-restart) ([#213](https://github.com/The-Vibe-Company/companion/issues/213)) ([fc1dd65](https://github.com/The-Vibe-Company/companion/commit/fc1dd65a9fd32958d47499af1b35992a0c10fe8e))
* **cli:** refresh systemd unit file on start/restart to prevent restart loops ([#215](https://github.com/The-Vibe-Company/companion/issues/215)) ([35f80d9](https://github.com/The-Vibe-Company/companion/commit/35f80d963b1f0f0feccf7215a9bd4711b4520a12))
* **cli:** resolve binaries via user shell PATH when running as service ([#216](https://github.com/The-Vibe-Company/companion/issues/216)) ([47e4967](https://github.com/The-Vibe-Company/companion/commit/47e4967215a5bfd84c8afc2a86ce42151c73d187))

## [0.34.4](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.3...the-companion-v0.34.4) (2026-02-13)


### Bug Fixes

* **codex:** handle init failure gracefully and isolate per-session CODEX_HOME ([#210](https://github.com/The-Vibe-Company/companion/issues/210)) ([f4efcea](https://github.com/The-Vibe-Company/companion/commit/f4efceace6c260de92df728335678b7bded3e144))

## [0.34.3](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.2...the-companion-v0.34.3) (2026-02-13)


### Bug Fixes

* **cli:** auto-update restarts service reliably via explicit systemctl/launchctl ([#208](https://github.com/The-Vibe-Company/companion/issues/208)) ([33fa67e](https://github.com/The-Vibe-Company/companion/commit/33fa67ebd75609b9a7b8700ce67b1dd949663b06))

## [0.34.2](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.1...the-companion-v0.34.2) (2026-02-13)


### Bug Fixes

* **sidebar:** nest notification toggles behind disclosure ([#207](https://github.com/The-Vibe-Company/companion/issues/207)) ([87e71b8](https://github.com/The-Vibe-Company/companion/commit/87e71b8f5bf3e47c96421bca315ac412934a7dc2))

## [0.34.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.34.0...the-companion-v0.34.1) (2026-02-13)


### Bug Fixes

* **task-panel:** enable scrolling for long MCP sections ([#204](https://github.com/The-Vibe-Company/companion/issues/204)) ([b98abbb](https://github.com/The-Vibe-Company/companion/commit/b98abbbea4355c7e91d4dc322e53e638f4e4c542))

## [0.34.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.33.0...the-companion-v0.34.0) (2026-02-13)


### Features

* **cli:** start and stop Companion via daemon service ([#201](https://github.com/The-Vibe-Company/companion/issues/201)) ([39e2b79](https://github.com/The-Vibe-Company/companion/commit/39e2b79a6dbb70e7c7dcaf3ccbaf2116ac26b43a))
* **sidebar:** group sound and alerts under notification ([#203](https://github.com/The-Vibe-Company/companion/issues/203)) ([0077e75](https://github.com/The-Vibe-Company/companion/commit/0077e75208e7505a53db8a829a9480a77b8c3916))

## [0.33.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.32.0...the-companion-v0.33.0) (2026-02-13)


### Features

* **web:** add browser web notifications ([#191](https://github.com/The-Vibe-Company/companion/issues/191)) ([092c59a](https://github.com/The-Vibe-Company/companion/commit/092c59aff620aa2b2eac51903c01ad7cb0c4bc8e))

## [0.32.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.31.0...the-companion-v0.32.0) (2026-02-13)


### Features

* add MCP server management support ([#198](https://github.com/The-Vibe-Company/companion/issues/198)) ([018cf1f](https://github.com/The-Vibe-Company/companion/commit/018cf1f65ea5e281c19a39367f8cccf14ac56c1f))


### Bug Fixes

* **web:** refresh git branch tracking after session start ([#195](https://github.com/The-Vibe-Company/companion/issues/195)) ([c3cb47b](https://github.com/The-Vibe-Company/companion/commit/c3cb47b56257b866b76abbb66709694cb26e0925))

## [0.31.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.30.1...the-companion-v0.31.0) (2026-02-13)


### Features

* **codex:** add offline protocol compatibility guardrails and playground coverage ([#194](https://github.com/The-Vibe-Company/companion/issues/194)) ([bf0a43e](https://github.com/The-Vibe-Company/companion/commit/bf0a43e5fdc791166e76391c0ee1ad3cf18dae10))


### Bug Fixes

* make service stop actually stop on macOS and refresh stale update checks ([#192](https://github.com/The-Vibe-Company/companion/issues/192)) ([f608f64](https://github.com/The-Vibe-Company/companion/commit/f608f64887bf78b2cca909aa20bd87e4a897ce94))

## [0.30.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.30.0...the-companion-v0.30.1) (2026-02-13)


### Bug Fixes

* **cli:** expose stop/restart in help and add test ([#188](https://github.com/The-Vibe-Company/companion/issues/188)) ([c307525](https://github.com/The-Vibe-Company/companion/commit/c30752545f2137fd7c03525d5bb7f5f8851271d4))

## [0.30.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.29.0...the-companion-v0.30.0) (2026-02-13)


### Features

* **cli:** add stop and restart service commands ([#185](https://github.com/The-Vibe-Company/companion/issues/185)) ([04da8e5](https://github.com/The-Vibe-Company/companion/commit/04da8e5a3d3f0e363f662cdd6bca6145eaec479f))

## [0.29.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.28.0...the-companion-v0.29.0) (2026-02-13)


### Features

* **web:** adaptive server-side PR polling with WebSocket push ([#178](https://github.com/The-Vibe-Company/companion/issues/178)) ([57939e4](https://github.com/The-Vibe-Company/companion/commit/57939e4030a4b0e5a7dae39d93c34944e3bdff0f))


### Bug Fixes

* **web:** unset CLAUDECODE env var to prevent CLI nesting guard rejec… ([#181](https://github.com/The-Vibe-Company/companion/issues/181)) ([75e264a](https://github.com/The-Vibe-Company/companion/commit/75e264a0be975dadbf3d56e64b990e0e07b12777))

## [0.28.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.27.1...the-companion-v0.28.0) (2026-02-12)


### Features

* **web:** add embedded terminal in sidebar ([#175](https://github.com/The-Vibe-Company/companion/issues/175)) ([e711c5d](https://github.com/The-Vibe-Company/companion/commit/e711c5d5ef40edfa9c265642383a4c526b9b3ece))

## [0.27.1](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.27.0...the-companion-v0.27.1) (2026-02-12)


### Bug Fixes

* **web:** stable session ordering — sort by creation date only ([#173](https://github.com/The-Vibe-Company/companion/issues/173)) ([05c3a06](https://github.com/The-Vibe-Company/companion/commit/05c3a0652b823c5ca20b233be164a899f9920caf))

## [0.27.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.26.0...the-companion-v0.27.0) (2026-02-12)


### Features

* OpenRouter-based session auto-naming + settings page ([#168](https://github.com/The-Vibe-Company/companion/issues/168)) ([a86b1e7](https://github.com/The-Vibe-Company/companion/commit/a86b1e711ff1c38985bb3d622c6ec372a266637e))
* **web:** add CLAUDE.md editor button in TopBar ([#170](https://github.com/The-Vibe-Company/companion/issues/170)) ([f553b9b](https://github.com/The-Vibe-Company/companion/commit/f553b9b86842f0b47c0bf24b08903e0352b7b078))

## [0.26.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.25.0...the-companion-v0.26.0) (2026-02-12)


### Features

* add Linux systemd support for service install/uninstall ([#169](https://github.com/The-Vibe-Company/companion/issues/169)) ([73fb3f7](https://github.com/The-Vibe-Company/companion/commit/73fb3f721efde79fec50f9c74a4f078f821c35d3))

## [0.25.0](https://github.com/The-Vibe-Company/companion/compare/the-companion-v0.24.0...the-companion-v0.25.0) (2026-02-12)


### Features

* Add permission & plan approval E2E tests ([#6](https://github.com/The-Vibe-Company/companion/issues/6)) ([8590a68](https://github.com/The-Vibe-Company/companion/commit/8590a68657f0a06e94795a179ad4bbedae782c63))
* add release-please for automated npm publishing ([#24](https://github.com/The-Vibe-Company/companion/issues/24)) ([93b24ee](https://github.com/The-Vibe-Company/companion/commit/93b24ee4a12b3f32e81f59a348b25e89aaa86dce))
* allow dev server access over Tailscale/LAN ([#33](https://github.com/The-Vibe-Company/companion/issues/33)) ([9599d7a](https://github.com/The-Vibe-Company/companion/commit/9599d7ad4e2823d51c8fa262e1dcd96eeb056244))
* claude.md update ([7fa4e7a](https://github.com/The-Vibe-Company/companion/commit/7fa4e7adfdc7c409cfeed4e8a11f237ff0572234))
* **cli:** add service install/uninstall and separate dev/prod ports ([#155](https://github.com/The-Vibe-Company/companion/issues/155)) ([a4e5ba6](https://github.com/The-Vibe-Company/companion/commit/a4e5ba6ced2cc8041f61b303b0205f36e50b7594))
* Corriger menu dossier mobile et décalage clavier ([#151](https://github.com/The-Vibe-Company/companion/issues/151)) ([8068925](https://github.com/The-Vibe-Company/companion/commit/8068925f6a5ec5c6b7a40b36398bd4f9be04708d))
* e2e permissions plans ([#9](https://github.com/The-Vibe-Company/companion/issues/9)) ([53b38bf](https://github.com/The-Vibe-Company/companion/commit/53b38bfd4e773454492a3fea10e8db7ffd3fd768))
* Fix Diffs panel for worktree/relative paths and untracked files ([#165](https://github.com/The-Vibe-Company/companion/issues/165)) ([6810643](https://github.com/The-Vibe-Company/companion/commit/681064328d2bf3f4fc5c3a1867abc1536d2d54f3))
* Hide successful no-output command results ([#139](https://github.com/The-Vibe-Company/companion/issues/139)) ([a66e386](https://github.com/The-Vibe-Company/companion/commit/a66e386491e6887c5684cd70f63cc49cac0a64b7))
* **landing:** add marketing landing page for thecompanion.sh ([#128](https://github.com/The-Vibe-Company/companion/issues/128)) ([170b89c](https://github.com/The-Vibe-Company/companion/commit/170b89c72012dfb0ba68239a7665634d65275aa3))
* protocol conformance fixes and improved E2E tests ([#14](https://github.com/The-Vibe-Company/companion/issues/14)) ([51b13b9](https://github.com/The-Vibe-Company/companion/commit/51b13b9d647de6c92881b1abb61161f39152e0ef))
* Redesign README as a landing page with API-first documentation ([#7](https://github.com/The-Vibe-Company/companion/issues/7)) ([a59e1b4](https://github.com/The-Vibe-Company/companion/commit/a59e1b4604baf87faa32af7d62e4846afae49dbe))
* simplified claude() API, unified endpoints, and landing page README ([#12](https://github.com/The-Vibe-Company/companion/issues/12)) ([aa2e535](https://github.com/The-Vibe-Company/companion/commit/aa2e535fe0a83b726ff2a2c08359e55973a9136b))
* The Vibe Companion complete web UI rewrite + npm package ([#23](https://github.com/The-Vibe-Company/companion/issues/23)) ([0bdc77a](https://github.com/The-Vibe-Company/companion/commit/0bdc77a81b21cd9d08ba29ea48844e73df3a1852))
* trigger release for statusline capture ([#19](https://github.com/The-Vibe-Company/companion/issues/19)) ([cedc9df](https://github.com/The-Vibe-Company/companion/commit/cedc9dfb7445344bdb43a1a756f1d2e538e08c76))
* **web:** add Clawd-inspired pixel art logo and favicon ([#70](https://github.com/The-Vibe-Company/companion/issues/70)) ([b3994ef](https://github.com/The-Vibe-Company/companion/commit/b3994eff2eac62c3cf8f40a8c31b720c910a7601))
* **web:** add component playground and ExitPlanMode display ([#36](https://github.com/The-Vibe-Company/companion/issues/36)) ([e958be7](https://github.com/The-Vibe-Company/companion/commit/e958be780f1b6e1a8f65daedbf968cdf6ef47798))
* **web:** add embedded code editor with file tree, changed files tracking, and diff view ([#81](https://github.com/The-Vibe-Company/companion/issues/81)) ([3ed0957](https://github.com/The-Vibe-Company/companion/commit/3ed095790c73edeef911ab4c73d74f1998100c5c))
* **web:** add git worktree support for isolated multi-branch sessions ([#64](https://github.com/The-Vibe-Company/companion/issues/64)) ([fee39d6](https://github.com/The-Vibe-Company/companion/commit/fee39d62986cd99700ba78c84a1f586331955ff8))
* **web:** add GitHub PR status to TaskPanel sidebar ([#166](https://github.com/The-Vibe-Company/companion/issues/166)) ([6ace3b2](https://github.com/The-Vibe-Company/companion/commit/6ace3b2944ec9e9082a11a45fe0798f0f5f41e55))
* **web:** add missing message-flow components to Playground ([#156](https://github.com/The-Vibe-Company/companion/issues/156)) ([ef6c27d](https://github.com/The-Vibe-Company/companion/commit/ef6c27dfa950c11b09394c74c4452c0b02aed8fb))
* **web:** add notification sound on task completion ([#99](https://github.com/The-Vibe-Company/companion/issues/99)) ([337c735](https://github.com/The-Vibe-Company/companion/commit/337c735e8267f076ada4b9ef01632d37376ec2d0))
* **web:** add OpenAI Codex CLI backend integration ([#100](https://github.com/The-Vibe-Company/companion/issues/100)) ([54e3c1a](https://github.com/The-Vibe-Company/companion/commit/54e3c1a2b359719d7983fa9ee857507e1446f505))
* **web:** add per-session usage limits with OAuth refresh and Codex support ([24ebd32](https://github.com/The-Vibe-Company/companion/commit/24ebd32f5ec617290b6b93e8bc76972a3b80d6a9))
* **web:** add permission suggestions and pending permission indicators ([10422c1](https://github.com/The-Vibe-Company/companion/commit/10422c1464b6ad4bc45eb90e6cd9ebbc0ebeac92))
* **web:** add PWA support for mobile home screen install ([#116](https://github.com/The-Vibe-Company/companion/issues/116)) ([85e605f](https://github.com/The-Vibe-Company/companion/commit/85e605fd758ee952e0d5b1dbc6f7065b514844a7))
* **web:** add update-available banner with auto-update for service mode ([#158](https://github.com/The-Vibe-Company/companion/issues/158)) ([727bd7f](https://github.com/The-Vibe-Company/companion/commit/727bd7fbd16557fd63ce41632592c1485e69713c))
* **web:** add usage limits display in session panel ([#97](https://github.com/The-Vibe-Company/companion/issues/97)) ([d29f489](https://github.com/The-Vibe-Company/companion/commit/d29f489ed9951d36ff45ec240410ffd8ffdf05eb))
* **web:** archive sessions instead of deleting them ([#56](https://github.com/The-Vibe-Company/companion/issues/56)) ([489d608](https://github.com/The-Vibe-Company/companion/commit/489d6087fc99b9131386547edaf3bd303a114090))
* **web:** enlarge homepage logo as hero element ([#71](https://github.com/The-Vibe-Company/companion/issues/71)) ([18ead74](https://github.com/The-Vibe-Company/companion/commit/18ead7436d3ebbe9d766754ddb17aa504c63703f))
* **web:** git fetch on branch picker open ([#72](https://github.com/The-Vibe-Company/companion/issues/72)) ([f110405](https://github.com/The-Vibe-Company/companion/commit/f110405edbd0f00454edd65ed72197daf0293182))
* **web:** git info display, folder dropdown fix, dev workflow ([#43](https://github.com/The-Vibe-Company/companion/issues/43)) ([1fe2069](https://github.com/The-Vibe-Company/companion/commit/1fe2069a7db17b410e383f883c934ee1662c2171))
* **web:** git worktree support with branch picker and git pull ([#65](https://github.com/The-Vibe-Company/companion/issues/65)) ([4d0c9c8](https://github.com/The-Vibe-Company/companion/commit/4d0c9c83f4fe13be863313d6c945ce0b671a7f8a))
* **web:** group sidebar sessions by project directory ([#117](https://github.com/The-Vibe-Company/companion/issues/117)) ([deceb59](https://github.com/The-Vibe-Company/companion/commit/deceb599975f53141e9c0bd6c7675437f96978b8))
* **web:** named environment profiles (~/.companion/envs/) ([#50](https://github.com/The-Vibe-Company/companion/issues/50)) ([eaa1a49](https://github.com/The-Vibe-Company/companion/commit/eaa1a497f3be61f2f71f9467e93fa2b65be19095))
* **web:** persist sessions to disk for dev mode resilience ([#45](https://github.com/The-Vibe-Company/companion/issues/45)) ([c943d00](https://github.com/The-Vibe-Company/companion/commit/c943d0047b728854f059e26facde950e08cdfe0c))
* **web:** redesign session list with avatars, auto-reconnect, and git info ([#111](https://github.com/The-Vibe-Company/companion/issues/111)) ([8a7284b](https://github.com/The-Vibe-Company/companion/commit/8a7284b3c08dc301a879924aea133945697b037a))
* **web:** replace CodeMirror editor with unified diff viewer ([#160](https://github.com/The-Vibe-Company/companion/issues/160)) ([f9b6869](https://github.com/The-Vibe-Company/companion/commit/f9b686902011ffd194a118cc1cb022bac71eaa3b))
* **web:** replace folder picker dropdown with fixed-size modal ([#76](https://github.com/The-Vibe-Company/companion/issues/76)) ([979e395](https://github.com/The-Vibe-Company/companion/commit/979e395b530cdb21e6a073ba60e33ea8ac497e2a))
* **web:** session rename persistence + auto-generated titles ([#79](https://github.com/The-Vibe-Company/companion/issues/79)) ([e1dc58c](https://github.com/The-Vibe-Company/companion/commit/e1dc58ce8ab9a619d36f2261cce89b90cfdb70d6))
* **web:** warn when branch is behind remote before session creation ([#127](https://github.com/The-Vibe-Company/companion/issues/127)) ([ef89d5c](https://github.com/The-Vibe-Company/companion/commit/ef89d5c208ca5da006aaa88b78dbd647186fb0df))


### Bug Fixes

* add web/dist to gitignore ([#2](https://github.com/The-Vibe-Company/companion/issues/2)) ([b9ac264](https://github.com/The-Vibe-Company/companion/commit/b9ac264fbb99415517636517e8f503d40fe3253d))
* always update statusLine settings on agent spawn ([#21](https://github.com/The-Vibe-Company/companion/issues/21)) ([71c343c](https://github.com/The-Vibe-Company/companion/commit/71c343cfd29fff3204ad0cc2986ff000d1be5adc))
* auto-accept workspace trust prompt and handle idle in ask() ([#16](https://github.com/The-Vibe-Company/companion/issues/16)) ([ded31b4](https://github.com/The-Vibe-Company/companion/commit/ded31b4cf9900f7ed8c3ff373ef16ae8f1e8a886))
* checkout selected branch when worktree mode is off ([#68](https://github.com/The-Vibe-Company/companion/issues/68)) ([500f3b1](https://github.com/The-Vibe-Company/companion/commit/500f3b112c5ccc646c7965344b5774efe1338377))
* **codex:** fix 3 critical bugs in Codex backend integration ([#147](https://github.com/The-Vibe-Company/companion/issues/147)) ([0ec92db](https://github.com/The-Vibe-Company/companion/commit/0ec92db909c7be42f94cc21d2890c9c123702dd7))
* remove vibe alias, update repo URLs to companion ([#30](https://github.com/The-Vibe-Company/companion/issues/30)) ([4f7b47c](https://github.com/The-Vibe-Company/companion/commit/4f7b47cba86c278e89fe81292fea9b8b3e75c035))
* scope permission requests to their session tab ([#35](https://github.com/The-Vibe-Company/companion/issues/35)) ([ef9f41c](https://github.com/The-Vibe-Company/companion/commit/ef9f41c8589e382de1db719984931bc4e91aeb11))
* show pasted images in chat history ([#32](https://github.com/The-Vibe-Company/companion/issues/32)) ([46365be](https://github.com/The-Vibe-Company/companion/commit/46365be45ae8b325100ed296617455c105d4d52e))
* track all commits in release-please, not just web/ ([#27](https://github.com/The-Vibe-Company/companion/issues/27)) ([d49f649](https://github.com/The-Vibe-Company/companion/commit/d49f64996d02807baf0482ce3c3607ae59f78638))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([e296ab0](https://github.com/The-Vibe-Company/companion/commit/e296ab0fabd6345b1f21c7094ca1f8d6f6af79cb))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([#26](https://github.com/The-Vibe-Company/companion/issues/26)) ([61eed5a](https://github.com/The-Vibe-Company/companion/commit/61eed5addd6e332fac360d9ae8239f1b0f93868e))
* use random suffixes for worktree branch names ([#88](https://github.com/The-Vibe-Company/companion/issues/88)) ([0b79f9a](https://github.com/The-Vibe-Company/companion/commit/0b79f9af172595cb84810b5d4cd65e0ed9c8e23d))
* **web:** always generate unique branch names for worktrees with forceNew ([#131](https://github.com/The-Vibe-Company/companion/issues/131)) ([cd62d4a](https://github.com/The-Vibe-Company/companion/commit/cd62d4ac8fae0b56cdef0ff850eab4a8c707f99b))
* **web:** chat scroll and composer visibility in plan mode ([#55](https://github.com/The-Vibe-Company/companion/issues/55)) ([4cff10c](https://github.com/The-Vibe-Company/companion/commit/4cff10cde297b7142c088584b6dd83060902c526))
* **web:** deduplicate messages on WebSocket reconnection ([#150](https://github.com/The-Vibe-Company/companion/issues/150)) ([a81bb3d](https://github.com/The-Vibe-Company/companion/commit/a81bb3d878957f1f18234a5f9194d1d8064f795c))
* **web:** default folder picker to home directory instead of server cwd ([#122](https://github.com/The-Vibe-Company/companion/issues/122)) ([7b8a4c7](https://github.com/The-Vibe-Company/companion/commit/7b8a4c71f32c68ffcc907269e88b3711c0d5af7a))
* **web:** enable codex web search when internet toggle is on ([#135](https://github.com/The-Vibe-Company/companion/issues/135)) ([8d9f0b0](https://github.com/The-Vibe-Company/companion/commit/8d9f0b002dcafcfc020862cb107777d75fc2580e))
* **web:** fetch and pull selected branch on session create ([#137](https://github.com/The-Vibe-Company/companion/issues/137)) ([9cdbbe1](https://github.com/The-Vibe-Company/companion/commit/9cdbbe1e151f024bd41f60e20c60e2f092ba7014))
* **web:** fix Codex approval policy and Composer mode labels ([#106](https://github.com/The-Vibe-Company/companion/issues/106)) ([fd5c2f1](https://github.com/The-Vibe-Company/companion/commit/fd5c2f15b144eb2ae9ec809fdb6ee19e797dc15a))
* **web:** fix session auto-rename and add blur-to-focus animation ([#86](https://github.com/The-Vibe-Company/companion/issues/86)) ([6d3c91f](https://github.com/The-Vibe-Company/companion/commit/6d3c91f73a65054e2c15727e90ca554af70eed28))
* **web:** fix WritableStream locked race condition in Codex adapter ([b43569d](https://github.com/The-Vibe-Company/companion/commit/b43569dbb3d154a303d60ec6bc2007b5a7bcedea))
* **web:** improve light mode contrast ([#89](https://github.com/The-Vibe-Company/companion/issues/89)) ([7ac7886](https://github.com/The-Vibe-Company/companion/commit/7ac7886fc6305e3ec45698a1c7c91b72a91c7c44))
* **web:** improve responsive design across all components ([#85](https://github.com/The-Vibe-Company/companion/issues/85)) ([0750fbb](https://github.com/The-Vibe-Company/companion/commit/0750fbbbe456d79bc104fdbdaf8f08e8795a3b62))
* **web:** isolate worktree sessions with proper branch-tracking ([#74](https://github.com/The-Vibe-Company/companion/issues/74)) ([764d7a7](https://github.com/The-Vibe-Company/companion/commit/764d7a7f5391a686408a8542421f771da341d5db))
* **web:** polyfill localStorage for Node.js 22+ ([#149](https://github.com/The-Vibe-Company/companion/issues/149)) ([602c684](https://github.com/The-Vibe-Company/companion/commit/602c6841f03677ec3f419860469e39b791968de6))
* **web:** prevent iOS auto-zoom on mobile input focus ([#102](https://github.com/The-Vibe-Company/companion/issues/102)) ([18ee23f](https://github.com/The-Vibe-Company/companion/commit/18ee23f6f1674fbcf5e1be25f8c4e23510bc12b5))
* **web:** prevent mobile keyboard layout shift and iOS zoom on branch selector ([#159](https://github.com/The-Vibe-Company/companion/issues/159)) ([4276afd](https://github.com/The-Vibe-Company/companion/commit/4276afd4390808d9d040555652c80bd1461c45b7))
* **web:** resolve [object Object] display for Codex file edit results ([#133](https://github.com/The-Vibe-Company/companion/issues/133)) ([9cc21a7](https://github.com/The-Vibe-Company/companion/commit/9cc21a78064cf07bb90174dd87bbfbd367516c90))
* **web:** resolve original repo root for worktree sessions in sidebar grouping ([#120](https://github.com/The-Vibe-Company/companion/issues/120)) ([8925ac9](https://github.com/The-Vibe-Company/companion/commit/8925ac9f540b3cd2520268539d21b0267b2dadb1))
* **web:** session reconnection with auto-relaunch and persist ([#49](https://github.com/The-Vibe-Company/companion/issues/49)) ([f58e542](https://github.com/The-Vibe-Company/companion/commit/f58e5428847a342069e6790fa7d70f190bc5f396))
* **web:** use --resume on CLI relaunch to restore conversation context ([#46](https://github.com/The-Vibe-Company/companion/issues/46)) ([3e2b5bd](https://github.com/The-Vibe-Company/companion/commit/3e2b5bdd39bd265ca5675784227a9f1b4f2a8aa3))

## [0.24.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.23.0...the-vibe-companion-v0.24.0) (2026-02-12)


### Features

* Fix Diffs panel for worktree/relative paths and untracked files ([#165](https://github.com/The-Vibe-Company/companion/issues/165)) ([6810643](https://github.com/The-Vibe-Company/companion/commit/681064328d2bf3f4fc5c3a1867abc1536d2d54f3))
* **web:** add GitHub PR status to TaskPanel sidebar ([#166](https://github.com/The-Vibe-Company/companion/issues/166)) ([6ace3b2](https://github.com/The-Vibe-Company/companion/commit/6ace3b2944ec9e9082a11a45fe0798f0f5f41e55))
* **web:** add update-available banner with auto-update for service mode ([#158](https://github.com/The-Vibe-Company/companion/issues/158)) ([727bd7f](https://github.com/The-Vibe-Company/companion/commit/727bd7fbd16557fd63ce41632592c1485e69713c))
* **web:** replace CodeMirror editor with unified diff viewer ([#160](https://github.com/The-Vibe-Company/companion/issues/160)) ([f9b6869](https://github.com/The-Vibe-Company/companion/commit/f9b686902011ffd194a118cc1cb022bac71eaa3b))


### Bug Fixes

* **web:** prevent mobile keyboard layout shift and iOS zoom on branch selector ([#159](https://github.com/The-Vibe-Company/companion/issues/159)) ([4276afd](https://github.com/The-Vibe-Company/companion/commit/4276afd4390808d9d040555652c80bd1461c45b7))

## [0.23.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.22.1...the-vibe-companion-v0.23.0) (2026-02-12)


### Features

* **cli:** add service install/uninstall and separate dev/prod ports ([#155](https://github.com/The-Vibe-Company/companion/issues/155)) ([a4e5ba6](https://github.com/The-Vibe-Company/companion/commit/a4e5ba6ced2cc8041f61b303b0205f36e50b7594))
* **web:** add missing message-flow components to Playground ([#156](https://github.com/The-Vibe-Company/companion/issues/156)) ([ef6c27d](https://github.com/The-Vibe-Company/companion/commit/ef6c27dfa950c11b09394c74c4452c0b02aed8fb))

## [0.22.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.22.0...the-vibe-companion-v0.22.1) (2026-02-12)


### Bug Fixes

* **web:** polyfill localStorage for Node.js 22+ ([#149](https://github.com/The-Vibe-Company/companion/issues/149)) ([602c684](https://github.com/The-Vibe-Company/companion/commit/602c6841f03677ec3f419860469e39b791968de6))

## [0.22.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.21.0...the-vibe-companion-v0.22.0) (2026-02-12)


### Features

* Corriger menu dossier mobile et décalage clavier ([#151](https://github.com/The-Vibe-Company/companion/issues/151)) ([8068925](https://github.com/The-Vibe-Company/companion/commit/8068925f6a5ec5c6b7a40b36398bd4f9be04708d))


### Bug Fixes

* **codex:** fix 3 critical bugs in Codex backend integration ([#147](https://github.com/The-Vibe-Company/companion/issues/147)) ([0ec92db](https://github.com/The-Vibe-Company/companion/commit/0ec92db909c7be42f94cc21d2890c9c123702dd7))
* **web:** deduplicate messages on WebSocket reconnection ([#150](https://github.com/The-Vibe-Company/companion/issues/150)) ([a81bb3d](https://github.com/The-Vibe-Company/companion/commit/a81bb3d878957f1f18234a5f9194d1d8064f795c))

## [0.21.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.20.3...the-vibe-companion-v0.21.0) (2026-02-11)


### Features

* Hide successful no-output command results ([#139](https://github.com/The-Vibe-Company/companion/issues/139)) ([a66e386](https://github.com/The-Vibe-Company/companion/commit/a66e386491e6887c5684cd70f63cc49cac0a64b7))

## [0.20.3](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.20.2...the-vibe-companion-v0.20.3) (2026-02-11)


### Bug Fixes

* **web:** enable codex web search when internet toggle is on ([#135](https://github.com/The-Vibe-Company/companion/issues/135)) ([8d9f0b0](https://github.com/The-Vibe-Company/companion/commit/8d9f0b002dcafcfc020862cb107777d75fc2580e))
* **web:** fetch and pull selected branch on session create ([#137](https://github.com/The-Vibe-Company/companion/issues/137)) ([9cdbbe1](https://github.com/The-Vibe-Company/companion/commit/9cdbbe1e151f024bd41f60e20c60e2f092ba7014))

## [0.20.2](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.20.1...the-vibe-companion-v0.20.2) (2026-02-11)


### Bug Fixes

* **web:** resolve [object Object] display for Codex file edit results ([#133](https://github.com/The-Vibe-Company/companion/issues/133)) ([9cc21a7](https://github.com/The-Vibe-Company/companion/commit/9cc21a78064cf07bb90174dd87bbfbd367516c90))

## [0.20.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.20.0...the-vibe-companion-v0.20.1) (2026-02-11)


### Bug Fixes

* **web:** always generate unique branch names for worktrees with forceNew ([#131](https://github.com/The-Vibe-Company/companion/issues/131)) ([cd62d4a](https://github.com/The-Vibe-Company/companion/commit/cd62d4ac8fae0b56cdef0ff850eab4a8c707f99b))

## [0.20.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.19.1...the-vibe-companion-v0.20.0) (2026-02-11)


### Features

* **landing:** add marketing landing page for thecompanion.sh ([#128](https://github.com/The-Vibe-Company/companion/issues/128)) ([170b89c](https://github.com/The-Vibe-Company/companion/commit/170b89c72012dfb0ba68239a7665634d65275aa3))
* **web:** warn when branch is behind remote before session creation ([#127](https://github.com/The-Vibe-Company/companion/issues/127)) ([ef89d5c](https://github.com/The-Vibe-Company/companion/commit/ef89d5c208ca5da006aaa88b78dbd647186fb0df))

## [0.19.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.19.0...the-vibe-companion-v0.19.1) (2026-02-11)


### Bug Fixes

* **web:** default folder picker to home directory instead of server cwd ([#122](https://github.com/The-Vibe-Company/companion/issues/122)) ([7b8a4c7](https://github.com/The-Vibe-Company/companion/commit/7b8a4c71f32c68ffcc907269e88b3711c0d5af7a))

## [0.19.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.18.1...the-vibe-companion-v0.19.0) (2026-02-11)


### Features

* **web:** add PWA support for mobile home screen install ([#116](https://github.com/The-Vibe-Company/companion/issues/116)) ([85e605f](https://github.com/The-Vibe-Company/companion/commit/85e605fd758ee952e0d5b1dbc6f7065b514844a7))

## [0.18.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.18.0...the-vibe-companion-v0.18.1) (2026-02-11)


### Bug Fixes

* **web:** resolve original repo root for worktree sessions in sidebar grouping ([#120](https://github.com/The-Vibe-Company/companion/issues/120)) ([8925ac9](https://github.com/The-Vibe-Company/companion/commit/8925ac9f540b3cd2520268539d21b0267b2dadb1))

## [0.18.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.17.1...the-vibe-companion-v0.18.0) (2026-02-11)


### Features

* **web:** group sidebar sessions by project directory ([#117](https://github.com/The-Vibe-Company/companion/issues/117)) ([deceb59](https://github.com/The-Vibe-Company/companion/commit/deceb599975f53141e9c0bd6c7675437f96978b8))
* **web:** redesign session list with avatars, auto-reconnect, and git info ([#111](https://github.com/The-Vibe-Company/companion/issues/111)) ([8a7284b](https://github.com/The-Vibe-Company/companion/commit/8a7284b3c08dc301a879924aea133945697b037a))

## [0.17.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.17.0...the-vibe-companion-v0.17.1) (2026-02-11)


### Bug Fixes

* **web:** prevent iOS auto-zoom on mobile input focus ([#102](https://github.com/The-Vibe-Company/companion/issues/102)) ([18ee23f](https://github.com/The-Vibe-Company/companion/commit/18ee23f6f1674fbcf5e1be25f8c4e23510bc12b5))

## [0.17.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.16.0...the-vibe-companion-v0.17.0) (2026-02-11)


### Features

* **web:** add per-session usage limits with OAuth refresh and Codex support ([24ebd32](https://github.com/The-Vibe-Company/companion/commit/24ebd32f5ec617290b6b93e8bc76972a3b80d6a9))


### Bug Fixes

* **web:** fix WritableStream locked race condition in Codex adapter ([b43569d](https://github.com/The-Vibe-Company/companion/commit/b43569dbb3d154a303d60ec6bc2007b5a7bcedea))

## [0.16.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.15.0...the-vibe-companion-v0.16.0) (2026-02-11)


### Features

* **web:** add usage limits display in session panel ([#97](https://github.com/The-Vibe-Company/companion/issues/97)) ([d29f489](https://github.com/The-Vibe-Company/companion/commit/d29f489ed9951d36ff45ec240410ffd8ffdf05eb))


### Bug Fixes

* **web:** fix Codex approval policy and Composer mode labels ([#106](https://github.com/The-Vibe-Company/companion/issues/106)) ([fd5c2f1](https://github.com/The-Vibe-Company/companion/commit/fd5c2f15b144eb2ae9ec809fdb6ee19e797dc15a))

## [0.15.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.14.1...the-vibe-companion-v0.15.0) (2026-02-10)


### Features

* **web:** add notification sound on task completion ([#99](https://github.com/The-Vibe-Company/companion/issues/99)) ([337c735](https://github.com/The-Vibe-Company/companion/commit/337c735e8267f076ada4b9ef01632d37376ec2d0))
* **web:** add OpenAI Codex CLI backend integration ([#100](https://github.com/The-Vibe-Company/companion/issues/100)) ([54e3c1a](https://github.com/The-Vibe-Company/companion/commit/54e3c1a2b359719d7983fa9ee857507e1446f505))


### Bug Fixes

* use random suffixes for worktree branch names ([#88](https://github.com/The-Vibe-Company/companion/issues/88)) ([0b79f9a](https://github.com/The-Vibe-Company/companion/commit/0b79f9af172595cb84810b5d4cd65e0ed9c8e23d))
* **web:** improve light mode contrast ([#89](https://github.com/The-Vibe-Company/companion/issues/89)) ([7ac7886](https://github.com/The-Vibe-Company/companion/commit/7ac7886fc6305e3ec45698a1c7c91b72a91c7c44))

## [0.14.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.14.0...the-vibe-companion-v0.14.1) (2026-02-10)


### Bug Fixes

* **web:** fix session auto-rename and add blur-to-focus animation ([#86](https://github.com/The-Vibe-Company/companion/issues/86)) ([6d3c91f](https://github.com/The-Vibe-Company/companion/commit/6d3c91f73a65054e2c15727e90ca554af70eed28))
* **web:** improve responsive design across all components ([#85](https://github.com/The-Vibe-Company/companion/issues/85)) ([0750fbb](https://github.com/The-Vibe-Company/companion/commit/0750fbbbe456d79bc104fdbdaf8f08e8795a3b62))

## [0.14.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.13.0...the-vibe-companion-v0.14.0) (2026-02-10)


### Features

* **web:** add embedded code editor with file tree, changed files tracking, and diff view ([#81](https://github.com/The-Vibe-Company/companion/issues/81)) ([3ed0957](https://github.com/The-Vibe-Company/companion/commit/3ed095790c73edeef911ab4c73d74f1998100c5c))
* **web:** session rename persistence + auto-generated titles ([#79](https://github.com/The-Vibe-Company/companion/issues/79)) ([e1dc58c](https://github.com/The-Vibe-Company/companion/commit/e1dc58ce8ab9a619d36f2261cce89b90cfdb70d6))

## [0.13.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.12.1...the-vibe-companion-v0.13.0) (2026-02-10)


### Features

* **web:** replace folder picker dropdown with fixed-size modal ([#76](https://github.com/The-Vibe-Company/companion/issues/76)) ([979e395](https://github.com/The-Vibe-Company/companion/commit/979e395b530cdb21e6a073ba60e33ea8ac497e2a))

## [0.12.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.12.0...the-vibe-companion-v0.12.1) (2026-02-10)


### Bug Fixes

* **web:** isolate worktree sessions with proper branch-tracking ([#74](https://github.com/The-Vibe-Company/companion/issues/74)) ([764d7a7](https://github.com/The-Vibe-Company/companion/commit/764d7a7f5391a686408a8542421f771da341d5db))

## [0.12.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.11.0...the-vibe-companion-v0.12.0) (2026-02-10)


### Features

* **web:** git fetch on branch picker open ([#72](https://github.com/The-Vibe-Company/companion/issues/72)) ([f110405](https://github.com/The-Vibe-Company/companion/commit/f110405edbd0f00454edd65ed72197daf0293182))

## [0.11.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.10.0...the-vibe-companion-v0.11.0) (2026-02-10)


### Features

* **web:** add Clawd-inspired pixel art logo and favicon ([#70](https://github.com/The-Vibe-Company/companion/issues/70)) ([b3994ef](https://github.com/The-Vibe-Company/companion/commit/b3994eff2eac62c3cf8f40a8c31b720c910a7601))
* **web:** enlarge homepage logo as hero element ([#71](https://github.com/The-Vibe-Company/companion/issues/71)) ([18ead74](https://github.com/The-Vibe-Company/companion/commit/18ead7436d3ebbe9d766754ddb17aa504c63703f))


### Bug Fixes

* checkout selected branch when worktree mode is off ([#68](https://github.com/The-Vibe-Company/companion/issues/68)) ([500f3b1](https://github.com/The-Vibe-Company/companion/commit/500f3b112c5ccc646c7965344b5774efe1338377))

## [0.10.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.9.0...the-vibe-companion-v0.10.0) (2026-02-10)


### Features

* **web:** git worktree support with branch picker and git pull ([#65](https://github.com/The-Vibe-Company/companion/issues/65)) ([4d0c9c8](https://github.com/The-Vibe-Company/companion/commit/4d0c9c83f4fe13be863313d6c945ce0b671a7f8a))

## [0.9.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.8.1...the-vibe-companion-v0.9.0) (2026-02-10)


### Features

* claude.md update ([7fa4e7a](https://github.com/The-Vibe-Company/companion/commit/7fa4e7adfdc7c409cfeed4e8a11f237ff0572234))
* **web:** add git worktree support for isolated multi-branch sessions ([#64](https://github.com/The-Vibe-Company/companion/issues/64)) ([fee39d6](https://github.com/The-Vibe-Company/companion/commit/fee39d62986cd99700ba78c84a1f586331955ff8))

## [0.8.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.8.0...the-vibe-companion-v0.8.1) (2026-02-10)


### Bug Fixes

* **web:** chat scroll and composer visibility in plan mode ([#55](https://github.com/The-Vibe-Company/companion/issues/55)) ([4cff10c](https://github.com/The-Vibe-Company/companion/commit/4cff10cde297b7142c088584b6dd83060902c526))

## [0.8.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.7.0...the-vibe-companion-v0.8.0) (2026-02-10)


### Features

* **web:** archive sessions instead of deleting them ([#56](https://github.com/The-Vibe-Company/companion/issues/56)) ([489d608](https://github.com/The-Vibe-Company/companion/commit/489d6087fc99b9131386547edaf3bd303a114090))

## [0.7.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.6.1...the-vibe-companion-v0.7.0) (2026-02-10)


### Features

* **web:** named environment profiles (~/.companion/envs/) ([#50](https://github.com/The-Vibe-Company/companion/issues/50)) ([eaa1a49](https://github.com/The-Vibe-Company/companion/commit/eaa1a497f3be61f2f71f9467e93fa2b65be19095))

## [0.6.1](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.6.0...the-vibe-companion-v0.6.1) (2026-02-10)


### Bug Fixes

* **web:** session reconnection with auto-relaunch and persist ([#49](https://github.com/The-Vibe-Company/companion/issues/49)) ([f58e542](https://github.com/The-Vibe-Company/companion/commit/f58e5428847a342069e6790fa7d70f190bc5f396))
* **web:** use --resume on CLI relaunch to restore conversation context ([#46](https://github.com/The-Vibe-Company/companion/issues/46)) ([3e2b5bd](https://github.com/The-Vibe-Company/companion/commit/3e2b5bdd39bd265ca5675784227a9f1b4f2a8aa3))

## [0.6.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.5.0...the-vibe-companion-v0.6.0) (2026-02-10)


### Features

* **web:** git info display, folder dropdown fix, dev workflow ([#43](https://github.com/The-Vibe-Company/companion/issues/43)) ([1fe2069](https://github.com/The-Vibe-Company/companion/commit/1fe2069a7db17b410e383f883c934ee1662c2171))
* **web:** persist sessions to disk for dev mode resilience ([#45](https://github.com/The-Vibe-Company/companion/issues/45)) ([c943d00](https://github.com/The-Vibe-Company/companion/commit/c943d0047b728854f059e26facde950e08cdfe0c))

## [0.5.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.4.0...the-vibe-companion-v0.5.0) (2026-02-09)


### Features

* **web:** add permission suggestions and pending permission indicators ([10422c1](https://github.com/The-Vibe-Company/companion/commit/10422c1464b6ad4bc45eb90e6cd9ebbc0ebeac92))

## [0.4.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.3.0...the-vibe-companion-v0.4.0) (2026-02-09)


### Features

* **web:** add component playground and ExitPlanMode display ([#36](https://github.com/The-Vibe-Company/companion/issues/36)) ([e958be7](https://github.com/The-Vibe-Company/companion/commit/e958be780f1b6e1a8f65daedbf968cdf6ef47798))

## [0.3.0](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.2.2...the-vibe-companion-v0.3.0) (2026-02-09)


### Features

* allow dev server access over Tailscale/LAN ([#33](https://github.com/The-Vibe-Company/companion/issues/33)) ([9599d7a](https://github.com/The-Vibe-Company/companion/commit/9599d7ad4e2823d51c8fa262e1dcd96eeb056244))


### Bug Fixes

* scope permission requests to their session tab ([#35](https://github.com/The-Vibe-Company/companion/issues/35)) ([ef9f41c](https://github.com/The-Vibe-Company/companion/commit/ef9f41c8589e382de1db719984931bc4e91aeb11))

## [0.2.2](https://github.com/The-Vibe-Company/companion/compare/the-vibe-companion-v0.2.1...the-vibe-companion-v0.2.2) (2026-02-09)


### Bug Fixes

* remove vibe alias, update repo URLs to companion ([#30](https://github.com/The-Vibe-Company/companion/issues/30)) ([4f7b47c](https://github.com/The-Vibe-Company/companion/commit/4f7b47cba86c278e89fe81292fea9b8b3e75c035))
* show pasted images in chat history ([#32](https://github.com/The-Vibe-Company/companion/issues/32)) ([46365be](https://github.com/The-Vibe-Company/companion/commit/46365be45ae8b325100ed296617455c105d4d52e))

## [0.2.1](https://github.com/The-Vibe-Company/claude-code-controller/compare/the-vibe-companion-v0.2.0...the-vibe-companion-v0.2.1) (2026-02-09)


### Bug Fixes

* track all commits in release-please, not just web/ ([#27](https://github.com/The-Vibe-Company/claude-code-controller/issues/27)) ([d49f649](https://github.com/The-Vibe-Company/claude-code-controller/commit/d49f64996d02807baf0482ce3c3607ae59f78638))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([e296ab0](https://github.com/The-Vibe-Company/claude-code-controller/commit/e296ab0fabd6345b1f21c7094ca1f8d6f6af79cb))
* use correct secret name NPM_PUBLISH_TOKEN in publish workflow ([#26](https://github.com/The-Vibe-Company/claude-code-controller/issues/26)) ([61eed5a](https://github.com/The-Vibe-Company/claude-code-controller/commit/61eed5addd6e332fac360d9ae8239f1b0f93868e))
