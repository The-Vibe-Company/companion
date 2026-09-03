import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function tomlSection(source, name) {
  const marker = `[${name}]`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing TOML section ${marker}`);
  const next = source.indexOf("\n[", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("Conductor keeps the root stack default and exposes the complete native iOS run locally", () => {
  const settings = read(".conductor/settings.toml");
  assert.match(tomlSection(settings, "scripts.run.dev"), /^default = true$/m);

  const ios = tomlSection(settings, "scripts.run.\"iOS (live Box)\"");
  assert.match(ios, /^available_in = \["local"\]$/m);
  assert.match(ios, /^command = "pnpm ios:live"$/m);
  assert.doesNotMatch(settings, /\[scripts\.run\.ios\]/);
  assert.doesNotMatch(settings, /scripts\.run\.mobile-|mobile:android|mobile:metro/);
});

test("the root exposes the native launcher without an Expo workspace exception", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts["ios:dev"], "bash apps/ios/scripts/dev-conductor.sh");
  assert.equal(
    packageJson.scripts["ios:test"],
    "xcodebuildmcp swift-package test --package-path apps/ios/CompanionKit",
  );
  assert.equal(Object.keys(packageJson.scripts).some((name) => name.startsWith("mobile:")), false);
  assert.doesNotMatch(read("pnpm-workspace.yaml"), /apps\/mobile/);
  assert.doesNotMatch(read("scripts/setup-conductor.sh"), /apps\/ios|xcodebuildmcp/i);
});

test("Debug and Release keep distinct native identities and API contracts", () => {
  const shared = read("apps/ios/Config/Shared.xcconfig");
  const debug = read("apps/ios/Config/Debug.xcconfig");
  const release = read("apps/ios/Config/Release.xcconfig");
  const plist = read("apps/ios/Companion/Support/Info.plist");

  assert.match(shared, /^MARKETING_VERSION = 2\.0\.0$/m);
  assert.match(shared, /^DEVELOPMENT_TEAM = K28B69CWQ7$/m);
  assert.match(shared, /^SWIFT_VERSION = 6\.0$/m);
  assert.match(shared, /^IPHONEOS_DEPLOYMENT_TARGET = 26\.0$/m);
  assert.match(debug, /^PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile\.dev$/m);
  assert.match(debug, /^COMPANION_URL_SCHEME = dev\.companion\.mobile\.dev$/m);
  assert.match(debug, /127\.0\.0\.1:3001/);
  assert.match(release, /^PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile$/m);
  assert.match(release, /^COMPANION_URL_SCHEME = dev\.companion\.mobile$/m);
  assert.match(release, /api\.thecompanion\.sh/);
  assert.match(plist, /<string>Companion \(623507\)<\/string>/);
  assert.match(plist, /<string>Companion623507<\/string>/);
  assert.match(plist, /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  assert.doesNotMatch(plist, /<key>UIUserInterfaceStyle<\/key>/);
});

test("the iOS app packages the approved light appearance and provider marks", () => {
  const companionMark = read(
    "apps/ios/Companion/Support/Assets.xcassets/CompanionMark.imageset/companion-mark.svg",
  );
  const googleMark = read(
    "apps/ios/Companion/Support/Assets.xcassets/GoogleMark.imageset/google-mark.svg",
  );
  const appIcon = readFileSync(
    resolve(ROOT, "apps/ios/Companion/Support/Assets.xcassets/AppIcon.appiconset/AppIcon.png"),
  );

  assert.match(companionMark, /<svg[^>]+viewBox="0 0 1024 1024"/);
  for (const color of ["#D9622B", "#E9A23B", "#F2C14B"]) {
    assert.match(companionMark, new RegExp(color));
  }
  for (const color of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
    assert.match(googleMark, new RegExp(color));
  }
  assert.equal(appIcon.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(appIcon.readUInt32BE(16), 1024);
  assert.equal(appIcon.readUInt32BE(20), 1024);
  assert.equal(appIcon[25], 2, "App Store icon must be RGB without alpha");
});

test("the iOS app wires the approved OLED palette and CharacterMark notification projection", () => {
  const palette = read("apps/ios/CompanionKit/Sources/CompanionKit/CompanionAppearance.swift");
  const colors = read("apps/ios/Companion/DesignSystem/Colors.swift");
  const root = read("apps/ios/Companion/Navigation/RootView.swift");
  const launchCanvas = JSON.parse(
    read("apps/ios/Companion/Support/Assets.xcassets/LaunchCanvas.colorset/Contents.json"),
  );
  const renderer = read(
    "apps/ios/CompanionKit/Sources/CompanionNotificationAvatar/CompanionNotificationAvatar.swift",
  );
  const service = read("apps/ios/CompanionNotificationService/NotificationService.swift");
  const appearanceDemo = read("apps/ios/Companion/Screens/CompanionAppearanceDemoView.swift");

  for (const value of [
    "0x000000", "0x1C1C1E", "0xFFFFFF", "0xF2F2F7", "0x8E8E93", "0x38383A",
  ]) {
    assert.match(palette, new RegExp(value));
  }
  assert.match(root, /@AppStorage\(CompanionPreferenceKeys\.appearance\)/);
  assert.match(root, /appearance\.forcesBlackPalette \? \.dark : nil/);
  assert.doesNotMatch(read("apps/ios/Companion/Support/Info.plist"), /UIUserInterfaceStyle/);
  assert.deepEqual(
    launchCanvas.colors.map((entry) => ({
      appearance: entry.appearances?.[0]?.value ?? "universal",
      components: entry.color.components,
    })),
    [
      {
        appearance: "universal",
        components: { alpha: "1.000", blue: "0.000", green: "0.000", red: "0.000" },
      },
    ],
  );
  assert.match(read("docs/ios-design.md"), /static launch canvas is always #000000/);
  assert.match(colors, /CompanionAppearancePalette\.Black\.canvas/);
  assert.match(renderer, /CharacterMarkGeometry\.commands\(shapeIndex:/);
  assert.match(renderer, /CharacterMarkGeometry\.eyeSegments/);
  assert.doesNotMatch(renderer, /draw(?:Mouth|Face|Accessory)|draw(?:Linear|Radial)Gradient|setShadow/);
  assert.match(service, /CompanionNotificationMark\(apnsUserInfo:/);
  assert.match(appearanceDemo, /demo\.appearance\.gallery/);
  assert.match(root, /-companion-appearance-demo/);
  assert.match(read("apps/ios/README.md"), /nested\s+`companion_icon` dictionary/);
});

test("the plugin add-account chip matches connected account tokens", () => {
  const plugins = read("apps/ios/Companion/Screens/PluginCatalogSheet.swift");
  const root = read("apps/ios/Companion/Navigation/RootView.swift");
  const addChip = plugins.slice(
    plugins.indexOf('Label("Account", systemImage: "plus")'),
    plugins.indexOf('.accessibilityIdentifier("plugins.account.add.', plugins.indexOf('Label("Account", systemImage: "plus")')),
  );

  assert.match(addChip, /foregroundStyle\(CompanionIOSTheme\.textPrimary\)/);
  assert.match(addChip, /background\(CompanionIOSTheme\.chip, in: Capsule\(\)\)/);
  assert.doesNotMatch(addChip, /textSecondary/);
  assert.match(root, /PluginManagementView\(demoModel: \.linearMultiAccountDemo\)/);
  assert.match(root, /-companion-plugins-multi-account-demo/);
  assert.match(plugins, /Button \{\s*guard !demoMode else \{ return \}\s*showingAddPlugin = true/);
  assert.match(plugins, /private func disconnect[\s\S]{0,120}?guard !demoMode else \{ return \}/);
});

test("home and simplified chat header keep the approved 44-point actions", () => {
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const design = read("docs/ios-design.md");
  const homeButton = roster.slice(
    roster.indexOf("private func headerToolbarButton"),
    roster.indexOf("private func sectionHeader"),
  );
  const accountAvatar = roster.slice(
    roster.indexOf("private struct AccountAvatar"),
    roster.indexOf("#if DEBUG", roster.indexOf("private struct AccountAvatar")),
  );
  const chatHeader = chat.slice(
    chat.indexOf("private var headerToolbar"),
    chat.indexOf("private var loadEarlierButton"),
  );

  assert.match(homeButton, /frame\(width: 44, height: 44\)/);
  assert.doesNotMatch(homeButton, /Circle\(\)|\.background\(|\.overlay/);
  assert.match(accountAvatar, /clipShape\(Circle\(\)\)/);
  assert.doesNotMatch(accountAvatar, /Circle\(\)\.stroke/);
  assert.match(chatHeader, /accessibilityIdentifier\("chat\.details"\)/);
  assert.match(chatHeader, /systemImage: "desktopcomputer"/);
  assert.doesNotMatch(chatHeader, /Image\(systemName: "ellipsis"\)|Menu\s*\{/);
  assert.doesNotMatch(chatHeader, /CompanionStatusBadge/);
  assert.doesNotMatch(chatHeader, /background\(CompanionIOSTheme\.card, in: Circle\(\)\)/);
  assert.match(design, /bare search and \+ icons/);
  assert.match(design, /chat header remains a centered CharacterMark-and-name pill/);
});

test("home renders three-companion sections as list rows and keeps move errors human-readable", () => {
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const rosterState = read("apps/ios/CompanionKit/Sources/CompanionKit/CompanionRosterState.swift");
  const management = read("apps/ios/Companion/DesignSystem/ManagementComponents.swift");
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");

  assert.doesNotMatch(roster, /usesPinnedGrid|pinnedGrid/);
  assert.match(roster, /ForEach\(section\.companions\)\s*\{\s*companionRow\(\$0\)\s*\}/);
  assert.match(roster, /Text\(preview\)[\s\S]*?lineLimit\(1\)/);
  assert.match(roster, /Text\(timeLabel\)/);
  assert.match(
    roster,
    /Text\(timeLabel\)[\s\S]{0,180}?CompanionStatusDot\(runtime: companion\.runtime\)[\s\S]{0,80}?frame\(width: 18, alignment: \.leading\)/,
  );
  assert.match(roster, /COMPANION_ROSTER_DEMO_THREE/);
  assert.doesNotMatch(rosterState, /usesPinnedGrid/);
  assert.equal(management.includes('hasPrefix("{")'), true);
  assert.equal(management.includes('hasPrefix("[")'), true);
  assert.match(roster, /Move failed\. Choose a valid section and try again\./);
  assert.match(uiTests, /testRosterRendersThreeCompanionsAsListRowsWithPreviews/);
});

test("root stacks preserve native pop and add a guarded 52-point back zone", () => {
  const navigation = read("apps/ios/Companion/Support/NavigationSwipeBackSupport.swift");
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const memberSettings = read("apps/ios/Companion/Screens/MemberSettingsView.swift");
  const botDetails = read("apps/ios/Companion/Screens/CompanionDetailView.swift");
  const plugins = read("apps/ios/Companion/Screens/PluginCatalogSheet.swift");
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");

  assert.match(roster, /NavigationStack\(path: \$path\)[\s\S]*?\.companionNavigationSwipeBackEnabled\(\)/);
  assert.match(memberSettings, /NavigationStack\s*\{[\s\S]*?\.companionNavigationSwipeBackEnabled\(\)/);
  assert.match(navigation, /supplementalLeadingEdgeBand: CGFloat = 52/);
  assert.match(navigation, /nativeLeadingEdgeBand: CGFloat = 20/);
  assert.match(navigation, /navigationController\.viewControllers\.count > 1/);
  assert.match(navigation, /navigationController\.transitionCoordinator == nil/);
  assert.match(navigation, /otherGestureRecognizer === installedNativeGesture/);
  assert.match(navigation, /pan\.cancelsTouchesInView = false/);
  assert.match(navigation, /contentSize\.width > scrollView\.bounds\.width/);
  assert.match(navigation, /hasCompetingHorizontalDrag\(excluding: pan\)/);
  assert.match(navigation, /otherGestureRecognizer is UIPanGestureRecognizer/);
  assert.match(navigation, /navigationController\.popViewController\(animated: true\)/);
  assert.match(memberSettings, /case \.plugins:\s*PluginManagementView\(\)/);
  assert.match(plugins, /CompanionSheetHeader\([\s\S]{0,120}?leadingStyle: \.back/);
  assert.match(botDetails, /CompanionSheetHeader\(title: routine\.name, leadingStyle: \.back\)/);
  assert.match(botDetails, /CompanionSheetHeader\(title: "Routine run", leadingStyle: \.back\)/);
  assert.match(uiTests, /testMemberSettingsCustomHeadersSupportButtonAndLeadingEdgeBack/);
  assert.match(uiTests, /testBotDetailRoutineAndRunCustomHeadersSupportConsecutiveEdgePops/);
  assert.match(uiTests, /testWideBackZoneDoesNotStealAHorizontalCharacterDrag/);
  assert.match(uiTests, /CGVector\(dx: 0\.10, dy: 0\.5\)/);
  assert.match(uiTests, /swipeFromNativeLeadingEdge/);
});

test("full-screen native backdrops stay neutral in every state", () => {
  const glassComponents = read("apps/ios/Companion/DesignSystem/GlassComponents.swift");
  const backdrop = glassComponents.slice(
    glassComponents.indexOf("struct CompanionBackdrop"),
    glassComponents.indexOf("extension View"),
  );
  const backdropCallers = [
    "apps/ios/Companion/Navigation/RootView.swift",
    ...readdirSync(resolve(ROOT, "apps/ios/Companion/Screens"))
      .filter((file) => file.endsWith(".swift"))
      .map((file) => `apps/ios/Companion/Screens/${file}`),
  ].map(read).join("\n");
  const managementComponents = read(
    "apps/ios/Companion/DesignSystem/ManagementComponents.swift",
  );

  assert.match(backdrop, /CompanionIOSTheme\.canvas\s*\n\s*\.ignoresSafeArea\(\)/);
  assert.deepEqual(
    [...backdrop.matchAll(/\bCompanionIOSTheme\.[A-Za-z]\w*/g)].map(([color]) => color),
    ["CompanionIOSTheme.canvas"],
  );
  assert.doesNotMatch(
    backdrop,
    /CompanionBackdropStyle|case \.companion|GeometryReader|\.fill\(|\.opacity\(|\.(?:red|companionAccent|companionDanger)\b/,
  );
  assert.doesNotMatch(backdropCallers, /CompanionBackdrop\s*\(\s*style:/);
  assert.doesNotMatch(
    managementComponents,
    /\.background\s*(?:\(\s*(?:(?:Color)?\.)?(?:companionDanger|red)\b|\{[\s\S]{0,120}?(?:companionDanger|Color\.red|\.red\b))/,
  );
});

test("chat uses the approved two-sided bubbles and morphing composer", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const composer = read("apps/ios/Companion/Screens/ChatComposer.swift");
  const bubble = chat.slice(
    chat.indexOf("struct ChatMessageBubble"),
    chat.indexOf("struct CompanionThinkingDisclosure"),
  );
  const decisionCard = read("apps/ios/Companion/Screens/CompanionDecisionCard.swift");
  const glassChatDemo = read("apps/ios/Companion/Screens/GlassChatDemoView.swift");
  const glassDemoBubbles = glassChatDemo.slice(
    glassChatDemo.indexOf("ChatMessageBubble("),
    glassChatDemo.indexOf(".accessibilityIdentifier(message.accessibilityIdentifier)"),
  );
  const queuedDemo = read("apps/ios/Companion/Screens/CompanionQueuedMessagesDemoView.swift");
  const queuedDemoBubbles = queuedDemo.slice(
    queuedDemo.indexOf("ChatMessageBubble("),
    queuedDemo.indexOf(".padding(16)"),
  );

  assert.match(
    bubble,
    /\.background\(bubbleColor, in: RoundedRectangle\(cornerRadius: 18, style: \.continuous\)\)/,
  );
  assert.match(bubble, /kind == \.mine \? CompanionIOSTheme\.userBubble/);
  assert.match(bubble, /CompanionIOSTheme\.botBubble/);
  assert.match(
    bubble,
    /MarkdownMessageView\([\s\S]{0,120}?document: markdown,[\s\S]{0,120}?foreground: primaryTextColor,[\s\S]{0,120}?linkColor: messageLinkColor/,
  );
  assert.doesNotMatch(bubble, /var accent\b|accent\.opacity|visualTheme\.accent|tint:/);
  assert.doesNotMatch(chat, /\.toolbar \{ headerToolbar \}\s*\.tint\(visualTheme\.accent\)/);
  assert.match(composer, /TextField\("Ask \\\(companionName\)"/);
  assert.match(composer, /TextField\("Ask \\\(companionName\)"[\s\S]{0,180}?\.font\(\.body\)/);
  assert.match(composer, /private var composerAvailabilityContent: some View/);
  assert.match(composer, /private var attachmentErrorMessage: some View/);
  assert.match(composer, /private var inputBar: some View/);
  assert.doesNotMatch(composer, /transcription\.liveTranscript/);
  assert.match(bubble, /Text\(streamingDelta\)[\s\S]{0,100}?\.font\(\.body\)/);
  assert.match(composer, /else if showsSendButton \|\| !transcriptionAvailable/);
  assert.match(composer, /\.background\(CompanionIOSTheme\.primaryCTA, in: Circle\(\)\)/);
  assert.match(chat, /CharacterMark\([\s\S]{0,220}?size: 20/);
  const chatHeader = chat.slice(
    chat.indexOf("private var headerToolbar"),
    chat.indexOf("private var loadEarlierButton"),
  );
  assert.doesNotMatch(chatHeader, /CompanionStatusBadge|systemName: "ellipsis"/);
  assert.match(chatHeader, /CompanionStatusDot\(runtime: currentCompanion\.runtime\)/);
  assert.doesNotMatch(decisionCard, /pending \? accent\.opacity/);
  assert.doesNotMatch(glassDemoBubbles, /accent:|tint:/);
  assert.doesNotMatch(queuedDemoBubbles, /accent:|tint:/);
  assert.doesNotMatch(
    glassChatDemo,
    /\.navigationBarTitleDisplayMode\(\.inline\)\s*\.tint\(visualTheme\.accent\)/,
  );
});

test("Companion status dots share the runtime projection and reduced-motion contract", () => {
  const status = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionStatusIndicator.swift",
  );
  const dot = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionStatusDot.swift",
  );
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const models = read("apps/ios/CompanionKit/Sources/CompanionKit/Models.swift");
  const coreProjection = read("packages/core/src/companionRuntimeApi.ts");
  const coreTests = read("packages/core/test/companionRuntimeApi.test.ts");
  const kitTests = read(
    "apps/ios/CompanionKit/Tests/CompanionKitTests/CompanionKitTests.swift",
  );
  const readme = read("apps/ios/README.md");
  const design = read("docs/ios-design.md");

  assert.match(models, /let runtime: Runtime/);
  assert.match(models, /case daemonState = "daemon_state"/);
  assert.match(models, /replying = try container\.decodeIfPresent\(Bool\.self/);
  assert.match(coreProjection, /replying: row\.is_replying === true/);
  assert.match(coreProjection, /if \(row\.box_state === "archived"\) return "stopped"/);
  assert.match(coreTests, /normalizes an archived Box to the stopped client projection/);
  assert.match(status, /case inactive[\s\S]*case live[\s\S]*case replying[\s\S]*case error/);
  assert.match(status, /case \.running:[\s\S]{0,80}?self = \.live/);
  assert.match(status, /case \.error:[\s\S]{0,80}?self = \.error/);
  assert.match(status, /self == \.replying && !reduceMotion/);
  assert.match(dot, /@Environment\(\\\.accessibilityReduceMotion\)/);
  assert.match(dot, /TimelineView\(\.animation/);
  assert.match(dot, /static let dotSize: CGFloat = 8/);
  assert.match(dot, /frame\(width: Self\.dotSize, height: Self\.dotSize\)/);
  assert.match(dot, /case \.live: return CompanionIOSTheme\.toggleGreen/);
  assert.match(dot, /case \.inactive: return CompanionIOSTheme\.textSecondary/);
  assert.match(dot, /case \.error: return CompanionIOSTheme\.danger/);
  assert.match(roster, /CompanionStatusDot\(runtime: companion\.runtime\)/);
  assert.match(chat, /CompanionStatusDot\(runtime: currentCompanion\.runtime\)/);
  assert.match(kitTests, /mapsEveryRuntimeStateToTheCompactStatusIndicator/);
  assert.match(kitTests, /replyingIndicatorFallsBackToAStaticLiveDotForReducedMotion/);
  assert.match(readme, /add no fetch or polling loop/);
  assert.match(design, /archived Boxes are normalized to stopped by the API/);
});

test("computer view is immersive and keeps the desktop handoff ephemeral", () => {
  const computer = read("apps/ios/Companion/Screens/CompanionComputerView.swift");

  assert.match(computer, /Color\.black\.ignoresSafeArea\(\)/);
  assert.match(computer, /configuration\.websiteDataStore = \.nonPersistent\(\)/);
  assert.match(computer, /guard companion\.access != \.viewer else/);
  assert.match(computer, /\.onDisappear \{ desktop = nil \}/);
  assert.match(computer, /\.aspectRatio\(16 \/ 10, contentMode: \.fit\)/);
  assert.doesNotMatch(computer, /UserDefaults|FileManager|print\(|Logger|os_log/);
  assert.match(computer, /onFailure: \{ message in[\s\S]{0,120}?desktop = nil[\s\S]{0,80}?loading = false/);
});

test("document previews cancel with their view and surface retryable errors", () => {
  const attachments = read("apps/ios/Companion/Screens/ChatAttachmentViews.swift");

  assert.match(attachments, /@State private var previewTask: Task<Void, Never>\?/);
  assert.match(attachments, /\.onDisappear \{[\s\S]{0,100}?previewTask\?\.cancel\(\)[\s\S]{0,120}?removePreviewFile\(\)/);
  assert.match(attachments, /try Task\.checkCancellation\(\)/);
  assert.match(attachments, /\.alert\([\s\S]{0,180}?Couldn’t Open File[\s\S]{0,500}?Button\("Try Again"\)/);
  assert.doesNotMatch(attachments, /catch \{\s*return\s*\}/);
});

test("long-thread composer and poll work stay behind narrow invalidation boundaries", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const composer = read("apps/ios/Companion/Screens/ChatComposer.swift");
  const coordination = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionThreadCoordination.swift",
  );
  const sessionStore = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/SessionStore.swift",
  );

  assert.doesNotMatch(chat, /@State private var draft\b/);
  assert.match(chat, /ChatComposer\(/);
  assert.match(composer, /@State private var draft = ""/);
  assert.match(chat, /TranscriptRowView: View, @MainActor Equatable/);
  assert.match(chat, /TranscriptRowView\([\s\S]*?\.equatable\(\)/);
  assert.match(chat, /CompanionTranscriptPollDiff\(/);
  assert.match(chat, /if previousThread != next\s*\{\s*threadProjection\.update\(next\)/);
  assert.match(coordination, /public struct CompanionTranscriptPollDiff: Equatable, Sendable/);
  assert.equal(
    (chat.match(/refreshGate\.invalidate\(\)\s*\n\s*threadProjection\.replaceAfterMutation/g) ?? []).length,
    2,
    "authoritative decision and cancellation responses must fence polls started during the mutation",
  );
  assert.match(sessionStore, /private var persistedSession: Session\?/);
  assert.match(sessionStore, /if persistedSession != authority \{/);
});

test("native message interactions stay accessible without simulator CI", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const interactions = read(
    "apps/ios/Companion/Support/MessageInteractionSupport.swift",
  );
  const markdown = read("apps/ios/Companion/Screens/MarkdownMessageView.swift");
  const queued = read("apps/ios/Companion/Screens/CompanionQueuedMessagesView.swift");
  const queuedDemo = read("apps/ios/Companion/Screens/CompanionQueuedMessagesDemoView.swift");
  const readme = read("apps/ios/README.md");

  assert.match(chat, /\.companionMessageInteractionMenu\(rawContent: content\)/);
  assert.match(chat, /allowsTextSelection: false/);
  for (const action of ["Copy", "Share", "Select Text"]) {
    assert.match(interactions, new RegExp(`Label\\("${action}"`));
  }
  assert.match(interactions, /UIPasteboard\.general\.string = rawContent/);
  assert.match(interactions, /presentedSheet = \.share\(rawContent\)/);
  assert.match(interactions, /presentedSheet = \.selectText\(rawContent\)/);
  assert.match(interactions, /\.sensoryFeedback\(\.success, trigger: copyFeedbackTrigger\)/);
  assert.match(
    interactions,
    /\.sensoryFeedback\(\.impact\(weight: \.light\), trigger: shareFeedbackTrigger\)/,
  );
  assert.match(interactions, /UIAccessibility\.post\(notification: \.announcement/);
  assert.match(interactions, /\.contentShape\(\.rect\)\s*\.contextMenu/);
  assert.match(interactions, /\.textSelection\(\.enabled\)/);

  assert.match(markdown, /\.frame\(minWidth: 44, minHeight: 44\)/);
  const thinkingDisclosure = chat.slice(
    chat.indexOf("struct CompanionThinkingDisclosure"),
    chat.indexOf("struct CompanionThinkingStatus"),
  );
  const thinkingStatus = chat.slice(
    chat.indexOf("struct CompanionThinkingStatus"),
    chat.indexOf("private struct TranscriptRowInput"),
  );
  assert.match(
    thinkingDisclosure,
    /\.background\(CompanionIOSTheme\.chip, in: Capsule\(\)\)[\s\S]{0,100}?\.frame\(minHeight: 44\)/,
  );
  assert.match(
    thinkingStatus,
    /Button\(action: onTap\)[\s\S]{0,180}?\.frame\(minHeight: 44, alignment: \.leading\)/,
  );
  assert.match(markdown, /UIPasteboard\.general\.string = code/);
  assert.match(markdown, /\.sensoryFeedback\(\.success, trigger: copyFeedbackTrigger\)/);
  assert.match(markdown, /accessibilityReduceMotion/);
  assert.match(markdown, /accessibilityIdentifier\("markdown\.code-copy\.\\\(identifier\)"\)/);

  assert.match(queued, /entry\.authorID == viewerID/);
  assert.match(queued, /removingTurnID == nil/);
  assert.match(queued, /Button\("Delete", systemImage: "trash", role: \.destructive\)/);
  assert.match(
    queued,
    /Button\("Delete", systemImage: "trash", role: \.destructive\) \{\s*requestRemoval\(of: entry\)/,
  );
  assert.match(queuedDemo, /viewerID: viewerID/);
  assert.match(readme, /Reply or thread\s+actions and regenerate are deliberately out of scope/);
});

test("chat links auto-detect safely and preserve the complete Markdown renderer", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const markdown = read("apps/ios/Companion/Screens/MarkdownMessageView.swift");
  const detector = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionMessageLinkDetector.swift",
  );
  const palette = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionAppearance.swift",
  );
  const colors = read("apps/ios/Companion/DesignSystem/Colors.swift");
  const computer = read("apps/ios/Companion/Screens/CompanionComputerView.swift");
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");
  const design = read("docs/ios-design.md");

  assert.match(chat, /filter \{ \$0\.role == "assistant" \|\| \$0\.role == "user" \}/);
  assert.match(chat, /markdown: MarkdownDocument\(markdown: content\)/);
  assert.match(chat, /markdown: input\.markdown,/);
  assert.doesNotMatch(chat, /markdown: input\.entry\.role == "assistant"/);
  assert.match(chat, /else if let markdown \{[\s\S]{0,220}?MarkdownMessageView\(/);
  assert.match(chat, /kind == \.assistant \|\| markdown\?\.containsInteractiveLink == true/);
  assert.match(detector, /NSDataDetector\([\s\S]{0,120}?CheckingType\.link/);
  assert.match(detector, /CompanionLinkPolicy\.isAllowed\(url\)/);
  assert.match(markdown, /run\.inlinePresentationIntent\?\.contains\(\.code\) != true/);
  assert.match(markdown, /else if !isCode \{[\s\S]{0,160}?CompanionMessageLinkDetector\.detect/);
  for (const intent of ["stronglyEmphasized", "emphasized", "strikethrough", "code"]) {
    assert.match(markdown, new RegExp(`contains\\(\\.${intent}\\)`));
  }
  for (const block of ["heading", "orderedList", "unorderedList", "codeBlock", "blockQuote", "table"]) {
    assert.match(markdown, new RegExp(`case \\.${block}`));
  }
  assert.match(markdown, /LinkHitTestingTextView: UITextView/);
  assert.match(markdown, /shouldInteractWith url: URL/);
  assert.match(markdown, /case \.invokeDefaultAction:[\s\S]{0,100}?CompanionMessageLinkActions\.open\(url\)/);
  assert.match(markdown, /case \.presentActions, \.preview:\s*return true/);
  assert.match(markdown, /Button\("Open", systemImage: "arrow\.up\.right\.square"\)/);
  assert.match(markdown, /Button\("Copy", systemImage: "doc\.on\.doc"\)/);
  assert.match(markdown, /ExternalURLLauncher\.open\(url\)/);
  assert.match(palette, /actionBlue: UInt32 = 0x007AFF/);
  assert.match(palette, /actionBlueBlack: UInt32 = 0x0A84FF/);
  assert.match(colors, /static let linkBlue = adaptive/);
  assert.match(colors, /static let userBubbleLink = adaptive/);
  assert.match(uiTests, /testMessageLinkLongPressOffersOpenAndCopy/);
  assert.match(uiTests, /testMessageLinksRemainVisibleInBlackAppearance/);
  assert.match(design, /Bare HTTP\(S\) URLs and Markdown links render in `action\.blue`/);
  assert.doesNotMatch(computer, /TranscriptEntry|MarkdownMessageView|MarkdownDocument/);
});

test("external iOS links and OAuth stay browser-owned and callback-scoped", () => {
  const markdown = read("apps/ios/Companion/Screens/MarkdownMessageView.swift");
  const login = read("apps/ios/Companion/Screens/LoginView.swift");
  const plugins = read("apps/ios/Companion/Screens/PluginManagementView.swift");
  const coordinator = read("apps/ios/Companion/Support/ExternalOAuthCoordinator.swift");
  const launcher = read("apps/ios/Companion/Support/ExternalURLLauncher.swift");
  const root = read("apps/ios/Companion/Navigation/RootView.swift");
  const kitClient = read("apps/ios/CompanionKit/Sources/CompanionKit/APIClient.swift");
  const kitSessionStore = read("apps/ios/CompanionKit/Sources/CompanionKit/SessionStore.swift");
  const callbackPolicy = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionOAuthCallbackPolicy.swift",
  );
  const kitTests = read("apps/ios/CompanionKit/Tests/CompanionKitTests/CompanionKitTests.swift");
  const entitlements = read("apps/ios/Config/Companion.entitlements");
  const aasa = JSON.parse(read("apps/web/public/.well-known/apple-app-site-association"));
  const nextConfig = read("apps/web/next.config.ts");
  const design = read("docs/design.md");
  const authFlow = [markdown, login, plugins, coordinator, launcher, root, kitClient, callbackPolicy].join("\n");

  assert.match(markdown, /case \.system, \.conductor:[\s\S]{0,160}?CompanionMessageLinkActions\.open\(url\)/);
  assert.match(markdown, /ExternalURLLauncher\.open\(url\)/);
  assert.match(coordinator, /UIApplication\.shared\.open\(pendingURL/);
  assert.match(coordinator, /guard let activeFlow, phase != \.completing, callbackURL == nil/);
  assert.match(root, /\.onOpenURL\s*\{[\s\S]{0,180}?externalOAuth\.handle/);
  assert.match(root, /\.onContinueUserActivity\(NSUserActivityTypeBrowsingWeb\)/);
  assert.match(launcher, /@MainActor\s+static func open/);
  assert.match(login, /login\.google\.waiting/);
  assert.match(login, /Button\("Reopen"/);
  assert.match(login, /Button\("Cancel"/);
  assert.match(login, /No callback arrived/);
  assert.match(login, /activeFlow\?\.googleNativeState/);
  assert.match(login, /cancelGoogleSignIn\(expectedNativeState: nativeState\)/);
  assert.match(plugins, /startCompanionPluginOAuth/);
  assert.match(plugins, /completeCompanionPluginOAuth\(callbackURL:/);
  assert.match(plugins, /beginPlugin\(authorizationURL:/);
  assert.match(plugins, /plugins\.oauth\.reopen/);
  assert.match(plugins, /plugins\.oauth\.cancel/);
  assert.match(plugins, /No callback arrived\. Reopen this authorization or cancel this attempt\./);
  assert.match(plugins, /externalOAuth\.reopen\(\)/);
  assert.match(plugins, /cancellationPending/);
  assert.match(plugins, /\.disabled\(submitting \|\| cancellationPending \|\| externalOAuth\.phase == \.completing\)/);
  assert.match(plugins, /\.interactiveDismissDisabled\([\s\S]{0,120}?externalOAuth\.phase == \.completing/);
  assert.match(plugins, /finishCancellation\(/);
  assert.match(plugins, /requestCancellation\(fromDisappear: true\)/);
  assert.doesNotMatch(plugins, /onChange\(of: externalOAuth\.phase\)/);
  const provider = read("apps/ios/Companion/Screens/ProviderManagementView.swift");
  assert.match(provider, /systemImage: "arrow\.up\.right\.square"/);
  assert.doesNotMatch(provider, /systemImage: "safari"/);
  assert.match(kitClient, /companionPluginOAuthCookie/);
  assert.match(kitClient, /header\(named: "set-cookie"/);
  assert.match(kitClient, /companion_mcp_oauth_/);
  assert.match(kitClient, /SecRandomCopyBytes/);
  assert.match(kitClient, /googleOAuthState/);
  assert.match(kitClient, /cancelGoogleSignIn\(expectedNativeState: String\)/);
  assert.match(kitSessionStore, /cancelGoogleSignIn\(expectedNativeState: String\)/);
  assert.match(kitClient, /companionPluginOAuthState/);
  assert.match(kitClient, /redirect_uri/);
  assert.match(kitClient, /APIClientRedirectDelegateFactory/);
  assert.match(kitClient, /redirectDelegateFactory/);
  assert.match(kitClient, /make\(followRedirects: followRedirects\)/);
  assert.match(kitClient, /NoRedirectURLSessionDelegate/);
  assert.match(kitClient, /followRedirects: false/);
  assert.match(kitClient, /response\.statusCode == 303/);
  assert.match(kitClient, /pluginOAuthRedirect/);
  const redirectParser = kitClient.slice(
    kitClient.indexOf("private static func pluginOAuthRedirect"),
    kitClient.indexOf("private static func randomOAuthState"),
  );
  assert.match(redirectParser, /expectedScheme/);
  assert.match(redirectParser, /expectedHost/);
  assert.match(redirectParser, /effectivePort/);
  assert.doesNotMatch(redirectParser, /pluginCallbackHost/);
  assert.match(kitTests, /validatesCompanionPluginOAuthRedirectBeforeReturning/);
  assert.match(kitTests, /refusesCompanionPluginOAuthRedirects/);
  assert.match(kitTests, /willPerformHTTPRedirection/);
  assert.match(kitTests, /RedirectDelegateFactoryRecorder/);
  assert.match(kitTests, /redirectDelegateFactory:/);
  assert.doesNotMatch(kitTests, /wasRedirectedTo:/);
  assert.doesNotMatch(kitTests, /redirectEvents/);
  assert.match(kitTests, /cancelGoogleSignIn\(expectedNativeState: authorization\.nativeState\)/);
  assert.match(kitTests, /oauth_error=duplicate_label/);
  assert.match(kitTests, /oauth\.example/);
  assert.match(kitTests, /oauth\.example:444/);
  assert.match(kitTests, /http:\/\/oauth\.example/);
  assert.match(kitTests, /https:\/\/evil\.example\/companions/);
  assert.match(callbackPolicy, /pluginCallbackHost = "thecompanion\.sh"/);
  assert.match(callbackPolicy, /pluginCallbackPath = "\/v1\/companion-plugins\/oauth\/callback"/);
  assert.match(callbackPolicy, /googleNativeStateQueryName = "native_state"/);
  assert.match(callbackPolicy, /expectedCallbackURL/);
  assert.match(callbackPolicy, /url\.user == nil/);
  assert.match(callbackPolicy, /url\.password == nil/);
  assert.match(entitlements, /com\.apple\.developer\.associated-domains/);
  assert.match(entitlements, /applinks:thecompanion\.sh/);
  assert.deepEqual(aasa, {
    applinks: {
      details: [{
        appIDs: ["K28B69CWQ7.dev.companion.mobile", "K28B69CWQ7.dev.companion.mobile.dev"],
        components: [{ "/": "/v1/companion-plugins/oauth/callback" }],
      }],
    },
  });
  assert.match(nextConfig, /source: "\/.well-known\/apple-app-site-association"/);
  assert.match(nextConfig, /key: "Content-Type", value: "application\/json"/);
  assert.match(nextConfig, /key: "Cache-Control", value: "public, max-age=300, must-revalidate"/);
  assert.match(read("apps/ios/README.md"), /HTTP on a\s+loopback address, which cannot deliver an Apple Universal Link/i);
  assert.match(design, /authenticated start response\s+provides the exact callback origin and signed state/);
  assert.match(design, /production-signed app makes no general self-hosted-domain claim/);
  assert.doesNotMatch(authFlow, /WKWebView|SFSafariViewController|ASWebAuthenticationSession/);
});

test("the chat scroll-to-bottom control floats over the transcript", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const transcript = chat.slice(
    chat.indexOf('.accessibilityIdentifier("chat.transcript")'),
    chat.indexOf("bottomControls(", chat.indexOf('.accessibilityIdentifier("chat.transcript")')),
  );

  assert.match(transcript, /\.overlay\(alignment: \.bottomTrailing\)/);
  assert.match(transcript, /scrollToBottomButton\s*\{/);
  assert.match(transcript, /\.padding\(\.trailing, 16\)/);
  assert.match(transcript, /\.padding\(\.bottom, 12\)/);
  assert.match(transcript, /reduceMotion\s*\n\s*\? \.identity/);

  const button = chat.slice(
    chat.indexOf("private func scrollToBottomButton"),
    chat.indexOf("private func dayMarker"),
  );
  assert.match(button, /\.buttonStyle\(\.glass\)/);
  assert.equal(button.match(/Button\(action: action\)/g)?.length, 1);
  assert.match(button, /\.buttonBorderShape\(unseenCount > 0 \? \.capsule : \.circle\)/);
  assert.doesNotMatch(button, /\.shadow\(/);
});

test("native transcript taps dismiss the keyboard without consuming message controls", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const readme = read("apps/ios/README.md");
  const transcriptDemo = read(
    "apps/ios/Companion/Screens/CompanionTranscriptWindowDemoView.swift",
  );
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");
  const transcript = chat.slice(
    chat.indexOf(".scrollDismissesKeyboard(.interactively)"),
    chat.indexOf("bottomControls(", chat.indexOf('.accessibilityIdentifier("chat.transcript")')),
  );

  assert.match(transcript, /\.scrollDismissesKeyboard\(\.interactively\)/);
  assert.match(
    chat,
    /struct TranscriptKeyboardDismissGesture: UIGestureRecognizerRepresentable/,
  );
  assert.match(chat, /recognizer\.cancelsTouchesInView = false/);
  assert.match(chat, /shouldRecognizeSimultaneouslyWith/);
  assert.match(chat, /shouldReceive touch: UITouch/);
  assert.match(chat, /current is UITextField \|\| current is UITextView/);
  assert.match(
    chat,
    /shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer[\s\S]{0,180}?otherGestureRecognizer is UIScreenEdgePanGestureRecognizer/,
  );
  assert.match(chat, /recognizer\.delegate = context\.coordinator/);
  assert.match(chat, /\) -> Bool \{\s*true\s*\}/);
  assert.match(
    transcript,
    /\.gesture\(\s*TranscriptKeyboardDismissGesture \{[\s\S]*?UIApplication\.shared\.sendAction\(/,
  );
  assert.match(chat, /#selector\(UIResponder\.resignFirstResponder\)/);
  assert.doesNotMatch(chat, /composerKeyboardDismissalRequest/);
  assert.match(readme, /Linux quality still protects the keyboard-dismissal gesture mechanics/);
  assert.match(readme, /The focus change is intentionally silent/);
  assert.match(transcriptDemo, /COMPANION_TRANSCRIPT_DEMO_QUESTION/);
  assert.match(uiTests, /testTranscriptQuestionKeepsCardFocusedAndSubmitsAnswer/);
  assert.match(uiTests, /answerField\.typeText\("Ship the stable release"\)/);
  assert.match(uiTests, /XCTAssertEqual\(composer\.value as\? String, "Keep this draft"\)/);
  assert.match(uiTests, /testChatLeadingEdgeSwipeWorksAfterMidScrollAcrossRepeatedPops/);
  assert.match(roster, /COMPANION_ROSTER_DEMO_LONG_THREAD/);
  assert.match(uiTests, /chat\.scroll-to-bottom/);
  assert.doesNotMatch(transcript, /DragGesture/);
});

test("native chat reading restoration stays covered at the behavior layer", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const coordination = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionThreadCoordination.swift",
  );
  const companionKitTests = read(
    "apps/ios/CompanionKit/Tests/CompanionKitTests/CompanionKitTests.swift",
  );
  const uiTests = read("apps/ios/CompanionUITests/CompanionUITests.swift");
  const ci = read(".github/workflows/ci.yml");

  assert.match(roster, /CompanionChatReadingPositionStore\(\)/);
  assert.match(roster, /readingPosition: chatReadingPositions\.position\(for: companionID\)/);
  assert.match(chat, /private let readingPosition: CompanionChatReadingPosition\?/);
  assert.match(chat, /self\.readingPosition = readingPosition/);
  assert.match(chat, /\.onScrollTargetVisibilityChange\(/);
  assert.match(chat, /isRestoringReadingPosition \? 0 : 1/);
  assert.match(chat, /previousThread != nil/);
  assert.match(chat, /CompanionScrollCoordinator/);
  assert.match(chat, /scrollCoordinator\.takePendingRequest\(\)/);
  assert.match(chat, /\.onScrollPhaseChange/);
  assert.match(chat, /scrollCoordinator\.beginUserInteraction/);
  const scrollPhase = chat.slice(
    chat.indexOf(".onScrollPhaseChange"),
    chat.indexOf(".onScrollTargetVisibilityChange", chat.indexOf(".onScrollPhaseChange")),
  );
  assert.match(scrollPhase, /newPhase == \.interacting[\s\S]*stopFollowingTailForReveal\(\)/);
  assert.match(chat, /newPhase == \.interacting[\s\S]*scrollCoordinator\.observeGeometry/);
  assert.match(chat, /\.defaultScrollAnchor\(\.bottom, for: \.initialOffset\)/);
  assert.doesNotMatch(chat, /\.defaultScrollAnchor\(\.bottom\)\s*/);
  assert.match(chat, /\.id\(transcriptScrollIdentity\)/);
  const acceptedThread = chat.indexOf("threadProjection.update(next)");
  const observedTail = chat.indexOf("let tailChanged = observeActualTail", acceptedThread);
  assert.notEqual(acceptedThread, -1);
  assert.ok(observedTail > acceptedThread);
  assert.match(chat, /let renderedScrollRevision = scrollContentRevision/);
  const scrollRevisionObserver = chat.indexOf(".task(id: renderedScrollRevision)");
  const deferredScrollDelivery = chat.indexOf("await Task.yield()", scrollRevisionObserver);
  const consumedScrollRequest = chat.indexOf(
    "scrollCoordinator.takePendingRequest()",
    scrollRevisionObserver,
  );
  assert.notEqual(scrollRevisionObserver, -1);
  assert.ok(deferredScrollDelivery > scrollRevisionObserver);
  assert.ok(consumedScrollRequest > deferredScrollDelivery);
  assert.match(
    chat.slice(deferredScrollDelivery, consumedScrollRequest),
    /renderedScrollRevision == scrollContentRevision/,
  );
  const lazyTranscriptTargets = chat.indexOf(".scrollTargetLayout()");
  const eagerBottomTarget = chat.indexOf('.id("bottom")', lazyTranscriptTargets);
  assert.notEqual(lazyTranscriptTargets, -1);
  assert.ok(eagerBottomTarget > lazyTranscriptTargets);
  assert.doesNotMatch(chat, /BottomDestinationLayoutSignal|markInitialBottomReady/);
  assert.equal(chat.match(/scrollCoordinator\.takePendingRequest\(\)/g)?.length, 1);
  assert.match(chat, /batches=\\\(scrollCoordinator\.issuedRequestBatchCount\)/);
  assert.match(uiTests, /Scroll diagnostics:/);
  const scrollOwner = chat.indexOf("private func performScroll");
  assert.notEqual(scrollOwner, -1);
  assert.doesNotMatch(chat.slice(0, scrollOwner), /proxy\.scrollTo\(/);
  assert.match(chat.slice(scrollOwner), /proxy\.scrollTo\(/);
  assert.match(chat, /ScrollViewReader/);
  assert.doesNotMatch(chat, /transcriptScrollPosition|\.scrollPosition\(/);
  assert.match(chat.slice(scrollOwner), /let targetID = bottomScrollTargetID/);
  assert.doesNotMatch(chat.slice(scrollOwner), /proxy\.scrollTo\("bottom"/);
  assert.match(chat, /return entries\.last\?\.id \?\? "bottom"/);
  assert.doesNotMatch(chat, /requestScroll\(to: \.bottom\)/);
  assert.match(coordination, /func position\(for companionID: String\)/);
  assert.match(coordination, /public mutating func restore\(/);
  assert.match(coordination, /public struct CompanionScrollCoordinator/);
  assert.match(coordination, /case followingTail/);
  assert.match(coordination, /case userReading/);
  assert.match(coordination, /case \.initial:\s*break/);
  assert.match(coordination, /issuedRequestBatchCount/);
  assert.match(uiTests, /testTranscriptWindowDemoRestoresReadingPositionAfterCompanionSwitch/);
  assert.match(uiTests, /testTranscriptWindowDemoStaysAtLatestAcrossPollInterval/);
  assert.match(companionKitTests, /func chatReadingPositionsRemainIsolatedByCompanion\(\)/);
  assert.match(
    companionKitTests,
    /func transcriptWindowRestorationKeepsSavedAnchorExposedAfterTailGrowth\(\)/,
  );
  assert.match(ci, /xcodebuild build/);
  assert.doesNotMatch(ci, /-only-testing:CompanionUITests/);
  assert.match(read("apps/ios/README.md"), /four-second poll/);
});

test("the project is synchronized, shared, and backed by CompanionKit", () => {
  const project = read("apps/ios/Companion.xcodeproj/project.pbxproj");
  const scheme = read("apps/ios/Companion.xcodeproj/xcshareddata/xcschemes/Companion.xcscheme");
  const workspace = read("apps/ios/Companion.xcworkspace/contents.xcworkspacedata");

  assert.match(project, /PBXFileSystemSynchronizedRootGroup/);
  assert.match(project, /productName = CompanionKit/);
  assert.match(scheme, /BlueprintName = "Companion"/);
  assert.match(workspace, /group:CompanionKit/);
  assert.doesNotMatch(
    read("apps/ios/CompanionKit/Sources/CompanionKit/CompanionKit.swift"),
    /native_mobile|clientSurface/,
  );
  assert.match(read("apps/ios/README.md"), /same\s+`\/v1` API/);
});

test("reply notifications embed the locally rendered avatar service extension", () => {
  const project = read("apps/ios/Companion.xcodeproj/project.pbxproj");
  const appInfo = read("apps/ios/Companion/Support/Info.plist");
  const extensionInfo = read("apps/ios/CompanionNotificationService/Info.plist");
  const entitlements = read("apps/ios/Config/Companion.entitlements");

  assert.match(project, /CompanionNotificationService\.appex in Embed App Extensions/);
  assert.match(project, /productName = CompanionNotificationAvatar/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile\.dev\.notifyextension/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = dev\.companion\.mobile\.notifyextension/);
  assert.match(extensionInfo, /com\.apple\.usernotifications\.service/);
  assert.match(extensionInfo, /\$\(PRODUCT_MODULE_NAME\)\.NotificationService/);
  assert.match(appInfo, /<string>INSendMessageIntent<\/string>/);
  assert.match(entitlements, /com\.apple\.developer\.usernotifications\.communication/);
});

test("notification entry narrowly invalidates the local-first transcript before routing", () => {
  const coordinator = read("apps/ios/Companion/Support/NotificationCoordinator.swift");
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const root = read("apps/ios/Companion/Navigation/RootView.swift");
  const invalidations = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/CompanionNotificationInvalidation.swift",
  );
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");

  const foregroundDelivery = coordinator.slice(
    coordinator.indexOf("willPresent notification"),
    coordinator.indexOf("didReceive response"),
  );
  assert.match(foregroundDelivery, /requestTranscriptInvalidation\(for: destination\)/);

  const notificationRoute = roster.slice(
    roster.indexOf("private func openPendingNotificationIfPossible"),
    roster.indexOf("@ViewBuilder", roster.indexOf("private func openPendingNotificationIfPossible")),
  );
  assert.match(
    notificationRoute,
    /companions\.contains[\s\S]*?activeCompanionID == destination\.companionID[\s\S]*?requestTranscriptInvalidation\(for: destination\)[\s\S]*?path = \[\.chat\(destination\.companionID\)\]/,
  );
  assert.match(
    root,
    /installTranscriptInvalidationHandler\(scopeID: orgID\)[\s\S]*?sessionStore\.invalidateCompanion\(companionID: companionID\)/,
  );
  assert.match(
    root,
    /backgroundRefresh:[\s\S]*?sessionStore\.refreshInvalidatedCompanion\(companionID: companionID\)/,
  );
  assert.match(
    coordinator,
    /didReceiveRemoteNotification[\s\S]*?refreshTranscriptInBackground[\s\S]*?backgroundFetchResult/,
  );
  assert.match(
    chat,
    /companionInvalidations\([\s\S]*?replayPending: false[\s\S]*?await reload\(silently: thread != nil\)[\s\S]*?for await _ in invalidations/,
  );
  assert.match(
    chat,
    /Task\.sleep\(for: \.seconds\(4\)\)[\s\S]*?reloadInBackground\(\)[\s\S]*?for await _ in invalidations[\s\S]*?reloadInBackground\(\)/,
  );
  const backgroundReload = chat.slice(
    chat.indexOf("private func reloadInBackground"),
    chat.indexOf("private func renderedMarkdown", chat.indexOf("private func reloadInBackground")),
  );
  assert.match(
    backgroundReload,
    /guard refreshGate\.beginBackgroundRefresh\(\)[\s\S]*?guard refreshGate\.completeBackgroundRefresh\(\)/,
  );
  assert.match(invalidations, /pendingRequestSet\.insert\(request\)\.inserted/);
  assert.match(invalidations, /pendingBackgroundRequestSet\.insert\(request\)\.inserted/);
  assert.match(read("apps/ios/Companion/Support/Info.plist"), /remote-notification/);
});

test("the Expo client and its repository-local skills are gone", () => {
  assert.equal(existsSync(resolve(ROOT, "apps/mobile")), false);
  assert.equal(existsSync(resolve(ROOT, "skills-lock.json")), false);
  for (const root of [".agents/skills", ".claude/skills"]) {
    for (const skill of ["eas-app-stores", "eas-workflows", "expo-overview", "expo-router", "vercel-react-native-skills"]) {
      assert.equal(existsSync(resolve(ROOT, root, skill)), false, `${root}/${skill}`);
    }
  }
});

test("Agents and Claude share the durable native iOS skill surface", () => {
  const packages = {
    "ios-product-dev": ["SKILL.md", "SOURCE.md", "companion.json", "evals/evals.json"],
    "swiftui-expert-dev": ["SKILL.md", "SOURCE.md", "companion.json", "evals/evals.json"],
    "xcodebuildmcp-cli": ["SKILL.md", "SOURCE.md", "LICENSE", "companion.json", "evals/evals.json"],
  };

  for (const [skill, files] of Object.entries(packages)) {
    for (const file of files) {
      const agentsPath = `.agents/skills/${skill}/${file}`;
      const claudePath = `.claude/skills/${skill}/${file}`;
      assert.equal(existsSync(resolve(ROOT, agentsPath)), true, agentsPath);
      assert.equal(existsSync(resolve(ROOT, claudePath)), true, claudePath);
      assert.equal(read(agentsPath), read(claudePath), `${skill}/${file} must stay mirrored`);
    }
    const manifest = JSON.parse(read(`.agents/skills/${skill}/companion.json`));
    const evals = JSON.parse(read(`.agents/skills/${skill}/evals/evals.json`));
    assert.equal(manifest.name, skill);
    assert.equal(evals.skill_name, skill);
    assert.equal(evals.evals.length, 4);
  }
});

test("the iOS launcher derives the API port from Conductor and uses XcodeBuildMCP", () => {
  const launcher = read("apps/ios/scripts/dev-conductor.sh");
  assert.match(launcher, /API_PORT="\$\(\(BASE_PORT \+ 1\)\)"/);
  assert.match(launcher, /xcodebuildmcp simulator build-and-run/);
  assert.match(launcher, /xcodebuildmcp simulator list --output json/);
  assert.match(launcher, /simulator\.get\("state"\) == "Booted"/);
  assert.match(launcher, /SIMULATOR_ARGS=\(--simulator-id/);
  assert.match(launcher, /-COMPANION_API_URL/);
  assert.doesNotMatch(launcher, /iPhone 17|\bxcodebuild\b|\bxcrun\b|\bsimctl\b/);
});

test("the local live iOS action uses Conductor nonconcurrency and the existing stack lock", () => {
  const settings = read(".conductor/settings.toml");
  const packageJson = JSON.parse(read("package.json"));
  const launcher = read("scripts/dev-ios-live.sh");
  const stack = read("scripts/dev-conductor.sh");

  assert.match(settings, /^run_mode = "nonconcurrent"$/m);
  assert.match(settings, /^\[scripts\.run\."iOS \(live Box\)"\]$/m);
  assert.match(settings, /^command = "pnpm ios:live"$/m);
  assert.equal(packageJson.scripts["ios:live"], "bash scripts/dev-ios-live.sh");
  assert.equal(packageJson.scripts["ios:live:stop"], "bash scripts/dev-ios-live.sh stop");
  assert.match(launcher, /COMPANION_DEV_BOX_MODE=live/);
  assert.match(launcher, /bash scripts\/dev-conductor\.sh/);
  assert.match(launcher, /bash scripts\/dev-ios-live\.sh client/);
  assert.match(launcher, /--kill-others-on-fail/);
  assert.match(launcher, /bash scripts\/dev-process\.sh ios-local node scripts\/ios-local-live\.mjs bootstrap/);
  assert.match(launcher, /bash apps\/ios\/scripts\/dev-conductor\.sh/);
  assert.match(launcher, /wait_for_endpoint "API" "http:\/\/127\.0\.0\.1:\$\(\(base_port \+ 1\)\)\/health"/);
  assert.match(launcher, /wait_for_endpoint "Runtime" "http:\/\/127\.0\.0\.1:\$\(\(base_port \+ 7\)\)\/healthz"/);
  assert.doesNotMatch(launcher, /\bflock\b|lockfile|\.lock|\bxcodebuild\b|\bxcrun\b|\bsimctl\b/);
  assert.match(stack, /acquire_run_lock/);
});

test("CI keeps Apple Quality valuable, native, and under five minutes", () => {
  const ci = read(".github/workflows/ci.yml");
  const e2e = read(".github/workflows/ios-e2e.yml");
  const appleQualityStart = ci.indexOf("  apple-quality:");
  const appleQuality = ci.slice(
    appleQualityStart,
    ci.indexOf("\n  quality:", appleQualityStart),
  );

  assert.match(appleQuality, /^  apple-quality:$/m);
  assert.match(appleQuality, /^    runs-on: macos-26$/m);
  assert.match(appleQuality, /^    timeout-minutes: 5$/m);
  assert.match(
    appleQuality,
    /if: needs\.scope\.outputs\.skill == 'true' \|\| needs\.scope\.outputs\.ios == 'true' \|\| needs\.scope\.outputs\.macos == 'true'/,
  );
  assert.match(appleQuality, /Test bundled Companion skill guards/);
  assert.match(appleQuality, /run: bash scripts\/run-skill-guards\.sh/);
  assert.match(appleQuality, /swift test --package-path apps\/ios\/CompanionKit/);
  assert.match(
    appleQuality,
    /- name: Test CompanionKit[\s\S]*?if: needs\.scope\.outputs\.ios != needs\.scope\.outputs\.macos/,
  );
  assert.match(
    appleQuality,
    /- name: Validate native apps[\s\S]*?swift test --package-path apps\/ios\/CompanionKit &[\s\S]*?if wait "\$companion_kit_pid";[\s\S]*?xcodebuild test/,
  );
  assert.match(appleQuality, /xcodebuild build/);
  assert.match(appleQuality, /-destination "generic\/platform=iOS Simulator"/);
  assert.match(appleQuality, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(appleQuality, /xcodebuild test[\s\S]*?-scheme CompanionMac[\s\S]*?-destination "platform=macOS"/);
  assert.doesNotMatch(appleQuality, /CompanionUITests|only-testing:/);
  assert.doesNotMatch(appleQuality, /simctl|Select an available simulator|retry-tests-on-failure/);
  assert.doesNotMatch(ci, /xcodebuildmcp/i);
  assert.doesNotMatch(ci, /^  skill-guards-macos:$/m);
  assert.doesNotMatch(ci, /^  ios-quality:$/m);
  assert.doesNotMatch(ci, /^  schedule:$/m);
  assert.doesNotMatch(ci, /^  workflow_dispatch:$/m);
  assert.match(e2e, /^name: "Diagnostic: iOS Live E2E"$/m);
  assert.doesNotMatch(e2e, /xcodebuildmcp/i);
  assert.match(e2e, /swift test --package-path apps\/ios\/CompanionKit/);
  assert.match(e2e, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(e2e, /^  schedule:$/m);
  assert.doesNotMatch(e2e, /^  pull_request:/m);
  assert.doesNotMatch(e2e, /^  push:/m);
  assert.match(e2e, /^    environment: ios-e2e$/m);
  assert.match(e2e, /COMPANION_BOX_API_KEY: \$\{\{ secrets\.COMPANION_BOX_E2E_API_KEY \}\}/);
  assert.match(e2e, /node scripts\/ios-e2e-fixture\.mjs prepare/);
  assert.match(e2e, /node scripts\/ios-e2e-fixture\.mjs cleanup/);
});

test("voice transcription keeps the global key server-side and delegates Apple checks", () => {
  const composer = read("apps/ios/Companion/Screens/ChatComposer.swift");
  const routes = read("apps/api/src/companionRoutes.ts");
  const envExample = read(".env.example");
  const status = read("apps/ios/Companion/Screens/VoiceTranscriptionStatusView.swift");
  const controller = read("apps/ios/Companion/Support/VoiceTranscriptionController.swift");
  const client = read(
    "apps/ios/CompanionKit/Sources/CompanionKit/VoiceTranscription.swift",
  );
  const info = read("apps/ios/Companion/Support/Info.plist");
  const tests = read(
    "apps/ios/CompanionKit/Tests/CompanionKitTests/VoiceTranscriptionTests.swift",
  );
  const ci = read(".github/workflows/ci.yml");

  assert.match(composer, /accessibilityIdentifier\("chat\.transcription\.toggle"\)/);
  assert.match(composer, /if transcription\.isBusy \{/);
  assert.match(composer, /else if showsSendButton \|\| !transcriptionAvailable/);
  assert.match(composer, /onChange\(of: transcriptionAvailable\)/);
  assert.match(composer, /frame\(width: 44, height: 44\)/);
  assert.match(routes, /COMPANION_GEMINI_TRANSCRIPTION_API_KEY\?\.trim\(\)/);
  assert.match(routes, /transcription_available: transcriptionAvailable/);
  assert.match(envExample, /^COMPANION_GEMINI_TRANSCRIPTION_API_KEY=$/m);
  assert.match(status, /Audio and recent conversation are processed for transcription\./);
  assert.match(controller, /AVAudioApplication\.requestRecordPermission/);
  assert.match(controller, /AVSampleRateKey: 16_000/);
  assert.match(controller, /kAudioFormatMPEG4AAC/);
  assert.match(controller, /private var transcriptionTask: Task<Void, Never>\?/);
  assert.match(controller, /guard generation == activeGeneration/);
  assert.match(controller, /case processing/);
  assert.doesNotMatch(composer, /Task \{ await transcription\.cancel\(\) \}/);
  assert.match(composer, /transcription\.cancel\(\)/);
  assert.match(composer, /onChange\(of: canSend\)/);
  assert.match(client, /companionTranscriptionAudioMaximumBytes = 8 \* 1024 \* 1024/);
  assert.doesNotMatch(client, /AIza[0-9A-Za-z_-]{20,}/);
  assert.match(info, /<key>NSMicrophoneUsageDescription<\/key>/);
  assert.match(tests, /uploadsOneCompressedRecordingAndDecodesOnlyTheTranscript/);
  assert.match(tests, /rejectsEmptyAndOversizedRecordingsBeforeTheNetwork/);
  assert.match(ci, /swift test --package-path apps\/ios\/CompanionKit/);
  assert.match(ci, /xcodebuild build/);
  assert.doesNotMatch(ci, /xcodebuildmcp/i);
});

test("the staged reply fixture is armed only after the UI reader leaves the tail", () => {
  const chatView = read("apps/ios/Companion/Screens/ChatView.swift");
  const demo = read("apps/ios/Companion/Screens/CompanionTranscriptWindowDemoView.swift");

  assert.match(
    demo,
    /@State private var stagedFixture = CompanionTranscriptWindowDemoFixtures\.makeStagedFixture\(\)/,
  );
  assert.match(demo, /services\(\s*stagedFixture: stagedFixture\s*\)/);
  assert.match(demo, /stagedFixture\.deliveredStagedReply \? "Reply delivered" : "Stage reply"/);
  assert.match(demo, /accessibilityIdentifier\("demo\.stage-reply"\)/);
  assert.match(demo, /guard stagesNextPoll else \{ return current \}/);
  assert.match(demo, /"event_id": "staged-reply"/);
  assert.match(chatView, /@State private var unseenCount = 0/);
  assert.match(chatView, /var nextUnseenTracker = unseenTracker/);
  assert.match(chatView, /unseenTracker = nextUnseenTracker/);
  assert.match(chatView, /unseenCount = nextUnseenCount/);
  assert.match(chatView, /let readerWasNearBottom = isNearBottom/);
  assert.match(chatView, /let readerIsNearBottom = isNearBottom/);
  assert.match(chatView, /isNearBottom: readerIsNearBottom/);
  assert.match(chatView, /completedReveal\.followsTail, isNearBottom, !loadingEarlier/);
  assert.match(chatView, /source: \.poll,\s+animated: false/);
});

test("native routine history keeps private runs separate and reachable", () => {
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const details = read("apps/ios/Companion/Screens/CompanionDetailView.swift");
  const history = read("apps/ios/Companion/Screens/CompanionRoutineHistoryView.swift");
  const models = read("apps/ios/CompanionKit/Sources/CompanionKit/Models.swift");
  const client = read("apps/ios/CompanionKit/Sources/CompanionKit/APIClient.swift");
  const readme = read("apps/ios/README.md");

  assert.match(chat, /if let routine = input\.entry\.routine/);
  assert.match(chat, /Text\("Routine: \\\(routine\.name\)"\)/);
  assert.match(chat, /CompanionRoutineHistoryTarget\([\s\S]*?runID: runID/);
  assert.match(details, /CompanionRoutineRunListStore/);
  assert.match(details, /CompanionRoutineRunSheet\([\s\S]*?run: run/);
  assert.match(history, /Text\("Internal transcript"\)/);
  assert.match(history, /case \.noOutput: return "Completed silently"/);
  assert.match(history, /nextRunsCursor != nil/);
  assert.match(history, /run\.nextEntryCursor != nil/);
  assert.match(models, /case routine\s*[\r\n]/);
  assert.match(models, /case runID = "run_id"/);
  assert.match(client, /\/routines\/\\\(routine\)\/runs\?\\\(query\)/);
  assert.match(client, /\/routine-runs\/\\\(run\)\?\\\(query\)/);
  assert.match(readme, /compact\s+clickable marker instead of a prompt bubble/);
});

test("iOS navigation has one Companion details route and no legacy resource page", () => {
  const roster = read("apps/ios/Companion/Screens/CompanionListView.swift");
  const chat = read("apps/ios/Companion/Screens/ChatView.swift");
  const computer = read("apps/ios/Companion/Screens/CompanionComputerView.swift");
  const details = read("apps/ios/Companion/Screens/CompanionDetailView.swift");
  const resources = read("apps/ios/Companion/Screens/CompanionDetailResourceSections.swift");
  const detailDemo = read("apps/ios/Companion/Screens/CompanionDetailDemo.swift");
  const root = read("apps/ios/Companion/Navigation/RootView.swift");

  assert.match(roster, /case chat\(String\)\s*\n\s*case details\(String\)/);
  assert.doesNotMatch(roster, /case settings\(|case identity\(/);
  assert.match(roster, /NavigationLink\(value: CompanionRoute\.chat\(companion\.id\)\)/);
  const contextMenu = roster.slice(
    roster.indexOf("private func companionContextMenu"),
    roster.indexOf("private func reload", roster.indexOf("private func companionContextMenu")),
  );
  assert.match(contextMenu, /Button\("Settings", systemImage: "gearshape"\)[\s\S]*?path = \[\.details\(companion\.id\)\]/);
  assert.match(chat, /accessibilityIdentifier\("chat\.details"\)/);
  const chatHeader = chat.slice(
    chat.indexOf("private var headerToolbar"),
    chat.indexOf("private var loadEarlierButton"),
  );
  assert.doesNotMatch(chatHeader, /accessibilityIdentifier\("chat\.actions"\)|systemName: "ellipsis"/);
  assert.doesNotMatch(computer, /computer\.details|Button\("Companion details"/);
  for (const identifier of [
    "companion.details.provider",
    "companion.details.routine.",
    "companion.details.delete",
  ]) {
    assert.match(details, new RegExp(identifier.replaceAll(".", "\\.")));
  }
  assert.match(resources, /companion\.details\.resources/);
  assert.match(resources, /companion\.details\.plugin-account\./);
  assert.match(resources, /Advanced recovery asynchronously recycles Pi while the Box and saved files stay in place\./);
  assert.match(resources, /Advanced recovery remains available while this Companion is offline\./);
  assert.doesNotMatch(resources, /restart the full server|Full Box|must be Online before it can restart/);
  const runtimeControlsDisabled = resources.slice(
    resources.indexOf("private var runtimeControlsDisabled"),
    resources.indexOf("private var runtimeMessage", resources.indexOf("private var runtimeControlsDisabled")),
  );
  const restartFunction = resources.slice(
    resources.indexOf("private func restart(_ target"),
    resources.indexOf("private func deleteCompanion", resources.indexOf("private func restart(_ target")),
  );
  assert.doesNotMatch(runtimeControlsDisabled, /runtimeOnline/);
  assert.doesNotMatch(restartFunction, /runtimeOnline/);
  assert.match(resources, /background\(CompanionIOSTheme\.chip, in: Capsule\(\)\)/);
  assert.doesNotMatch(details, /CompanionLegacySettingsView|companion\.details\.settings/);
  assert.doesNotMatch(resources, /struct CompanionConnectedResourcesView|navigationTitle\("Connected resources"\)/);
  assert.match(detailDemo, /connectedResources: \{ CompanionResourceDemoFixtures\.resources \}/);
  assert.match(resources, /enum CompanionResourceDemoFixtures/);
  assert.doesNotMatch(resources, /enum CompanionDetailDemoFixtures/);
  assert.match(details, /\.onChange\(of: providerID\) \{ _, _ in selectDefaultModel\(\) \}/);
  assert.match(
    details,
    /private func apply[\s\S]{0,180}?let preservesProviderDraft = changedProviderOrModel[\s\S]{0,300}?if !preservesProviderDraft/,
  );
  assert.match(roster, /case \.details\(let companionID\):[\s\S]{0,500}?path = \[\.chat\(companionID\)\]/);
  assert.doesNotMatch(detailDemo, /struct CompanionLegacySettingsView|navigationTitle\("Companion settings"\)/);
  assert.doesNotMatch(root, /-companion-resources-demo|CompanionConnectedResourcesDemoView/);
});

test("iOS trigger providers are member-wide while MCP tool attachments remain Companion-specific", () => {
  const resources = read("apps/ios/Companion/Screens/CompanionDetailResourceSections.swift");
  const editor = read("apps/ios/Companion/Screens/CompanionResourceEditorViews.swift");
  const plugins = read("apps/ios/Companion/Screens/PluginCatalogSheet.swift");
  const client = read("apps/ios/CompanionKit/Sources/CompanionKit/APIClient.swift");

  const triggerAccounts = resources.slice(
    resources.indexOf("private var triggerAccountOptions"),
    resources.indexOf("private var effectiveMemberTimezone"),
  );
  assert.match(triggerAccounts, /\[CompanionTriggerProviderAccount\]/);
  assert.match(triggerAccounts, /triggerProviderAccounts/);
  assert.doesNotMatch(triggerAccounts, /plugins\.filter|selectedMCPAccountIDs|attached/);
  assert.match(resources, /Text\("Shared providers"\)/);
  assert.match(resources, /No Companion attachment is required\. MCP tool attachments are managed separately above\./);
  assert.match(resources, /Registration blocked · provider disconnected/);
  assert.match(editor, /LabeledContent\("Shared account"/);
  assert.match(editor, /provider == \.github \|\| provider == \.linear \|\| provider == \.sentry/);
  assert.doesNotMatch(editor, /Attach a GitHub or Linear account/);
  assert.match(plugins, /struct TriggerProviderManagementView/);
  assert.match(plugins, /there is no attachment step/);
  assert.match(plugins, /unavailable to every Companion/);
  assert.match(plugins, /dependent triggers cannot register or receive events/);
  assert.match(client, /path: "\/v1\/companion-trigger-provider-accounts"/);
  assert.doesNotMatch(client, /companion-trigger-provider-accounts\/.*companion/);
});

test("GitHub Actions never installs or invokes XcodeBuildMCP", () => {
  const workflows = readdirSync(resolve(ROOT, ".github/workflows"))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));

  for (const workflow of workflows) {
    assert.doesNotMatch(
      read(`.github/workflows/${workflow}`),
      /xcodebuildmcp/i,
      `${workflow} must use native Apple command-line tools`,
    );
  }
});

test("dependency auditing stays inside Quality and Pi publishing remains narrowly scoped", () => {
  const ci = read(".github/workflows/ci.yml");
  const quality = ci.slice(ci.indexOf("  quality:"), ci.indexOf("  application-build:"));
  const pi = read(".github/workflows/pi-bundle.yml");

  assert.match(quality, /if: needs\.scope\.outputs\.dependencies == 'true'/);
  assert.match(quality, /audit --prod --audit-level=high/);
  assert.doesNotMatch(ci, /^  dependency-audit:$/m);
  assert.doesNotMatch(ci, /^  coverage:$/m);
  assert.match(pi, /^name: "Publish: Pi Bundle"$/m);
  assert.match(pi, /^  workflow_dispatch:$/m);
  assert.match(pi, /^  push:$/m);
  for (const path of [
    "packages/box-runtime/src/piBundle.ts",
    "scripts/build-pi-bundle.sh",
    "scripts/upload-pi-bundle.mjs",
    ".github/workflows/pi-bundle.yml",
  ]) {
    assert.match(pi, new RegExp(`      - "${path.replaceAll(".", "\\.")}"`));
  }
});
