import Foundation
import CompanionKit
import SwiftUI
import UIKit

@MainActor
struct ChatServices {
    let thread: (String) async throws -> CompanionThread
    let listCompanions: () async throws -> [CompanionSummary]
    let decide: (String, String, CompanionDecisionAction) async throws -> CompanionThread
    let cancelTurn: (String, String) async throws -> CompanionThread
    let listSkills: () async throws -> [CompanionSkillReference]
    let listPlugins: () async throws -> [CompanionPluginAccount]
    let listProviders: () async throws -> CompanionProvidersResponse
    let listRoutineRuns: ((String, String, Int, String?) async throws -> CompanionRoutineRunList)?
    let readRoutineRun: ((String, String, Int, Int?) async throws -> CompanionRoutineRunDetail)?
    let openDesktop: ((String) async throws -> CompanionDesktop)?

    init(
        thread: @escaping (String) async throws -> CompanionThread,
        listCompanions: @escaping () async throws -> [CompanionSummary],
        decide: @escaping (String, String, CompanionDecisionAction) async throws -> CompanionThread,
        cancelTurn: @escaping (String, String) async throws -> CompanionThread,
        listSkills: @escaping () async throws -> [CompanionSkillReference],
        listPlugins: @escaping () async throws -> [CompanionPluginAccount],
        listProviders: @escaping () async throws -> CompanionProvidersResponse,
        listRoutineRuns: ((String, String, Int, String?) async throws -> CompanionRoutineRunList)? = nil,
        readRoutineRun: ((String, String, Int, Int?) async throws -> CompanionRoutineRunDetail)? = nil,
        openDesktop: ((String) async throws -> CompanionDesktop)? = nil
    ) {
        self.thread = thread
        self.listCompanions = listCompanions
        self.decide = decide
        self.cancelTurn = cancelTurn
        self.listSkills = listSkills
        self.listPlugins = listPlugins
        self.listProviders = listProviders
        self.listRoutineRuns = listRoutineRuns
        self.readRoutineRun = readRoutineRun
        self.openDesktop = openDesktop
    }
}

private struct AssistantTailReveal: Equatable, Sendable {
    let id: UUID
    let eventID: String
    let baseMarkdown: MarkdownDocument?
    var visibleDelta: String
    var followsTail: Bool
}

private struct AssistantTailChange: Equatable, Sendable {
    let eventID: String
    let previousContent: String
    let nextContent: String
}

/// Fences overlapping refresh tasks without making each poll a SwiftUI-observed state mutation.
private final class ChatRefreshGate {
    private var revision = 0
    private var backgroundRefreshActive = false
    private var backgroundRefreshQueued = false

    func begin() -> Int {
        revision += 1
        return revision
    }

    func invalidate() {
        revision += 1
    }

    func accepts(_ refresh: Int) -> Bool {
        refresh == revision
    }

    func beginBackgroundRefresh() -> Bool {
        if backgroundRefreshActive {
            backgroundRefreshQueued = true
            return false
        }
        backgroundRefreshActive = true
        return true
    }

    func completeBackgroundRefresh() -> Bool {
        if backgroundRefreshQueued {
            backgroundRefreshQueued = false
            return true
        }
        backgroundRefreshActive = false
        return false
    }

    func cancelBackgroundRefresh() {
        backgroundRefreshActive = false
        backgroundRefreshQueued = false
    }
}

private struct TranscriptKeyboardDismissGesture: UIGestureRecognizerRepresentable {
    let onTap: () -> Void

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldReceive touch: UITouch
        ) -> Bool {
            var view = touch.view
            while let current = view {
                if current is UITextField || current is UITextView { return false }
                view = current.superview
            }
            return true
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRequireFailureOf otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            otherGestureRecognizer is UIScreenEdgePanGestureRecognizer
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator {
        Coordinator()
    }

    func makeUIGestureRecognizer(context: Context) -> UITapGestureRecognizer {
        let recognizer = UITapGestureRecognizer()
        recognizer.cancelsTouchesInView = false
        recognizer.delegate = context.coordinator
        return recognizer
    }

    func handleUIGestureRecognizerAction(
        _ recognizer: UITapGestureRecognizer,
        context: Context
    ) {
        onTap()
    }
}

