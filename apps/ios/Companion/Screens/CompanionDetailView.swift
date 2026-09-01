import SwiftUI
import CompanionKit
import UIKit

struct CompanionDetailView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(NotificationCoordinator.self) private var notifications
    @Environment(\.dismiss) private var dismiss

    let companion: CompanionSummary
    let onSaved: (CompanionSummary) -> Void
    /// Replaces the detail route with the existing chat route. The roster owns this replacement
    /// so opening chat from details never creates a second chat/detail cycle on the stack.
    let onOpenChat: () -> Void
    let onDeletionStarted: (CompanionSummary, UUID) -> Void
    let onDeletionAccepted: (String, CompanionOperationSummary) -> Void
    let onDeletionFailed: (CompanionSummary, UUID, Error) -> Void
    private let services: CompanionDetailServices?

    @State private var model: CompanionBotDetailSheetModel
    @State private var editingTitle = false
    @State private var showingCharacterPicker = false
    @State private var showingInstructions = false
    @State private var showingNewRoutine = false
    @State private var providers: CompanionProvidersResponse?
    @State private var providerID: String
    @State private var modelID: String
    @State private var loadingProviders = true
    @State private var savingModel = false
    @State private var providerModelSelectionRevision = 0
    @State private var deleting = false
    @State private var confirmingDelete = false
    @State private var showingProviders = false
    @State private var deleteRequestID: UUID?
    @State private var success: String?
    @State private var routinesLoading = true
    @State private var savingIdentity = false
    @State private var savingNotifications = false
    @State private var error: String?
    @AppStorage private var notificationsEnabled: Bool
    @AppStorage(CompanionPreferenceKeys.notifications) private var globalNotificationsEnabled = true
    @FocusState private var titleFocused: Bool

    init(
        companion: CompanionSummary,
        onSaved: @escaping (CompanionSummary) -> Void,
        onOpenChat: @escaping () -> Void = {},
        onDeletionStarted: @escaping (CompanionSummary, UUID) -> Void = { _, _ in },
        onDeletionAccepted: @escaping (String, CompanionOperationSummary) -> Void,
        onDeletionFailed: @escaping (CompanionSummary, UUID, Error) -> Void = { _, _, _ in },
        services: CompanionDetailServices? = nil
    ) {
        self.companion = companion
        self.onSaved = onSaved
        self.onOpenChat = onOpenChat
        self.onDeletionStarted = onDeletionStarted
        self.onDeletionAccepted = onDeletionAccepted
        self.onDeletionFailed = onDeletionFailed
        self.services = services
        _model = State(initialValue: CompanionBotDetailSheetModel(companion: companion))
        _providerID = State(initialValue: companion.runtime.providerIDs.first ?? "")
        _modelID = State(initialValue: companion.modelID ?? "")
        _notificationsEnabled = AppStorage(
            wrappedValue: !companion.muted,
            CompanionPreferenceKeys.notificationPrefix + companion.id
        )
    }

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 22) {
                    CompanionSheetHeader(
                        title: "Bot details",
                        leadingStyle: .back,
                        leadingAction: { dismiss() }
                    ) {
                        Button("Open chat", systemImage: "bubble.left.and.bubble.right") {
                            onOpenChat()
                        }
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.actionBlue)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("companion.details.open-chat")
                    }

                    characterHero
                    titleCard
                    if let error { CompanionErrorNotice(message: error) }
                    if let success { CompanionSuccessNotice(message: success) }
                    characterSection
                    instructionsCard
                    intelligenceSection
                    routinesSection
                    resourceSections
                    notificationsCard
                    if canDelete { deletionSection }

                    if !canEdit {
                        Text("You have read-only access to this Bot.")
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 4)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 36)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .toolbar(.hidden, for: .navigationBar)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task(id: companion.id) {
            synchronizeNotificationPreference(with: companion)
            await loadProviders()
            await loadRoutines()
        }
        .onChange(of: companion) { _, updated in
            let preservesProviderDraft = changedProviderOrModel
            model = CompanionBotDetailSheetModel(companion: updated, routines: model.routines)
            if !preservesProviderDraft {
                providerID = updated.runtime.providerIDs.first ?? providerID
                modelID = updated.modelID ?? modelID
            }
            synchronizeNotificationPreference(with: updated)
        }
        .onChange(of: providerID) { _, _ in selectDefaultModel() }
        .onChange(of: titleFocused) { _, focused in
            if !focused, editingTitle { requestIdentitySave() }
        }
        .sheet(isPresented: $showingCharacterPicker) {
            CompanionCharacterPickerSheet(icon: model.icon) { icon in
                model.icon = icon
                showingCharacterPicker = false
                requestIdentitySave()
            }
        }
        .sheet(isPresented: $showingInstructions) {
            CompanionInstructionsSheet(companion: model.companion) { persona in
                try await update(persona: persona)
            } onSaved: { updated in
                apply(updated)
                showingInstructions = false
            }
        }
        .sheet(isPresented: $showingNewRoutine) {
            CompanionRoutineEditorView(
                memberTimezone: sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier,
                memberTimezoneWasUnset: sessionStore.memberTimezone == nil,
                saveMemberTimezone: { identifier in
                    let profile = try await sessionStore.updateUserProfile(timezone: identifier)
                    return profile.timezone ?? identifier
                },
                create: { try await createRoutine($0) },
                update: { id, input in try await updateRoutine(id: id, input: input) }
            ) {
                showingNewRoutine = false
                Task { await loadRoutines() }
            }
        }
        .sheet(isPresented: $showingProviders, onDismiss: { Task { await loadProviders() } }) {
            ProviderManagementView()
        }
        .confirmationDialog(
            "Delete \(model.companion.name)?",
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete Companion", role: .destructive) {
                Task { await deleteCompanion() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its Box, thread, and Companion record will be permanently deleted. This cannot be undone.")
        }
    }

    private var characterHero: some View {
        Button {
            guard canEdit, !savingModel, !savingIdentity else { return }
            showingCharacterPicker = true
            UISelectionFeedbackGenerator().selectionChanged()
        } label: {
            CharacterMark(name: model.name, icon: model.icon, size: 104)
                .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
        .disabled(!canEdit || savingModel || savingIdentity)
        .accessibilityLabel(canEdit ? "Change \(model.name)'s character" : "\(model.name)'s character")
        .accessibilityIdentifier("companion.details.character")
    }

    private var titleCard: some View {
        CompanionSheetCard {
            HStack(spacing: 12) {
                if editingTitle && canEdit {
                    TextField("Bot name", text: $model.name)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                        .focused($titleFocused)
                        .submitLabel(.done)
                        .onSubmit { titleFocused = false }
                        .accessibilityIdentifier("companion.details.name")
                } else {
                    Text(model.name)
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                }
                Spacer()
                if savingIdentity {
                    ProgressView().controlSize(.small)
                } else if canEdit {
                    Button {
                        editingTitle = true
                        titleFocused = true
                    } label: {
                        Image(systemName: "pencil")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .disabled(savingModel)
                    .accessibilityLabel("Edit Bot name")
                }
            }
            .padding(.leading, 16)
            .padding(.trailing, 6)
            .frame(minHeight: 64)
        }
    }

    private var characterSection: some View {
        CompanionSheetSection("Character") {
            CompanionSheetCard {
                CompanionCharacterControls(
                    icon: $model.icon,
                    canEdit: canEdit && !savingModel && !savingIdentity
                ) {
                    requestIdentitySave()
                }
                CompanionSheetSeparator()
                Button {
                    model.icon = defaultIcon
                    requestIdentitySave()
                } label: {
                    CompanionSheetValueRow(
                        title: "Reset to default",
                        showsChevron: false
                    )
                }
                .buttonStyle(.plain)
                .disabled(!canEdit || savingModel || savingIdentity || model.icon == defaultIcon)
            }
            Text("How this Bot's mark looks everywhere")
                .font(.system(size: 15))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 4)
        }
    }

    private var instructionsCard: some View {
        CompanionSheetCard {
            Button { showingInstructions = true } label: {
                CompanionSheetValueRow(
                    title: "Instructions",
                    detail: instructionPreview,
                    symbol: "doc.text"
                )
            }
            .buttonStyle(.plain)
            .disabled(!canEdit || savingModel || savingIdentity)
            .accessibilityIdentifier("companion.details.instructions")
        }
    }

    private var intelligenceSection: some View {
        CompanionSheetSection("Intelligence") {
            CompanionSheetCard {
                if loadingProviders && providers == nil {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading model providers…")
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if connectedProviders.isEmpty {
                    CompanionSheetValueRow(
                        title: "No connected model provider",
                        detail: "Connect a provider to choose the model this Companion uses.",
                        symbol: "cpu",
                        showsChevron: false
                    )
                    CompanionSheetSeparator()
                    Button("Try again", systemImage: "arrow.clockwise") {
                        Task { await loadProviders() }
                    }
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .padding(.horizontal, 16)
                } else {
                    providerSelectionRow
                    if selectedProvider != nil {
                        CompanionSheetSeparator()
                        modelSelectionRow
                    }
                }
            }
            if canEdit && providers?.canManage == true {
                manageProvidersCard
            }
            Text("Provider and model changes are applied between turns. Saving never wakes an asleep Box.")
                .font(.system(size: 15))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 4)
        }
    }

    private var providerSelectionRow: some View {
        Menu {
            ForEach(connectedProviders) { provider in
                Button {
                    selectProvider(provider)
                } label: {
                    if provider.id == providerID {
                        Label(provider.name, systemImage: "checkmark")
                    } else {
                        Text(provider.name)
                    }
                }
                .accessibilityIdentifier("companion.details.provider.option.\(provider.id)")
            }
        } label: {
            selectionValueRow(
                title: "Provider",
                value: selectedProvider?.name ?? providerID,
                symbol: "cpu"
            )
        }
        .buttonStyle(.plain)
        .disabled(!canEdit || savingModel || savingIdentity || editingTitle)
        .accessibilityLabel("Provider, \(selectedProvider?.name ?? providerID)")
        .accessibilityValue(savingModel ? "Updating" : "")
        .accessibilityHint(canEdit ? "Choose a connected model provider." : "Read only.")
        .accessibilityIdentifier("companion.details.provider")
    }

    private var modelSelectionRow: some View {
        Menu {
            if let selectedProvider {
                ForEach(selectedProvider.models) { option in
                    Button {
                        selectModel(option)
                    } label: {
                        if option.id == modelID {
                            Label(option.name, systemImage: "checkmark")
                        } else {
                            Text(option.name)
                        }
                    }
                    .accessibilityIdentifier("companion.details.model.option.\(option.id)")
                }
            }
        } label: {
            selectionValueRow(
                title: "Model",
                value: selectedModel?.name ?? modelID,
                symbol: "sparkles"
            )
        }
        .buttonStyle(.plain)
        .disabled(
            !canEdit
                || savingModel
                || savingIdentity
                || editingTitle
                || selectedProvider?.models.isEmpty != false
        )
        .accessibilityLabel("Model, \(selectedModel?.name ?? modelID)")
        .accessibilityValue(savingModel ? "Updating" : "")
        .accessibilityHint(canEdit ? "Choose a model for the selected provider." : "Read only.")
        .accessibilityIdentifier("companion.details.model")
    }

    private var manageProvidersCard: some View {
        CompanionSheetCard {
            Button {
                guard !savingModel, !savingIdentity, !editingTitle else { return }
                showingProviders = true
            } label: {
                CompanionSheetValueRow(
                    title: "Manage providers",
                    value: connectedProviderCountLabel,
                    symbol: "slider.horizontal.3"
                )
            }
            .buttonStyle(.plain)
            .disabled(savingModel || savingIdentity || editingTitle)
            .accessibilityHint("Manage connected model providers.")
            .accessibilityIdentifier("companion.details.providers.manage")
        }
    }

    private func selectionValueRow(
        title: String,
        value: String,
        symbol: String
    ) -> some View {
        CompanionSheetValueRow(
            title: title,
            value: value.isEmpty ? "Not set" : value,
            symbol: symbol,
            showsProgress: savingModel
        )
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var resourceSections: some View {
        CompanionResourceSections(
            companion: model.companion,
            hasUnsavedSettings: changedProviderOrModel,
            onCompanionUpdated: { updated in apply(updated) },
            services: resourceServices
        )
        .padding(.top, 2)
    }

    private var deletionSection: some View {
        CompanionSheetSection("Delete Companion") {
            CompanionSheetCard {
                Button(deleteLabel, systemImage: "trash", role: .destructive) {
                    confirmingDelete = true
                }
                .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                .padding(.horizontal, 16)
                .disabled(deleting || deletionActive)
                .accessibilityIdentifier("companion.details.delete")

                if let message = model.companion.deletionOperation?.error?.message {
                    Text(message)
                        .font(.system(size: 14))
                        .foregroundStyle(CompanionIOSTheme.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 14)
                }
            }
            Text("Permanently deletes its Box and transcript. This cannot be undone.")
                .font(.system(size: 15))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 4)
        }
    }

    private var routinesSection: some View {
        CompanionSheetSection("Routines") {
            CompanionSheetCard {
                if routinesLoading && model.routines.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Loading routines…")
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(Array(model.routines.enumerated()), id: \.element.id) { index, routine in
                        if index > 0 { CompanionSheetSeparator(leading: 52) }
                        NavigationLink {
                            CompanionRoutineDetailSheet(
                                companionID: companion.id,
                                routine: routine,
                                canEdit: canEdit,
                                services: services,
                                onUpdated: { updated in
                                    replaceRoutine(updated)
                                }
                            )
                        } label: {
                            routineRow(routine)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("companion.details.routine.\(routine.id)")
                    }
                }

                if canEdit {
                    if !model.routines.isEmpty || routinesLoading { CompanionSheetSeparator() }
                    Button {
                        showingNewRoutine = true
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "plus")
                                .frame(width: 24)
                            Text("Add routine")
                                .font(.system(size: 17, weight: .semibold))
                            Spacer()
                        }
                        .foregroundStyle(CompanionIOSTheme.actionBlue)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 56)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("companion.details.add-routine")
                }
            }
        }
    }

    private func routineRow(_ routine: CompanionRoutine) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "clock")
                .font(.system(size: 18))
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .frame(width: 24, height: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(routine.name)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                Text(model.promptPreview(for: routine))
                    .font(.system(size: 15))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.top, 4)
        }
        .padding(16)
        .frame(minHeight: 72)
        .contentShape(Rectangle())
    }

    private var notificationsCard: some View {
        CompanionSheetCard {
            CompanionSheetToggleRow(title: "Notifications", isOn: notificationBinding)
                .disabled(!canEdit || savingNotifications)
        }
    }

    private var connectedProviders: [CompanionProviderDefinition] {
        providers?.connectedDefinitions ?? []
    }

    private var selectedProvider: CompanionProviderDefinition? {
        connectedProviders.first(where: { $0.id == providerID })
    }

    private var selectedModel: CompanionProviderDefinition.Model? {
        selectedProvider?.models.first(where: { $0.id == modelID })
    }

    private var connectedProviderCountLabel: String {
        let count = connectedProviders.count
        return count == 1 ? "1 connected" : "\(count) connected"
    }

    private var changedProviderOrModel: Bool {
        providerID != model.companion.runtime.providerIDs.first
            || modelID != model.companion.modelID
    }

    private var deletionActive: Bool {
        model.companion.deletionOperation?.isActive == true
    }

    private var deleteLabel: String {
        if deleting { return "Deleting…" }
        if deleteRequestID != nil { return "Retry Delete" }
        guard let operation = model.companion.deletionOperation else { return "Delete Companion" }
        if operation.isActive { return "Deletion requested" }
        if operation.status == .failed || operation.status == .interrupted || operation.status == .cancelled {
            return "Retry Delete"
        }
        return "Delete Companion"
    }

    private var resourceServices: CompanionResourceSectionsServices? {
        guard let services else { return nil }
        return CompanionResourceSectionsServices(
            load: services.connectedResources,
            listPlugins: services.listPlugins,
            listTriggerProviderAccounts: services.listTriggerProviderAccounts,
            updatePluginSelection: services.updatePluginSelection,
            loadCompanion: services.loadCompanion,
            restart: services.restart,
            createTrigger: services.createTrigger,
            updateTrigger: services.updateTrigger,
            deleteTrigger: services.deleteTrigger,
            rotateTriggerSecret: services.rotateTriggerSecret
        )
    }

    private var notificationBinding: Binding<Bool> {
        Binding(
            get: { notificationsEnabled },
            set: { enabled in
                guard canEdit, !savingNotifications, enabled != notificationsEnabled else { return }
                let previous = notificationsEnabled
                savingNotifications = true
                notificationsEnabled = enabled
                UISelectionFeedbackGenerator().selectionChanged()
                Task { await saveNotifications(enabled: enabled, previous: previous) }
            }
        )
    }

    private func synchronizeNotificationPreference(
        with companion: CompanionSummary,
        whileSaving: Bool = false
    ) {
        guard whileSaving || !savingNotifications else { return }
        notificationsEnabled = !companion.muted
    }

    private func saveNotifications(enabled: Bool, previous: Bool) async {
        guard canEdit else {
            notificationsEnabled = previous
            savingNotifications = false
            return
        }
        error = nil
        defer { savingNotifications = false }

        do {
            let updated: CompanionSummary
            if let updateMemberState = services?.updateMemberState {
                updated = try await updateMemberState(
                    model.companion.id,
                    CompanionMemberStatePatch(muted: !enabled)
                )
            } else {
                updated = try await sessionStore.updateCompanionMemberState(
                    companionID: model.companion.id,
                    patch: CompanionMemberStatePatch(muted: !enabled)
                )
            }
            apply(updated, forceNotificationSync: true)
            if enabled && !updated.muted && globalNotificationsEnabled {
                await notifications.requestAuthorizationAndRegister()
            }
        } catch {
            notificationsEnabled = previous
            self.error = companionDisplayMessage(
                error,
                fallback: "Notification settings could not be saved."
            )
        }
    }

    private var canEdit: Bool { model.companion.access.canEditCompanionSettings }
    private var canDelete: Bool { model.companion.access.canDeleteCompanion }
    private var defaultIcon: CompanionSummary.Icon { .init(shape: 1, mouth: 0, accessory: 0, color: 2) }
    private var instructionPreview: String {
        let value = model.companion.persona?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return value.isEmpty ? "Add a persona and working style" : value
    }

    private func loadProviders() async {
        loadingProviders = true
        do {
            let response: CompanionProvidersResponse
            if let services {
                response = try await services.listProviders()
            } else {
                response = try await sessionStore.listCompanionProviders()
            }
            providers = response
            if !savingModel, providerID.isEmpty {
                providerID = response.connectedDefinitions.first?.id ?? ""
            }
            error = nil
        } catch {
            self.error = companionDisplayMessage(
                error,
                fallback: "Model providers are temporarily unavailable."
            )
        }
        loadingProviders = false
    }

    private func selectDefaultModel() {
        guard let selectedProvider else {
            modelID = ""
            return
        }
        if !selectedProvider.models.contains(where: { $0.id == modelID }) {
            modelID = selectedProvider.defaultModelID ?? ""
        }
    }

    private func selectProvider(_ provider: CompanionProviderDefinition) {
        guard canEdit,
              !savingModel,
              !savingIdentity,
              !editingTitle,
              let selectedModelID = provider.defaultModelID else { return }

        let providerChanged = providerID != provider.id
        let modelChanged = modelID != selectedModelID
        guard providerChanged || modelChanged else { return }

        providerID = provider.id
        modelID = selectedModelID
        providerModelSelectionRevision += 1
        savingModel = true
        error = nil
        success = nil
        let revision = providerModelSelectionRevision
        Task {
            await updateProviderAndModel(
                providerID: provider.id,
                modelID: selectedModelID,
                revision: revision
            )
        }
    }

    private func selectModel(_ selectedModel: CompanionProviderDefinition.Model) {
        guard canEdit,
              !savingModel,
              !savingIdentity,
              !editingTitle,
              selectedProvider != nil,
              modelID != selectedModel.id else { return }

        modelID = selectedModel.id
        providerModelSelectionRevision += 1
        savingModel = true
        error = nil
        success = nil
        let revision = providerModelSelectionRevision
        Task {
            await updateProviderAndModel(
                providerID: providerID,
                modelID: selectedModel.id,
                revision: revision
            )
        }
    }

    private func updateProviderAndModel(
        providerID selectedProviderID: String,
        modelID selectedModelID: String,
        revision: Int
    ) async {
        guard canEdit, providerModelSelectionRevision == revision else { return }

        do {
            let input = UpdateCompanionInput(
                name: model.normalizedName,
                persona: model.companion.persona,
                providerID: selectedProviderID,
                modelID: selectedModelID,
                icon: model.icon
            )
            let updated: CompanionSummary
            if let services {
                updated = try await services.updateCompanion(model.companion.id, input)
            } else {
                updated = try await sessionStore.updateCompanion(
                    companionID: model.companion.id,
                    input: input
                )
            }
            guard !Task.isCancelled, providerModelSelectionRevision == revision else { return }
            apply(updated)
            providerID = updated.runtime.providerIDs.first ?? selectedProviderID
            modelID = updated.modelID ?? selectedModelID
            success = "Provider and model updated."
        } catch {
            guard !Task.isCancelled, providerModelSelectionRevision == revision else { return }
            providerID = model.companion.runtime.providerIDs.first ?? ""
            modelID = model.companion.modelID ?? ""
            self.error = companionDisplayMessage(
                error,
                fallback: "Provider and model could not be updated."
            )
        }
        if providerModelSelectionRevision == revision {
            savingModel = false
        }
    }

    private func deleteCompanion() async {
        guard canDelete, !deleting else { return }
        deleting = true
        error = nil
        let requestID = deleteRequestID ?? UUID()
        deleteRequestID = requestID
        onDeletionStarted(model.companion, requestID)
        do {
            let operation: CompanionOperationSummary
            if let services {
                operation = try await services.deleteCompanion(model.companion.id, requestID)
            } else {
                operation = try await sessionStore.deleteCompanion(
                    companionID: model.companion.id,
                    requestID: requestID
                )
            }
            deleteRequestID = nil
            onDeletionAccepted(model.companion.id, operation)
        } catch {
            onDeletionFailed(model.companion, requestID, error)
            if let apiError = error as? APIError, apiError.status == 0 {
                self.error = "The deletion response was not received. Retry Delete safely reuses the same request."
            } else {
                self.error = companionDisplayMessage(
                    error,
                    fallback: "This Companion could not be deleted."
                )
            }
        }
        deleting = false
    }

    private func loadRoutines() async {
        routinesLoading = true
        do {
            model.routines = if let list = services?.listRoutines {
                try await list()
            } else {
                try await sessionStore.listCompanionRoutines(companionID: companion.id)
            }
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Routines are temporarily unavailable.")
        }
        routinesLoading = false
    }

    private func requestIdentitySave() {
        guard model.canSaveIdentity else {
            editingTitle = false
            return
        }
        guard !savingIdentity, !savingModel else { return }

        savingIdentity = true
        error = nil
        Task { await saveIdentity() }
    }

    private func saveIdentity() async {
        do {
            let updated = try await update(persona: model.companion.persona)
            apply(updated)
            editingTitle = false
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Bot details could not be saved.")
        }
        savingIdentity = false
    }

    private func update(persona: String?) async throws -> CompanionSummary {
        guard let providerID = model.companion.runtime.providerIDs.first,
              let modelID = model.companion.modelID else {
            throw APIError(status: 409, code: "model_unavailable", message: "This Bot has no active model.")
        }
        let input = UpdateCompanionInput(
            name: model.normalizedName,
            persona: persona,
            providerID: providerID,
            modelID: modelID,
            icon: model.icon
        )
        if let services { return try await services.updateCompanion(model.companion.id, input) }
        return try await sessionStore.updateCompanion(companionID: model.companion.id, input: input)
    }

    private func apply(_ updated: CompanionSummary, forceNotificationSync: Bool = false) {
        let preservesProviderDraft = changedProviderOrModel
        let reconciled = updated.preservingListProjection(from: model.companion)
        model = CompanionBotDetailSheetModel(companion: reconciled, routines: model.routines)
        if !preservesProviderDraft {
            providerID = reconciled.runtime.providerIDs.first ?? providerID
            modelID = reconciled.modelID ?? modelID
        }
        synchronizeNotificationPreference(with: reconciled, whileSaving: forceNotificationSync)
        onSaved(reconciled)
    }

    private func createRoutine(_ input: CreateCompanionRoutineInput) async throws -> CompanionRoutine {
        if let create = services?.createRoutine { return try await create(input) }
        return try await sessionStore.createCompanionRoutine(companionID: companion.id, input: input)
    }

    private func updateRoutine(id: String, input: UpdateCompanionRoutineInput) async throws -> CompanionRoutine {
        if let update = services?.updateRoutine { return try await update(id, input) }
        return try await sessionStore.updateCompanionRoutine(companionID: companion.id, routineID: id, input: input)
    }

    private func replaceRoutine(_ routine: CompanionRoutine) {
        if let index = model.routines.firstIndex(where: { $0.id == routine.id }) {
            model.routines[index] = routine
        }
    }
}

