import AppKit
import CompanionKit
import Observation
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

@MainActor
@Observable
final class CompanionMacChatModel {
    let sessionStore: SessionStore
    private(set) var companion: CompanionSummary
    private(set) var thread: CompanionThread?
    private(set) var loading = true
    private(set) var loadingEarlier = false
    private(set) var historyIsPartial = false
    private(set) var sending = false
    private(set) var errorMessage: String?
    private(set) var actionError: String?
    private var projection = CompanionThreadProjection()
    @ObservationIgnored private let mutationGate = CompanionThreadMutationGate()

    init(companion: CompanionSummary, sessionStore: SessionStore) {
        self.companion = companion
        self.sessionStore = sessionStore
    }

    var canSend: Bool {
        companion.access.canEditCompanionSettings && thread?.canSend == true && thread?.readOnly == false
    }

    var isReplying: Bool {
        thread?.activeTurn?.replying == true || companion.runtime.replying
    }

    var statusLine: String {
        if isReplying { return "Replying" }
        switch companion.runtime.state {
        case .running: return "Online · Box running"
        case .provisioning: return "Starting · Box provisioning"
        case .stopping: return "Stopping · Box shutting down"
        case .error: return "Needs attention · Box error"
        case .notCreated, .stopped: return "Asleep · Box stopped"
        case .unknown: return "Unknown · Box status unavailable"
        }
    }

    func updateCompanion(_ companion: CompanionSummary) {
        guard self.companion.id == companion.id else { return }
        self.companion = companion
    }

    func start() async {
        await reload()
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(isReplying ? 3 : 12))
            guard !Task.isCancelled else { return }
            await reload(silently: true)
        }
    }

    func reload(silently: Bool = false) async {
        if silently, loadingEarlier { return }
        let generation = projection.beginRefresh()
        if !silently { loading = true }
        do {
            let snapshot = try await sessionStore.synchronizeThread(
                companionID: companion.id
            ).value
            let next = snapshot.thread
            guard projection.accepts(refresh: generation) else { return }
            _ = projection.accept(next, refresh: generation)
            thread = next
            historyIsPartial = snapshot.isPartial
            errorMessage = nil
            if companion.unread {
                do {
                    let updated = try await sessionStore.updateCompanionMemberState(
                        companionID: companion.id,
                        patch: CompanionMemberStatePatch(unread: false)
                    )
                    updateCompanion(updated)
                } catch {
                    // Reading a thread remains useful when the private unread watermark update
                    // is temporarily unavailable; the next roster refresh reconciles it.
                }
            }
        } catch {
            if !silently || thread == nil {
                errorMessage = companionMacErrorMessage(error, fallback: "This conversation is temporarily unavailable.")
            }
        }
        loading = false
    }

    func loadEarlier() async {
        guard historyIsPartial, !loadingEarlier else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        do {
            guard let page = try await sessionStore.loadOlderThreadWindow(
                companionID: companion.id
            ) else {
                historyIsPartial = false
                return
            }
            projection.replaceAfterMutation(with: page.value.thread)
            thread = page.value.thread
            historyIsPartial = page.value.isPartial
            errorMessage = nil
        } catch {
            errorMessage = companionMacErrorMessage(
                error,
                fallback: "Earlier messages could not be loaded. Try again."
            )
        }
    }

    @discardableResult
    func send(content: String, attachments: [CompanionMessageAttachment]) async -> Bool {
        let trimmedContent = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !sending, !trimmedContent.isEmpty || !attachments.isEmpty else { return false }
        sending = true
        actionError = nil
        do {
            try await sessionStore.sendMessage(
                companionID: companion.id,
                content: trimmedContent,
                clientMessageID: UUID(),
                attachments: attachments
            )
            await reload()
            sending = false
            return true
        } catch {
            actionError = companionMacErrorMessage(error, fallback: "The message could not be sent. Try again.")
            sending = false
            return false
        }
    }

    func decide(requestID: String, action: CompanionDecisionAction) async {
        guard canSend else { return }
        let mutationID = "decision:\(requestID)"
        guard await mutationGate.acquire(mutationID: mutationID) else { return }
        projection.invalidateRefreshes()
        actionError = nil
        do {
            let next = try await sessionStore.decideCompanionDecision(
                companionID: companion.id,
                requestID: requestID,
                action: action
            )
            projection.replaceAfterMutation(with: next)
            thread = next
            await mutationGate.release(mutationID: mutationID)
        } catch {
            actionError = companionMacErrorMessage(error, fallback: "That decision could not be submitted.")
            await reload(silently: true)
            await mutationGate.release(mutationID: mutationID)
        }
    }

    func retryInterruptedTurn() async {
        guard canSend, let turn = thread?.interruptedTurn else { return }
        actionError = nil
        do {
            _ = try await sessionStore.retryCompanionTurn(
                companionID: companion.id,
                turnID: turn.id,
                retryID: UUID()
            )
            await reload()
        } catch {
            actionError = companionMacErrorMessage(error, fallback: "The interrupted turn could not be retried.")
        }
    }

    func cancelInterruptedTurn() async {
        guard canSend, let turn = thread?.interruptedTurn else { return }
        let mutationID = "cancel:\(turn.id)"
        guard await mutationGate.acquire(mutationID: mutationID) else { return }
        projection.invalidateRefreshes()
        actionError = nil
        do {
            let next = try await sessionStore.cancelCompanionTurn(
                companionID: companion.id,
                turnID: turn.id
            )
            projection.replaceAfterMutation(with: next)
            thread = next
            await mutationGate.release(mutationID: mutationID)
        } catch {
            actionError = companionMacErrorMessage(error, fallback: "The interrupted turn could not be cancelled.")
            await reload(silently: true)
            await mutationGate.release(mutationID: mutationID)
        }
    }
}

