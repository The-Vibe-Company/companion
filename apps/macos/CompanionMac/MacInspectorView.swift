import CompanionKit
import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
private final class CompanionMacInspectorModel {
    let sessionStore: SessionStore
    private(set) var companion: CompanionSummary
    var name: String
    var persona: String
    var icon: CompanionSummary.Icon
    var providerID: String
    var modelID: String
    var selectedPluginIDs: Set<String>
    private(set) var providers: CompanionProvidersResponse?
    private(set) var plugins: [CompanionPluginAccount] = []
    private(set) var resources: CompanionConnectedResources?
    private(set) var loading = true
    private(set) var saving = false
    private(set) var errorMessage: String?
    private(set) var successMessage: String?

    init(companion: CompanionSummary, sessionStore: SessionStore) {
        self.companion = companion
        self.sessionStore = sessionStore
        name = companion.name
        persona = companion.persona ?? ""
        icon = companion.icon ?? .init(shape: 1, mouth: 0, accessory: 0, color: 2)
        providerID = companion.runtime.providerIDs.first ?? ""
        modelID = companion.modelID ?? ""
        selectedPluginIDs = Set(companion.selectedMCPAccountIDs)
    }

    var canEdit: Bool { companion.access.canEditCompanionSettings }
    var canManagePlugins: Bool { companion.access == .owner }
    var canDelete: Bool { companion.access.canDeleteCompanion }
    var connectedProviders: [CompanionProviderDefinition] { providers?.connectedDefinitions ?? [] }
    var selectedProvider: CompanionProviderDefinition? {
        connectedProviders.first { $0.id == providerID }
    }
    var hasChanges: Bool {
        name.trimmingCharacters(in: .whitespacesAndNewlines) != companion.name
            || persona.trimmingCharacters(in: .whitespacesAndNewlines) != (companion.persona ?? "")
            || icon != (companion.icon ?? .init(shape: 1, mouth: 0, accessory: 0, color: 2))
            || providerID != companion.runtime.providerIDs.first
            || modelID != companion.modelID
            || selectedPluginIDs != Set(companion.selectedMCPAccountIDs)
    }
    var canSave: Bool {
        canEdit && !saving && hasChanges
            && !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && selectedProvider?.models.contains(where: { $0.id == modelID }) == true
    }

    func load() async {
        loading = true
        do {
            async let providerRequest = sessionStore.listCompanionProviders()
            async let pluginRequest = sessionStore.listCompanionPlugins()
            async let resourceRequest = sessionStore.connectedResources(for: companion)
            let (providerValue, pluginValue, resourceValue) = try await (
                providerRequest, pluginRequest, resourceRequest
            )
            providers = providerValue
            plugins = pluginValue
            resources = resourceValue
            if !providerValue.connectedDefinitions.contains(where: { $0.id == providerID }) {
                providerID = providerValue.defaultProviderID
                    .flatMap { id in providerValue.connectedDefinitions.first(where: { $0.id == id })?.id }
                    ?? providerValue.connectedDefinitions.first?.id
                    ?? ""
            }
            selectDefaultModelIfNeeded()
            errorMessage = nil
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Bot details are temporarily unavailable.")
        }
        loading = false
    }

    func selectDefaultModelIfNeeded() {
        guard let provider = selectedProvider,
              !provider.models.contains(where: { $0.id == modelID }) else { return }
        modelID = provider.defaultModelID ?? ""
    }