struct ChatView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    let companion: CompanionSummary
    let onDetails: () -> Void
    /// Opens the shared Plugins surface for a decision card that requests a connection.
    /// This is intentionally separate from the chat header, whose only destinations are the
    /// detail pill and the computer action.
    let onOpenPlugins: (_ provider: String?, _ controlRequestID: String?) -> Void
    let onReadingPositionChange: (CompanionChatReadingPosition) -> Void
    private let readingPosition: CompanionChatReadingPosition?
    private let renderedFromCache: Bool
    private let services: ChatServices?
    @State private var currentCompanion: CompanionSummary
    @State private var threadProjection = CompanionThreadProjection()
    /// Cached transcripts render instantly but carry no authority. Send capability stays unknown,
    /// not denied, until a fresh server response lands, so an unsynchronized thread never claims
    /// Viewer read-only access to an Owner or Editor.
    @State private var threadAuthorityVerified: Bool
    @State private var refreshGate = ChatRefreshGate()
    @State private var loading = true
    @State private var sending = false
    @State private var error: String?
    @State private var pendingMessages: [PendingMessage] = []
    @State private var markdownByEventID: [String: CachedMarkdownDocument] = [:]
    @State private var expandedReasoningEventIDs: Set<String> = []
    @State private var expandedRoutineNotifyEventIDs: Set<String> = []
    @State private var threadMutationGate = CompanionThreadMutationGate()
    @State private var decisionCatalog = CompanionDecisionCatalog.empty
    @State private var decisionCatalogLoaded = false
    @State private var transcriptWindow = CompanionTranscriptWindow()
    @State private var scrollCoordinator = CompanionScrollCoordinator()
    @State private var unseenTracker = CompanionTranscriptUnseenTracker()
    @State private var unseenCount = 0
    @State private var loadingEarlier = false
    @State private var historyIsPartial: Bool
    @State private var scrollContentRevision = 0
    @State private var pendingReadingPosition: CompanionChatReadingPosition?
    @State private var lastReportedReadingPosition: CompanionChatReadingPosition?
    @State private var visibleEntryIDs: [String] = []
    @State private var isRestoringReadingPosition = false
    @State private var restorationTargetEventID: String?
    @State private var restorationScrollPerformed = false
    @State private var assistantTailReveal: AssistantTailReveal?
    @State private var assistantTailRevealTask: Task<Void, Never>?
    @State private var selectedToolDetail: ToolRunDetailRoute?
    @State private var inputFocusCoordinator = CompanionChatInputFocusCoordinator()
    @State private var routineHistoryTarget: CompanionRoutineHistoryTarget?
    @State private var showingComputer = false

    private let bottomProximityThreshold: CGFloat = 80

    init(
        companion: CompanionSummary,
        initialSnapshot: CompanionThreadSnapshot? = nil,
        readingPosition: CompanionChatReadingPosition? = nil,
        onOpenPlugins: @escaping (_ provider: String?, _ controlRequestID: String?) -> Void = { _, _ in },
        services: ChatServices? = nil,
        onReadingPositionChange: @escaping (CompanionChatReadingPosition) -> Void = { _ in },
        onDetails: @escaping () -> Void
    ) {
        self.companion = companion
        self.readingPosition = readingPosition
        renderedFromCache = initialSnapshot != nil
        self.onOpenPlugins = onOpenPlugins
        self.services = services
        self.onReadingPositionChange = onReadingPositionChange
        self.onDetails = onDetails
        let cachedThread = initialSnapshot?.thread
        _currentCompanion = State(initialValue: companion)
        _threadProjection = State(initialValue: CompanionThreadProjection(thread: cachedThread))
        _loading = State(initialValue: cachedThread == nil)
        _threadAuthorityVerified = State(initialValue: cachedThread == nil)
        _historyIsPartial = State(initialValue: initialSnapshot?.isPartial == true)
        _transcriptWindow = State(initialValue: CompanionTranscriptWindow(
            totalCount: cachedThread?.entries.filter { !$0.queued }.count ?? 0
        ))
        _pendingReadingPosition = State(initialValue: readingPosition)
        _scrollCoordinator = State(
            initialValue: CompanionScrollCoordinator(
                followState: readingPosition?.isFollowingTail == false
                    ? .userReading
                    : .followingTail,
                lastActualTailSnapshot: cachedThread.map { CompanionScrollTailSnapshot(thread: $0) }
            )
        )
    }

    var body: some View {
        let visibleEntries = entries
        let renderedItems = CompanionTranscriptProjection.displayItems(
            from: visibleEntries,
            expandedRoutineNotifyEventIDs: expandedRoutineNotifyEventIDs
        )
        let queuedEntries = queuedEntries(in: thread)
        let renderedScrollRevision = scrollContentRevision
        ZStack {
            CompanionIOSTheme.canvas
                .ignoresSafeArea()

            ScrollViewReader { proxy in
                VStack(spacing: 0) {
                    ScrollView {
                        VStack(spacing: 16) {
                            LazyVStack(spacing: 0) {
                                if loading && threadProjection.needsBlockingLoader {
                                    ProgressView("Loading conversation…")
                                        .padding(.top, 80)
                                } else if let error, thread == nil {
                                    unavailableState(error)
                                } else if visibleEntries.isEmpty && pendingMessages.isEmpty
                                            && thread?.interruptedTurn == nil {
                                    emptyState
                                } else {
                                    if transcriptWindow.hasEarlierEntries || historyIsPartial {
                                        loadEarlierButton
                                    }

                                    ForEach(Array(renderedItems.enumerated()), id: \.element.id) { index, item in
                                        if case let .routineNotifyDisclosure(
                                            routineName,
                                            totalCount,
                                            latestAssistantEventID
                                        ) = item.kind {
                                            let previousEntry = previousTranscriptEntry(
                                                in: renderedItems,
                                                before: index
                                            )
                                            let nextEntry = nextTranscriptEntry(
                                                in: renderedItems,
                                                after: index
                                            )
                                            let startsDay = nextEntry.map {
                                                startsNewDay($0, after: previousEntry)
                                            } ?? false
                                            if startsDay {
                                                dayMarker(for: transcriptDate(nextEntry?.createdAt ?? "") ?? .now)
                                                    .padding(.top, index == 0 ? 0 : 8)
                                                    .padding(.bottom, 16)
                                            }
                                            CompanionRoutineNotifyDisclosure(
                                                routineName: routineName,
                                                totalCount: totalCount,
                                                latestAssistantEventID: latestAssistantEventID,
                                                isExpanded: expandedRoutineNotifyEventIDs.contains(
                                                    latestAssistantEventID
                                                ),
                                                onToggle: {
                                                    toggleRoutineNotifyDisclosure(
                                                        for: latestAssistantEventID
                                                    )
                                                }
                                            )
                                            .padding(
                                                .top,
                                                startsDay
                                                    ? 0
                                                    : routineNotifyDisclosureSpacing(
                                                        after: previousEntry,
                                                        before: nextEntry,
                                                        index: index
                                                    )
                                            )
                                            .id(item.id)
                                        } else if case let .entry(entry) = item.kind {
                                            let previousEntry = previousTranscriptEntry(
                                                in: renderedItems,
                                                before: index
                                            )
                                            let followsDisclosure = index > 0
                                                && isRoutineNotifyDisclosure(renderedItems[index - 1])
                                            let startsDay = !followsDisclosure
                                                && startsNewDay(entry, after: previousEntry)
                                            if startsDay {
                                                dayMarker(for: transcriptDate(entry.createdAt) ?? .now)
                                                    .padding(.top, index == 0 ? 0 : 8)
                                                    .padding(.bottom, 16)
                                            }
                                            TranscriptRowView(
                                                input: transcriptRowInput(for: entry),
                                                onDecide: { action in
                                                    guard let decision = entry.decision else { return }
                                                    try await decide(
                                                        requestID: decision.requestID,
                                                        action: action
                                                    )
                                                },
                                                onAnswerFocusChange: { focused in
                                                    guard let decision = entry.decision else { return }
                                                    decisionAnswerFocusChanged(
                                                        focused,
                                                        requestID: decision.requestID,
                                                        eventID: entry.eventID
                                                    )
                                                },
                                                onOpenPlugins: onOpenPlugins,
                                                onReasoningExpansionChange: { isExpanded in
                                                    setReasoningExpanded(isExpanded, for: entry.eventID)
                                                },
                                                onOpenToolDetails: { selectedToolDetail = $0 },
                                                onOpenRoutineRun: { routine in
                                                    guard let runID = routine.runID else { return }
                                                    routineHistoryTarget = CompanionRoutineHistoryTarget(
                                                        routineID: routine.id,
                                                        runID: runID,
                                                        name: routine.name
                                                    )
                                                }
                                            )
                                            .equatable()
                                            .padding(
                                                .top,
                                                startsDay || followsDisclosure
                                                    ? 0
                                                    : transcriptSpacing(
                                                        after: previousEntry,
                                                        before: entry
                                                    )
                                            )
                                            .id(item.id)
                                        }
                                    }

                                    if let interruptedTurn = thread?.interruptedTurn {
                                        CompanionInterruptedTurnNotice(
                                            turn: interruptedTurn,
                                            queuedCount: thread?.queuedCount ?? 0
                                        )
                                        .padding(.top, 16)
                                        .id("interrupted-\(interruptedTurn.id)")
                                    }

                                    if !pendingMessages.isEmpty, pendingStartsNewDay {
                                        dayMarker(for: .now)
                                            .padding(.vertical, 16)
                                    }

                                    ForEach(pendingMessages) { pending in
                                        PendingMessageView(
                                            message: pending,
                                            accent: visualTheme.accent,
                                            accentForeground: visualTheme.accentForeground,
                                            retry: { retry(pending.id) },
                                            dismiss: { dismiss(pending.id) }
                                        )
                                        .padding(.top, 16)
                                        .id("pending-\(pending.id)")
                                    }
                                }
                            }
                            .scrollTargetLayout()

                            Color.clear
                                .frame(height: 1)
                                .id("bottom")
                        }
                        .padding(.horizontal, 16)
                        .padding(.top, 16)
                        .padding(.bottom, 22)
                    }
                    .opacity(isRestoringReadingPosition ? 0 : 1)
                    .scrollDismissesKeyboard(.interactively)
                    .scrollIndicators(.hidden)
                    // Initial placement belongs to layout, not an imperative request competing
                    // with that layout. Scoping the anchor to initialOffset prevents later poll,
                    // markdown, composer, and safe-area size changes from reapplying it.
                    .defaultScrollAnchor(.bottom, for: .initialOffset)
                    .id(transcriptScrollIdentity)
                    .accessibilityIdentifier("chat.transcript")
                    .accessibilityValue(transcriptScrollDiagnostics)
                    .gesture(
                        TranscriptKeyboardDismissGesture {
                            inputFocusCoordinator.transcriptBackgroundTapped()
                            UIApplication.shared.sendAction(
                                #selector(UIResponder.resignFirstResponder),
                                to: nil,
                                from: nil,
                                for: nil
                            )
                        }
                    )
                    .onScrollGeometryChange(for: CGFloat.self) { geometry in
                        max(0, geometry.contentSize.height - geometry.visibleRect.maxY)
                    } action: { _, bottomDistance in
                        let wasNearBottom = isNearBottom
                        let stateChanged = scrollCoordinator.observeGeometry(
                            bottomDistance: Double(bottomDistance),
                            threshold: Double(bottomProximityThreshold)
                        )
                        if isNearBottom, !wasNearBottom {
                            if unseenCount > 0 {
                                unseenTracker.markReaderAtBottom()
                                unseenCount = 0
                            }
                        }
                        if stateChanged {
                            recordReadingPosition()
                        }
                    }
                    .onScrollPhaseChange { _, newPhase, context in
                        let wasNearBottom = isNearBottom
                        let geometry = context.geometry
                        let bottomDistance = max(
                            0,
                            geometry.contentSize.height - geometry.visibleRect.maxY
                        )
                        let stateChanged: Bool
                        if newPhase == .interacting {
                            stopFollowingTailForReveal()
                            stateChanged = scrollCoordinator.beginUserInteraction(
                                bottomDistance: Double(bottomDistance),
                                threshold: Double(bottomProximityThreshold)
                            )
                        } else {
                            // The role-scoped initial anchor can coalesce geometry callbacks during
                            // a fast swipe. Phase geometry is the authoritative clamped position,
                            // including for transcripts too short to move at all.
                            stateChanged = scrollCoordinator.observeGeometry(
                                bottomDistance: Double(bottomDistance),
                                threshold: Double(bottomProximityThreshold)
                            )
                        }
                        if isNearBottom, !wasNearBottom {
                            unseenTracker.markReaderAtBottom()
                            unseenCount = 0
                        }
                        if stateChanged {
                            recordReadingPosition()
                        }
                    }
                    .onScrollTargetVisibilityChange(
                        idType: String.self,
                        threshold: 0.01
                    ) { identifiers in
                        if visibleEntryIDs != identifiers {
                            visibleEntryIDs = identifiers
                        }
                        if let restorationTargetEventID,
                           restorationScrollPerformed,
                           identifiers.contains(restorationTargetEventID) {
                            finishReadingPositionRestoration()
                        }
                        recordReadingPosition()
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if !isNearBottom {
                            scrollToBottomButton {
                                requestScroll(
                                    to: .bottom,
                                    source: .userLatest,
                                    animated: true
                                )
                            }
                            .padding(.trailing, 16)
                            .padding(.bottom, 12)
                            .transition(
                                reduceMotion
                                    ? .identity
                                    : .move(edge: .bottom).combined(with: .opacity)
                            )
                        }
                    }

                bottomControls(
                    queuedEntries: queuedEntries,
                    onThinkingTap: revealLiveReasoning
                )
            }
            .animation(
                reduceMotion ? nil : .easeOut(duration: 0.2),
                value: isNearBottom
            )
            .task(id: renderedScrollRevision) {
                // Unlike onChange, an id-scoped task also runs for the value installed with a
                // newly rendered transcript. A newer revision cancels this task before the
                // coordinator is consumed, coalescing same-turn producers at one boundary.
                await Task.yield()
                guard !Task.isCancelled,
                      renderedScrollRevision == scrollContentRevision else { return }
                guard let request = scrollCoordinator.takePendingRequest() else { return }
                performScroll(to: request, with: proxy)
                }
            }
        }
        .navigationBarBackButtonHidden(true)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(CompanionIOSTheme.canvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar { headerToolbar }
        .navigationDestination(isPresented: $showingComputer) {
            CompanionComputerView(
                companion: currentCompanion,
                openDesktop: services?.openDesktop
            )
        }
        .sheet(item: $selectedToolDetail) { route in
            CompanionToolRunDetailView(tool: route.tool, timestamp: route.timestamp)
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
        }
        .sheet(item: $routineHistoryTarget) { target in
            NavigationStack {
                CompanionRoutineHistoryView(
                    companionID: currentCompanion.id,
                    target: target,
                    services: routineHistoryServices
                )
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Done") { routineHistoryTarget = nil }
                    }
                }
            }
        }
        .task(id: companion.id) {
            // Subscribe before the initial delta sync. A retained notification is subsumed by that
            // sync, while notifications arriving during it remain buffered for a follow-up sync.
            let invalidations = sessionStore.companionInvalidations(
                companionID: companion.id,
                replayPending: false
            )
            await reload(silently: thread != nil)
            let polling = Task { @MainActor in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(4))
                    if !Task.isCancelled { await reloadInBackground() }
                }
            }
            defer { polling.cancel() }
            for await _ in invalidations {
                guard !Task.isCancelled else { continue }
                await reloadInBackground()
            }
        }
        .onAppear { recordTranscriptFrameIfAvailable() }
        .onChange(of: thread != nil) { _, available in
            if available { recordTranscriptFrameIfAvailable() }
        }
        .task(id: decisionCatalogTaskID) {
            guard decisionCatalogTaskID != nil else { return }
            await loadDecisionCatalog()
        }
        .onChange(of: companion) {
            guard currentCompanion.id != companion.id else {
                if currentCompanion != companion {
                    currentCompanion = companion
                }
                return
            }
            recordReadingPosition()
            currentCompanion = companion
            pendingReadingPosition = readingPosition
            resetTranscriptState()
        }
        .onDisappear { recordReadingPosition() }
        .onChange(of: liveReasoningEventID) { oldValue, newValue in
            if oldValue != newValue, let oldValue {
                expandedReasoningEventIDs.remove(oldValue)
            }
        }
        .onDisappear {
            cancelAssistantTailReveal()
        }
    }

    @ToolbarContentBuilder
    private var headerToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            chatHeaderButton(
                systemImage: "chevron.left",
                label: "Back",
                action: { dismiss() }
            )
            .accessibilityIdentifier("chat.back")
        }

        ToolbarItem(placement: .principal) {
            Button(action: onDetails) {
                HStack(spacing: 8) {
                    CharacterMark(
                        name: currentCompanion.name,
                        icon: currentCompanion.icon,
                        size: 20
                    )
                    Text(currentCompanion.name)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                        .lineLimit(1)
                        .layoutPriority(1)
                    CompanionStatusDot(runtime: currentCompanion.runtime)
                }
                .padding(.leading, 10)
                .padding(.trailing, 10)
                .frame(minHeight: 36)
                .background(CompanionIOSTheme.card, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                "\(currentCompanion.name), \(currentStatus.accessibilityLabel). Opens details."
            )
            .accessibilityIdentifier("chat.details")
        }

        ToolbarItemGroup(placement: .topBarTrailing) {
            if currentCompanion.access != .viewer {
                chatHeaderButton(
                    systemImage: "desktopcomputer",
                    label: "Open \(currentCompanion.name)'s computer",
                    action: { showingComputer = true }
                )
                .disabled(currentCompanion.runtime.state != .running)
                .accessibilityHint(
                    currentCompanion.runtime.state == .running
                        ? "Opens the live Box screen."
                        : "Send a message to start the Companion first."
                )
            }
        }
    }

    private var currentStatus: CompanionStatusIndicatorState {
        CompanionStatusIndicatorState(runtime: currentCompanion.runtime)
    }

    private func chatHeaderButton(
        systemImage: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .foregroundStyle(CompanionIOSTheme.textPrimary)
        .accessibilityLabel(label)
    }

    private var loadEarlierButton: some View {
        Button {
            Task { await loadEarlier() }
        } label: {
            Group {
                if loadingEarlier {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Label("Load earlier messages", systemImage: "arrow.up")
                }
            }
            .font(.caption.weight(.semibold))
            .frame(minHeight: 44)
            .padding(.horizontal, 14)
        }
        .buttonStyle(.glass)
        .tint(visualTheme.accent)
        .disabled(loadingEarlier)
        .accessibilityLabel("Load earlier messages")
        .accessibilityIdentifier("chat.load-earlier")
    }

    private func scrollToBottomButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: unseenCount > 0 ? 8 : 0) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: unseenCount > 0 ? nil : 46, height: 46)
                if unseenCount > 0 {
                    Text(unseenMessage(count: unseenCount))
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                }
            }
            .frame(minHeight: 46)
            .padding(.horizontal, unseenCount > 0 ? 14 : 0)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(unseenCount > 0 ? .capsule : .circle)
        .tint(visualTheme.accent)
        .accessibilityLabel(
            unseenCount > 0
                ? "\(unseenMessage(count: unseenCount)). Scroll to latest message"
                : "Scroll to latest message"
        )
        .accessibilityValue(unseenCount > 0 ? unseenMessage(count: unseenCount) : "")
        .accessibilityHint("Double tap to scroll to the latest message.")
        .accessibilityIdentifier("chat.scroll-to-bottom")
    }

    private func unseenMessage(count: Int) -> String {
        count == 1 ? "1 new reply" : "\(count) new replies"
    }

    private func dayMarker(for date: Date) -> some View {
        Text(dayLabel(for: date))
            .font(.caption)
            .foregroundStyle(CompanionIOSTheme.textSecondary)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("chat.day-marker.\(dayLabel(for: date))")
    }

    private func transcriptSpacing(after previous: TranscriptEntry?, before current: TranscriptEntry) -> CGFloat {
        CGFloat(
            CompanionChatBubbleLayout.spacing(
                after: previous.map(transcriptBubbleKind),
                before: transcriptBubbleKind(current)
            )
        )
    }

    private func previousTranscriptEntry(
        in items: [CompanionTranscriptDisplayItem],
        before index: Int
    ) -> TranscriptEntry? {
        guard index > 0 else { return nil }
        return items[..<index].reversed().compactMap { $0.transcriptEntry }.first
    }

    private func nextTranscriptEntry(
        in items: [CompanionTranscriptDisplayItem],
        after index: Int
    ) -> TranscriptEntry? {
        guard index + 1 < items.count else { return nil }
        return items[(index + 1)...].compactMap { $0.transcriptEntry }.first
    }

    private func isRoutineNotifyDisclosure(_ item: CompanionTranscriptDisplayItem) -> Bool {
        if case .routineNotifyDisclosure = item.kind { return true }
        return false
    }

    private func routineNotifyDisclosureSpacing(
        after previous: TranscriptEntry?,
        before next: TranscriptEntry?,
        index: Int
    ) -> CGFloat {
        guard let next else { return index == 0 ? 0 : 8 }
        return index == 0 ? 0 : transcriptSpacing(after: previous, before: next)
    }

    private func transcriptBubbleKind(_ entry: TranscriptEntry) -> CompanionChatBubbleKind {
        if entry.decision != nil { return .card }
        if entry.role == "tool" { return .tool }
        if entry.role == "assistant" { return .assistant }
        if entry.role == "user", entry.authorID == thread?.viewerID { return .mine }
        return .member
    }

    private func unavailableState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Conversation unavailable", systemImage: "exclamationmark.bubble")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await reload() } }
                .buttonStyle(.glassProminent)
                .tint(visualTheme.accent)
        }
        .padding(.top, 60)
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            CharacterMark(name: currentCompanion.name, icon: currentCompanion.icon, size: 76)
            VStack(spacing: 6) {
                Text("Start the conversation")
                    .font(.title3.weight(.semibold))
                Text("Send the first message to wake \(currentCompanion.name).")
                    .font(.subheadline)
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }
        }
        .padding(28)
        .companionGlass(radius: 18)
        .padding(.top, 56)
    }

    @ViewBuilder
    private func bottomControls(
        queuedEntries: [TranscriptEntry],
        onThinkingTap: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 8) {
            if !queuedEntries.isEmpty {
                CompanionQueuedMessagesView(
                    entries: queuedEntries,
                    canManage: thread?.canSend == true,
                    viewerID: thread?.viewerID,
                    accent: visualTheme.accent,
                    onRemove: cancelTurn
                )
                .padding(.horizontal, 12)
            }

            ChatComposer(
                companionID: currentCompanion.id,
                companionName: currentCompanion.name,
                companionIcon: currentCompanion.icon,
                canSend: verifiedCanSend,
                transcriptionAvailable: thread?.transcriptionAvailable == true,
                isReplying: isReplying,
                hasLiveReasoning: liveReasoningEventID != nil,
                error: thread == nil ? nil : error,
                sending: sending,
                accent: visualTheme.accent,
                accentForeground: visualTheme.accentForeground,
                canAutomaticallyFocus: {
                    inputFocusCoordinator.allowsAutomaticComposerFocus
                },
                onFocusChange: { focused in
                    if focused {
                        inputFocusCoordinator.userFocused(.composer)
                    } else {
                        inputFocusCoordinator.userBlurred(.composer)
                    }
                },
                onThinkingTap: onThinkingTap,
                onSend: send(content:attachments:)
            )
        }
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: currentCompanion.icon)
    }

    private var routineHistoryServices: CompanionRoutineHistoryServices? {
        guard let services else { return nil }
        let companionID = currentCompanion.id
        let listRuns: ((String, Int, String?) async throws -> CompanionRoutineRunList)? = services.listRoutineRuns.map { loader in
            { routineID, limit, cursor in
                try await loader(companionID, routineID, limit, cursor)
            }
        }
        let readRun: ((String, Int, Int?) async throws -> CompanionRoutineRunDetail)? = services.readRoutineRun.map { loader in
            { runID, limit, cursor in
                try await loader(companionID, runID, limit, cursor)
            }
        }
        return CompanionRoutineHistoryServices(listRuns: listRuns, readRun: readRun)
    }

    private var isNearBottom: Bool {
        scrollCoordinator.isFollowingTail
    }

    private var isReplying: Bool {
        guard let thread else { return currentCompanion.runtime.replying }
        return thread.activeTurn?.replying == true
    }

    private var liveReasoningEventID: String? {
        guard isReplying,
              let attemptID = thread?.activeTurn?.latestAttempt?.id.lowercased() else {
            return nil
        }
        let eventPrefix = "v2:\(attemptID):"
        return entries.last(where: { entry in
            entry.role == "assistant"
                && entry.eventID.lowercased().hasPrefix(eventPrefix)
                && nonEmptyReasoning(entry.reasoning)
        })?.eventID
    }

    private func nonEmptyReasoning(_ value: String?) -> Bool {
        guard let value else { return false }
        return !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func decisionAnswerFocusChanged(
        _ focused: Bool,
        requestID: String,
        eventID: String
    ) {
        let input = CompanionChatInputFocus.decision(requestID: requestID)
        if focused {
            inputFocusCoordinator.userFocused(input)
            requestScroll(
                to: .entry(eventID),
                source: .inputFocus,
                animated: false
            )
        } else {
            inputFocusCoordinator.userBlurred(input)
        }
    }

    private func setReasoningExpanded(_ isExpanded: Bool, for eventID: String) {
        if isExpanded {
            expandedReasoningEventIDs.insert(eventID)
        } else {
            expandedReasoningEventIDs.remove(eventID)
        }
    }

    private func toggleRoutineNotifyDisclosure(for latestAssistantEventID: String) {
        let update = {
            if expandedRoutineNotifyEventIDs.contains(latestAssistantEventID) {
                expandedRoutineNotifyEventIDs.remove(latestAssistantEventID)
            } else {
                expandedRoutineNotifyEventIDs.insert(latestAssistantEventID)
            }
        }
        if reduceMotion {
            update()
        } else {
            withAnimation(.easeInOut(duration: 0.2)) {
                update()
            }
        }
    }

    private func transcriptRowInput(for entry: TranscriptEntry) -> TranscriptRowInput {
        TranscriptRowInput(
            entry: entry,
            own: entry.role == "user" && entry.authorID == thread?.viewerID,
            companionID: currentCompanion.id,
            companionName: currentCompanion.name,
            companionIcon: currentCompanion.icon,
            markdown: markdownByEventID[entry.eventID]?.document,
            tailReveal: assistantTailReveal?.eventID == entry.eventID
                ? assistantTailReveal
                : nil,
            reasoningExpanded: expandedReasoningEventIDs.contains(entry.eventID),
            canAct: thread?.canSend == true
                && (entry.decision?.requiredAccess != .owner || currentCompanion.access == .owner),
            decisionCatalog: entry.decision == nil ? .empty : decisionCatalog
        )
    }

    private func revealLiveReasoning() {
        guard let eventID = liveReasoningEventID else { return }
        if reduceMotion {
            expandedReasoningEventIDs.insert(eventID)
            requestScroll(
                to: .entry(eventID),
                source: .reasoning,
                animated: false
            )
        } else {
            withAnimation(.easeInOut(duration: 0.2)) {
                expandedReasoningEventIDs.insert(eventID)
            }
            requestScroll(
                to: .entry(eventID),
                source: .reasoning,
                animated: true
            )
        }
    }

    private func reload(silently: Bool = false, isPolling: Bool = false) async {
        if silently, loadingEarlier { return }
        // A navigation/manual reload returns to the deterministic collapsed projection. Background
        // polling keeps an open disclosure usable while the same grouped entry remains on screen.
        if !isPolling {
            expandedRoutineNotifyEventIDs.removeAll()
            cancelAssistantTailReveal()
        }
        let generation = refreshGate.begin()
        let previousThread = threadProjection.thread
        let hasPreviousThread = previousThread != nil
        if !silently { loading = true }
        do {
            let next: CompanionThread
            if let services {
                next = try await services.thread(companion.id)
            } else {
                let measurement = try await sessionStore.synchronizeThread(
                    companionID: companion.id,
                    markRead: true
                )
                next = measurement.value.thread
                CompanionPerformanceTelemetry.syncCompleted(
                    surface: "thread",
                    bytes: measurement.receivedBytes,
                    milliseconds: measurement.networkMilliseconds
                )
            }
            guard refreshGate.accepts(generation) else { return }
            let nextHistoryIsPartial = services == nil
                ? sessionStore.cachedThread(companionID: companion.id)?.isPartial == true
                : false
            if historyIsPartial != nextHistoryIsPartial {
                historyIsPartial = nextHistoryIsPartial
            }
            reconcileInputFocus(from: previousThread, to: next)
            let readerWasNearBottom = isNearBottom

            let previousEntries = previousThread.map { transcriptEntries(in: $0) } ?? []
            let nextEntries = transcriptEntries(in: next)
            if isPolling {
                let currentGroupEventIDs = Set(nextEntries.compactMap { entry in
                    entry.routineNotifyGroup == nil ? nil : entry.eventID
                })
                expandedRoutineNotifyEventIDs.formIntersection(currentGroupEventIDs)
            }
            var nextWindow = transcriptWindow
            let restoration = previousThread == nil ? pendingReadingPosition : nil
            let restorationAnchorIndex = restoration.flatMap { position in
                nextEntries.firstIndex { $0.eventID == position.anchorEventID }
            }
            if let restoration, !restoration.isFollowingTail, let restorationAnchorIndex {
                nextWindow.restore(
                    totalCount: nextEntries.count,
                    previouslyExposedCount: restoration.exposedEntryCount,
                    previousTotalCount: restoration.transcriptEntryCount,
                    anchorIndex: restorationAnchorIndex
                )
            } else {
                nextWindow.refresh(
                    totalCount: nextEntries.count,
                    preservingCurrentEntries: !readerWasNearBottom
                )
            }
            let visibleRange = nextWindow.visibleRange(for: nextEntries.count)
            let pollDiff = CompanionTranscriptPollDiff(
                previous: previousEntries,
                next: nextEntries,
                nextVisibleRange: visibleRange
            )
            let transcriptChanged = previousThread == nil || !pollDiff.isIdentical
            let visibleTranscriptChanged = previousThread == nil
                || markdownByEventID.isEmpty
                || pollDiff.hasVisibleChanges
                || transcriptWindow != nextWindow
            let renderedMarkdown = visibleTranscriptChanged
                ? await renderedMarkdown(for: Array(nextEntries[visibleRange]))
                : markdownByEventID
            guard refreshGate.accepts(generation) else { return }

            let tailChange = isPolling
                ? assistantTailChange(from: previousThread, to: next)
                : nil
            let tailBaseMarkdown = tailChange.flatMap {
                markdownByEventID[$0.eventID]?.document
            }

            let persistedEventIDs = Set(next.entries.map(\.eventID))
            let reconciledPendingMessages = pendingMessages.filter { pending in
                !persistedEventIDs.contains("msg:\(pending.id.uuidString.lowercased())")
            }
            let pendingChanged = reconciledPendingMessages.count != pendingMessages.count
            if pendingChanged {
                pendingMessages = reconciledPendingMessages
            }
            let restorationTarget = restoration.flatMap { position -> String? in
                guard !position.isFollowingTail, restorationAnchorIndex != nil else { return nil }
                return position.anchorEventID
            }
            if transcriptWindow != nextWindow {
                transcriptWindow = nextWindow
            }
            if !markdownCachesEqual(markdownByEventID, renderedMarkdown) {
                markdownByEventID = renderedMarkdown
            }
            if previousThread != next {
                threadProjection.update(next)
            }
            let tailChanged = observeActualTail(
                of: next,
                source: hasPreviousThread ? .poll : .initial
            )
            let readerIsNearBottom = isNearBottom
            if transcriptChanged {
                var nextUnseenTracker = unseenTracker
                let nextUnseenCount = nextUnseenTracker.observe(
                    entries: nextEntries,
                    isNearBottom: readerIsNearBottom
                )
                if nextUnseenTracker != unseenTracker {
                    unseenTracker = nextUnseenTracker
                }
                if nextUnseenCount != unseenCount {
                    unseenCount = nextUnseenCount
                }
            }
            let shouldFollowTail = !loadingEarlier
                && previousThread != nil
                && tailChanged
                && readerIsNearBottom
            refreshSelectedToolDetail(from: next.entries)
            if !threadAuthorityVerified {
                threadAuthorityVerified = true
            }
            if error != nil {
                error = nil
            }
            if let restorationTarget {
                if !isRestoringReadingPosition {
                    isRestoringReadingPosition = true
                }
                if restorationTargetEventID != restorationTarget {
                    restorationTargetEventID = restorationTarget
                }
                restorationScrollPerformed = false
                requestScroll(
                    to: .entry(restorationTarget),
                    source: .restoration,
                    animated: false
                )
            } else {
                if pendingReadingPosition != nil {
                    pendingReadingPosition = nil
                }
                if isRestoringReadingPosition {
                    isRestoringReadingPosition = false
                }
                if restorationTargetEventID != nil {
                    restorationTargetEventID = nil
                }
                restorationScrollPerformed = false
                if restoration != nil, restorationAnchorIndex == nil {
                    scrollCoordinator.setFollowState(.followingTail)
                }
            }
            if isPolling {
                if let tailChange {
                    startAssistantTailReveal(
                        for: tailChange,
                        baseMarkdown: tailBaseMarkdown,
                        followTail: shouldFollowTail
                    )
                } else {
                    cancelAssistantTailReveal()
                }
            }
        } catch is CancellationError {
            return
        } catch {
            guard refreshGate.accepts(generation) else { return }
            self.error = "The conversation could not be refreshed."
        }

        let refreshed: CompanionSummary?
        if let services {
            refreshed = try? await services.listCompanions().first(where: { $0.id == companion.id })
        } else {
            refreshed = nil
        }
        if let refreshed {
            guard refreshGate.accepts(generation) else { return }
            if currentCompanion != refreshed {
                currentCompanion = refreshed
            }
        }
        if refreshGate.accepts(generation), loading {
            loading = false
        }
    }

    private func reloadInBackground() async {
        guard refreshGate.beginBackgroundRefresh() else { return }
        while !Task.isCancelled {
            await reload(silently: true, isPolling: true)
            guard !Task.isCancelled else {
                refreshGate.cancelBackgroundRefresh()
                return
            }
            guard refreshGate.completeBackgroundRefresh() else { return }
        }
        refreshGate.cancelBackgroundRefresh()
    }

    private func renderedMarkdown(
        for entries: [TranscriptEntry]
    ) async -> [String: CachedMarkdownDocument] {
        let projectedEntries = entries.flatMap { entry in
            [entry] + (entry.routineNotifyGroup?.hiddenEntries ?? [])
        }
        let sources = projectedEntries.lazy
            .filter { $0.role == "assistant" || $0.role == "user" }
            .map { MarkdownDocumentSource(eventID: $0.eventID, content: $0.content) }
        return await MarkdownDocumentRenderer.render(
            sources: Array(sources),
            reusing: markdownByEventID
        )
    }

    private func markdownCachesEqual(
        _ lhs: [String: CachedMarkdownDocument],
        _ rhs: [String: CachedMarkdownDocument]
    ) -> Bool {
        guard lhs.count == rhs.count else { return false }
        return lhs.allSatisfy { eventID, cached in
            guard let other = rhs[eventID] else { return false }
            return cached.source == other.source && cached.document == other.document
        }
    }

    private func assistantTailChange(
        from previous: CompanionThread?,
        to next: CompanionThread
    ) -> AssistantTailChange? {
        guard let previous,
              next.activeTurn?.replying == true else {
            return nil
        }

        let previousEntries = transcriptEntries(in: previous)
        let nextEntries = transcriptEntries(in: next)
        guard let nextTail = nextEntries.last,
              nextTail.role == "assistant",
              !nextTail.content.isEmpty else {
            return nil
        }

        if let previousTail = previousEntries.last,
           previousTail.eventID == nextTail.eventID,
           nextTail.content.count > previousTail.content.count,
           nextTail.content.hasPrefix(previousTail.content) {
            return AssistantTailChange(
                eventID: nextTail.eventID,
                previousContent: previousTail.content,
                nextContent: nextTail.content
            )
        }

        let previousIDs = Set(previousEntries.map(\.eventID))
        guard !previousIDs.contains(nextTail.eventID),
              nextEntries.count > previousEntries.count,
              nextTail.ordinal > (previousEntries.last?.ordinal ?? Int.min) else {
            return nil
        }
        return AssistantTailChange(
            eventID: nextTail.eventID,
            previousContent: "",
            nextContent: nextTail.content
        )
    }

    private func startAssistantTailReveal(
        for change: AssistantTailChange,
        baseMarkdown: MarkdownDocument?,
        followTail: Bool
    ) {
        assistantTailRevealTask?.cancel()
        guard change.nextContent.hasPrefix(change.previousContent),
              change.nextContent != change.previousContent else {
            assistantTailReveal = nil
            assistantTailRevealTask = nil
            return
        }

        guard !reduceMotion else {
            assistantTailReveal = nil
            assistantTailRevealTask = nil
            return
        }

        let revealID = UUID()
        let delta = String(change.nextContent.dropFirst(change.previousContent.count))
        let deltaCharacters = delta.count
        assistantTailReveal = AssistantTailReveal(
            id: revealID,
            eventID: change.eventID,
            baseMarkdown: baseMarkdown,
            visibleDelta: "",
            followsTail: followTail
        )

        let task = Task { @MainActor in
            // Eight short updates keep the reveal near 200ms while making cancellation cheap.
            for step in 1...8 {
                do {
                    try await Task.sleep(for: .milliseconds(25))
                } catch {
                    return
                }
                guard let reveal = assistantTailReveal, reveal.id == revealID else { return }
                let characterCount = deltaCharacters * step / 8
                assistantTailReveal = AssistantTailReveal(
                    id: revealID,
                    eventID: change.eventID,
                    baseMarkdown: baseMarkdown,
                    visibleDelta: String(delta.prefix(characterCount)),
                    followsTail: reveal.followsTail
                )
            }

            guard let completedReveal = assistantTailReveal,
                  completedReveal.id == revealID else { return }
            assistantTailReveal = nil
            assistantTailRevealTask = nil
            if completedReveal.followsTail, isNearBottom, !loadingEarlier {
                // Text height can grow after the original follow-tail scroll. Re-anchor once the
                // final markdown document is restored so a reader following the tail is not left
                // just above the bottom.
                requestScroll(
                    to: .bottom,
                    source: .poll,
                    animated: false
                )
            }
        }
        assistantTailRevealTask = task
    }

    private func stopFollowingTailForReveal() {
        guard var reveal = assistantTailReveal, reveal.followsTail else { return }
        reveal.followsTail = false
        assistantTailReveal = reveal
    }

    private func cancelAssistantTailReveal() {
        guard assistantTailRevealTask != nil || assistantTailReveal != nil else { return }
        assistantTailRevealTask?.cancel()
        assistantTailRevealTask = nil
        assistantTailReveal = nil
    }

    private var entries: [TranscriptEntry] {
        guard let thread else { return [] }
        let visibleTranscript = transcriptEntries(in: thread)
        return Array(
            visibleTranscript[transcriptWindow.visibleRange(for: visibleTranscript.count)]
        )
    }

    private func transcriptEntries(in thread: CompanionThread?) -> [TranscriptEntry] {
        guard let thread else { return [] }
        return thread.entries
            .filter { !$0.queued }
            .sorted(by: transcriptOrder)
    }

    private func reconcileInputFocus(
        from previousThread: CompanionThread?,
        to nextThread: CompanionThread
    ) {
        let previous = pendingDecisionRequestIDs(in: previousThread)
        let next = pendingDecisionRequestIDs(in: nextThread)
        for requestID in next.subtracting(previous) {
            inputFocusCoordinator.pendingDecisionAppeared(requestID: requestID)
        }
        for requestID in previous.subtracting(next) {
            inputFocusCoordinator.decisionSettled(requestID: requestID)
        }
    }

    private func pendingDecisionRequestIDs(in thread: CompanionThread?) -> Set<String> {
        Set((thread?.entries ?? []).compactMap { entry in
            guard entry.decision?.status == .pending else { return nil }
            return entry.decision?.requestID
        })
    }

    private func queuedEntries(in thread: CompanionThread?) -> [TranscriptEntry] {
        guard let thread else { return [] }
        return thread.entries
            .filter(\.queued)
            .sorted(by: transcriptOrder)
    }

    private func transcriptOrder(_ lhs: TranscriptEntry, _ rhs: TranscriptEntry) -> Bool {
        lhs.ordinal == rhs.ordinal ? lhs.eventID < rhs.eventID : lhs.ordinal < rhs.ordinal
    }

    private func refreshSelectedToolDetail(from entries: [TranscriptEntry]) {
        guard let selectedToolDetail else { return }
        guard let entry = entries.first(where: { $0.eventID == selectedToolDetail.id }),
              let tool = entry.tool else {
            self.selectedToolDetail = nil
            return
        }
        let nextRoute = ToolRunDetailRoute(
            id: entry.eventID,
            tool: tool,
            timestamp: toolTimestamp(for: entry)
        )
        guard selectedToolDetail.id != nextRoute.id
                || selectedToolDetail.tool != nextRoute.tool
                || selectedToolDetail.timestamp != nextRoute.timestamp else {
            return
        }
        self.selectedToolDetail = nextRoute
    }

    private func toolTimestamp(for entry: TranscriptEntry) -> String? {
        guard let date = parseCompanionTimestamp(entry.createdAt) else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
    }

    private var thread: CompanionThread? {
        threadProjection.thread
    }

    private var verifiedCanSend: Bool? {
        CompanionThreadSendCapability.resolve(
            thread: thread,
            serverVerified: threadAuthorityVerified
        )
    }

    private func recordTranscriptFrameIfAvailable() {
        guard let thread else { return }
        CompanionPerformanceTelemetry.transcriptWillRender(
            companionID: companion.id,
            entryCount: thread.entries.count,
            cached: renderedFromCache
        )
    }

    private var decisionCatalogTaskID: String? {
        entries.contains { entry in
            guard let decision = entry.decision else { return false }
            return decision.kind == .config
        } ? companion.id : nil
    }

    private var pendingStartsNewDay: Bool {
        guard let last = entries.last(where: { !$0.queued }),
              let date = transcriptDate(last.createdAt) else { return true }
        return !Calendar.autoupdatingCurrent.isDateInToday(date)
    }
    private func startsNewDay(_ entry: TranscriptEntry, after previous: TranscriptEntry?) -> Bool {
        guard let previous else { return true }
        guard let date = transcriptDate(entry.createdAt),
              let previousDate = transcriptDate(previous.createdAt) else { return true }
        return !Calendar.autoupdatingCurrent.isDate(date, inSameDayAs: previousDate)
    }

    private func dayLabel(for date: Date) -> String {
        let calendar = Calendar.autoupdatingCurrent
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if calendar.component(.year, from: date) == calendar.component(.year, from: .now) {
            return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day().year())
    }

    private func transcriptDate(_ value: String) -> Date? {
        parseCompanionTimestamp(value)
    }

    @discardableResult
    private func observeActualTail(
        of thread: CompanionThread,
        source: CompanionScrollRequestSource
    ) -> Bool {
        let previousRequest = scrollCoordinator.pendingRequest
        let changed = scrollCoordinator.observeTail(of: thread, source: source)
        if previousRequest != scrollCoordinator.pendingRequest {
            scrollContentRevision &+= 1
        }
        return changed
    }

    private func loadEarlier() async {
        guard !loadingEarlier,
              transcriptWindow.hasEarlierEntries || historyIsPartial,
              let firstEventID = entries.first?.eventID,
              var snapshot = thread else { return }

        var expandedWindow = transcriptWindow
        cancelAssistantTailReveal()
        loadingEarlier = true
        refreshGate.invalidate()
        if !expandedWindow.hasEarlierEntries, historyIsPartial {
            do {
                let olderThread: CompanionThread
                let olderIsPartial: Bool
                if let services {
                    olderThread = try await services.thread(companion.id)
                    olderIsPartial = false
                } else {
                    guard let page = try await sessionStore.loadOlderThreadWindow(
                        companionID: companion.id
                    ) else {
                        historyIsPartial = false
                        loadingEarlier = false
                        return
                    }
                    olderThread = page.value.thread
                    olderIsPartial = page.value.isPartial
                    CompanionPerformanceTelemetry.syncCompleted(
                        surface: "thread-history",
                        bytes: page.receivedBytes,
                        milliseconds: page.networkMilliseconds
                    )
                }
                guard thread?.entries == snapshot.entries else {
                    loadingEarlier = false
                    return
                }
                snapshot = olderThread
                historyIsPartial = olderIsPartial
                threadProjection.update(olderThread)
                expandedWindow.revealCompleteHistory(
                    totalCount: transcriptEntries(in: olderThread).count
                )
            } catch {
                self.error = error.localizedDescription
                loadingEarlier = false
                return
            }
        }
        guard expandedWindow.loadEarlier() else {
            loadingEarlier = false
            return
        }
        let snapshotEntries = transcriptEntries(in: snapshot)
        let visibleRange = expandedWindow.visibleRange(for: snapshotEntries.count)
        let renderedMarkdown = await renderedMarkdown(
            for: Array(snapshotEntries[visibleRange])
        )
        guard thread?.entries == snapshot.entries else {
            loadingEarlier = false
            return
        }

        if !markdownCachesEqual(markdownByEventID, renderedMarkdown) {
            markdownByEventID = renderedMarkdown
        }
        if transcriptWindow != expandedWindow {
            transcriptWindow = expandedWindow
        }
        requestScroll(
            to: .entry(firstEventID),
            source: .loadEarlier,
            animated: false
        )
    }

    private func requestScroll(
        to destination: CompanionScrollDestination,
        source: CompanionScrollRequestSource,
        animated: Bool
    ) {
        if case .bottom = destination {
            guard !loadingEarlier else { return }
            pendingReadingPosition = nil
            isRestoringReadingPosition = false
            restorationTargetEventID = nil
            if source == .userLatest {
                unseenTracker.markReaderAtBottom()
                unseenCount = 0
            }
        }
        scrollCoordinator.request(
            CompanionScrollRequest(
                destination: destination,
                source: source,
                animated: animated
            )
        )
        scrollContentRevision &+= 1
    }

    private func recordReadingPosition() {
        guard !isRestoringReadingPosition, !loadingEarlier, let thread else { return }
        let transcript = transcriptEntries(in: thread)
        let visibleIDs = Set(visibleEntryIDs)
        guard let anchor = transcript.first(where: { visibleIDs.contains($0.eventID) }) else {
            return
        }
        let position = CompanionChatReadingPosition(
            anchorEventID: anchor.eventID,
            isFollowingTail: isNearBottom,
            exposedEntryCount: transcriptWindow.exposedCount,
            transcriptEntryCount: transcript.count
        )
        guard position != lastReportedReadingPosition else { return }
        lastReportedReadingPosition = position
        onReadingPositionChange(position)
    }

    private func performScroll(
        to request: CompanionScrollRequest,
        with proxy: ScrollViewProxy
    ) {
        switch request.destination {
        case .bottom:
            let targetID = bottomScrollTargetID
            if reduceMotion || !request.animated {
                proxy.scrollTo(targetID, anchor: .bottom)
            } else {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(targetID, anchor: .bottom)
                }
            }
        case .entry(let eventID):
            let anchor: UnitPoint = request.source == .reasoning ? .center : .top
            if reduceMotion || !request.animated {
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    proxy.scrollTo(eventID, anchor: anchor)
                }
            } else {
                withAnimation(.easeInOut(duration: 0.2)) {
                    proxy.scrollTo(eventID, anchor: anchor)
                }
            }
            if request.source == .restoration {
                restorationScrollPerformed = true
            }
            if restorationTargetEventID == eventID {
                Task { @MainActor in
                    await Task.yield()
                    await Task.yield()
                    if restorationTargetEventID == eventID {
                        finishReadingPositionRestoration()
                    }
                }
            } else {
                pendingReadingPosition = nil
                isRestoringReadingPosition = false
            }
            loadingEarlier = false
        }
    }

    private var bottomScrollTargetID: String {
        if let pending = pendingMessages.last {
            return "pending-\(pending.id)"
        }
        if let interruptedTurn = thread?.interruptedTurn {
            return "interrupted-\(interruptedTurn.id)"
        }
        return entries.last?.id ?? "bottom"
    }

    private var transcriptScrollDiagnostics: String {
        guard ProcessInfo.processInfo.arguments.contains(
            "-companion-transcript-window-demo"
        ) else { return "" }
        return [
            "revision=\(scrollContentRevision)",
            "pending=\(scrollCoordinator.pendingRequest?.source.rawValue ?? "none")",
            "batches=\(scrollCoordinator.issuedRequestBatchCount)",
            "outstanding=\(scrollCoordinator.isProgrammaticBottomScrollOutstanding)",
            "follow=\(scrollCoordinator.followState.rawValue)",
            "target=\(bottomScrollTargetID)",
        ].joined(separator: ";")
    }

    private var transcriptScrollIdentity: String {
        "\(currentCompanion.id)-\(thread == nil ? "loading" : "loaded")"
    }

    private func finishReadingPositionRestoration() {
        restorationTargetEventID = nil
        restorationScrollPerformed = false
        pendingReadingPosition = nil
        isRestoringReadingPosition = false
    }

    private func resetTranscriptState() {
        cancelAssistantTailReveal()
        refreshGate.invalidate()
        threadProjection.reset()
        threadAuthorityVerified = false
        transcriptWindow.reset()
        unseenTracker.reset()
        unseenCount = 0
        pendingMessages = []
        markdownByEventID = [:]
        expandedRoutineNotifyEventIDs = []
        decisionCatalog = .empty
        decisionCatalogLoaded = false
        selectedToolDetail = nil
        inputFocusCoordinator.reset()
        loading = true
        loadingEarlier = false
        historyIsPartial = false
        scrollCoordinator.reset(
            followState: pendingReadingPosition?.isFollowingTail == false
                ? .userReading
                : .followingTail
        )
        visibleEntryIDs = []
        isRestoringReadingPosition = false
        restorationTargetEventID = nil
        restorationScrollPerformed = false
        lastReportedReadingPosition = nil
        scrollContentRevision &+= 1
    }

    private func send(content: String, attachments: [CompanionMessageAttachment]) {
        guard thread?.canSend == true, !content.isEmpty, !sending else { return }
        let message = PendingMessage(
            id: UUID(),
            content: content,
            markdown: MarkdownDocument(markdown: content),
            attachments: attachments,
            failed: false,
            uploadProgress: attachments.isEmpty ? nil : 0
        )
        pendingMessages.append(message)
        if isNearBottom {
            requestScroll(
                to: .bottom,
                source: .localSend,
                animated: true
            )
        }
        sending = true
        error = nil
        Task {
            await sendPending(message.id)
            sending = false
        }
    }

    private func retry(_ id: UUID) {
        guard !sending else { return }
        sending = true
        Task {
            await sendPending(id)
            sending = false
        }
    }

    private func dismiss(_ id: UUID) {
        pendingMessages.removeAll { $0.id == id }
    }

    private func sendPending(_ id: UUID) async {
        guard let index = pendingMessages.firstIndex(where: { $0.id == id }) else { return }
        let message = pendingMessages[index]
        pendingMessages[index].failed = false
        if !message.attachments.isEmpty { pendingMessages[index].uploadProgress = 0 }
        error = nil
        let uploadProgress: (@Sendable (Double) -> Void)?
        if message.attachments.isEmpty {
            uploadProgress = nil
        } else {
            uploadProgress = { progress in
                Task { @MainActor in
                    guard let current = pendingMessages.firstIndex(where: { $0.id == id }) else {
                        return
                    }
                    pendingMessages[current].uploadProgress = progress
                }
            }
        }
        do {
            try await sessionStore.sendMessage(
                companionID: companion.id,
                content: message.content,
                clientMessageID: message.id,
                attachments: message.attachments,
                uploadProgress: uploadProgress
            )
            pendingMessages.removeAll { $0.id == id }
            await reload(silently: true)
        } catch {
            if let current = pendingMessages.firstIndex(where: { $0.id == id }) {
                pendingMessages[current].failed = true
            }
        }
    }

    private func decide(
        requestID: String,
        action: CompanionDecisionAction
    ) async throws {
        let mutationID = "decision:\(requestID)"
        guard await threadMutationGate.acquire(mutationID: mutationID) else { return }
        cancelAssistantTailReveal()
        expandedRoutineNotifyEventIDs.removeAll()
        refreshGate.invalidate()

        do {
            let next: CompanionThread
            if let services {
                next = try await services.decide(companion.id, requestID, action)
            } else {
                next = try await sessionStore.decideCompanionDecision(
                    companionID: companion.id,
                    requestID: requestID,
                    action: action
                )
            }

            refreshGate.invalidate()
            threadProjection.replaceAfterMutation(with: next)
            inputFocusCoordinator.decisionSettled(requestID: requestID)
            _ = observeActualTail(of: next, source: .poll)
            let nextEntries = transcriptEntries(in: next)
            var nextWindow = transcriptWindow
            nextWindow.refresh(totalCount: nextEntries.count)
            let visibleRange = nextWindow.visibleRange(for: nextEntries.count)
            let renderedMarkdown = await renderedMarkdown(
                for: Array(nextEntries[visibleRange])
            )
            if transcriptWindow != nextWindow {
                transcriptWindow = nextWindow
            }
            if !markdownCachesEqual(markdownByEventID, renderedMarkdown) {
                markdownByEventID = renderedMarkdown
            }
            await threadMutationGate.release(mutationID: mutationID)
        } catch {
            refreshGate.invalidate()
            await reload(silently: true)
            await threadMutationGate.release(mutationID: mutationID)
            throw error
        }
    }

    private func cancelTurn(turnID: String) async throws {
        let mutationID = "cancel:\(turnID)"
        guard await threadMutationGate.acquire(mutationID: mutationID) else { return }
        cancelAssistantTailReveal()
        expandedRoutineNotifyEventIDs.removeAll()
        refreshGate.invalidate()
        do {
            let next: CompanionThread
            if let services {
                next = try await services.cancelTurn(companion.id, turnID)
            } else {
                next = try await sessionStore.cancelCompanionTurn(
                    companionID: companion.id,
                    turnID: turnID
                )
            }
            refreshGate.invalidate()
            threadProjection.replaceAfterMutation(with: next)
            _ = observeActualTail(of: next, source: .poll)
            let nextEntries = transcriptEntries(in: next)
            var nextWindow = transcriptWindow
            nextWindow.refresh(totalCount: nextEntries.count)
            let visibleRange = nextWindow.visibleRange(for: nextEntries.count)
            let renderedMarkdown = await renderedMarkdown(
                for: Array(nextEntries[visibleRange])
            )
            if transcriptWindow != nextWindow {
                transcriptWindow = nextWindow
            }
            if !markdownCachesEqual(markdownByEventID, renderedMarkdown) {
                markdownByEventID = renderedMarkdown
            }
            await refreshCompanionProjection()
            await threadMutationGate.release(mutationID: mutationID)
        } catch {
            await reload(silently: true)
            await threadMutationGate.release(mutationID: mutationID)
            throw error
        }
    }

    private func refreshCompanionProjection() async {
        let refreshed: CompanionSummary?
        if let services {
            refreshed = try? await services.listCompanions().first(where: { $0.id == companion.id })
        } else {
            refreshed = try? await sessionStore.listCompanions().first(where: { $0.id == companion.id })
        }
        if let refreshed, currentCompanion != refreshed {
            currentCompanion = refreshed
        }
    }

    private func loadDecisionCatalog() async {
        guard !decisionCatalogLoaded else { return }
        decisionCatalogLoaded = true

        async let skillsResult = loadDecisionSkills()
        async let pluginsResult = loadDecisionPlugins()
        async let providersResult = loadDecisionProviders()
        let (skills, plugins, providers) = await (skillsResult, pluginsResult, providersResult)
        guard !Task.isCancelled else { return }

        decisionCatalog = CompanionDecisionCatalog(
            skills: Dictionary(uniqueKeysWithValues: skills.map { ($0.id, $0.slug) }),
            plugins: Dictionary(uniqueKeysWithValues: plugins.map {
                ($0.id, "\($0.provider) · \($0.label)")
            }),
            models: providers.reduce(into: [String: String]()) { result, provider in
                for model in provider.models { result[model.id] = model.name }
            }
        )
    }

    private func loadDecisionSkills() async -> [CompanionSkillReference] {
        if let services { return (try? await services.listSkills()) ?? [] }
        return (try? await sessionStore.listAccessibleCompanionSkills()) ?? []
    }

    private func loadDecisionPlugins() async -> [CompanionPluginAccount] {
        if let services { return (try? await services.listPlugins()) ?? [] }
        return (try? await sessionStore.listCompanionPlugins()) ?? []
    }

    private func loadDecisionProviders() async -> [CompanionProviderDefinition] {
        let response: CompanionProvidersResponse?
        if let services {
            response = try? await services.listProviders()
        } else {
            response = try? await sessionStore.listCompanionProviders()
        }
        return response?.catalog ?? []
    }

}