struct CompanionMacChatView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let companion: CompanionSummary
    let onCompanionChanged: (CompanionSummary) -> Void
    let onSettings: (CompanionSummary) -> Void
    let onOpenDesktop: (CompanionSummary) -> Void
    @State private var model: CompanionMacChatModel
    @State private var draft = ""
    @State private var attachments: [CompanionMessageAttachment] = []
    @State private var attachmentError: String?
    @State private var expandedReasoning: Set<String> = []
    @FocusState private var composerFocused: Bool

    init(
        companion: CompanionSummary,
        sessionStore: SessionStore,
        onCompanionChanged: @escaping (CompanionSummary) -> Void,
        onSettings: @escaping (CompanionSummary) -> Void,
        onOpenDesktop: @escaping (CompanionSummary) -> Void
    ) {
        self.companion = companion
        self.onCompanionChanged = onCompanionChanged
        self.onSettings = onSettings
        self.onOpenDesktop = onOpenDesktop
        _model = State(initialValue: CompanionMacChatModel(companion: companion, sessionStore: sessionStore))
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            transcript
            composer
        }
        .background(Color.companionMacCanvas)
        .task(id: model.companion.id) {
            await model.start()
        }
        .onChange(of: companion) { _, companion in
            model.updateCompanion(companion)
        }
        .onChange(of: model.companion) { _, companion in
            onCompanionChanged(companion)
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionMacFocusComposer)) { _ in
            composerFocused = true
        }
        .onChange(of: attachments) { _, items in
            if items.count > companionMessageAttachmentMaximumCount {
                attachmentError = "You can attach up to five files."
                attachments = Array(items.prefix(companionMessageAttachmentMaximumCount))
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            CompanionMacAvatar(
                name: model.companion.name,
                icon: model.companion.icon,
                size: 36,
                thinking: model.isReplying
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(model.companion.name)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    CompanionStatusDot(
                        status: CompanionStatusIndicatorState(
                            runtimeState: model.companion.runtime.state,
                            isReplying: model.isReplying
                        )
                    )
                    Text(CompanionStatusIndicatorState(
                        runtimeState: model.companion.runtime.state,
                        isReplying: model.isReplying
                    ).accessibilityLabel)
                        .font(.system(size: 13))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
            }
            Spacer(minLength: 12)
            if model.companion.access.canEditCompanionSettings {
                Button("Open Desktop", systemImage: "display") {
                    onOpenDesktop(model.companion)
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.plain)
                .frame(width: 36, height: 36)
                .disabled(!CompanionMacDesktopEligibility.evaluate(
                    access: model.companion.access,
                    runtimeState: model.companion.runtime.state
                ).canOpen)
                .help(CompanionMacDesktopEligibility.evaluate(
                    access: model.companion.access,
                    runtimeState: model.companion.runtime.state
                ).explanation)
                .accessibilityIdentifier("chat.open-desktop")
            }
            Button("Settings", systemImage: "gearshape") {
                onSettings(model.companion)
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
            .frame(width: 36, height: 36)
            .help("Toggle details")
            .accessibilityIdentifier("chat.settings")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(CompanionIOSTheme.canvas)
    }

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if model.loading && model.thread == nil {
                        ProgressView("Loading conversation…")
                            .frame(maxWidth: .infinity, minHeight: 180)
                    } else if let error = model.errorMessage, model.thread == nil {
                        VStack(spacing: CompanionMacMetrics.space * 3) {
                            CompanionMacErrorNotice(message: error)
                            Button("Try again") { Task { await model.reload() } }
                        }
                        .frame(maxWidth: 520)
                        .frame(maxWidth: .infinity, minHeight: 180)
                    } else if let thread = model.thread {
                        if model.historyIsPartial {
                            Button {
                                Task { await model.loadEarlier() }
                            } label: {
                                if model.loadingEarlier {
                                    ProgressView()
                                        .controlSize(.small)
                                } else {
                                    Label("Load earlier messages", systemImage: "arrow.up")
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(model.loadingEarlier)
                            .accessibilityIdentifier("chat.load-earlier")
                            .frame(maxWidth: .infinity)
                        }
                        if thread.entries.isEmpty && thread.interruptedTurn == nil && thread.queuedCount == 0 {
                            emptyConversation
                        }
                        ForEach(thread.entries) { entry in
                            CompanionMacTranscriptEntry(
                                entry: entry,
                                companion: model.companion,
                                viewerID: thread.viewerID,
                                canDecide: model.canSend,
                                decide: { action in
                                    await model.decide(requestID: entry.decision?.requestID ?? "", action: action)
                                },
                                reasoningExpanded: Binding(
                                    get: { expandedReasoning.contains(entry.id) },
                                    set: { expanded in
                                        if expanded { expandedReasoning.insert(entry.id) }
                                        else { expandedReasoning.remove(entry.id) }
                                    }
                                )
                            )
                            .id(entry.id)
                        }
                        if let interruptedTurn = thread.interruptedTurn {
                            CompanionMacInterruptedTurnView(
                                turn: interruptedTurn,
                                queuedCount: thread.queuedCount,
                                canAct: model.canSend,
                                actionError: model.actionError,
                                retry: { Task { await model.retryInterruptedTurn() } },
                                cancel: { Task { await model.cancelInterruptedTurn() } }
                            )
                            .id("interrupted-\(interruptedTurn.id)")
                        } else if thread.queuedCount > 0 {
                            CompanionMacQueuedStateView(count: thread.queuedCount)
                        }
                    }
                    if let actionError = model.actionError {
                        CompanionMacErrorNotice(message: actionError)
                            .frame(maxWidth: Self.contentMaxWidth)
                    }
                    Color.clear.frame(height: 1).id("chat-bottom")
                }
                .frame(maxWidth: Self.contentMaxWidth)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
                .padding(.vertical, 20)
            }
            .defaultScrollAnchor(.bottom)
            .scrollIndicators(.automatic)
            .onChange(of: model.thread?.entries.count) { _, _ in
                guard model.isReplying == false else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                    proxy.scrollTo("chat-bottom", anchor: .bottom)
                }
            }
        }
        .accessibilityIdentifier("chat.transcript")
    }

    private var emptyConversation: some View {
        VStack(spacing: 12) {
            CompanionMacAvatar(name: model.companion.name, icon: model.companion.icon, size: 72)
            Text("Say hello")
                .font(.system(size: 20, weight: .semibold))
            Text("A message wakes this Bot when needed.")
                .font(.system(size: 15))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, CompanionMacMetrics.space * 12)
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if model.thread?.readOnly == true || !model.canSend {
                Label("Viewer access is read-only. Sending a message will not contact this Box.", systemImage: "eye")
                    .font(.callout)
                    .foregroundStyle(Color.companionMacMuted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("chat.viewer-readonly")
            } else {
                if !attachments.isEmpty {
                    ScrollView(.horizontal) {
                        HStack(spacing: CompanionMacMetrics.space * 2) {
                            ForEach(attachments) { attachment in
                                HStack(spacing: CompanionMacMetrics.space) {
                                    Image(systemName: attachment.contentType.isImage ? "photo" : "doc")
                                    Text(attachment.filename).lineLimit(1)
                                    Button("Remove", systemImage: "xmark.circle.fill") {
                                        attachments.removeAll { $0.id == attachment.id }
                                    }
                                    .labelStyle(.iconOnly)
                                    .buttonStyle(.plain)
                                    .disabled(model.sending)
                                }
                                .font(.caption)
                                .padding(.horizontal, CompanionMacMetrics.space * 2)
                                .padding(.vertical, CompanionMacMetrics.space)
                                .background(Color.companionMacRaised, in: Capsule())
                                .overlay(Capsule().stroke(Color.companionMacDivider, lineWidth: 1))
                            }
                        }
                    }
                    .scrollIndicators(.hidden)
                }
                if let attachmentError {
                    Text(attachmentError)
                        .font(.caption)
                        .foregroundStyle(Color.companionMacDanger)
                }
                HStack(alignment: .bottom, spacing: 8) {
                    Button("Attach files", systemImage: "paperclip") {
                        presentOpenPanel()
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .frame(width: 36, height: 36)
                    .disabled(attachments.count >= companionMessageAttachmentMaximumCount || model.sending)
                    .accessibilityIdentifier("chat.attach")

                    TextField("Message \(model.companion.name)…", text: $draft, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($composerFocused)
                        .textFieldStyle(.plain)
                        .disabled(model.sending)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                        .accessibilityIdentifier("chat.composer")

                    Button {
                        let content = draft
                        let files = attachments
                        Task {
                            if await model.send(content: content, attachments: files) {
                                draft = ""
                                attachments = []
                            }
                        }
                    } label: {
                        if model.sending {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 14, weight: .bold))
                                .frame(width: 34, height: 34)
                                .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                                .background(CompanionIOSTheme.primaryCTA, in: Circle())
                        }
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(.return, modifiers: [.command])
                    .disabled(model.sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty)
                    .accessibilityLabel(model.sending ? "Sending message" : "Send message")
                    .accessibilityIdentifier("chat.send")
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
        .frame(maxWidth: Self.contentMaxWidth)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24)
        .padding(.vertical, 12)
        .background(CompanionIOSTheme.canvas)
    }

    private static let contentMaxWidth: CGFloat = CompanionMacMetrics.transcriptMaxWidth
    private static let allowedAttachmentTypes: [UTType] = [
        .png, .jpeg, .webP, .gif, .pdf, .commaSeparatedText, .plainText, .json,
        UTType(filenameExtension: "md") ?? .plainText,
    ]

    private func presentOpenPanel() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = Self.allowedAttachmentTypes
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.canCreateDirectories = false
        panel.begin { response in
            guard response == .OK else { return }
            let urls = panel.urls
            Task { @MainActor in
                importFiles(urls)
            }
        }
    }

    private func importFiles(_ urls: [URL]) {
        attachmentError = nil
        for url in urls.prefix(companionMessageAttachmentMaximumCount - attachments.count) {
            let hasSecurityScope = url.startAccessingSecurityScopedResource()
            defer {
                if hasSecurityScope { url.stopAccessingSecurityScopedResource() }
            }
            do {
                let data = try Data(contentsOf: url, options: .mappedIfSafe)
                let attachment = try CompanionMessageAttachment(
                    data: data,
                    filename: url.lastPathComponent,
                    declaredContentType: UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                )
                attachments.append(attachment)
            } catch let attachmentError as CompanionMessageAttachmentError {
                self.attachmentError = attachmentError.errorDescription
            } catch {
                self.attachmentError = "The selected file could not be read."
            }
        }
    }
}

private struct CompanionMacTranscriptEntry: View {
    let entry: TranscriptEntry
    let companion: CompanionSummary
    let viewerID: String
    let canDecide: Bool
    let decide: (CompanionDecisionAction) async -> Void
    @Binding var reasoningExpanded: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 72) }
            if !isUser {
                CompanionMacAvatar(name: companion.name, icon: companion.icon, size: 26, thinking: false)
            }
            VStack(alignment: .leading, spacing: 8) {
                if let routine = entry.routine {
                    Label("Routine: \(routine.name)", systemImage: "clock")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(linkColor)
                } else if entry.role == "user", !isUser, let author = entry.authorName {
                    Text(author)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(secondaryTextColor)
                }
                if !entry.content.isEmpty {
                    CompanionMacMarkdownText(markdown: entry.content, foreground: primaryTextColor, link: linkColor)
                }
                if entry.queued {
                    Label("Queued", systemImage: "clock")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(secondaryTextColor)
                        .accessibilityLabel("Message queued")
                }
                if let decision = entry.decision {
                    CompanionMacDecisionCard(
                        decision: decision,
                        canAct: canDecide,
                        onDecide: { action in
                            await decide(action)
                        }
                    )
                }
                if let reasoning = entry.reasoning, !reasoning.isEmpty {
                    DisclosureGroup("Reasoning", isExpanded: $reasoningExpanded) {
                        Text(reasoning)
                            .font(.system(size: 13, design: .monospaced))
                            .foregroundStyle(secondaryTextColor)
                            .textSelection(.enabled)
                            .padding(.top, CompanionMacMetrics.space)
                    }
                    .font(.caption)
                    .tint(Color.companionMacAccent)
                }
                if let tool = entry.tool {
                    CompanionMacToolCard(tool: tool)
                }
                if !entry.attachments.isEmpty {
                    VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                        ForEach(entry.attachments) { attachment in
                            CompanionMacAttachmentView(
                                attachment: attachment,
                                companionID: companion.id
                            )
                        }
                    }
                }
                Text(entry.createdAt.macShortDate)
                    .font(.system(size: 11))
                    .foregroundStyle(secondaryTextColor)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(bubbleColor, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .frame(maxWidth: 620, alignment: isUser ? .trailing : .leading)
            if !isUser { Spacer(minLength: 72) }
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .accessibilityIdentifier("chat.entry.\(entry.eventID)")
    }

    private var isUser: Bool {
        entry.role == "user" && entry.authorID == viewerID
    }

    private var bubbleColor: Color {
        isUser ? CompanionIOSTheme.userBubble : CompanionIOSTheme.botBubble
    }

    private var primaryTextColor: Color {
        isUser ? CompanionIOSTheme.userBubbleText : CompanionIOSTheme.textPrimary
    }

    private var secondaryTextColor: Color {
        primaryTextColor.opacity(0.68)
    }

    private var linkColor: Color {
        isUser ? CompanionIOSTheme.userBubbleLink : CompanionIOSTheme.linkBlue
    }
}