    func reconcile(_ updated: CompanionSummary) {
        guard updated.id == companion.id else { return }
        let previous = companion
        let nameChanged = name.trimmingCharacters(in: .whitespacesAndNewlines) != previous.name
        let personaChanged = persona.trimmingCharacters(in: .whitespacesAndNewlines) != (previous.persona ?? "")
        let iconChanged = icon != (previous.icon ?? .init(shape: 1, mouth: 0, accessory: 0, color: 2))
        let intelligenceChanged = providerID != previous.runtime.providerIDs.first || modelID != previous.modelID
        let pluginsChanged = selectedPluginIDs != Set(previous.selectedMCPAccountIDs)

        companion = updated
        if !nameChanged { name = updated.name }
        if !personaChanged { persona = updated.persona ?? "" }
        if !iconChanged { icon = updated.icon ?? .init(shape: 1, mouth: 0, accessory: 0, color: 2) }
        if !intelligenceChanged {
            providerID = updated.runtime.providerIDs.first ?? providerID
            modelID = updated.modelID ?? modelID
            selectDefaultModelIfNeeded()
        }
        if !pluginsChanged { selectedPluginIDs = Set(updated.selectedMCPAccountIDs) }
    }

    func save(onSaved: @escaping (CompanionSummary) -> Void) async {
        guard canSave else { return }
        saving = true
        errorMessage = nil
        successMessage = nil
        do {
            var updated = try await sessionStore.updateCompanion(
                companionID: companion.id,
                input: UpdateCompanionInput(
                    name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                    persona: persona.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : persona,
                    providerID: providerID,
                    modelID: modelID,
                    icon: icon
                )
            )
            if canManagePlugins, selectedPluginIDs != Set(updated.selectedMCPAccountIDs) {
                updated = try await sessionStore.updateCompanionPluginSelection(
                    companionID: companion.id,
                    selectedMCPAccountIDs: selectedPluginIDs.sorted()
                )
            }
            companion = updated
            name = updated.name
            persona = updated.persona ?? ""
            icon = updated.icon ?? icon
            selectedPluginIDs = Set(updated.selectedMCPAccountIDs)
            successMessage = "Saved"
            onSaved(updated)
            resources = try? await sessionStore.connectedResources(for: updated)
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Changes could not be saved.")
        }
        saving = false
    }

    func updateMuted(_ muted: Bool, onSaved: @escaping (CompanionSummary) -> Void) async {
        do {
            let updated = try await sessionStore.updateCompanionMemberState(
                companionID: companion.id,
                patch: CompanionMemberStatePatch(muted: muted)
            )
            companion = updated
            onSaved(updated)
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "Notifications could not be changed.")
        }
    }
}

struct CompanionMacInspectorView: View {
    let companion: CompanionSummary
    let onCompanionChanged: (CompanionSummary) -> Void
    let onDelete: (CompanionSummary) -> Void
    let onOpenProviders: () -> Void
    let onOpenPlugins: () -> Void
    @State private var model: CompanionMacInspectorModel