private struct CompanionCharacterPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var icon: CompanionSummary.Icon
    let onDone: (CompanionSummary.Icon) -> Void

    init(icon: CompanionSummary.Icon, onDone: @escaping (CompanionSummary.Icon) -> Void) {
        _icon = State(initialValue: icon)
        self.onDone = onDone
    }

    var body: some View {
        NavigationStack {
            CompanionSheetCanvas {
                ScrollView {
                    VStack(spacing: 20) {
                        CompanionSheetHeader(title: "Character", leadingStyle: .back) { dismiss() }
                        CompanionSheetCard {
                            CompanionCharacterControls(icon: $icon, canEdit: true) {}
                        }
                        Button("Done") { onDone(icon) }
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                            .frame(maxWidth: .infinity, minHeight: 50)
                            .background(CompanionIOSTheme.primaryCTA, in: Capsule())
                    }
                    .padding(16)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }
}

private struct CompanionCharacterControls: View {
    @Binding var icon: CompanionSummary.Icon
    let canEdit: Bool
    let onSelection: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Color")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(CharacterMark.palette.indices, id: \.self) { index in
                            Button {
                                icon = .init(shape: icon.shape, mouth: icon.mouth, accessory: icon.accessory, color: index)
                                onSelection()
                            } label: {
                                Circle()
                                    .fill(CharacterMark.palette[index])
                                    .frame(width: 30, height: 30)
                                    .padding(4)
                                    .overlay {
                                        Circle().stroke(
                                            icon.color == index ? CompanionIOSTheme.textPrimary : Color.clear,
                                            lineWidth: 2
                                        )
                                    }
                            }
                            .buttonStyle(.plain)
                            .disabled(!canEdit)
                            .accessibilityLabel("Color \(index + 1)")
                            .accessibilityAddTraits(icon.color == index ? .isSelected : [])
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .accessibilityIdentifier("companion.details.character.colors")
            }
            .padding(16)

            CompanionSheetSeparator()

            VStack(alignment: .leading, spacing: 12) {
                Text("Shape")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(CharacterMarkShape.allCases, id: \.rawValue) { shape in
                            Button {
                                icon = .init(shape: shape.rawValue, mouth: icon.mouth, accessory: icon.accessory, color: icon.color)
                                onSelection()
                            } label: {
                                CharacterMark(
                                    name: "Shape \(shape.rawValue + 1)",
                                    shapeIndex: shape.rawValue,
                                    colorIndex: icon.color,
                                    size: 42
                                )
                                .padding(6)
                                .overlay {
                                    Circle().stroke(
                                        icon.shape == shape.rawValue ? CompanionIOSTheme.textPrimary : Color.clear,
                                        lineWidth: 2
                                    )
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(!canEdit)
                            .accessibilityAddTraits(icon.shape == shape.rawValue ? .isSelected : [])
                        }
                    }
                }
                .scrollIndicators(.hidden)
                .accessibilityIdentifier("companion.details.character.shapes")
            }
            .padding(16)
        }
    }
}