private struct CompanionMacMarkdownText: View {
    let markdown: String
    let foreground: Color
    let link: Color

    @ViewBuilder
    var body: some View {
        if let standaloneLink {
            Button {
                guard CompanionLinkPolicy.isAllowed(standaloneLink) else { return }
                NSWorkspace.shared.open(standaloneLink)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "link")
                        .font(.system(size: 15, weight: .semibold))
                        .frame(width: 34, height: 34)
                        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(standaloneLink.host(percentEncoded: false) ?? "Link")
                            .font(.system(size: 14, weight: .semibold))
                        Text(standaloneLink.absoluteString)
                            .font(.system(size: 12))
                            .foregroundStyle(link)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "arrow.up.right")
                        .font(.system(size: 12, weight: .semibold))
                }
                .foregroundStyle(foreground)
                .padding(10)
                .background(CompanionIOSTheme.innerBubble, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)
            .contextMenu {
                Button("Open Link") { NSWorkspace.shared.open(standaloneLink) }
                Button("Copy Link") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(standaloneLink.absoluteString, forType: .string)
                }
            }
        } else {
            Text(attributedMarkdown)
                .font(.body)
                .foregroundStyle(foreground)
                .tint(link)
                .textSelection(.enabled)
                .environment(
                    \.openURL,
                    OpenURLAction { url in
                        CompanionLinkPolicy.isAllowed(url) ? .systemAction : .discarded
                    }
                )
        }
    }

    private var standaloneLink: URL? {
        let trimmed = markdown.trimmingCharacters(in: .whitespacesAndNewlines)
        let links = CompanionMessageLinkDetector.detect(in: trimmed)
        guard links.count == 1,
              links[0].utf16Location == 0,
              links[0].utf16Length == (trimmed as NSString).length else { return nil }
        return links[0].url
    }

    private var attributedMarkdown: AttributedString {
        var attributed: AttributedString
        do {
            attributed = try AttributedString(
                markdown: markdown,
                options: .init(
                    interpretedSyntax: .full,
                    failurePolicy: .returnPartiallyParsedIfPossible
                )
            )
        } catch {
            attributed = AttributedString(markdown)
        }
        let rendered = String(attributed.characters)
        for detected in CompanionMessageLinkDetector.detect(in: rendered) {
            guard let stringRange = Range(detected.nsRange, in: rendered),
                  let lower = AttributedString.Index(stringRange.lowerBound, within: attributed),
                  let upper = AttributedString.Index(stringRange.upperBound, within: attributed)
            else { continue }
            attributed[lower..<upper].link = detected.url
        }
        return attributed
    }
}