    init(
        companion: CompanionSummary,
        sessionStore: SessionStore,
        onCompanionChanged: @escaping (CompanionSummary) -> Void,
        onDelete: @escaping (CompanionSummary) -> Void,
        onOpenProviders: @escaping () -> Void,
        onOpenPlugins: @escaping () -> Void
    ) {
        self.companion = companion
        self.onCompanionChanged = onCompanionChanged
        self.onDelete = onDelete
        self.onOpenProviders = onOpenProviders
        self.onOpenPlugins = onOpenPlugins
        _model = State(initialValue: CompanionMacInspectorModel(companion: companion, sessionStore: sessionStore))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    header
                    characterHero
                    if let error = model.errorMessage { CompanionMacErrorNotice(message: error) }
                    if let success = model.successMessage {
                        Label(success, systemImage: "checkmark.circle.fill")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(Color.companionMacSuccess)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    identitySection
                    characterSection
                    intelligenceSection
                    routinesSection
                    resourcesSection
                    pluginsSection
                    notificationsSection
                    runtimeSection
                    if model.canDelete { deletionSection }
                    if !model.canEdit {
                        Text("You have read-only access to this Bot.")
                            .font(.system(size: 15))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            }
            .background(CompanionIOSTheme.canvas)
            .task { await model.load() }
            .onChange(of: companion) { _, updated in
                model.reconcile(updated)
            }
        }
        .background(CompanionIOSTheme.canvas)
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Bot details")
                    .font(.system(size: 20, weight: .semibold))
                Text(model.canEdit ? "Changes apply between turns" : "View only")
                    .font(.system(size: 13))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
            }
            Spacer()
            Button(model.saving ? "Saving…" : "Save") {
                Task { await model.save(onSaved: onCompanionChanged) }
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .disabled(!model.canSave)
            .accessibilityIdentifier("companion.inspector.save")
        }
    }

    private var characterHero: some View {
        CharacterMark(name: model.name, icon: model.icon, size: 80)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .accessibilityIdentifier("companion.inspector.character")
    }

    private var identitySection: some View {
        inspectorSection("Identity") {
            inspectorCard {
                TextField("Bot name", text: $model.name)
                    .textFieldStyle(.plain)
                    .font(.system(size: 18, weight: .semibold))
                    .disabled(!model.canEdit)
                    .padding(16)
                separator
                TextField("Instructions", text: $model.persona, axis: .vertical)
                    .textFieldStyle(.plain)
                    .font(.system(size: 15))
                    .lineLimit(4...12)
                    .disabled(!model.canEdit)
                    .padding(16)
            }
        }
    }

    private var characterSection: some View {
        inspectorSection("Character") {
            inspectorCard {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Shape")
                        .font(.system(size: 13))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 10) {
                        ForEach(CharacterMarkShape.allCases.indices, id: \.self) { index in
                            Button {
                                model.icon = .init(
                                    shape: index,
                                    mouth: model.icon.mouth,
                                    accessory: model.icon.accessory,
                                    color: model.icon.color
                                )
                            } label: {
                                CharacterMark(name: "Shape \(index + 1)", shapeIndex: index, colorIndex: model.icon.color, size: 40)
                                    .padding(4)
                                    .overlay(Circle().stroke(model.icon.shape == index ? CompanionIOSTheme.textPrimary : .clear, lineWidth: 2))
                            }
                            .buttonStyle(.plain)
                            .disabled(!model.canEdit)
                            .accessibilityLabel("Shape \(index + 1)")
                        }
                    }
                    Text("Color")
                        .font(.system(size: 13))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 6), spacing: 10) {
                        ForEach(CompanionIOSTheme.characterMarkPalette.indices, id: \.self) { index in
                            Button {
                                model.icon = .init(
                                    shape: model.icon.shape,
                                    mouth: model.icon.mouth,
                                    accessory: model.icon.accessory,
                                    color: index
                                )
                            } label: {
                                Circle()
                                    .fill(CompanionIOSTheme.characterMarkPalette[index])
                                    .frame(width: 28, height: 28)
                                    .padding(4)
                                    .overlay(Circle().stroke(model.icon.color == index ? CompanionIOSTheme.textPrimary : .clear, lineWidth: 2))
                            }
                            .buttonStyle(.plain)
                            .disabled(!model.canEdit)
                            .accessibilityLabel("Color \(index + 1)")
                        }
                    }
                }
                .padding(16)
            }
        }
    }

    private var intelligenceSection: some View {
        inspectorSection("Intelligence") {
            inspectorCard {
                if model.loading && model.providers == nil {
                    ProgressView("Loading…")
                        .padding(16)
                } else if model.connectedProviders.isEmpty {
                    inspectorValueRow("No connected provider", detail: "Connect one to choose a model", symbol: "cpu")
                    separator
                    inspectorAction("Open providers", symbol: "slider.horizontal.3", action: onOpenProviders)
                } else {
                    Picker("Provider", selection: $model.providerID) {
                        ForEach(model.connectedProviders) { provider in Text(provider.name).tag(provider.id) }
                    }
                    .padding(16)
                    .disabled(!model.canEdit)
                    .onChange(of: model.providerID) { _, _ in model.selectDefaultModelIfNeeded() }
                    if let provider = model.selectedProvider {
                        separator
                        Picker("Model", selection: $model.modelID) {
                            ForEach(provider.models) { item in Text(item.name).tag(item.id) }
                        }
                        .padding(16)
                        .disabled(!model.canEdit)
                    }
                    separator
                    inspectorAction("Manage providers", symbol: "slider.horizontal.3", action: onOpenProviders)
                }
            }
            Text("Provider and model changes never wake an asleep Box.")
                .font(.system(size: 13))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 4)
        }
    }

    private var routinesSection: some View {
        inspectorSection("Routines") {
            inspectorCard {
                let routines = model.resources?.routines ?? []
                if routines.isEmpty {
                    inspectorValueRow("No routines", detail: "Scheduled turns appear here", symbol: "clock")
                } else {
                    ForEach(Array(routines.enumerated()), id: \.element.id) { index, routine in
                        if index > 0 { separator }
                        NavigationLink {
                            CompanionMacRoutineInspectorView(
                                companionID: model.companion.id,
                                routine: routine,
                                sessionStore: model.sessionStore,
                                canEdit: model.canEdit
                            )
                        } label: {
                            inspectorValueRow(routine.name, detail: routine.scheduleDescription, symbol: "clock")
                        }
                        .buttonStyle(.plain)
                    }
                }
                if model.canEdit {
                    separator
                    NavigationLink {
                        CompanionMacRoutineEditorView(
                            companionID: model.companion.id,
                            sessionStore: model.sessionStore,
                            memberTimezone: model.sessionStore.memberTimezone ?? TimeZone.current.identifier
                        ) {
                            Task { await model.load() }
                        }
                    } label: {
                        inspectorActionLabel("Add routine", symbol: "plus")
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private var resourcesSection: some View {
        inspectorSection("Skills & triggers") {
            inspectorCard {
                let skills = model.resources?.skills ?? []
                if skills.isEmpty {
                    inspectorValueRow("No Skills", detail: "Add Skills from the Skills Hub", symbol: "shippingbox")
                } else {
                    ForEach(Array(skills.enumerated()), id: \.element.id) { index, skill in
                        if index > 0 { separator }
                        inspectorValueRow(skill.displayName, detail: skill.slug, symbol: "shippingbox.fill")
                    }
                }
                if let hidden = model.resources?.hiddenSkillCount, hidden > 0 {
                    separator
                    inspectorValueRow("Unavailable Skills", detail: "\(hidden) hidden", symbol: "eye.slash")
                }
            }
            inspectorCard {
                let triggers = model.resources?.triggers ?? []
                if triggers.isEmpty {
                    inspectorValueRow("No triggers", detail: "Webhook turns appear here", symbol: "bolt")
                } else {
                    ForEach(Array(triggers.enumerated()), id: \.element.id) { index, trigger in
                        if index > 0 { separator }
                        inspectorValueRow(trigger.name, detail: "\(trigger.providerName) · \(trigger.status.label)", symbol: "bolt.fill")
                    }
                }
            }
        }
    }

    private var pluginsSection: some View {
        inspectorSection("Connected accounts") {
            inspectorCard {
                if model.plugins.isEmpty {
                    inspectorValueRow("No connected accounts", detail: "Connect a plugin account first", symbol: "puzzlepiece.extension")
                } else {
                    ForEach(Array(model.plugins.enumerated()), id: \.element.id) { index, plugin in
                        if index > 0 { separator }
                        Toggle(isOn: Binding(
                            get: { model.selectedPluginIDs.contains(plugin.id) },
                            set: { enabled in
                                if enabled { model.selectedPluginIDs.insert(plugin.id) }
                                else { model.selectedPluginIDs.remove(plugin.id) }
                            }
                        )) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(plugin.label).font(.system(size: 15, weight: .medium))
                                Text(plugin.provider.capitalized).font(.system(size: 13)).foregroundStyle(CompanionIOSTheme.textSecondary)
                            }
                        }
                        .toggleStyle(.switch)
                        .padding(16)
                        .disabled(!model.canManagePlugins)
                    }
                }
                separator
                inspectorAction("Manage accounts", symbol: "puzzlepiece.extension", action: onOpenPlugins)
            }
        }
    }

    private var notificationsSection: some View {
        inspectorSection("Notifications") {
            inspectorCard {
                Toggle("Notifications", isOn: Binding(
                    get: { !model.companion.muted },
                    set: { enabled in
                        Task { await model.updateMuted(!enabled, onSaved: onCompanionChanged) }
                    }
                ))
                .toggleStyle(.switch)
                .padding(16)
                .disabled(!model.canEdit)
            }
        }
    }

    private var runtimeSection: some View {
        inspectorSection("Runtime") {
            inspectorCard {
                inspectorValueRow(
                    CompanionStatusIndicatorState(runtime: model.companion.runtime).accessibilityLabel,
                    detail: "Runtime status",
                    symbol: "power"
                )
                if model.canEdit {
                    separator
                    CompanionMacRestartButtons(companion: model.companion, sessionStore: model.sessionStore)
                }
            }
        }
    }

    private var deletionSection: some View {
        inspectorSection("Delete Companion") {
            inspectorCard {
                Button("Delete Companion", systemImage: "trash", role: .destructive) {
                    onDelete(model.companion)
                }
                .frame(maxWidth: .infinity, minHeight: 54, alignment: .leading)
                .padding(.horizontal, 16)
            }
            Text("Permanently deletes its Box and transcript.")
                .font(.system(size: 13))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 4)
        }
    }

    private func inspectorSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .tracking(0.5)
                .padding(.horizontal, 4)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func inspectorCard<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        VStack(spacing: 0, content: content)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var separator: some View {
        Rectangle().fill(CompanionIOSTheme.separator).frame(height: 1).padding(.leading, 16)
    }

    private func inspectorValueRow(_ title: String, detail: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 15, weight: .medium)).lineLimit(1)
                Text(detail).font(.system(size: 13)).foregroundStyle(CompanionIOSTheme.textSecondary).lineLimit(2)
            }
            Spacer(minLength: 4)
            Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(CompanionIOSTheme.textSecondary)
        }
        .foregroundStyle(CompanionIOSTheme.textPrimary)
        .padding(16)
        .contentShape(Rectangle())
    }

    private func inspectorAction(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { inspectorActionLabel(title, symbol: symbol) }.buttonStyle(.plain)
    }

    private func inspectorActionLabel(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(CompanionIOSTheme.linkBlue)
            .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
            .padding(.horizontal, 16)
            .contentShape(Rectangle())
    }
}