struct ChatMessageBubble: View {
    enum Kind: Equatable {
        case mine
        case assistant
        case member
    }

    let content: String
    let kind: Kind
    var authorName: String?
    var timestamp: String?
    var queued = false
    var companionName = "Companion"
    var companionID: String?
    var icon: CompanionSummary.Icon?
    var markdown: MarkdownDocument?
    var streamingBaseMarkdown: MarkdownDocument? = nil
    var streamingDelta: String? = nil
    var reasoning: String? = nil
    var reasoningExpansion: Binding<Bool>? = nil
    var attachments: [CompanionAttachment] = []
    var localAttachments: [CompanionMessageAttachment] = []

    @State private var localReasoningExpanded = false

    @ViewBuilder
    var body: some View {
        if kind == .assistant || markdown?.containsInteractiveLink == true {
            row.accessibilityElement(children: .contain)
        } else {
            row.accessibilityElement(children: .combine)
        }
    }

    private var row: some View {
        ChatBubbleRowLayout(
            alignment: CompanionChatBubbleLayout.alignment(for: layoutKind)
        ) {
            bubble
        }
        .companionMessageInteractionMenu(rawContent: content)
    }

    @ViewBuilder
    private var bubble: some View {
        let contentView = VStack(alignment: .leading, spacing: 6) {
            if kind == .member, let authorName {
                Text(authorName)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(secondaryTextColor)
            }

            if kind == .assistant, let reasoning = displayReasoning {
                CompanionThinkingDisclosure(
                    reasoning: reasoning,
                    isExpanded: reasoningExpansion ?? $localReasoningExpanded
                )
            }

            if kind == .assistant, let streamingDelta {
                if let streamingBaseMarkdown {
                    MarkdownMessageView(
                        document: streamingBaseMarkdown,
                        foreground: primaryTextColor,
                        linkColor: messageLinkColor,
                        allowsTextSelection: false
                    )
                }
                if !streamingDelta.isEmpty {
                    Text(streamingDelta)
                        .font(.body)
                        .foregroundStyle(primaryTextColor)
                        .lineSpacing(3)
                }
            } else if let markdown {
                MarkdownMessageView(
                    document: markdown,
                    foreground: primaryTextColor,
                    linkColor: messageLinkColor,
                    allowsTextSelection: false
                )
            } else {
                Text(content)
                    .font(.body)
                    .foregroundStyle(primaryTextColor)
            }

            if !localAttachments.isEmpty {
                LocalMessageAttachmentList(attachments: localAttachments)
            }

            if let companionID, !attachments.isEmpty {
                TranscriptAttachmentList(
                    companionID: companionID,
                    attachments: attachments
                )
            }

            if queued || timestamp != nil {
                HStack(spacing: 6) {
                    if queued {
                        Text("Queued")
                    }
                    if let timestamp {
                        Text(timestamp)
                    }
                }
                .font(.caption.monospacedDigit())
                .foregroundStyle(secondaryTextColor)
            }
        }

        contentView
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(bubbleColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var layoutKind: CompanionChatBubbleKind {
        switch kind {
        case .mine: .mine
        case .assistant: .assistant
        case .member: .member
        }
    }

    private var bubbleColor: Color {
        kind == .mine ? CompanionIOSTheme.userBubble : CompanionIOSTheme.botBubble
    }

    private var primaryTextColor: Color {
        kind == .mine ? CompanionIOSTheme.userBubbleText : CompanionIOSTheme.textPrimary
    }

    private var secondaryTextColor: Color {
        kind == .mine
            ? CompanionIOSTheme.userBubbleText.opacity(0.68)
            : CompanionIOSTheme.textSecondary
    }

    private var messageLinkColor: Color {
        kind == .mine ? CompanionIOSTheme.userBubbleLink : CompanionIOSTheme.linkBlue
    }

    private var displayReasoning: String? {
        guard let reasoning else { return nil }
        guard !reasoning.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return reasoning
    }

}

struct CompanionThinkingDisclosure: View {
    let reasoning: String
    @Binding var isExpanded: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var secondaryStyle: Color { CompanionIOSTheme.textSecondary }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "ellipsis")
                    Text("Thinking")
                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.semibold))
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(secondaryStyle)
                .padding(.horizontal, 10)
                .frame(minHeight: 32)
                .background(CompanionIOSTheme.chip, in: Capsule())
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                Text(reasoning)
                    .font(.footnote)
                    .foregroundStyle(secondaryStyle)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("thinking.content")
                    .transition(.opacity)
            }
        }
        .accessibilityLabel("Thinking")
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityHint(
            isExpanded
                ? "Double tap to collapse thinking."
                : "Double tap to expand thinking."
        )
        .accessibilityIdentifier("thinking.disclosure")
        .transaction { transaction in
            if reduceMotion {
                transaction.animation = nil
            }
        }
    }
}