private struct CompanionInstructionsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let companion: CompanionSummary
    let save: (String?) async throws -> CompanionSummary
    let onSaved: (CompanionSummary) -> Void
    @State private var persona: String
    @State private var saving = false
    @State private var error: String?

    init(
        companion: CompanionSummary,
        save: @escaping (String?) async throws -> CompanionSummary,
        onSaved: @escaping (CompanionSummary) -> Void
    ) {
        self.companion = companion
        self.save = save
        self.onSaved = onSaved
        _persona = State(initialValue: companion.persona ?? "")
    }

    var body: some View {
        CompanionSheetCanvas {
            VStack(spacing: 20) {
                CompanionSheetHeader(title: "Instructions", leadingStyle: .back) { dismiss() }
                if let error { CompanionErrorNotice(message: error) }
                TextEditor(text: $persona)
                    .font(.system(size: 17))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                    .scrollContentBackground(.hidden)
                    .padding(12)
                    .frame(minHeight: 240)
                    .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18))
                    .accessibilityIdentifier("companion.instructions.text")
                Spacer()
                Button {
                    Task { await saveInstructions() }
                } label: {
                    if saving {
                        ProgressView().tint(CompanionIOSTheme.primaryCTAText)
                    } else {
                        Text("Save instructions")
                    }
                }
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                .frame(maxWidth: .infinity, minHeight: 50)
                .background(CompanionIOSTheme.primaryCTA, in: Capsule())
                .disabled(saving)
            }
            .padding(16)
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private func saveInstructions() async {
        saving = true
        error = nil
        do {
            let value = persona.trimmingCharacters(in: .whitespacesAndNewlines)
            onSaved(try await save(value.isEmpty ? nil : value))
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Instructions could not be saved.")
        }
        saving = false
    }
}