private struct CompanionMacToolCard: View {
    let tool: CompanionToolRun

    var body: some View {
        HStack(alignment: .top, spacing: CompanionMacMetrics.space * 2) {
            Image(systemName: symbol)
                .foregroundStyle(color)
            VStack(alignment: .leading, spacing: CompanionMacMetrics.space) {
                HStack {
                    Text(tool.title)
                        .font(.callout.weight(.medium))
                    Spacer()
                    Text(tool.status.rawValue.capitalized)
                        .font(.caption)
                        .foregroundStyle(color)
                }
                if let detail = tool.detail, !detail.isEmpty {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(Color.companionMacMuted)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(12)
        .background(CompanionIOSTheme.innerBubble, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Tool \(tool.title), \(tool.status.rawValue)")
    }

    private var symbol: String {
        switch tool.kind {
        case .shell: return "terminal"
        case .file: return "doc.text"
        case .browse: return "safari"
        case .computer: return "display"
        case .subagent: return "person.2"
        case .tool: return "wrench.and.screwdriver"
        }
    }

    private var color: Color {
        switch tool.status {
        case .ok: return .companionMacSuccess
        case .error, .timeout: return .companionMacDanger
        case .running: return .companionMacAccent
        }
    }
}

private struct CompanionMacPrimaryCapsuleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(CompanionIOSTheme.primaryCTAText)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(CompanionIOSTheme.primaryCTA.opacity(configuration.isPressed ? 0.72 : 1), in: Capsule())
    }
}

private struct CompanionMacSecondaryCapsuleButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(CompanionIOSTheme.textPrimary)
            .frame(maxWidth: .infinity, minHeight: 42)
            .background(CompanionIOSTheme.card.opacity(configuration.isPressed ? 0.72 : 1), in: Capsule())
    }
}