private struct CompanionMacRestartButtons: View {
    let companion: CompanionSummary
    let sessionStore: SessionStore
    @State private var target: CompanionRuntimeRestartTarget?
    @State private var working = false
    @State private var operation: CompanionOperationSummary?
    @State private var requestID: UUID?
    @State private var requestTarget: CompanionRuntimeRestartTarget?
    @State private var errorMessage: String?
    @State private var restartTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Advanced recovery recycles only Pi. It joins automatic recovery and keeps the Box and saved files in place.")
                .font(.system(size: 13))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
            Button("Restart") { target = .pi }
            if let operation {
                Label(operationLabel(operation), systemImage: operationSymbol(operation))
                    .font(.system(size: 13))
                    .foregroundStyle(operationColor(operation))
            }
            if let errorMessage {
                Text(errorMessage)
                    .font(.system(size: 13))
                    .foregroundStyle(CompanionIOSTheme.dangerText)
            }
        }
        .buttonStyle(.plain)
        .foregroundStyle(CompanionIOSTheme.linkBlue)
        .padding(16)
        .disabled(working || operation?.isActive == true)
        .confirmationDialog(
            "Restart the Companion?",
            isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } })
        ) {
            Button("Restart", role: .destructive) {
                guard let selected = target else { return }
                target = nil
                restartTask?.cancel()
                restartTask = Task { await restart(selected) }
            }
            Button("Cancel", role: .cancel) { target = nil }
        } message: {
            Text("Active work may be interrupted. Pi is recycled asynchronously; the Box and saved files remain in place.")
        }
        .onAppear { adopt(companion.runtime.latestOperation) }
        .onChange(of: companion.runtime.latestOperation) { _, latest in
            adopt(latest)
        }
        .onDisappear { restartTask?.cancel() }
    }

    private func adopt(_ latest: CompanionOperationSummary?) {
        guard let latest,
              latest.kind == .restartPi,
              operation?.id != latest.id || operation?.status != latest.status else { return }
        operation = latest
        guard latest.isActive else { return }
        restartTask?.cancel()
        restartTask = Task { await poll(operationID: latest.id) }
    }

    private func restart(_ selected: CompanionRuntimeRestartTarget) async {
        working = true
        errorMessage = nil
        if requestTarget != selected { requestID = nil }
        let id = requestID ?? UUID()
        requestID = id
        requestTarget = selected
        do {
            let accepted = try await sessionStore.restartCompanion(
                companionID: companion.id,
                target: selected,
                requestID: id
            )
            operation = accepted
            working = false
            if accepted.isActive {
                await poll(operationID: accepted.id)
            } else {
                requestID = nil
                requestTarget = nil
            }
        } catch {
            errorMessage = companionMacErrorMessage(
                error,
                fallback: "The restart response was not received. Retry safely reuses the same request."
            )
            working = false
        }
    }

    private func poll(operationID: String) async {
        var attempts = 0
        while !Task.isCancelled, operation?.isActive == true, attempts < 150 {
            attempts += 1
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            do {
                let updated = try await sessionStore.companionRuntime(companionID: companion.id)
                guard let latest = updated.runtime.latestOperation, latest.id == operationID else { continue }
                operation = latest
                if !latest.isActive {
                    requestID = nil
                    requestTarget = nil
                }
            } catch {
                errorMessage = companionMacErrorMessage(error, fallback: "Restart status is temporarily unavailable.")
            }
        }
        if attempts == 150, operation?.isActive == true {
            errorMessage = "Restart status is taking longer than expected."
        }
    }

    private func operationLabel(_ operation: CompanionOperationSummary) -> String {
        switch operation.status {
        case .pending: "Restart queued"
        case .running: "Restarting…"
        case .succeeded: "Restarted"
        case .failed: operation.error?.message ?? "Restart failed"
        case .interrupted: "Restart interrupted"
        case .cancelled: "Restart cancelled"
        case .unknown: "Restart status unknown"
        }
    }

    private func operationSymbol(_ operation: CompanionOperationSummary) -> String {
        switch operation.status {
        case .pending, .running: "arrow.triangle.2.circlepath"
        case .succeeded: "checkmark.circle.fill"
        case .failed, .interrupted, .cancelled: "exclamationmark.triangle.fill"
        case .unknown: "questionmark.circle"
        }
    }

    private func operationColor(_ operation: CompanionOperationSummary) -> Color {
        switch operation.status {
        case .pending, .running, .unknown: CompanionIOSTheme.textSecondary
        case .succeeded: CompanionIOSTheme.successText
        case .failed, .interrupted, .cancelled: CompanionIOSTheme.dangerText
        }
    }
}

