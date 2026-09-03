import CompanionKit
import Observation
import SwiftUI

@MainActor
@Observable
final class CompanionMacWorkspaceModel {
    let sessionStore: SessionStore
    private(set) var rosterState = CompanionRosterState()
    private(set) var sectionStore = CompanionSectionStore()
    var selectedCompanionID: String?
    var query = ""
    private(set) var loading = true
    private(set) var errorMessage: String?
    private(set) var actionMessage: String?
    private(set) var actionError: String?
    private(set) var pendingDeletionIDs: Set<String> = []
    private var deletionRequestsInFlight: Set<String> = []

    init(sessionStore: SessionStore) {
        self.sessionStore = sessionStore
    }

    var companions: [CompanionSummary] {
        rosterState.companions
    }

    var matchingCompanions: [CompanionSummary] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return companions }
        return companions.filter { companion in
            [companion.name, companion.persona ?? "", companion.lastMessage?.preview ?? ""]
                .joined(separator: "\n")
                .localizedCaseInsensitiveContains(normalized)
        }
    }

    var homeSections: [CompanionHomeSection] {
        sectionStore.groups(companions: matchingCompanions)
    }

    var selectedCompanion: CompanionSummary? {
        guard let selectedCompanionID else { return nil }
        return companions.first { $0.id == selectedCompanionID }
    }

    func refresh(silently: Bool = false) async {
        if !silently { loading = true }
        do {
            async let sectionsRequest = loadSectionsResult()
            let next = try await sessionStore.listCompanions()
            // Keep the optimistic snapshot intact until the delete request settles. A list poll
            // that overlaps the request must not make a later failure impossible to roll back.
            if deletionRequestsInFlight.isEmpty {
                rosterState.reconcile(with: visibleCompanionsReconcilingDeletions(next))
            }
            switch await sectionsRequest {
            case .success(let sections):
                sectionStore.reconcile(with: sections)
            case .failure(let error):
                actionError = companionMacErrorMessage(
                    error,
                    fallback: "Sections are temporarily unavailable. Your Companions are still current."
                )
            }
            errorMessage = nil
            if let selectedCompanionID,
               companions.contains(where: { $0.id == selectedCompanionID }) {
                self.selectedCompanionID = selectedCompanionID
            } else if self.selectedCompanionID == nil {
                self.selectedCompanionID = matchingCompanions.first?.id
            }
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Companions are temporarily unavailable.")
        }
        loading = false
    }

    func startPolling() async {
        await refresh()
        while !Task.isCancelled {
            let hasActiveWork = !pendingDeletionIDs.isEmpty || companions.contains {
                $0.runtime.replying
                    || $0.runtime.state == .provisioning
                    || $0.runtime.state == .stopping
                    || $0.deletionLifecycle?.isActive == true
            }
            try? await Task.sleep(for: .seconds(hasActiveWork ? 8 : 45))
            guard !Task.isCancelled else { return }
            await refresh(silently: true)
        }
    }

    func select(_ companion: CompanionSummary?) {
        selectedCompanionID = companion?.id
        actionError = nil
    }

    func replaceProjection(_ companion: CompanionSummary) {
        _ = rosterState.replace(companion)
    }

    func markUnread(_ companion: CompanionSummary) {
        performMemberStateUpdate(
            companion,
            patch: CompanionMemberStatePatch(unread: true),
            success: "Marked \(companion.name) as unread."
        )
    }

    func toggleMuted(_ companion: CompanionSummary) {
        performMemberStateUpdate(
            companion,
            patch: CompanionMemberStatePatch(muted: !companion.muted),
            success: companion.muted ? "Unmuted \(companion.name)." : "Muted \(companion.name)."
        )
    }

    func toggleSection(_ section: CompanionHomeSection) {
        sectionStore.toggleCollapsed(sectionID: section.id)
    }

    func move(_ companion: CompanionSummary, to sectionID: String?) {
        guard companion.access.canDeleteCompanion else { return }
        actionError = nil
        Task {
            do {
                let updated = try await sessionStore.assignCompanionSection(
                    companionID: companion.id,
                    sectionID: sectionID
                )
                rosterState.replace(updated)
                let destination = sectionID.flatMap { id in
                    sectionStore.sections.first(where: { $0.id == id })?.name
                } ?? "Unassigned"
                actionMessage = "Moved \(companion.name) to \(destination)."
            } catch {
                actionError = companionMacErrorMessage(error, fallback: "The Companion could not be moved.")
            }
        }
    }

    func createSection(named rawName: String, moving companion: CompanionSummary?) {
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        actionError = nil
        Task {
            do {
                let section = try await sessionStore.createCompanionSection(name: name)
                sectionStore.reconcile(with: sectionStore.sections + [section])
                if let companion { move(companion, to: section.id) }
            } catch {
                actionError = companionMacErrorMessage(error, fallback: "The section could not be created.")
            }
        }
    }

    func deleteSection(_ section: CompanionSection) {
        actionError = nil
        Task {
            do {
                try await sessionStore.deleteCompanionSection(sectionID: section.id)
                sectionStore.remove(sectionID: section.id)
                await refresh(silently: true)
                actionMessage = "Deleted \(section.name). Its Companions are Unassigned."
            } catch {
                actionError = companionMacErrorMessage(error, fallback: "The section could not be deleted.")
            }
        }
    }

    func duplicate(_ companion: CompanionSummary) {
        guard companion.access.canDeleteCompanion, !isDeletionInProgress(companion) else { return }
        actionError = nil
        Task {
            do {
                let duplicate = try await sessionStore.duplicateCompanion(companionID: companion.id)
                rosterState.prepend(duplicate)
                selectedCompanionID = duplicate.id
                actionMessage = "Created a copy of \(companion.name)."
            } catch {
                actionError = companionMacErrorMessage(error, fallback: "The Companion could not be duplicated.")
            }
        }
    }

    func delete(_ companion: CompanionSummary) {
        guard companion.access.canDeleteCompanion, !isDeletionInProgress(companion) else { return }
        actionError = nil
        let wasSelected = selectedCompanionID == companion.id
        pendingDeletionIDs.insert(companion.id)
        deletionRequestsInFlight.insert(companion.id)
        _ = rosterState.removeOptimistically(companionID: companion.id)
        if selectedCompanionID == companion.id { selectedCompanionID = nil }
        Task {
            do {
                let lifecycle = try await sessionStore.deleteCompanion(
                    companionID: companion.id,
                    requestID: UUID()
                )
                deletionRequestsInFlight.remove(companion.id)
                if !lifecycle.isActive { pendingDeletionIDs.remove(companion.id) }
                let restored = rosterState.reconcileDeletionResponse(
                    companionID: companion.id,
                    lifecycle: lifecycle
                )
                if lifecycle.isActive {
                    actionMessage = "Deletion requested for \(companion.name)."
                } else {
                    if wasSelected, restored != nil { selectedCompanionID = companion.id }
                    actionMessage = nil
                    actionError = lifecycle.error?.message ?? "\(companion.name) could not be deleted and was restored."
                }
            } catch {
                deletionRequestsInFlight.remove(companion.id)
                pendingDeletionIDs.remove(companion.id)
                let restored = rosterState.restoreDeletion(companionID: companion.id)
                if wasSelected, restored != nil { selectedCompanionID = companion.id }
                actionError = companionMacErrorMessage(error, fallback: "The Companion could not be deleted.")
            }
        }
    }

    func applyCreated(_ companion: CompanionSummary) {
        rosterState.prepend(companion)
        selectedCompanionID = companion.id
        actionMessage = "Created \(companion.name)."
    }

    private func performMemberStateUpdate(
        _ companion: CompanionSummary,
        patch: CompanionMemberStatePatch,
        success: String
    ) {
        guard !loading, !isDeletionInProgress(companion) else { return }
        actionError = nil
        Task {
            do {
                let updated = try await sessionStore.updateCompanionMemberState(
                    companionID: companion.id,
                    patch: patch
                )
                _ = rosterState.replaceAndRepartition(updated)
                actionMessage = success
            } catch {
                actionError = companionMacErrorMessage(error, fallback: "That roster change could not be saved.")
            }
        }
    }

    private func isDeletionInProgress(_ companion: CompanionSummary) -> Bool {
        pendingDeletionIDs.contains(companion.id) || companion.deletionLifecycle?.isActive == true
    }

    private func loadSectionsResult() async -> Result<[CompanionSection], Error> {
        do {
            return .success(try await sessionStore.listCompanionSections())
        } catch {
            do {
                return .success(try CompanionSectionCompatibility.fallback(for: error))
            } catch {
                return .failure(error)
            }
        }
    }

    private func visibleCompanionsReconcilingDeletions(
        _ next: [CompanionSummary]
    ) -> [CompanionSummary] {
        var retainedPendingIDs: Set<String> = []
        var visible: [CompanionSummary] = []

        for companion in next {
            if companion.deletionLifecycle?.isActive == true {
                retainedPendingIDs.insert(companion.id)
                continue
            }
            if pendingDeletionIDs.contains(companion.id), companion.deletionLifecycle == nil {
                // A list response can briefly lag the accepted delete lifecycle. Keep that stale
                // projection hidden until the API reports a terminal lifecycle or removes it.
                retainedPendingIDs.insert(companion.id)
                continue
            }
            visible.append(companion)
        }

        pendingDeletionIDs = retainedPendingIDs
        return visible
    }
}