private struct CompanionMacDecisionCard: View {
    let decision: CompanionDecision
    let canAct: Bool
    let onDecide: (CompanionDecisionAction) async -> Void
    @State private var answer = ""
    @State private var submitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                    .foregroundStyle(statusColor)
                Text(decision.title)
                    .font(.callout.weight(.semibold))
                Spacer()
                Text(statusLabel)
                    .font(.caption)
                    .foregroundStyle(statusColor)
            }
            if let detail = decision.detail, !detail.isEmpty {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                    .lineLimit(8)
                    .textSelection(.enabled)
            }
            if let proposal = proposalSummary {
                Text(proposal)
                    .font(.caption.monospaced())
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                    .lineLimit(6)
            }
            if decision.status == .pending {
                if decision.kind == .question {
                    TextField("Type an answer", text: $answer, axis: .vertical)
                        .lineLimit(2...5)
                        .textFieldStyle(.roundedBorder)
                }
                HStack {
                    if decision.kind == .question {
                        Button("Answer") {
                            submit(.answer(answer.trimmingCharacters(in: .whitespacesAndNewlines)))
                        }
                        .buttonStyle(CompanionMacPrimaryCapsuleButtonStyle())
                        .disabled(!canAct || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || submitting)
                    } else {
                        Button("Approve") { submit(.allow) }
                            .buttonStyle(CompanionMacPrimaryCapsuleButtonStyle())
                            .disabled(!canAct || submitting)
                    }
                    Button("Deny") { submit(.deny) }
                        .buttonStyle(CompanionMacSecondaryCapsuleButtonStyle())
                        .disabled(!canAct || submitting)
                    if !canAct {
                        Label("Read-only", systemImage: "eye")
                            .font(.caption)
                            .foregroundStyle(Color.companionMacMuted)
                    }
                }
            } else if let decidedByName = decision.decidedByName {
                Text("\(statusLabel) by \(decidedByName)")
                    .font(.caption)
                    .foregroundStyle(Color.companionMacMuted)
            }
        }
        .padding(14)
        .frame(maxWidth: 640, alignment: .leading)
        .background(CompanionIOSTheme.botBubble, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat.decision.\(decision.requestID)")
    }

    private var symbol: String {
        switch decision.kind {
        case .question: return "questionmark.circle"
        case .shell: return "terminal"
        case .file: return "doc.text"
        case .config, .routine, .trigger: return "checkmark.shield"
        case .unknown: return "questionmark"
        }
    }

    private var statusLabel: String {
        switch decision.status {
        case .pending: return "Waiting"
        case .allowed: return "Allowed"
        case .denied: return "Denied"
        case .answered: return "Answered"
        case .expired: return "Expired"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }

    private var statusColor: Color {
        switch decision.status {
        case .pending: return .companionMacAccent
        case .allowed, .answered: return .companionMacSuccess
        case .denied, .expired, .cancelled: return .companionMacDanger
        case .unknown: return .companionMacUnknown
        }
    }

    private var proposalSummary: String? {
        switch decision.proposal {
        case .config(let proposal):
            var pieces: [String] = []
            if !proposal.addSkillIDs.isEmpty { pieces.append("Add skills: \(proposal.addSkillIDs.joined(separator: ", "))") }
            if !proposal.removeSkillIDs.isEmpty { pieces.append("Remove skills: \(proposal.removeSkillIDs.joined(separator: ", "))") }
            if let modelID = proposal.modelID { pieces.append("Model: \(modelID)") }
            if proposal.includesPersona { pieces.append("Update persona") }
            if let plugin = proposal.connectPlugin { pieces.append("Connect plugin: \(plugin.serverName)") }
            return pieces.isEmpty ? "Configuration change proposed" : pieces.joined(separator: " · ")
        case .routine(let proposal):
            return "Routine: \(proposal.name) · \(proposal.cron) · \(proposal.timezone)"
        case .trigger(let proposal):
            return "Trigger: \(proposal.name) · \(proposal.provider)"
        case nil:
            return nil
        }
    }

    private func submit(_ action: CompanionDecisionAction) {
        guard canAct, !submitting else { return }
        submitting = true
        Task {
            await onDecide(action)
            submitting = false
        }
    }
}

