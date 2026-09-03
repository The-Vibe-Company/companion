import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the native macOS target shares CompanionKit without a reduced API surface", () => {
  const project = read("apps/macos/CompanionMac.xcodeproj/project.pbxproj");
  const scheme = read("apps/macos/CompanionMac.xcodeproj/xcshareddata/xcschemes/CompanionMac.xcscheme");
  const workspace = read("apps/ios/Companion.xcworkspace/contents.xcworkspacedata");
  const packageManifest = read("apps/ios/CompanionKit/Package.swift");
  const macReadme = read("apps/macos/README.md");
  const rootView = read("apps/macos/CompanionMac/MacRootView.swift");
  const workspaceView = read("apps/macos/CompanionMac/MacWorkspaceView.swift");
  const chatView = read("apps/macos/CompanionMac/MacChatView.swift");

  assert.match(project, /PBXFileSystemSynchronizedRootGroup/);
  assert.match(project, /name = CompanionMac;/);
  assert.match(project, /name = CompanionMacTests;/);
  assert.match(project, /MACOSX_DEPLOYMENT_TARGET = 14\.0;/);
  assert.match(project, /relativePath = "?\.\.\/ios\/CompanionKit"?;/);
  assert.match(project, /productName = CompanionKit;/);
  assert.match(project, /CompanionMac\/Info\.plist/);
  assert.match(project, /CompanionMac\/CompanionMac\.entitlements/);
  assert.match(scheme, /BlueprintName = "CompanionMac"/);
  assert.match(scheme, /BlueprintName = "CompanionMacTests"/);
  assert.match(workspace, /container:\.\.\/macos\/CompanionMac\.xcodeproj/);
  assert.match(packageManifest, /\.macOS\(\.v14\)/);
  assert.match(macReadme, /same Better Auth session, models, polling, and\s+`\/v1` API/);
  assert.doesNotMatch(
    read("apps/macos/CompanionMac/CompanionMacApp.swift"),
    /native_mobile|clientSurface/,
  );
  assert.match(workspaceView, /CompanionMacChatView\([\s\S]*?\.id\(companion\.id\)/);
  assert.match(rootView, /phase == \.signedOut[\s\S]*?desktopWindow\.clear\(\)[\s\S]*?dismissWindow\(id: "companion-desktop"\)/);
  assert.match(chatView, /if await model\.send\([\s\S]*?draft = ""[\s\S]*?attachments = \[\]/);
  assert.doesNotMatch(chatView, /let files = attachments\s+draft = ""/);
});