private struct CompanionRoutineDetailSheet: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let companionID: String
    let routine: CompanionRoutine
    let canEdit: Bool
    let services: CompanionDetailServices?
    let onUpdated: (CompanionRoutine) -> Void

    @State private var showingEditor = false
    @State private var store: CompanionRoutineRunListStore?

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 22) {
                    CompanionSheetHeader(title: routine.name, leadingStyle: .back) { dismiss() }

                    CompanionSheetCard {
                        CompanionSheetValueRow(
                            title: routine.scheduleDescription,
                            detail: "\(routine.cron) · \(routine.timezone)",
                            value: routine.enabled ? "On" : "Off",
                            symbol: "calendar"
                        )
                        CompanionSheetSeparator(leading: 52)
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Prompt")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(CompanionIOSTheme.textPrimary)
                            Text(routine.prompt ?? "No prompt")
                                .font(.system(size: 15))
                                .foregroundStyle(CompanionIOSTheme.textSecondary)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if canEdit {
                            CompanionSheetSeparator()
                            Button { showingEditor = true } label: {
                                CompanionSheetValueRow(title: "Edit routine", symbol: "pencil")
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    runHistory
                }
                .padding(16)
                .padding(.bottom, 28)
            }
        }
        .navigationBarBackButtonHidden(false)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: routine.id) {
            if store == nil {
                store = CompanionRoutineRunListStore { cursor in
                    if let list = services?.listRoutineRuns {
                        return try await list(routine.id, cursor)
                    }
                    return try await sessionStore.listCompanionRoutineRuns(
                        companionID: companionID,
                        routineID: routine.id,
                        cursor: cursor
                    )
                }
            }
            await store?.reload()
        }
        .sheet(isPresented: $showingEditor) {
            CompanionRoutineEditorView(
                initial: routine,
                memberTimezone: sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier,
                memberTimezoneWasUnset: false,
                saveMemberTimezone: { identifier in
                    let profile = try await sessionStore.updateUserProfile(timezone: identifier)
                    return profile.timezone ?? identifier
                },
                create: { input in
                    try await sessionStore.createCompanionRoutine(companionID: companionID, input: input)
                },
                update: { id, input in
                    let updated: CompanionRoutine
                    if let update = services?.updateRoutine {
                        updated = try await update(id, input)
                    } else {
                        updated = try await sessionStore.updateCompanionRoutine(
                            companionID: companionID,
                            routineID: id,
                            input: input
                        )
                    }
                    onUpdated(updated)
                    return updated
                }
            ) {
                showingEditor = false
            }
        }
    }

    @ViewBuilder
    private var runHistory: some View {
        CompanionSheetSection("Run history") {
            CompanionSheetCard {
                if let store {
                    if store.loading && !store.loaded {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text("Loading runs…")
                                .foregroundStyle(CompanionIOSTheme.textSecondary)
                        }
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else if let message = store.errorMessage, store.runs.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(message).foregroundStyle(CompanionIOSTheme.textSecondary)
                            Button("Try again") { Task { await store.reload() } }
                        }
                        .font(.system(size: 15))
                        .padding(16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    } else if store.runs.isEmpty {
                        Text("No runs yet")
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ForEach(Array(store.runs.enumerated()), id: \.element.id) { index, run in
                            if index > 0 { CompanionSheetSeparator() }
                            NavigationLink {
                                CompanionRoutineRunSheet(
                                    companionID: companionID,
                                    run: run,
                                    services: services,
                                    memberTimezone: memberTimezone
                                )
                            } label: {
                                CompanionRoutineRunRow(
                                    run: run,
                                    memberTimezone: memberTimezone
                                )
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("companion.details.routine-run.\(run.runID)")
                        }
                        if store.canLoadMore {
                            CompanionSheetSeparator()
                            Button("Load more") { Task { await store.loadMore() } }
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(CompanionIOSTheme.actionBlue)
                                .frame(maxWidth: .infinity, minHeight: 52)
                        }
                    }
                }
            }
        }
    }

    private var memberTimezone: String {
        sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier
    }

}