private struct CompanionMacRoutineInspectorView: View {
    let companionID: String
    let routine: CompanionRoutine
    let sessionStore: SessionStore
    let canEdit: Bool
    @State private var runs: [CompanionRoutineRunSummary] = []
    @State private var loading = true
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(routine.prompt ?? "")
                    .font(.system(size: 15))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                LabeledContent("Schedule", value: routine.scheduleDescription)
                LabeledContent("Timezone", value: routine.timezone)
                LabeledContent("State", value: routine.status.label)
                Text("Run history").font(.system(size: 17, weight: .semibold))
                if loading { ProgressView("Loading…") }
                if let errorMessage { CompanionMacErrorNotice(message: errorMessage) }
                ForEach(runs) { run in
                    NavigationLink {
                        CompanionMacRoutineRunView(companionID: companionID, run: run, sessionStore: sessionStore)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(run.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                                    .font(.system(size: 15, weight: .semibold))
                                Text(run.createdAt).font(.system(size: 12)).foregroundStyle(CompanionIOSTheme.textSecondary)
                            }
                            Spacer()
                            Image(systemName: "chevron.right").foregroundStyle(CompanionIOSTheme.textSecondary)
                        }
                        .padding(14)
                        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(16)
        }
        .background(CompanionIOSTheme.canvas)
        .navigationTitle(routine.name)
        .task {
            do {
                runs = try await sessionStore.listCompanionRoutineRuns(
                    companionID: companionID,
                    routineID: routine.id
                ).runs
            } catch {
                errorMessage = companionMacErrorMessage(error, fallback: "Run history is unavailable.")
            }
            loading = false
        }
    }
}