struct CompanionThinkingStatus: View {
    let companionName: String
    let icon: CompanionSummary.Icon?
    let accent: Color
    let isInteractive: Bool
    let onTap: () -> Void

    private var label: String { "\(companionName) thinking" }

    private var statusTextColor: Color { CompanionIOSTheme.textPrimary }

    @ViewBuilder
    var body: some View {
        if isInteractive {
            Button(action: onTap) {
                statusContent
                    .frame(minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityValue("Details available")
            .accessibilityHint("Double tap to show current thinking.")
            .accessibilityIdentifier("chat.thinking-status")
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            statusContent
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(label)
                .accessibilityValue("Thinking details not available yet")
                .accessibilityHint("Thinking details are not available yet.")
                .accessibilityIdentifier("chat.thinking-status")
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var statusContent: some View {
        HStack(spacing: 6) {
            Image(systemName: "ellipsis")
                .accessibilityHidden(true)

            Text("\(companionName) thinking")
                .lineLimit(1)

            if isInteractive {
                Image(systemName: "chevron.up")
                    .font(.caption2.weight(.semibold))
                    .accessibilityHidden(true)
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(CompanionIOSTheme.textSecondary)
        .padding(.horizontal, 10)
        .frame(minHeight: 32)
        .background(CompanionIOSTheme.chip, in: Capsule())
        .contentShape(Capsule())
    }
}

private struct TranscriptRowInput: Equatable {
    let entry: TranscriptEntry
    let own: Bool
    let companionID: String
    let companionName: String
    let companionIcon: CompanionSummary.Icon?
    let markdown: MarkdownDocument?
    let tailReveal: AssistantTailReveal?
    let reasoningExpanded: Bool
    let canAct: Bool
    let decisionCatalog: CompanionDecisionCatalog
}

private struct TranscriptRowView: View, @MainActor Equatable {
    let input: TranscriptRowInput
    let onDecide: @MainActor (CompanionDecisionAction) async throws -> Void
    let onAnswerFocusChange: (Bool) -> Void
    let onOpenPlugins: (_ provider: String?, _ controlRequestID: String?) -> Void
    let onReasoningExpansionChange: (Bool) -> Void
    let onOpenToolDetails: (ToolRunDetailRoute) -> Void
    let onOpenRoutineRun: (CompanionTranscriptRoutineOrigin) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.input == rhs.input
    }

    @ViewBuilder
    var body: some View {
        if let delegation = input.entry.delegation {
            VStack(alignment: input.own ? .trailing : .leading, spacing: 6) {
                Text(delegation.direction == .request ? "Delegated by \(delegation.companionName)" : "Response from \(delegation.companionName)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                if let decision = input.entry.decision {
                    decisionEntry(decision)
                } else {
                    ordinaryEntry
                }
            }
            .frame(maxWidth: .infinity, alignment: input.own ? .trailing : .leading)
            .accessibilityIdentifier("chat.delegation.\(input.entry.eventID)")
        } else if let routine = input.entry.routine {
            CompanionRoutineOriginMarker(
                routine: routine,
                companionID: input.companionID,
                attachments: input.entry.attachments,
                onOpenRun: { onOpenRoutineRun(routine) }
            )
            .accessibilityIdentifier("chat.routine-origin.\(input.entry.eventID)")
        } else if let decision = input.entry.decision {
            decisionEntry(decision)
        } else if input.entry.role == "tool", let tool = input.entry.tool {
            ChatBubbleRowLayout(alignment: .leading) {
                CompanionToolRunCard(tool: tool, eventID: input.entry.eventID) {
                    onOpenToolDetails(ToolRunDetailRoute(
                        id: input.entry.eventID,
                        tool: tool,
                        timestamp: timeLabel
                    ))
                }
            }
        } else {
            ChatMessageBubble(
                content: input.entry.content,
                kind: kind,
                authorName: input.own
                    ? nil
                    : input.entry.authorName
                        ?? (input.entry.role == "user" ? "Workspace member" : input.companionName),
                timestamp: timeLabel,
                queued: input.entry.queued,
                companionName: input.companionName,
                companionID: input.companionID,
                icon: input.companionIcon,
                markdown: input.markdown,
                streamingBaseMarkdown: input.tailReveal?.baseMarkdown,
                streamingDelta: input.tailReveal?.visibleDelta,
                reasoning: input.entry.role == "assistant" ? input.entry.reasoning : nil,
                reasoningExpansion: Binding(
                    get: { input.reasoningExpanded },
                    set: onReasoningExpansionChange
                ),
                attachments: input.entry.attachments
            )
            .accessibilityIdentifier("chat.entry.\(input.entry.eventID)")
        }
    }

    @ViewBuilder
    private var ordinaryEntry: some View {
        if input.entry.role == "tool", let tool = input.entry.tool {
            ChatBubbleRowLayout(alignment: .leading) {
                CompanionToolRunCard(tool: tool, eventID: input.entry.eventID) {
                    onOpenToolDetails(ToolRunDetailRoute(
                        id: input.entry.eventID,
                        tool: tool,
                        timestamp: timeLabel
                    ))
                }
            }
        } else {
            ChatMessageBubble(
                content: input.entry.content,
                kind: kind,
                authorName: input.own
                    ? nil
                    : input.entry.authorName
                        ?? (input.entry.role == "user" ? "Workspace member" : input.companionName),
                timestamp: timeLabel,
                queued: input.entry.queued,
                companionName: input.companionName,
                companionID: input.companionID,
                icon: input.companionIcon,
                markdown: input.markdown,
                streamingBaseMarkdown: input.tailReveal?.baseMarkdown,
                streamingDelta: input.tailReveal?.visibleDelta,
                reasoning: input.entry.role == "assistant" ? input.entry.reasoning : nil,
                reasoningExpansion: Binding(
                    get: { input.reasoningExpanded },
                    set: onReasoningExpansionChange
                ),
                attachments: input.entry.attachments
            )
            .accessibilityIdentifier("chat.entry.\(input.entry.eventID)")
        }
    }

    private func decisionEntry(_ decision: CompanionDecision) -> some View {
        ChatBubbleRowLayout(alignment: .leading) {
            CompanionDecisionCard(
                decision: decision,
                companionName: input.companionName,
                canAct: input.canAct,
                catalog: input.decisionCatalog,
                accent: visualTheme.accent,
                accentForeground: visualTheme.accentForeground,
                onDecide: onDecide,
                onOpenPlugins: onOpenPlugins,
                onAnswerFocusChange: onAnswerFocusChange
            )
        }
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: input.companionIcon)
    }

    private var kind: ChatMessageBubble.Kind {
        if input.own { return .mine }
        return input.entry.role == "user" ? .member : .assistant
    }

    private var timeLabel: String? {
        guard let date = parseCompanionTimestamp(input.entry.createdAt) else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
    }
}

private struct CompanionRoutineOriginMarker: View {
    let routine: CompanionTranscriptRoutineOrigin
    let companionID: String
    let attachments: [CompanionAttachment]
    let onOpenRun: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if routine.runID != nil {
                Button(action: onOpenRun) {
                    markerLabel
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(routine.name) routine run")
                .accessibilityHint("Opens the routine's persisted run history")
                .accessibilityIdentifier("chat.routine-origin.open-run")
            } else {
                markerLabel
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Routine: \(routine.name)")
            }

            if !attachments.isEmpty {
                TranscriptAttachmentList(companionID: companionID, attachments: attachments)
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var markerLabel: some View {
        HStack(spacing: 7) {
            Image(systemName: "clock")
                .accessibilityHidden(true)
            Text("Routine: \(routine.name)")
                .font(.footnote.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            if routine.runID != nil {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .accessibilityHidden(true)
            }
        }
        .foregroundStyle(Color.companionInk)
        .frame(minHeight: 44)
        .padding(.horizontal, 12)
        .companionMaterial(radius: 12)
        .contentShape(Rectangle())
    }
}

private struct CompanionRoutineNotifyDisclosure: View {
    let routineName: String
    let totalCount: Int
    let latestAssistantEventID: String
    let isExpanded: Bool
    let onToggle: () -> Void

    private var title: String {
        "\(routineName) · \(totalCount) updates"
    }

    var body: some View {
        Button(action: onToggle) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                    .font(.caption.weight(.semibold))
                    .frame(width: 24, height: 44)
                    .accessibilityHidden(true)

                Text(title)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .layoutPriority(1)

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(CompanionIOSTheme.textSecondary)
        .accessibilityLabel(title)
        .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
        .accessibilityHint(
            isExpanded
                ? "Double tap to hide earlier routine updates."
                : "Double tap to show earlier routine updates."
        )
        .accessibilityIdentifier("chat.routine-notify.\(latestAssistantEventID)")
    }
}

private struct ChatBubbleRowLayout: Layout {
    let alignment: CompanionChatBubbleAlignment

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let availableWidth = proposal.width.map(Double.init)
            ?? CompanionChatBubbleLayout.absoluteMaximumWidth
        let maximumWidth = CGFloat(
            CompanionChatBubbleLayout.maximumWidth(in: availableWidth)
        )
        let childSize = subview.sizeThatFits(.init(width: maximumWidth, height: proposal.height))
        return CGSize(width: proposal.width ?? childSize.width, height: childSize.height)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard let subview = subviews.first else { return }
        let maximumWidth = CGFloat(
            CompanionChatBubbleLayout.maximumWidth(in: Double(bounds.width))
        )
        let childSize = subview.sizeThatFits(.init(width: maximumWidth, height: proposal.height))
        let x = alignment == .trailing ? bounds.maxX - childSize.width : bounds.minX
        subview.place(
            at: CGPoint(x: x, y: bounds.minY),
            anchor: .topLeading,
            proposal: .init(width: childSize.width, height: childSize.height)
        )
    }
}

private func parseCompanionTimestamp(_ value: String) -> Date? {
    (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
        ?? (try? Date.ISO8601FormatStyle().parse(value))
}

private struct PendingMessage: Identifiable, Equatable {
    let id: UUID
    let content: String
    let markdown: MarkdownDocument
    let attachments: [CompanionMessageAttachment]
    var failed: Bool
    var uploadProgress: Double?
}

private struct PendingMessageView: View {
    let message: PendingMessage
    let accent: Color
    let accentForeground: Color
    let retry: () -> Void
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ChatMessageBubble(
                content: message.content,
                kind: .mine,
                timestamp: statusLabel,
                markdown: message.markdown,
                localAttachments: message.attachments
            )

            if let progress = message.uploadProgress, !message.failed {
                ProgressView(value: progress)
                    .tint(CompanionIOSTheme.textSecondary)
                    .frame(maxWidth: 220)
                    .accessibilityLabel("Uploading attachments")
                    .accessibilityValue(progress.formatted(.percent.precision(.fractionLength(0))))
            }

            if message.failed {
                VStack(alignment: .trailing, spacing: 6) {
                    Text("Delivery could not be confirmed. Retrying reuses the same request.")
                        .font(.caption2)
                        .foregroundStyle(CompanionIOSTheme.danger)
                    HStack(spacing: 8) {
                        Button("Dismiss", action: dismiss)
                            .buttonStyle(.glass)
                        Button("Retry", action: retry)
                            .buttonStyle(.glassProminent)
                            .tint(accent)
                            .foregroundStyle(accentForeground)
                    }
                    .controlSize(.small)
                }
                .padding(.trailing, 4)
            }
        }
    }

    private var statusLabel: String {
        if message.failed { return "Not delivered" }
        guard let progress = message.uploadProgress else { return "Sending…" }
        if progress >= 1 { return "Finishing upload…" }
        return "Uploading \(progress.formatted(.percent.precision(.fractionLength(0))))"
    }
}