private struct CompanionMacAttachmentView: View {
    @Environment(SessionStore.self) private var sessionStore
    let attachment: CompanionAttachment
    let companionID: String
    @State private var image: NSImage?
    @State private var previewURL: URL?
    @State private var opening = false
    @State private var errorMessage: String?

    var body: some View {
        Button {
            Task { await openPreview() }
        } label: {
            HStack(spacing: 10) {
                if let image {
                    Image(nsImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(maxWidth: 220, maxHeight: 140)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                } else {
                    Image(systemName: "doc.text.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                        .frame(width: 36, height: 36)
                        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(attachment.filename)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                    Text(ByteCountFormatter.string(fromByteCount: Int64(attachment.byteSize), countStyle: .file))
                        .font(.system(size: 12).monospacedDigit())
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
                if opening { ProgressView().controlSize(.small) }
            }
            .padding(10)
            .background(CompanionIOSTheme.innerBubble, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(opening)
        .task {
            guard attachment.kind == .piOutput, attachment.contentType.isImage else { return }
            guard let data = try? await sessionStore.attachmentData(
                companionID: companionID,
                attachmentID: attachment.id
            ) else { return }
            image = NSImage(data: data)
        }
        .quickLookPreview($previewURL)
        .alert("Couldn’t Open File", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("Try Again") { Task { await openPreview() } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text(errorMessage ?? "The attachment could not be opened.")
        }
        .onDisappear { removePreviewFile() }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Attachment \(attachment.filename)")
        .accessibilityHint("Opens a file preview")
    }

    private func openPreview() async {
        opening = true
        defer { opening = false }
        do {
            let data = try await sessionStore.attachmentData(
                companionID: companionID,
                attachmentID: attachment.id
            )
            removePreviewFile()
            let safeName = URL(fileURLWithPath: attachment.filename).lastPathComponent
            let directory = FileManager.default.temporaryDirectory.appending(
                path: "companion-mac-preview-\(UUID().uuidString)",
                directoryHint: .isDirectory
            )
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appending(path: safeName)
            try data.write(to: url, options: .atomic)
            previewURL = url
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "The attachment could not be opened.")
        }
    }

    private func removePreviewFile() {
        guard let previewURL else { return }
        try? FileManager.default.removeItem(at: previewURL.deletingLastPathComponent())
        self.previewURL = nil
    }
}

private struct CompanionMacInterruptedTurnView: View {
    let turn: CompanionTurn
    let queuedCount: Int
    let canAct: Bool
    let actionError: String?
    let retry: () -> Void
    let cancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: CompanionMacMetrics.space * 2) {
            Label("Turn interrupted", systemImage: "pause.circle.fill")
                .font(.callout.weight(.semibold))
                .foregroundStyle(Color.companionMacWarning)
            Text("The runtime stopped waiting for this turn. Earlier external effects may have succeeded. Retry only if that is safe.")
                .font(.callout)
                .foregroundStyle(Color.companionMacMuted)
            HStack {
                Button("Retry", action: retry)
                    .buttonStyle(.borderedProminent)
                    .disabled(!canAct)
                Button("Cancel", role: .destructive, action: cancel)
                    .disabled(!canAct)
                if queuedCount > 0 {
                    Text("\(queuedCount) later message\(queuedCount == 1 ? "" : "s") queued")
                        .font(.caption)
                        .foregroundStyle(Color.companionMacMuted)
                }
            }
            if let actionError {
                Text(actionError)
                    .font(.caption)
                    .foregroundStyle(Color.companionMacDanger)
            }
        }
        .padding(CompanionMacMetrics.space * 3)
        .frame(maxWidth: 620, alignment: .leading)
        .background(Color.companionMacWarning.opacity(0.11), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.companionMacWarning.opacity(0.36), lineWidth: 1))
        .accessibilityIdentifier("chat.interrupted-turn")
    }
}

private struct CompanionMacQueuedStateView: View {
    let count: Int

    var body: some View {
        Label(
            "\(count) message\(count == 1 ? "" : "s") queued. They will run in order.",
            systemImage: "clock"
        )
        .font(.callout)
        .foregroundStyle(Color.companionMacMuted)
        .padding(CompanionMacMetrics.space * 2)
        .accessibilityIdentifier("chat.queued-state")
    }
}

private extension String {
    var macShortDate: String {
        guard let date = ISO8601DateFormatter().date(from: self) else { return "" }
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