private struct CompanionMacRoutineRunView: View {
    let companionID: String
    let run: CompanionRoutineRunSummary
    let sessionStore: SessionStore
    @State private var detail: CompanionRoutineRunDetail?
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(run.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.system(size: 20, weight: .semibold))
                Text(run.outcome.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                if let errorMessage { CompanionMacErrorNotice(message: errorMessage) }
                ForEach(detail?.internalEntries ?? []) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entry.role.capitalized).font(.system(size: 12, weight: .semibold)).foregroundStyle(CompanionIOSTheme.textSecondary)
                        Text(entry.content).font(.system(size: 14)).textSelection(.enabled)
                    }
                    .padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                }
            }
            .padding(16)
        }
        .background(CompanionIOSTheme.canvas)
        .navigationTitle("Run")
        .task {
            do {
                detail = try await sessionStore.readCompanionRoutineRun(companionID: companionID, runID: run.runID)
            } catch {
                errorMessage = companionMacErrorMessage(error, fallback: "Run details are unavailable.")
            }
        }
    }
}

private struct CompanionMacRoutineEditorView: View {
    let companionID: String
    let sessionStore: SessionStore
    let onSaved: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var prompt = ""
    @State private var cron = "0 9 * * *"
    @State private var timezone: String
    @State private var saving = false
    @State private var errorMessage: String?

    init(
        companionID: String,
        sessionStore: SessionStore,
        memberTimezone: String,
        onSaved: @escaping () -> Void
    ) {
        self.companionID = companionID
        self.sessionStore = sessionStore
        self.onSaved = onSaved
        _timezone = State(initialValue: memberTimezone)
    }

    var body: some View {
        Form {
            if let errorMessage { CompanionMacErrorNotice(message: errorMessage) }
            TextField("Name", text: $name)
            TextField("Prompt", text: $prompt, axis: .vertical).lineLimit(4...10)
            TextField("Schedule", text: $cron)
            TextField("Timezone", text: $timezone)
            Button(saving ? "Saving…" : "Add routine") { Task { await save() } }
                .buttonStyle(.borderedProminent)
                .disabled(saving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .formStyle(.grouped)
        .navigationTitle("New routine")
    }

    private func save() async {
        saving = true
        do {
            _ = try await sessionStore.createCompanionRoutine(
                companionID: companionID,
                input: CreateCompanionRoutineInput(name: name, prompt: prompt, cron: cron, timezone: timezone)
            )
            onSaved()
            dismiss()
        } catch {
            errorMessage = companionMacErrorMessage(error, fallback: "The routine could not be added.")
        }
        saving = false
    }
}