private struct CompanionRoutineRunRow: View {
    let run: CompanionRoutineRunSummary
    let memberTimezone: String
    let detail: CompanionRoutineRunDetail?

    init(
        run: CompanionRoutineRunSummary,
        memberTimezone: String,
        detail: CompanionRoutineRunDetail? = nil
    ) {
        self.run = run
        self.memberTimezone = memberTimezone
        self.detail = detail
    }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: statusSymbol)
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(statusColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(statusLabel)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                Text(MemberTimezone.formatInstant(run.createdAt, in: memberTimezone) ?? run.createdAt)
                    .font(.system(size: 15))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                if let recoveryDescription {
                    Text(recoveryDescription)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(statusColor)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("companion.details.routine-run.recovery.\(run.runID)")
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
        }
        .padding(16)
        .frame(minHeight: 64)
        .contentShape(Rectangle())
    }

    private var statusLabel: String {
        if recoveryStatus == .pending { return "Recovery queued" }
        if recoveryStatus == .running { return "Recovering" }
        if recoveryStatus == .completed { return "Recovery complete" }
        if recoveryStatus == .unknown || (recoveryStatus == nil && runStatus == .interrupted) {
            return "Recovering automatically"
        }
        return switch runOutcome {
        case .surfaced: "Shared in chat"
        case .noOutput: "Completed · No update"
        case .error: "Failed"
        case .pending: runStatus.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
        case .unknown: "Completed"
        }
    }

    private var statusSymbol: String {
        if recoveryStatus == .completed { return "checkmark.circle.fill" }
        if recoveryStatus != nil || runStatus == .interrupted { return "arrow.trianglehead.2.clockwise.rotate.90" }
        return switch runOutcome {
        case .error: "exclamationmark.circle.fill"
        case .pending: "clock.fill"
        default: "checkmark.circle.fill"
        }
    }

    private var statusColor: Color {
        if recoveryStatus == .completed { return CompanionIOSTheme.toggleGreen }
        if recoveryStatus != nil || runStatus == .interrupted { return CompanionIOSTheme.warning }
        return runOutcome == .error
            ? CompanionIOSTheme.danger
            : (runOutcome == .pending ? CompanionIOSTheme.warning : CompanionIOSTheme.toggleGreen)
    }

    private var runStatus: CompanionRoutineRunStatus { detail?.status ?? run.status }
    private var runOutcome: CompanionRoutineRunOutcome { detail?.outcome ?? run.outcome }
    private var recoveryStatus: CompanionRecoveryStatus? { detail?.recoveryStatus ?? run.recoveryStatus }

    private var recoveryDescription: String? {
        switch recoveryStatus {
        case .pending: "Automatic cleanup for this exact run is queued. The prompt will not be replayed. Later routine messages resume automatically in order when cleanup finishes."
        case .running: "Automatic cleanup for this exact run is running. The prompt will not be replayed. Later routine messages resume automatically in order when cleanup finishes."
        case .completed: "Automatic cleanup for this exact run is complete. The prompt was not replayed. Later routine messages continue automatically in order."
        case .unknown: "Automatic cleanup for this exact run continues in the background. The prompt will not be replayed. Later routine messages resume automatically in order."
        case nil: runStatus == .interrupted
            ? "Automatic cleanup for this exact run continues in the background. The prompt will not be replayed. Later routine messages resume automatically in order."
            : nil
        }
    }
}