struct CompanionMacWorkspaceView: View {
    @Environment(\.openWindow) private var openWindow
    @Environment(CompanionMacDesktopWindowState.self) private var desktopWindow
    let session: Session
    @State private var model: CompanionMacWorkspaceModel
    @State private var showingCreate = false
    @State private var showingMemberSettings = false
    @State private var showingProviders = false
    @State private var showingPlugins = false
    @State private var companionToDelete: CompanionSummary?
    @AppStorage("companion.mac.inspector-visible") private var inspectorVisible = true

    init(session: Session, sessionStore: SessionStore) {
        self.session = session
        _model = State(initialValue: CompanionMacWorkspaceModel(sessionStore: sessionStore))
    }

    var body: some View {
        NavigationSplitView {
            sidebar
        } detail: {
            detail
        }
        .navigationSplitViewColumnWidth(
            min: CompanionMacMetrics.sidebarWidth - 24,
            ideal: CompanionMacMetrics.sidebarWidth,
            max: CompanionMacMetrics.sidebarWidth + 100
        )
        .background(Color.companionMacCanvas)
        .task {
            await model.startPolling()
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionMacNewCompanion)) { _ in
            showingCreate = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionMacDeleteSelected)) { _ in
            if let companion = model.selectedCompanion, companion.access.canDeleteCompanion {
                companionToDelete = companion
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .companionMacOpenDesktop)) { _ in
            if let companion = model.selectedCompanion {
                requestDesktop(for: companion)
            }
        }
        .sheet(isPresented: $showingCreate) {
            CompanionMacCreateCompanionView { companion in
                model.applyCreated(companion)
                showingCreate = false
            }
            .environment(model.sessionStore)
        }
        .sheet(isPresented: $showingMemberSettings) {
            CompanionMacMemberSettingsView(session: session)
                .environment(model.sessionStore)
        }
        .sheet(isPresented: $showingProviders) {
            CompanionMacProviderManagementView()
                .environment(model.sessionStore)
        }
        .sheet(isPresented: $showingPlugins) {
            CompanionMacPluginManagementView()
                .environment(model.sessionStore)
        }
        .confirmationDialog(
            "Delete \(companionToDelete?.name ?? "Companion")?",
            isPresented: Binding(
                get: { companionToDelete != nil },
                set: { if !$0 { companionToDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: companionToDelete
        ) { companion in
            Button("Delete Companion", role: .destructive) {
                model.delete(companion)
                companionToDelete = nil
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its Box, thread, and Companion record will be permanently deleted. This cannot be undone.")
        }
        .tint(Color.companionMacAccent)
    }

    private var sidebar: some View {
        CompanionMacRosterSidebar(
            model: model,
            session: session,
            onSettings: { companion in
                model.select(companion)
                inspectorVisible = true
            },
            onDelete: { companionToDelete = $0 },
            onNew: { showingCreate = true },
            onMemberSettings: { showingMemberSettings = true },
            onProviders: { showingProviders = true },
            onPlugins: { showingPlugins = true },
            onSignOut: { Task { await model.sessionStore.signOut() } }
        )
        .safeAreaInset(edge: .bottom) {
            if let actionError = model.actionError {
                CompanionMacErrorNotice(message: actionError)
                    .padding(CompanionMacMetrics.space * 2)
            } else if let actionMessage = model.actionMessage {
                Label(actionMessage, systemImage: "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(Color.companionMacSuccess)
                    .padding(CompanionMacMetrics.space * 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let companion = model.selectedCompanion {
            CompanionMacChatView(
                companion: companion,
                sessionStore: model.sessionStore,
                onCompanionChanged: { model.replaceProjection($0) },
                onSettings: { _ in inspectorVisible.toggle() },
                onOpenDesktop: { requestDesktop(for: $0) },
                onOpenControlPlugin: { provider, requestID in
                    openControlPlugin(
                        companionID: companion.id,
                        provider: provider,
                        requestID: requestID
                    )
                }
            )
            .id(companion.id)
            .environment(model.sessionStore)
            .inspector(isPresented: inspectorBinding) {
                CompanionMacInspectorView(
                    companion: companion,
                    sessionStore: model.sessionStore,
                    onCompanionChanged: { model.replaceProjection($0) },
                    onDelete: { companionToDelete = $0 },
                    onOpenProviders: { showingProviders = true },
                    onOpenPlugins: { showingPlugins = true }
                )
                .id(companion.id)
                .environment(model.sessionStore)
                .inspectorColumnWidth(
                    min: 320,
                    ideal: CompanionMacMetrics.inspectorWidth,
                    max: 480
                )
            }
        } else {
            CompanionMacWelcomeView {
                showingCreate = true
            }
        }
    }

    private var inspectorBinding: Binding<Bool> {
        Binding(
            get: { model.selectedCompanion != nil && inspectorVisible },
            set: { inspectorVisible = $0 }
        )
    }

    private func requestDesktop(for companion: CompanionSummary) {
        guard CompanionMacDesktopEligibility.evaluate(
                  access: companion.access,
                  runtimeState: companion.runtime.state
              ).canOpen else { return }
        desktopWindow.begin(
            companionID: companion.id,
            companionName: companion.name,
            access: companion.access
        )
        // The dedicated window owns the one-and-only mint request in its lifetime task. Keeping
        // the request there prevents a Window scene startup task and the toolbar path from racing
        // and rotating two signed stream URLs.
        openWindow(id: "companion-desktop")
    }

    private func openControlPlugin(companionID: String, provider: String, requestID: String) {
        guard var components = URLComponents(
            url: CompanionMacAppConfig.webURL.appending(path: "companions"),
            resolvingAgainstBaseURL: false
        ) else { return }
        components.queryItems = [
            URLQueryItem(name: "view", value: "plugins"),
            URLQueryItem(name: "control_companion", value: companionID),
            URLQueryItem(name: "connect", value: provider),
            URLQueryItem(name: "control_request", value: requestID),
        ]
        guard let url = components.url else { return }
        NSWorkspace.shared.open(url)
    }
}

struct CompanionMacWelcomeView: View {
    let create: () -> Void

    var body: some View {
        VStack(spacing: CompanionMacMetrics.space * 4) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 42, weight: .light))
                .foregroundStyle(Color.companionMacAccent)
            Text("Choose a Companion")
                .font(.title2.weight(.semibold))
            Text("Select a conversation from the roster, or create a Companion for this workspace.")
                .font(.callout)
                .foregroundStyle(Color.companionMacMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 430)
            Button("New Companion", systemImage: "plus", action: create)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.companionMacCanvas)
    }
}

private struct CompanionMacRosterSidebar: View {
    @Bindable var model: CompanionMacWorkspaceModel
    let session: Session
    let onSettings: (CompanionSummary) -> Void
    let onDelete: (CompanionSummary) -> Void
    let onNew: () -> Void
    let onMemberSettings: () -> Void
    let onProviders: () -> Void
    let onPlugins: () -> Void
    let onSignOut: () -> Void
    @State private var searchVisible = false
    @State private var showingNewSection = false
    @State private var newSectionName = ""
    @State private var pendingSectionCompanion: CompanionSummary?
    @State private var sectionToDelete: CompanionSection?

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Menu {
                    Text(session.user.email)
                    Divider()
                    Button("Member settings", systemImage: "person.crop.circle", action: onMemberSettings)
                    Button("Model providers", systemImage: "cpu", action: onProviders)
                    Button("Plugins", systemImage: "puzzlepiece.extension", action: onPlugins)
                    Divider()
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive, action: onSignOut)
                } label: {
                    CompanionMacAccountAvatar(name: session.user.name, email: session.user.email)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .help("Account")
                .accessibilityLabel("Account for \(session.user.email)")

                Spacer()
                bareHeaderButton("Search", systemImage: "magnifyingglass") {
                    searchVisible.toggle()
                }
                Button("New Companion", systemImage: "plus", action: onNew)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.plain)
                    .frame(width: 36, height: 36)
                    .help("New Companion")
                    .accessibilityIdentifier("roster.new.sidebar")
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, searchVisible ? 6 : 10)

            if searchVisible {
                TextField("Search Companions", text: $model.query)
                    .textFieldStyle(.roundedBorder)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
                    .accessibilityIdentifier("roster.search")
            }

            List(selection: $model.selectedCompanionID) {
                if model.loading && model.companions.isEmpty {
                    ProgressView("Loading…")
                        .frame(maxWidth: .infinity, alignment: .center)
                        .listRowSeparator(.hidden)
                } else if let error = model.errorMessage, model.companions.isEmpty {
                    CompanionMacErrorNotice(message: error)
                        .listRowSeparator(.hidden)
                    Button("Try again") {
                        Task { await model.refresh() }
                    }
                    .listRowSeparator(.hidden)
                } else if model.matchingCompanions.isEmpty {
                    Text(model.query.isEmpty ? "No Companions yet" : "No matches")
                        .font(.callout)
                        .foregroundStyle(Color.companionMacMuted)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, CompanionMacMetrics.space * 5)
                        .listRowSeparator(.hidden)
                } else {
                    ForEach(model.homeSections) { section in
                        Section {
                            if !section.isCollapsed || !model.query.isEmpty {
                                ForEach(section.companions) { companion in
                                    row(companion)
                                }
                            }
                        } header: {
                            sectionHeader(section)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .scrollContentBackground(.hidden)
            .accessibilityIdentifier("roster.list")
        }
        .background(Color.companionMacCanvas)
        .alert("New Section", isPresented: $showingNewSection) {
            TextField("Section name", text: $newSectionName)
            Button("Create") {
                model.createSection(named: newSectionName, moving: pendingSectionCompanion)
                pendingSectionCompanion = nil
                newSectionName = ""
            }
            .disabled(newSectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {
                pendingSectionCompanion = nil
                newSectionName = ""
            }
        } message: {
            Text(pendingSectionCompanion == nil
                 ? "Create a section for your Companion list."
                 : "The Companion will move into the new section.")
        }
        .confirmationDialog(
            "Delete \(sectionToDelete?.name ?? "section")?",
            isPresented: Binding(
                get: { sectionToDelete != nil },
                set: { if !$0 { sectionToDelete = nil } }
            ),
            presenting: sectionToDelete
        ) { section in
            Button("Delete Section", role: .destructive) {
                model.deleteSection(section)
                sectionToDelete = nil
            }
            Button("Cancel", role: .cancel) { }
        } message: { _ in
            Text("Companions in this section will move to Unassigned.")
        }
    }

    private func bareHeaderButton(
        _ label: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .semibold))
                .frame(width: 36, height: 36)
        }
        .buttonStyle(.plain)
        .help(label)
        .accessibilityLabel(label)
    }

    private func sectionHeader(_ section: CompanionHomeSection) -> some View {
        Button {
            model.toggleSection(section)
        } label: {
            HStack(spacing: 6) {
                Text(section.name)
                    .font(.system(size: 13))
                Image(systemName: section.isCollapsed && model.query.isEmpty ? "chevron.right" : "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                Spacer()
            }
            .foregroundStyle(Color.companionMacMuted)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !section.isUnassigned,
               let stored = model.sectionStore.sections.first(where: { $0.id == section.id }),
               stored.ownerID == session.user.id {
                Button("Delete Section", systemImage: "trash", role: .destructive) {
                    sectionToDelete = stored
                }
            }
        }
        .accessibilityLabel("\(section.name), \(section.companions.count) Companions")
        .accessibilityValue(section.isCollapsed && model.query.isEmpty ? "Collapsed" : "Expanded")
    }

    private func row(_ companion: CompanionSummary) -> some View {
        CompanionMacRosterRow(companion: companion)
            .tag(companion.id)
            .contextMenu {
                Button("Settings", systemImage: "gearshape") { onSettings(companion) }
                if companion.access.canDeleteCompanion {
                    Button("Duplicate", systemImage: "plus.square.on.square") {
                        model.duplicate(companion)
                    }
                    Menu("Move to", systemImage: "folder") {
                        ForEach(model.sectionStore.sections.filter { $0.ownerID == session.user.id }) { section in
                            Button(section.name) { model.move(companion, to: section.id) }
                        }
                        Button("Unassigned") { model.move(companion, to: nil) }
                        Divider()
                        Button("New Section") {
                            pendingSectionCompanion = companion
                            showingNewSection = true
                        }
                    }
                }
                Button(companion.muted ? "Unmute" : "Mute", systemImage: companion.muted ? "bell" : "bell.slash") {
                    model.toggleMuted(companion)
                }
                Button("Mark as unread", systemImage: "envelope.badge") {
                    model.markUnread(companion)
                }
                if companion.access.canDeleteCompanion {
                    Divider()
                    Button("Delete", systemImage: "trash", role: .destructive) { onDelete(companion) }
                }
            }
    }
}

private struct CompanionMacAccountAvatar: View {
    let name: String?
    let email: String

    var body: some View {
        Text(initials)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(CompanionIOSTheme.userBubbleText)
            .frame(width: 36, height: 36)
            .background(CompanionIOSTheme.userBubble, in: Circle())
            .accessibilityHidden(true)
    }

    private var initials: String {
        let source = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = (source?.isEmpty == false ? source! : email)
            .split(whereSeparator: { $0 == " " || $0 == "@" })
        return words.prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

private struct CompanionMacRosterRow: View {
    let companion: CompanionSummary

    var body: some View {
        HStack(spacing: 10) {
            CompanionMacAvatar(
                name: companion.name,
                icon: companion.icon,
                size: 36,
                thinking: companion.runtime.replying
            )

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(companion.name)
                        .font(.system(size: 17, weight: .semibold))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    CompanionStatusDot(status: statusState)
                    Text(relativeTime)
                        .font(.system(size: 12))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
                HStack(spacing: 6) {
                    Text(preview)
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if companion.unread {
                        Circle()
                            .fill(CompanionIOSTheme.linkBlue)
                            .frame(width: 6, height: 6)
                            .accessibilityLabel("Unread")
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(companion.name), \(statusState.accessibilityLabel), \(preview)\(companion.unread ? ", unread" : "")")
        .accessibilityIdentifier("roster.row.\(companion.id)")
    }

    private var preview: String {
        companion.lastMessage?.preview ?? companion.persona ?? "No messages yet"
    }

    private var statusState: CompanionStatusIndicatorState {
        CompanionStatusIndicatorState(runtime: companion.runtime)
    }

    private var relativeTime: String {
        guard let createdAt = companion.lastMessage?.createdAt,
              let date = ISO8601DateFormatter().date(from: createdAt) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let sixDaysAgo = calendar.date(byAdding: .day, value: -6, to: .now), date >= sixDaysAgo {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.month(.defaultDigits).day(.defaultDigits))
    }
}
