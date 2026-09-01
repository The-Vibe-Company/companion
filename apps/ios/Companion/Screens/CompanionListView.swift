import SwiftUI
import CompanionKit
import UIKit

@MainActor
struct CompanionListServices {
    let listCompanions: () async throws -> [CompanionSummary]
    let listSections: () async throws -> [CompanionSection]
    let createSection: (String) async throws -> CompanionSection
    let deleteSection: (String) async throws -> Void
    let assignSection: (String, String?) async throws -> CompanionSummary
    let deleteCompanion: (String, UUID) async throws -> CompanionOperationSummary
    let updateMemberState: (String, CompanionMemberStatePatch) async throws -> CompanionSummary
    let duplicateCompanion: (String) async throws -> CompanionSummary
}

struct CompanionListView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(NotificationCoordinator.self) private var notifications
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    let session: Session
    private let initialSnapshot: CompanionRosterSnapshot?
    private let services: CompanionListServices?
    private let chatServices: ChatServices?
    @State private var path: [CompanionRoute] = []
    @State private var rosterState = CompanionRosterState()
    @State private var sectionStore = CompanionSectionStore()
    @State private var query = ""
    @State private var loading = true
    @State private var error: String?
    @State private var reloadGeneration = 0
    @State private var showingCreateCompanion = false
    @State private var showingProviders = false
    @State private var showingPlugins = false
    @State private var pluginControlRequest: CompanionPluginControlRequest?
    @State private var showingMemberSettings = false
    @State private var companionToDelete: CompanionSummary?
    @State private var deleteRequestIDs: [String: UUID] = [:]
    @State private var deletingCompanionIDs: Set<String> = []
    @State private var rosterActionCompanionIDs: Set<String> = []
    @State private var showingSearch = false
    @State private var companionToMove: CompanionSummary?
    @State private var pendingNewSectionCompanion: CompanionSummary?
    @State private var sectionToDelete: CompanionSection?
    @State private var showingNewSection = false
    @State private var newSectionName = ""
    @State private var rosterNotice: String?
    @State private var rosterActionError: String?
    @State private var chatReadingPositions = CompanionChatReadingPositionStore()

    init(
        session: Session,
        initialSnapshot: CompanionRosterSnapshot? = nil,
        services: CompanionListServices? = nil,
        chatServices: ChatServices? = nil
    ) {
        self.session = session
        self.initialSnapshot = initialSnapshot
        self.services = services
        self.chatServices = chatServices
        _rosterState = State(initialValue: CompanionRosterState(
            companions: initialSnapshot?.companions ?? []
        ))
        _sectionStore = State(initialValue: CompanionSectionStore(
            sections: initialSnapshot?.sections ?? []
        ))
        _loading = State(initialValue: initialSnapshot == nil)
    }

    var body: some View {
        NavigationStack(path: $path) {
            rosterScreen
            .task(id: session.orgID) {
                await reload(silently: initialSnapshot != nil)
                while !Task.isCancelled {
                    let interval: UInt64 = companions.contains(where: hasActiveWork) ? 8 : 45
                    try? await Task.sleep(for: .seconds(interval))
                    if !Task.isCancelled { await reload(silently: true) }
                }
            }
            .task(id: mostRecentCompanionID) {
                guard services == nil,
                      scenePhase == .active,
                      let companionID = mostRecentCompanionID,
                      sessionStore.cachedThread(companionID: companionID) == nil else { return }
                if let measurement = try? await sessionStore.synchronizeThread(companionID: companionID) {
                    CompanionPerformanceTelemetry.syncCompleted(
                        surface: "thread-prefetch",
                        bytes: measurement.receivedBytes,
                        milliseconds: measurement.networkMilliseconds
                    )
                }
            }
            .onAppear { recordRosterFrame(isLoading: loading) }
            .onChange(of: loading) { _, isLoading in recordRosterFrame(isLoading: isLoading) }
            .onChange(of: path) { previous, next in recordChatOpen(from: previous, to: next) }
            .onChange(of: notifications.pendingDestination) { _, _ in
                openPendingNotificationIfPossible()
            }
            .onChange(of: scenePhase) { _, phase in reloadOnForeground(phase) }
            .tint(CompanionIOSTheme.textPrimary)
        }
    }

    // body is a single expression, and the Swift solver abandoned it once this chain grew. Each
    // property below is type-checked on its own, so the chain is split rather than shortened; the
    // modifier order, and therefore the behavior, is unchanged.
    private var rosterScreen: some View {
        rosterSheets
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
                Task { await delete(companion) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Its Box, thread, and Companion record will be permanently deleted. This cannot be undone.")
        }
        .confirmationDialog(
            moveCompanionDialogTitle,
            isPresented: Binding(
                get: { companionToMove != nil },
                set: { if !$0 { companionToMove = nil } }
            ),
            titleVisibility: .visible,
            presenting: companionToMove
        ) { companion in
            ForEach(ownedSections) { section in
                Button(section.name) { Task { await move(companion, to: section.id) } }
            }
            Button("Unassigned") { Task { await move(companion, to: nil) } }
            Button("New Section") {
                pendingNewSectionCompanion = companion
                newSectionName = ""
                showingNewSection = true
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert("New Section", isPresented: $showingNewSection) {
            TextField("Section name", text: $newSectionName)
            Button("Create") { Task { await createSectionAndMove() } }
                .disabled(newSectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The Companion will move into the new section.")
        }
        .confirmationDialog(
            "Delete \(sectionToDelete?.name ?? "section")?",
            isPresented: Binding(
                get: { sectionToDelete != nil },
                set: { if !$0 { sectionToDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: sectionToDelete
        ) { section in
            Button("Delete Section", role: .destructive) { Task { await deleteSection(section) } }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Companions in this section will move to Unassigned.")
        }
    }

    private var rosterSheets: some View {
        rosterSurface
        .sheet(isPresented: $showingCreateCompanion) {
            CreateCompanionView { companion in
                rosterState.prepend(companion)
                path = [.chat(companion.id)]
                Task { await reload(silently: true) }
            }
            .tint(CompanionIOSTheme.actionBlue)
        }
        .sheet(isPresented: $showingProviders) {
            ProviderManagementView()
                .tint(Color.companionAccent)
        }
        .sheet(isPresented: $showingPlugins, onDismiss: { pluginControlRequest = nil }) {
            PluginManagementView(controlRequest: pluginControlRequest)
                .tint(Color.companionAccent)
        }
        .sheet(isPresented: $showingMemberSettings) {
            MemberSettingsView(session: session)
                .tint(Color.companionAccent)
        }
    }

    private var rosterSurface: some View {
        CompanionIOSTheme.canvas
            .ignoresSafeArea()
            .overlay { rosterContent }
        // Install the widened leading-edge capture once for the whole stack so direct and
        // value-based pushes share the same guarded UIKit pop path.
        .companionNavigationSwipeBackEnabled()
        .navigationBarTitleDisplayMode(.inline)
        .navigationDestination(for: CompanionRoute.self) { route in
            destination(for: route)
        }
        .searchable(
            text: $query,
            isPresented: $showingSearch,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: "Search Companions"
        )
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Menu {
                    Text(session.user.email)
                    Divider()
                    Button("Member settings", systemImage: "person.crop.circle") {
                        showingMemberSettings = true
                    }
                    Button("Model providers", systemImage: "cpu") {
                        showingProviders = true
                    }
                    Button("Plugins", systemImage: "puzzlepiece.extension") {
                        showingPlugins = true
                    }
                    Divider()
                    Button("Sign out", systemImage: "rectangle.portrait.and.arrow.right") {
                        Task { await sessionStore.signOut() }
                    }
                } label: {
                    AccountAvatar(user: session.user)
                }
                .accessibilityLabel("Account for \(session.user.email)")
                .accessibilityIdentifier("account.menu")
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                headerToolbarButton("Search", systemImage: "magnifyingglass") {
                    showingSearch = true
                }
                headerToolbarButton("New Bot", systemImage: "plus") {
                    showingCreateCompanion = true
                }
            }
        }
    }

    private var rosterContent: some View {
        Group {
            if loading && companions.isEmpty {
                loadingState
            } else if let error, companions.isEmpty {
                errorState(error)
            } else if matchingCompanions.isEmpty {
                emptyState
            } else {
                roster
            }
        }
    }

    private var companions: [CompanionSummary] {
        rosterState.companions
    }

    private func reloadOnForeground(_ phase: ScenePhase) {
        guard phase == .active else { return }
        Task { await reload(silently: !companions.isEmpty) }
    }

    private func recordRosterFrame(isLoading: Bool) {
        guard !isLoading else { return }
        CompanionPerformanceTelemetry.rosterWillRender(
            cacheRestoreMilliseconds: sessionStore.initialCacheRestoreMilliseconds,
            companionCount: companions.count
        )
    }

    /// Times the transcript from the moment a chat becomes the visible route. A row push, a
    /// notification, and the details-to-chat replacement all arrive here, unlike a gesture on the
    /// row, which competes with the NavigationLink for the same touch.
    private func recordChatOpen(from previous: [CompanionRoute], to next: [CompanionRoute]) {
        guard next.last != previous.last,
              case .chat(let companionID)? = next.last else { return }
        CompanionPerformanceTelemetry.chatTapped(companionID: companionID)
    }

    private var roster: some View {
        List {
            if let rosterActionError {
                CompanionErrorNotice(message: rosterActionError)
                    .rosterListRow()
            } else if let rosterNotice {
                CompanionSuccessNotice(message: rosterNotice)
                    .rosterListRow()
            }

            ForEach(homeSections) { section in
                Section {
                    if !section.isCollapsed || !query.isEmpty {
                        ForEach(section.companions) { companionRow($0) }
                    }
                } header: {
                    sectionHeader(section)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await reload() }
        .scrollIndicators(.hidden)
    }

    private var loadingState: some View {
        List {
            ForEach(0..<5, id: \.self) { index in
                HStack(spacing: 12) {
                    Circle()
                        .fill(CompanionIOSTheme.card)
                        .frame(width: 36, height: 36)
                    VStack(alignment: .leading, spacing: 7) {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(CompanionIOSTheme.card)
                            .frame(width: index.isMultiple(of: 2) ? 112 : 146, height: 15)
                        RoundedRectangle(cornerRadius: 3)
                            .fill(CompanionIOSTheme.card)
                            .frame(maxWidth: index.isMultiple(of: 2) ? 214 : 176)
                            .frame(height: 12)
                    }
                }
                .frame(minHeight: 52)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollDisabled(true)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading Companions")
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Could not load Companions", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await reload() } }
                .buttonStyle(.glassProminent)
        }
        .padding(24)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(
                query.isEmpty ? "Create your first companion" : "No matches",
                systemImage: "bubble.left.and.bubble.right"
            )
        } description: {
            Text(query.isEmpty ? "Give your new companion a name and character to begin." : "Try a different name or message.")
        } actions: {
            if query.isEmpty {
                Button("Create", systemImage: "plus") {
                    showingCreateCompanion = true
                }
                .buttonStyle(.borderedProminent)
                .tint(CompanionIOSTheme.primaryCTA)
            }
        }
        .padding(24)
    }

    private var matchingCompanions: [CompanionSummary] {
        companions.filter(matchesSearch)
    }

    private var moveCompanionDialogTitle: String {
        let name = companionToMove?.name ?? "Companion"
        return "Move \(name) to"
    }

    private var mostRecentCompanionID: String? {
        companions.compactMap { companion in
            companion.lastMessage.map { (id: companion.id, createdAt: $0.createdAt) }
        }.max { $0.createdAt < $1.createdAt }?.id
    }

    private var homeSections: [CompanionHomeSection] {
        sectionStore.groups(companions: matchingCompanions)
    }

    private var ownedSections: [CompanionSection] {
        sectionStore.sections.filter { $0.ownerID == session.user.id }
    }

    private func matchesSearch(_ companion: CompanionSummary) -> Bool {
        guard !query.isEmpty else { return true }
        return companion.name.localizedStandardContains(query)
            || (companion.lastMessage?.preview.localizedStandardContains(query) ?? false)
            || (companion.persona?.localizedStandardContains(query) ?? false)
    }

    private func headerToolbarButton(
        _ label: String,
        systemImage: String,
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

    private func sectionHeader(_ section: CompanionHomeSection) -> some View {
        Button {
            withRosterAnimation { sectionStore.toggleCollapsed(sectionID: section.id) }
        } label: {
            HStack(spacing: 7) {
                Text(section.name)
                    .font(.system(size: 13))
                Image(systemName: section.isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                Spacer()
            }
            .foregroundStyle(CompanionIOSTheme.textSecondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .textCase(nil)
        .contextMenu {
            if !section.isUnassigned,
               let model = sectionStore.sections.first(where: { $0.id == section.id }),
               model.ownerID == session.user.id {
                Button("Delete Section", systemImage: "trash", role: .destructive) {
                    sectionToDelete = model
                }
            }
        }
    }

    @ViewBuilder
    private func companionRow(_ companion: CompanionSummary) -> some View {
        let busy = rosterActionCompanionIDs.contains(companion.id)
            || deletingCompanionIDs.contains(companion.id)
        NavigationLink(value: CompanionRoute.chat(companion.id)) {
            CompanionRow(
                companion: companion,
                deletionOperation: effectiveDeletion(for: companion)
            )
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityIdentifier("companion.row.\(companion.id)")
        .contextMenu { companionContextMenu(for: companion, busy: busy) }
        .swipeActions(edge: .trailing) {
            if companion.access.canDeleteCompanion {
                Button("Move to", systemImage: "folder") { companionToMove = companion }
                    .tint(CompanionIOSTheme.actionBlue)
            }
            Button(companion.muted ? "Unmute" : "Mute",
                   systemImage: companion.muted ? "bell" : "bell.slash") {
                Task { await updateMemberState(companion, patch: .init(muted: !companion.muted)) }
            }
                .tint(.gray)
            if canRequestDeletion(of: companion), !busy {
                Button("Delete", systemImage: "trash", role: .destructive) {
                    companionToDelete = companion
                }
            }
        }
        .accessibilityActions {
            Button(companion.pinned ? "Unpin" : "Pin") {
                Task { await updateMemberState(companion, patch: .init(pinned: !companion.pinned)) }
            }
            if !companion.unread {
                Button("Mark as unread") {
                    Task { await updateMemberState(companion, patch: .init(unread: true)) }
                }
            }
            if companion.access.canDeleteCompanion {
                Button("Duplicate") { Task { await duplicate(companion) } }
            }
            if canRequestDeletion(of: companion), !busy {
                Button("Delete") { companionToDelete = companion }
            }
        }
        .rosterListRow()
    }

    @ViewBuilder
    private func companionContextMenu(for companion: CompanionSummary, busy: Bool) -> some View {
        Button("Settings", systemImage: "gearshape") {
            path = [.details(companion.id)]
        }
        .disabled(busy)

        if companion.access.canDeleteCompanion {
            Button("Duplicate", systemImage: "plus.square.on.square") {
                Task { await duplicate(companion) }
            }
            .disabled(busy)
        }

        Button("Move to", systemImage: "folder") { companionToMove = companion }
            .disabled(!companion.access.canDeleteCompanion || busy)

        if companion.access.canDeleteCompanion {
            Divider()
            if deletingCompanionIDs.contains(companion.id) {
                Button("Deleting…", systemImage: "clock") {}
                    .disabled(true)
            } else if effectiveDeletion(for: companion)?.isActive == true {
                Button("Deletion requested", systemImage: "clock") {}
                    .disabled(true)
            } else {
                Button(deleteMenuLabel(for: companion), systemImage: "trash", role: .destructive) {
                    companionToDelete = companion
                }
                .disabled(busy)
            }
        }
    }

    private func reload(silently: Bool = false) async {
        reloadGeneration += 1
        let generation = reloadGeneration
        if !silently { loading = true }
        do {
            let next: [CompanionSummary]
            let nextSections: [CompanionSection]
            if let services {
                next = try await services.listCompanions()
                do {
                    nextSections = try await services.listSections()
                } catch {
                    nextSections = try CompanionSectionCompatibility.fallback(for: error)
                }
            } else {
                let measurement = try await sessionStore.synchronizeRoster()
                next = measurement.value.companions
                nextSections = measurement.value.sections
                CompanionPerformanceTelemetry.syncCompleted(
                    surface: "roster",
                    bytes: measurement.receivedBytes,
                    milliseconds: measurement.networkMilliseconds
                )
            }
            guard generation == reloadGeneration else { return }
            rosterState.reconcile(with: next)
            sectionStore.reconcile(with: nextSections)
            let nextIDs = Set(next.map(\.id))
            let reconciledDeletionIDs = Set(next.compactMap { companion in
                companion.deletionOperation == nil ? nil : companion.id
            })
            deleteRequestIDs = deleteRequestIDs.filter { companionID, _ in
                nextIDs.contains(companionID) && !reconciledDeletionIDs.contains(companionID)
            }
            if let missingRoute = path.last?.companionID, !nextIDs.contains(missingRoute) {
                path.removeAll()
            }
            error = nil
            loading = false
            openPendingNotificationIfPossible()
        } catch let apiError as APIError where apiError.status == 403 || apiError.status == 404 {
            guard generation == reloadGeneration else { return }
            error = "Hosted Companions are not enabled for this workspace."
        } catch {
            guard generation == reloadGeneration else { return }
            self.error = "The workspace roster is temporarily unavailable."
        }
        if generation == reloadGeneration { loading = false }
    }

    private func openPendingNotificationIfPossible() {
        guard !loading, let destination = notifications.pendingDestination else { return }
        guard destination.orgID == session.orgID else {
            notifications.discardPendingDestination()
            return
        }
        guard companions.contains(where: { $0.id == destination.companionID }) else {
            notifications.discardPendingDestination()
            return
        }
        if notifications.activeCompanionID == destination.companionID {
            notifications.requestTranscriptInvalidation(for: destination)
        }
        path = [.chat(destination.companionID)]
        notifications.consume(destination)
    }

    @ViewBuilder
    private func destination(for route: CompanionRoute) -> some View {
        if let companion = companions.first(where: { $0.id == route.companionID }) {
            switch route {
            case .chat(let companionID):
                ChatView(
                    companion: companion,
                    initialSnapshot: sessionStore.cachedThread(companionID: companionID),
                    readingPosition: chatReadingPositions.position(for: companionID),
                    onOpenPlugins: { provider, requestID in
                        if let provider, let requestID {
                            pluginControlRequest = CompanionPluginControlRequest(
                                provider: provider,
                                companionID: companionID,
                                requestID: requestID
                            )
                        }
                        showingPlugins = true
                    },
                    services: chatServices,
                    onReadingPositionChange: { position in
                        chatReadingPositions.record(position, for: companionID)
                    },
                    onDetails: { path.append(.details(companionID)) }
                )
                .onAppear { notifications.activeCompanionID = companionID }
                .onDisappear {
                    if notifications.activeCompanionID == companionID {
                        notifications.activeCompanionID = nil
                    }
                }
            case .details(let companionID):
                CompanionDetailView(
                    companion: companion,
                    onSaved: replace,
                    onOpenChat: { path = [.chat(companionID)] },
                    onDeletionStarted: beginOptimisticDeletion,
                    onDeletionAccepted: deletionAccepted,
                    onDeletionFailed: deletionFailed
                )
            }
        } else {
            ContentUnavailableView(
                "Companion unavailable",
                systemImage: "bubble.left.and.exclamationmark.bubble.right",
                description: Text("This Companion is no longer available in the workspace.")
            )
        }
    }

    private func replace(_ updated: CompanionSummary) {
        rosterState.replace(updated)
    }

    private func updateMemberState(
        _ companion: CompanionSummary,
        patch: CompanionMemberStatePatch
    ) async {
        guard !rosterActionCompanionIDs.contains(companion.id) else { return }
        rosterActionCompanionIDs.insert(companion.id)
        defer { rosterActionCompanionIDs.remove(companion.id) }
        rosterActionError = nil
        rosterNotice = nil
        do {
            let updated: CompanionSummary
            if let services {
                updated = try await services.updateMemberState(companion.id, patch)
            } else {
                updated = try await sessionStore.updateCompanionMemberState(
                    companionID: companion.id,
                    patch: patch
                )
            }
            withRosterAnimation {
                rosterState.replaceAndRepartition(updated)
            }
            rosterNotice = memberStateNotice(for: updated, patch: patch)
            AccessibilityNotification.Announcement(rosterNotice ?? "Companion updated.").post()
            await reload(silently: true)
        } catch {
            rosterActionError = companionDisplayMessage(
                error,
                fallback: "This Companion could not be updated."
            )
        }
    }

    private func duplicate(_ companion: CompanionSummary) async {
        guard companion.access.canDeleteCompanion,
              !rosterActionCompanionIDs.contains(companion.id) else { return }
        rosterActionCompanionIDs.insert(companion.id)
        defer { rosterActionCompanionIDs.remove(companion.id) }
        rosterActionError = nil
        rosterNotice = nil
        do {
            let duplicate: CompanionSummary
            if let services {
                duplicate = try await services.duplicateCompanion(companion.id)
            } else {
                duplicate = try await sessionStore.duplicateCompanion(companionID: companion.id)
            }
            withRosterAnimation { rosterState.prepend(duplicate) }
            rosterNotice = "\(duplicate.name) created."
            AccessibilityNotification.Announcement("\(duplicate.name) created.").post()
            path = [.details(duplicate.id)]
            await reload(silently: true)
        } catch {
            rosterActionError = companionDisplayMessage(
                error,
                fallback: "This Companion could not be duplicated."
            )
        }
    }

    private func memberStateNotice(
        for companion: CompanionSummary,
        patch: CompanionMemberStatePatch
    ) -> String {
        if let hidden = patch.hidden {
            return hidden ? "\(companion.name) hidden." : "\(companion.name) unhidden."
        }
        if let pinned = patch.pinned {
            return pinned ? "\(companion.name) pinned." : "\(companion.name) unpinned."
        }
        if let muted = patch.muted {
            return muted ? "\(companion.name) muted." : "\(companion.name) unmuted."
        }
        if patch.unread == true { return "\(companion.name) marked as unread." }
        return "\(companion.name) updated."
    }

    private func move(_ companion: CompanionSummary, to sectionID: String?) async {
        companionToMove = nil
        do {
            let updated: CompanionSummary
            if let services {
                updated = try await services.assignSection(companion.id, sectionID)
            } else {
                updated = try await sessionStore.assignCompanionSection(
                    companionID: companion.id,
                    sectionID: sectionID
                )
            }
            rosterState.replace(updated)
            let sectionName = sectionID.flatMap { id in
                sectionStore.sections.first(where: { $0.id == id })?.name
            }
            rosterNotice = sectionName.map { "\(companion.name) moved to \($0)." }
                ?? "\(companion.name) moved to Unassigned."
        } catch {
            rosterActionError = companionDisplayMessage(
                error,
                fallback: "Move failed. Choose a valid section and try again."
            )
        }
    }

    private func createSectionAndMove() async {
        guard let companion = pendingNewSectionCompanion else { return }
        pendingNewSectionCompanion = nil
        let name = newSectionName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        do {
            let section: CompanionSection
            if let services {
                section = try await services.createSection(name)
            } else {
                section = try await sessionStore.createCompanionSection(name: name)
            }
            sectionStore.reconcile(with: sectionStore.sections + [section])
            await move(companion, to: section.id)
        } catch {
            rosterActionError = companionDisplayMessage(error, fallback: "The section could not be created.")
        }
    }

    private func deleteSection(_ section: CompanionSection) async {
        sectionToDelete = nil
        do {
            if let services {
                try await services.deleteSection(section.id)
            } else {
                try await sessionStore.deleteCompanionSection(sectionID: section.id)
            }
            sectionStore.remove(sectionID: section.id)
            await reload(silently: true)
            rosterNotice = "\(section.name) deleted. Its Companions are Unassigned."
        } catch {
            rosterActionError = companionDisplayMessage(error, fallback: "The section could not be deleted.")
        }
    }

    private func withRosterAnimation(_ updates: () -> Void) {
        if reduceMotion {
            updates()
        } else {
            withAnimation(.easeOut(duration: 0.2)) { updates() }
        }
    }

    private func effectiveDeletion(for companion: CompanionSummary) -> CompanionOperationSummary? {
        companion.deletionOperation
    }

    private func canRequestDeletion(of companion: CompanionSummary) -> Bool {
        companion.access.canDeleteCompanion
            && !deletingCompanionIDs.contains(companion.id)
            && effectiveDeletion(for: companion)?.isActive != true
    }

    private func hasActiveWork(_ companion: CompanionSummary) -> Bool {
        companion.runtime.replying
            || companion.runtime.state == .provisioning
            || companion.runtime.state == .stopping
            || companion.runtime.latestOperation?.isActive == true
            || deletingCompanionIDs.contains(companion.id)
            || deleteRequestIDs[companion.id] != nil
            || effectiveDeletion(for: companion)?.isActive == true
    }

    private func deleteMenuLabel(for companion: CompanionSummary) -> String {
        if deleteRequestIDs[companion.id] != nil { return "Retry Delete" }
        guard let operation = effectiveDeletion(for: companion) else { return "Delete Companion" }
        if operation.status == .failed || operation.status == .interrupted || operation.status == .cancelled {
            return "Retry Delete"
        }
        return "Delete Companion"
    }

    private func delete(_ companion: CompanionSummary) async {
        guard companion.access.canDeleteCompanion,
              !deletingCompanionIDs.contains(companion.id) else { return }
        deletingCompanionIDs.insert(companion.id)
        defer { deletingCompanionIDs.remove(companion.id) }
        rosterActionError = nil
        rosterNotice = nil
        let requestID = deleteRequestIDs[companion.id] ?? UUID()
        deleteRequestIDs[companion.id] = requestID
        beginOptimisticDeletion(companion, requestID)
        do {
            let operation: CompanionOperationSummary
            if let services {
                operation = try await services.deleteCompanion(companion.id, requestID)
            } else {
                operation = try await sessionStore.deleteCompanion(
                    companionID: companion.id,
                    requestID: requestID
                )
            }
            deleteRequestIDs[companion.id] = nil
            deletionAccepted(companion.id, operation)
        } catch {
            deletionFailed(companion, requestID, error)
        }
        companionToDelete = nil
    }

    private func beginOptimisticDeletion(_ companion: CompanionSummary, _ requestID: UUID) {
        deleteRequestIDs[companion.id] = requestID
        deletingCompanionIDs.insert(companion.id)
        companionToDelete = nil
        rosterActionError = nil
        rosterNotice = nil
        path.removeAll()
        if notifications.activeCompanionID == companion.id {
            notifications.activeCompanionID = nil
        }
        if notifications.pendingDestination?.companionID == companion.id {
            notifications.discardPendingDestination()
        }
        if reduceMotion {
            rosterState.removeOptimistically(companionID: companion.id)
        } else {
            withAnimation(.easeOut(duration: 0.2)) {
                rosterState.removeOptimistically(companionID: companion.id)
            }
        }
        AccessibilityNotification.Announcement("\(companion.name) removed.").post()
    }

    private func deletionAccepted(_ companionID: String, _ operation: CompanionOperationSummary) {
        deletingCompanionIDs.remove(companionID)
        deleteRequestIDs[companionID] = nil
        let restored = reconcileDeletionResponse(companionID: companionID, operation: operation)
        guard operation.isActive else {
            let name = restored?.name
                ?? companions.first(where: { $0.id == companionID })?.name
                ?? "Companion"
            let message = operation.error?.message ?? "\(name) could not be deleted."
            rosterActionError = restored == nil ? message : "\(message) \(name) was restored."
            rosterNotice = nil
            announceRestoration(restored)
            return
        }
        rosterActionError = nil
        rosterNotice = "Deletion requested."
    }

    private func deletionFailed(_ companion: CompanionSummary, _ requestID: UUID, _ cause: Error) {
        deletingCompanionIDs.remove(companion.id)
        let restored = restoreOptimisticDeletion(companionID: companion.id)
        guard restored != nil || rosterState.contains(companionID: companion.id) else {
            deleteRequestIDs[companion.id] = nil
            rosterActionError = nil
            rosterNotice = "Deletion completed."
            return
        }
        deleteRequestIDs[companion.id] = requestID
        if let apiError = cause as? APIError, apiError.status == 0 {
            rosterActionError = restored == nil
                ? "Deletion could not be confirmed. Retrying reuses the same request."
                : "Deletion could not be confirmed. \(companion.name) was restored. Retrying reuses the same request."
        } else {
            let message = companionDisplayMessage(
                cause,
                fallback: "This Companion could not be deleted."
            )
            rosterActionError = restored == nil ? message : "\(message) \(companion.name) was restored."
        }
        rosterNotice = nil
        announceRestoration(restored)
    }

    private func restoreOptimisticDeletion(companionID: String) -> CompanionSummary? {
        if reduceMotion {
            return rosterState.restoreDeletion(companionID: companionID)
        }
        var restored: CompanionSummary?
        withAnimation(.easeOut(duration: 0.2)) {
            restored = rosterState.restoreDeletion(companionID: companionID)
        }
        return restored
    }

    private func reconcileDeletionResponse(
        companionID: String,
        operation: CompanionOperationSummary
    ) -> CompanionSummary? {
        if reduceMotion {
            return rosterState.reconcileDeletionResponse(companionID: companionID, operation: operation)
        }
        var restored: CompanionSummary?
        withAnimation(.easeOut(duration: 0.2)) {
            restored = rosterState.reconcileDeletionResponse(companionID: companionID, operation: operation)
        }
        return restored
    }

    private func announceRestoration(_ companion: CompanionSummary?) {
        guard let companion else { return }
        AccessibilityNotification.Announcement("\(companion.name) could not be deleted and was restored.").post()
    }
}

private struct AccountAvatar: View {
    @Environment(SessionStore.self) private var sessionStore
    let user: Session.User
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Circle()
                    .fill(CompanionIOSTheme.card)
                    .overlay {
                        Text(initials)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(CompanionIOSTheme.textPrimary)
                    }
            }
        }
        .frame(width: 44, height: 44)
        .clipShape(Circle())
        .task(id: user.avatarURL) {
            guard let avatarURL = user.avatarURL,
                  let data = try? await sessionStore.userAvatarData(at: avatarURL),
                  let loaded = UIImage(data: data) else { return }
            image = loaded
        }
    }

    private var initials: String {
        let source = user.name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = (source?.isEmpty == false ? source! : user.email)
            .split(whereSeparator: { $0 == " " || $0 == "@" || $0 == "." })
        return parts.prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

#if DEBUG
struct CompanionRosterDemoView: View {
    @State private var demoState = CompanionRosterDemoState()

    private let access: CompanionAccess

    init() {
        let rawAccess = ProcessInfo.processInfo.environment["COMPANION_ROSTER_DEMO_ACCESS"] ?? "owner"
        access = CompanionAccess(rawValue: rawAccess) ?? .viewer
    }

    var body: some View {
        CompanionListView(
            session: CompanionRosterDemoFixtures.session,
            services: CompanionListServices(
                listCompanions: {
                    CompanionRosterDemoFixtures.companions(access: access)
                },
                listSections: { [CompanionRosterDemoFixtures.section] },
                createSection: { _ in CompanionRosterDemoFixtures.section },
                deleteSection: { _ in },
                assignSection: { _, _ in CompanionRosterDemoFixtures.companion(access: access) },
                deleteCompanion: { companionID, requestID in
                    try demoState.delete(companionID: companionID, requestID: requestID)
                },
                updateMemberState: { _, patch in
                    CompanionRosterDemoFixtures.companion(
                        access: access,
                        pinned: patch.pinned ?? false,
                        hidden: patch.hidden ?? false,
                        unread: patch.unread ?? false
                    )
                },
                duplicateCompanion: { _ in
                    CompanionRosterDemoFixtures.companion(
                        id: "e87357f6-b1b7-4afe-bb6c-fd196ec46065",
                        name: "Luna copy",
                        access: access
                    )
                }
            ),
            chatServices: CompanionRosterDemoFixtures.chatServices(access: access)
        )
    }
}

@MainActor
private final class CompanionRosterDemoState {
    private var firstRequestID: UUID?

    func delete(companionID: String, requestID: UUID) throws -> CompanionOperationSummary {
        guard companionID == CompanionRosterDemoFixtures.companionID else {
            throw APIError(status: 404, code: "not_found", message: "Companion not found.")
        }
        if firstRequestID == nil {
            firstRequestID = requestID
            throw APIError(status: 0, code: "network_error", message: "The server could not be reached.")
        }
        guard firstRequestID == requestID else {
            throw APIError(status: 400, code: "idempotency_mismatch", message: "The delete request changed unexpectedly.")
        }
        return CompanionRosterDemoFixtures.deleteOperation
    }
}

@MainActor
private enum CompanionRosterDemoFixtures {
    static let companionID = "c96ab360-00f3-4497-a51a-51442db8add1"
    static let secondCompanionID = "d96ab360-00f3-4497-a51a-51442db8add2"
    static let thirdCompanionID = "e96ab360-00f3-4497-a51a-51442db8add3"
    static let showsThreeCompanions = ProcessInfo.processInfo.environment[
        "COMPANION_ROSTER_DEMO_THREE"
    ] == "1"
    static let usesLongThread = ProcessInfo.processInfo.environment[
        "COMPANION_ROSTER_DEMO_LONG_THREAD"
    ] == "1"

    static let section: CompanionSection = decode(#"""
    {
      "id":"1c6759e2-58d2-4b0e-8f99-6cd73175f85a",
      "org_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "owner_id":"demo-user",
      "name":"Favorites",
      "position":0,
      "created_at":"2026-08-27T00:00:00Z",
      "updated_at":"2026-08-27T00:00:00Z"
    }
    """#)

    static let session = Session(
        cookie: "demo-session",
        orgID: "demo-org",
        needsOnboarding: false,
        user: .init(id: "demo-user", email: "demo@example.com", name: "Demo")
    )

    static func companions(access: CompanionAccess) -> [CompanionSummary] {
        guard showsThreeCompanions else { return [companion(access: access)] }
        return [
            companion(access: access),
            companion(
                id: secondCompanionID,
                name: "Nova",
                access: access,
                replying: true
            ),
            companion(
                id: thirdCompanionID,
                name: "Orbit",
                access: access,
                runtimeState: .error
            ),
        ]
    }

    static func companion(
        id: String = companionID,
        name: String = "Luna",
        access: CompanionAccess,
        pinned: Bool = false,
        hidden: Bool = false,
        unread: Bool = false,
        runtimeState: CompanionRuntimeState = .running,
        replying: Bool = false
    ) -> CompanionSummary {
        decode(#"""
        {
          "id":"\#(id)",
          "name":"\#(name)",
          "persona":"Keep releases calm",
          "model_id":"claude-sonnet",
          "selected_skill_ids":["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"],
          "icon":{"shape":6,"mouth":1,"accessory":6,"color":2},
          "access":"\#(access.rawValue)",
          "pinned":\#(pinned),
          "hidden":\#(hidden),
          "unread":\#(unread),
          "last_message":{"preview":"Release notes are ready.","role":"assistant","created_at":"2026-08-25T08:00:00.000Z"},
          "runtime":{"state":"\#(runtimeState.rawValue)","replying":\#(replying),"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}
        }
        """#)
    }

    static var deleteOperation: CompanionOperationSummary {
        decode(#"""
        {
          "id":"14757274-8d64-455c-a394-334665a258f0",
          "kind":"delete",
          "status":"pending",
          "error":null
        }
        """#)
    }

    static func chatServices(access: CompanionAccess) -> ChatServices {
        let currentCompanion = companion(access: access, replying: true)
        let baseThread: CompanionThread = decode(#"""
        {
          "companion_id":"c96ab360-00f3-4497-a51a-51442db8add1",
          "viewer_id":"demo-user",
          "read_only":\#(access == .viewer ? "true" : "false"),
          "can_send":\#(access == .viewer ? "false" : "true"),
          "entries":[],
          "active_turn":{
            "id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "companion_id":"c96ab360-00f3-4497-a51a-51442db8add1",
            "client_message_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "status":"running",
            "queue_sequence":1,
            "latest_attempt":{
              "id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              "turn_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "attempt_number":1,
              "retry_id":null,
              "status":"running",
              "dispatch_state":"accepted",
              "pi_invocation_id":"pi-demo",
              "dispatch_accepted_at":"2026-08-28T10:00:01.000Z",
              "error":null,
              "started_at":"2026-08-28T10:00:00.000Z",
              "settled_at":null
            },
            "replying":true,
            "error":null,
            "state_changed_at":"2026-08-28T10:00:00.000Z",
            "settled_at":null,
            "created_at":"2026-08-28T10:00:00.000Z",
            "updated_at":"2026-08-28T10:00:00.000Z"
          },
          "queued_count":0,
          "interrupted_turn":null
        }
        """#)
        let currentThread = usesLongThread ? longThread(from: baseThread) : baseThread
        let desktop: CompanionDesktop = decode(#"""
        {
          "desktop_url":null,
          "provisioning":true,
          "automation":"lux",
          "transport":null
        }
        """#)
        return ChatServices(
            thread: { _ in currentThread },
            listCompanions: { [currentCompanion] },
            decide: { _, _, _ in currentThread },
            retryTurn: { _, _, _ in deleteOperation },
            cancelTurn: { _, _ in currentThread },
            listSkills: { [] },
            listPlugins: { [] },
            listProviders: { providers },
            openDesktop: { _ in desktop }
        )
    }

    private static func longThread(from baseThread: CompanionThread) -> CompanionThread {
        let encoded = try! JSONEncoder().encode(baseThread)
        var payload = try! JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        payload["entries"] = (1...36).map { index in
            let isAssistant = index.isMultiple(of: 2)
            return [
                "event_id": "roster-long-\(index)",
                "ordinal": index,
                "role": isAssistant ? "assistant" : "user",
                "content": "Navigation regression message \(index). Keep the thread long enough to verify a pop while reading earlier messages.",
                "author_id": isAssistant ? NSNull() : "demo-user" as Any,
                "author_name": isAssistant ? NSNull() : "Demo" as Any,
                "decision": NSNull(),
                "tool": NSNull(),
                "queued": false,
                "attachments": [Any](),
                "created_at": String(
                    format: "2026-08-28T10:%02d:00.000Z",
                    index
                ),
            ] as [String: Any]
        }
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(CompanionThread.self, from: data)
    }

    private static var providers: CompanionProvidersResponse {
        decode(#"""
        {
          "catalog":[{
            "id":"anthropic",
            "name":"Claude",
            "auth_methods":["api_key"],
            "description":"Claude models",
            "models":[{"id":"claude-sonnet","name":"Sonnet","default":true}]
          }],
          "connections":[],
          "default_provider_id":"anthropic",
          "can_manage":true
        }
        """#)
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}
#endif

private extension View {
    func rosterListRow(verticalInset: CGFloat = 6) -> some View {
        listRowInsets(
            EdgeInsets(top: verticalInset, leading: 16, bottom: verticalInset, trailing: 16)
        )
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }
}

private enum CompanionRoute: Hashable {
    case chat(String)
    case details(String)

    var companionID: String {
        switch self {
        case .chat(let id), .details(let id): return id
        }
    }
}

private struct CompanionRow: View {
    let companion: CompanionSummary
    let deletionOperation: CompanionOperationSummary?

    var body: some View {
        HStack(spacing: 12) {
            CharacterMark(name: companion.name, icon: companion.icon, size: 36)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .center, spacing: 0) {
                    Text(companion.name)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 8)
                    Text(timeLabel)
                        .font(.system(size: 13))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                    CompanionStatusDot(runtime: companion.runtime)
                        .frame(width: 18, alignment: .leading)
                }

                HStack(alignment: .center, spacing: 8) {
                    Text(preview)
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if companion.unread {
                        Circle()
                            .fill(CompanionIOSTheme.actionBlue)
                            .frame(width: 6, height: 6)
                            .accessibilityLabel("Unread")
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(companion.name), \(status.accessibilityLabel), \(preview)\(companion.unread ? ", unread" : "")"
        )
    }

    private var preview: String {
        guard let deletionOperation else {
            return companion.lastMessage?.preview ?? companion.persona ?? "No messages yet"
        }
        if deletionOperation.isActive { return "Deletion requested" }
        if let message = deletionOperation.error?.message { return message }
        return companion.lastMessage?.preview ?? companion.persona ?? "No messages yet"
    }

    private var status: CompanionStatusIndicatorState {
        CompanionStatusIndicatorState(runtime: companion.runtime)
    }

    private var timeLabel: String {
        guard let value = companion.lastMessage?.createdAt,
              let date = Self.parseDate(value) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) {
            return date.formatted(date: .omitted, time: .shortened)
        }
        if calendar.isDateInYesterday(date) { return "Yesterday" }
        if let days = calendar.dateComponents(
            [.day],
            from: calendar.startOfDay(for: date),
            to: calendar.startOfDay(for: .now)
        ).day, days >= 0, days < 7 {
            return date.formatted(.dateTime.weekday(.wide))
        }
        return date.formatted(.dateTime.month(.defaultDigits).day())
    }

    private static func parseDate(_ value: String) -> Date? {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return precise.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}

private struct CompanionUnreadBadge: View {
    let count: Int
    let tint: Color

    var body: some View {
        Group {
            if count == 1 {
                Circle()
                    .fill(tint)
                    .frame(width: 10, height: 10)
            } else {
                Text(count > 9 ? "9+" : "\(count)")
                    .font(.caption2.monospacedDigit().weight(.bold))
                    .foregroundStyle(Color.companionInk)
                    .padding(.horizontal, 6)
                    .frame(minWidth: 22, minHeight: 22)
                    .background(tint, in: Capsule())
            }
        }
        .accessibilityLabel(count == 1 ? "1 unread message" : "\(count) unread messages")
    }
}