private struct CompanionRoutineRunSheet: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let companionID: String
    let run: CompanionRoutineRunSummary
    let services: CompanionDetailServices?
    let memberTimezone: String
    @State private var store: CompanionRoutineRunDetailStore?

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 20) {
                    CompanionSheetHeader(title: "Routine run", leadingStyle: .back) { dismiss() }
                    CompanionRoutineRunRow(
                        run: run,
                        memberTimezone: memberTimezone,
                        detail: store?.detail
                    )

                    if let store {
                        if let message = store.errorMessage, store.entries.isEmpty {
                            CompanionErrorNotice(message: message)
                            Button("Try again") { Task { await store.reload() } }
                        }
                        ForEach(store.entries) { entry in
                            CompanionRoutineRunEntryCard(entry: entry)
                        }
                        if store.canLoadMore {
                            Button("Load earlier activity") { Task { await store.loadMore() } }
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(CompanionIOSTheme.actionBlue)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(CompanionIOSTheme.card, in: Capsule())
                        } else if store.loading {
                            ProgressView().padding()
                        }
                    }
                }
                .padding(16)
                .padding(.bottom, 28)
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task(id: run.runID) {
            if store == nil {
                store = CompanionRoutineRunDetailStore { cursor in
                    if let detail = services?.routineRun { return try await detail(run.runID, cursor) }
                    return try await sessionStore.readCompanionRoutineRun(
                        companionID: companionID,
                        runID: run.runID,
                        entryCursor: cursor
                    )
                }
            }
            await store?.reload()
        }
        .task(id: recoveryPollingID) {
            await pollRecovery()
        }
    }

    private var recoveryPollingID: String {
        "\(run.runID):\((store?.detail?.recoveryStatus ?? run.recoveryStatus)?.rawValue ?? "none")"
    }

    private func pollRecovery() async {
        guard (store?.detail?.recoveryStatus ?? run.recoveryStatus)?.isActive == true else { return }
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(4))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await store?.refreshPreservingLoadedPages()
            guard (store?.detail?.recoveryStatus ?? run.recoveryStatus)?.isActive == true else { return }
        }
    }
}

private struct CompanionRoutineRunEntryCard: View {
    let entry: CompanionRoutineRunEntry

    var body: some View {
        CompanionSheetCard {
            VStack(alignment: .leading, spacing: 8) {
                Label(roleLabel, systemImage: roleSymbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                if let tool = entry.tool {
                    Text(tool.title)
                        .font(.system(size: 17, weight: .semibold))
                    if let detail = tool.detail { Text(detail) }
                } else if let decision = entry.decision {
                    Text(decision.title)
                        .font(.system(size: 17, weight: .semibold))
                    if let detail = decision.detail { Text(detail) }
                } else if !entry.content.isEmpty {
                    Text(entry.content)
                }
                if let reasoning = entry.reasoning, !reasoning.isEmpty {
                    Text(reasoning)
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
            }
            .font(.system(size: 15))
            .foregroundStyle(CompanionIOSTheme.textPrimary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        }
    }

    private var roleLabel: String { entry.role.capitalized }
    private var roleSymbol: String {
        switch entry.role {
        case "user": "person"
        case "assistant": "sparkles"
        case "system": "gearshape"
        case "tool": "wrench.and.screwdriver"
        case "decision": "checkmark.shield"
        default: "circle"
        }
    }
}