test("the Mac redesign keeps three native zones and the shared Grok Bot grammar", () => {
  const app = read("apps/macos/CompanionMac/CompanionMacApp.swift");
  const workspace = read("apps/macos/CompanionMac/MacWorkspaceView.swift");
  const chat = read("apps/macos/CompanionMac/MacChatView.swift");
  const inspector = read("apps/macos/CompanionMac/MacInspectorView.swift");
  const design = read("apps/macos/CompanionMac/MacDesignSystem.swift");
  const ci = read(".github/workflows/ci.yml");

  assert.match(workspace, /NavigationSplitView[\s\S]*?\.inspector\(isPresented: inspectorBinding\)/);
  assert.match(workspace, /ForEach\(model\.homeSections\)/);
  assert.match(workspace, /CompanionStatusDot\(status: statusState\)/);
  assert.match(workspace, /let next = try await sessionStore\.listCompanions\(\)[\s\S]*?switch await sectionsRequest/);
  assert.match(chat, /CompanionIOSTheme\.userBubble[\s\S]*?CompanionIOSTheme\.botBubble/);
  assert.match(chat, /RoundedRectangle\(cornerRadius: 18/);
  assert.match(inspector, /CharacterMarkShape\.allCases/);
  assert.match(inspector, /Intelligence[\s\S]*?Routines[\s\S]*?Skills & triggers[\s\S]*?Connected accounts/);
  assert.match(inspector, /\.onChange\(of: companion\)[\s\S]*?model\.reconcile\(updated\)/);
  assert.match(inspector, /let accepted = try await sessionStore\.restartCompanion[\s\S]*?lifecycle = accepted[\s\S]*?sawRecycleProjection = accepted\.intent == \.recyclePi[\s\S]*?await poll/);
  assert.match(inspector, /\.onChange\(of: companion\.runtime\.latestLifecycle\)[\s\S]*?adopt\(latest\)/);
  assert.match(inspector, /latest\.intent == \.recyclePi[\s\S]*?latest\.isActive[\s\S]*?await poll/);
  assert.match(inspector, /latest\.intent == \.prepare[\s\S]*?sawRecycleProjection[\s\S]*?lifecycle = latest/);
  assert.doesNotMatch(inspector, /Button\("Restart Server"\)|target = \.box/);
  assert.doesNotMatch(inspector, /try\? await sessionStore\.restartCompanion/);
  assert.match(inspector, /memberTimezone: model\.sessionStore\.memberTimezone \?\? TimeZone\.current\.identifier/);
  assert.match(design, /CharacterMark\(/);
  assert.doesNotMatch(design, /mouth|accessory|sparkle/);
  assert.match(app, /CompanionMacWindowFrameAutosaver/);
  assert.match(app, /CommandMenu\("Appearance"\)/);
  assert.match(ci, /xcodebuild test[\s\S]*?-scheme CompanionMac[\s\S]*?-destination "platform=macOS"/);
});

test("the macOS bootstrap keeps credentials, mutations, and native inputs lifecycle-safe", () => {
  const packageJSON = read("package.json");
  const project = read("apps/macos/CompanionMac.xcodeproj/project.pbxproj");
  const entitlements = read("apps/macos/CompanionMac/CompanionMac.entitlements");
  const infoPlist = read("apps/macos/CompanionMac/Info.plist");
  const appIcon = read("apps/macos/CompanionMac/Assets.xcassets/AppIcon.appiconset/Contents.json");
  const models = read("apps/ios/CompanionKit/Sources/CompanionKit/Models.swift");
  const rootView = read("apps/macos/CompanionMac/MacRootView.swift");
  const loginView = read("apps/macos/CompanionMac/MacLoginView.swift");
  const googleAuth = read("apps/macos/CompanionMac/MacGoogleAuthentication.swift");
  const desktopWindow = read("apps/macos/CompanionMac/MacDesktopWindow.swift");
  const chatView = read("apps/macos/CompanionMac/MacChatView.swift");
  const workspaceView = read("apps/macos/CompanionMac/MacWorkspaceView.swift");
  const settings = read("apps/macos/CompanionMac/MacSettingsViews.swift");
  const deleteFunction = workspaceView.match(
    /    func delete\(_ companion: CompanionSummary\)[\s\S]*?(?=\n    func applyCreated)/,
  )?.[0];

  assert.ok(deleteFunction, "MacWorkspaceView must keep its delete action");

  assert.match(packageJSON, /test:anti-slop[^\n]+scripts\/macos-devx\.test\.mjs/);
  assert.match(project, /DEVELOPMENT_TEAM = K28B69CWQ7/);
  assert.match(project, /ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon/);
  assert.match(project, /ENABLE_APP_SANDBOX = YES/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile;/);
  assert.match(project, /COMPANION_URL_SCHEME = dev\.companion\.mobile;/);
  assert.match(project, /COMPANION_URL_SCHEME = dev\.companion\.mobile\.dev;/);
  assert.match(project, /MARKETING_VERSION = 2\.0\.0;/);
  assert.match(infoPlist, /<string>Companion \(623507\)<\/string>/);
  assert.match(infoPlist, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  assert.match(infoPlist, /public\.app-category\.productivity/);
  assert.match(appIcon, /AppIcon-1024\.png/);
  assert.match(entitlements, /com\.apple\.security\.files\.user-selected\.read-only/);
  assert.match(models, /enum CompanionDesktopTransport[\s\S]*?case unknown[\s\S]*?Self\(rawValue: value\) \?\? \.unknown/);
  assert.match(rootView, /case \.signedOut:[\s\S]*?bootstrapError != nil[\s\S]*?retryRestore/);
  assert.match(loginView, /apiError\.code == "EMAIL_NOT_VERIFIED"/);
  assert.match(googleAuth, /guard let window = NSApp\.keyWindow[\s\S]*?presentationWindow = window/);
  assert.doesNotMatch(googleAuth, /NSWindow\(/);
  assert.match(desktopWindow, /requestGeneration &\+= 1[\s\S]*?guard requestGeneration == generation/);
  assert.match(desktopWindow, /func clear\(\)[\s\S]*?requestGeneration &\+= 1/);
  assert.match(chatView, /CompanionThreadMutationGate\(\)[\s\S]*?mutationGate\.acquire/);
  assert.match(chatView, /\.onChange\(of: companion\)[\s\S]*?model\.updateCompanion/);
  assert.match(chatView, /startAccessingSecurityScopedResource\(\)[\s\S]*?stopAccessingSecurityScopedResource\(\)/);
  assert.match(workspaceView, /func duplicate[\s\S]*?guard companion\.access\.canDeleteCompanion/);
  assert.match(workspaceView, /reconcileDeletionResponse[\s\S]*?lifecycle\.isActive/);
  assert.match(workspaceView, /pendingDeletionIDs\.insert\(companion\.id\)/);
  assert.match(workspaceView, /if deletionRequestsInFlight\.isEmpty[\s\S]*?rosterState\.reconcile/);
  assert.match(deleteFunction, /deletionRequestsInFlight\.insert\(companion\.id\)[\s\S]*?removeOptimistically/);
  assert.match(deleteFunction, /catch \{[\s\S]*?deletionRequestsInFlight\.remove\(companion\.id\)[\s\S]*?pendingDeletionIDs\.remove\(companion\.id\)[\s\S]*?restoreDeletion/);
  assert.match(workspaceView, /visibleCompanionsReconcilingDeletions[\s\S]*?companion\.deletionLifecycle\?\.isActive == true[\s\S]*?retainedPendingIDs\.insert/);
  assert.match(workspaceView, /func duplicate[\s\S]*?!isDeletionInProgress\(companion\)/);
  assert.match(workspaceView, /performMemberStateUpdate[\s\S]*?!isDeletionInProgress\(companion\)/);
  assert.match(settings, /oauth\?\.flow == \.deviceCode[\s\S]*?pollCompanionProviderOAuth\(\)/);
  assert.match(settings, /providerSlug\.range[\s\S]*?hasValidCredentialPair/);
  assert.match(settings, /selectedProvider\?\.models\.contains/);
});
