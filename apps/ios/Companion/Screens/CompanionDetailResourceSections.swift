import SwiftUI
import CompanionKit
import UIKit

/// Resource sections embedded in the single Companion details page.
@MainActor
struct CompanionResourceSectionsServices {
    let load: () async throws -> CompanionConnectedResources
    let listPlugins: () async throws -> [CompanionPluginAccount]
    let listTriggerProviderAccounts: (() async throws -> [CompanionTriggerProviderAccount])?
    let updatePluginSelection: ([String]) async throws -> CompanionSummary
    let loadCompanion: () async throws -> CompanionSummary
    let restart: (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionLifecycleReceipt
    let createTrigger: ((CreateCompanionTriggerInput) async throws -> CompanionTrigger)?
    let updateTrigger: ((String, UpdateCompanionTriggerInput) async throws -> CompanionTrigger)?
    let deleteTrigger: ((String) async throws -> Void)?
    let rotateTriggerSecret: ((String) async throws -> CompanionTrigger)?
    let retryTriggerRegistration: ((String) async throws -> CompanionTrigger)?

    init(
        load: @escaping () async throws -> CompanionConnectedResources,
        listPlugins: @escaping () async throws -> [CompanionPluginAccount],
        listTriggerProviderAccounts: (() async throws -> [CompanionTriggerProviderAccount])? = nil,
        updatePluginSelection: @escaping ([String]) async throws -> CompanionSummary,
        loadCompanion: @escaping () async throws -> CompanionSummary,
        restart: @escaping (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionLifecycleReceipt,
        createTrigger: ((CreateCompanionTriggerInput) async throws -> CompanionTrigger)? = nil,
        updateTrigger: ((String, UpdateCompanionTriggerInput) async throws -> CompanionTrigger)? = nil,
        deleteTrigger: ((String) async throws -> Void)? = nil,
        rotateTriggerSecret: ((String) async throws -> CompanionTrigger)? = nil,
        retryTriggerRegistration: ((String) async throws -> CompanionTrigger)? = nil
    ) {
        self.load = load
        self.listPlugins = listPlugins
        self.listTriggerProviderAccounts = listTriggerProviderAccounts
        self.updatePluginSelection = updatePluginSelection
        self.loadCompanion = loadCompanion
        self.restart = restart
        self.createTrigger = createTrigger
        self.updateTrigger = updateTrigger
        self.deleteTrigger = deleteTrigger
        self.rotateTriggerSecret = rotateTriggerSecret
        self.retryTriggerRegistration = retryTriggerRegistration
    }
}

struct CompanionResourceSections: View {
    @Environment(SessionStore.self) private var sessionStore
    let companion: CompanionSummary
    let hasUnsavedSettings: Bool
    let onCompanionUpdated: (CompanionSummary) -> Void
    private let services: CompanionResourceSectionsServices?
    @State private var currentCompanion: CompanionSummary
    @State private var resources: CompanionConnectedResources?
    @State private var plugins: [CompanionPluginAccount] = []
    @State private var triggerProviderAccounts: [CompanionTriggerProviderAccount] = []
    @State private var loading = true
    @State private var error: String?
    @State private var success: String?
    @State private var loadGeneration = 0
    @State private var mutatingPluginID: String?
    @State private var showingPluginChoices = false
    @State private var showingPluginManagement = false
    @State private var showingTriggerProviderManagement = false
    @State private var restartTarget: CompanionRuntimeRestartTarget?
    @State private var restartingTarget: CompanionRuntimeRestartTarget?
    @State private var restartRequestIDs: [CompanionRuntimeRestartTarget: UUID] = [:]
    @State private var acceptedLifecycle: CompanionLifecycleReceipt?
    @State private var resourceActionError: String?
    @State private var busyResourceID: String?
    @State private var triggerToDelete: CompanionTrigger?
    @State private var editingTrigger: CompanionTrigger?
    @State private var showingNewTrigger = false
    @State private var confirmingRotateTriggerID: String?
    @State private var historyTrigger: CompanionTrigger?

    init(
        companion: CompanionSummary,
        hasUnsavedSettings: Bool = false,
        onCompanionUpdated: @escaping (CompanionSummary) -> Void = { _ in },
        services: CompanionResourceSectionsServices? = nil
    ) {
        self.companion = companion
        self.hasUnsavedSettings = hasUnsavedSettings
        self.onCompanionUpdated = onCompanionUpdated
        self.services = services
        _currentCompanion = State(initialValue: companion)
        _acceptedLifecycle = State(initialValue: companion.runtime.latestLifecycle)
    }

    var body: some View {
        Group {
            if loading, resources == nil {
                loadingState
            } else if let error, resources == nil {
                errorState(error)
            } else if let resources {
                resourceList(resources)
            }
        }
        .tint(visualTheme.accent)
        .task(id: companion.id) { await load() }
        .task(id: runtimePollingID) { await pollRuntimeWhileNeeded() }
        .onChange(of: companion) { _, updated in
            currentCompanion = updated.reconcilingParentProjection(from: currentCompanion)
            acceptedLifecycle = currentCompanion.runtime.latestLifecycle
        }
        .confirmationDialog(
            restartConfirmationTitle,
            isPresented: Binding(
                get: { restartTarget != nil },
                set: { if !$0 { restartTarget = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let restartTarget {
                Button(restartConfirmationButton(restartTarget)) {
                    Task { await restart(restartTarget) }
                }
            }
            Button("Cancel", role: .cancel) { restartTarget = nil }
        } message: {
            Text("This asynchronously recycles Pi and joins any automatic recovery already running. Active work may be interrupted; the Box and saved files remain in place.")
        }
        .confirmationDialog(
            "Add connected plugin",
            isPresented: $showingPluginChoices,
            titleVisibility: .visible
        ) {
            ForEach(availablePlugins) { plugin in
                Button("\(pluginProviderName(plugin.provider)) · \(plugin.label)") {
                    Task { await setPlugin(plugin, attached: true) }
                }
            }
            Button("Connect another account") { showingPluginManagement = true }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(availablePlugins.isEmpty
                ? "Connect a plugin account, then attach it to this Companion."
                : "Choose one of your connected plugin accounts.")
        }
        .sheet(isPresented: $showingPluginManagement, onDismiss: { Task { await loadPlugins() } }) {
            PluginManagementView()
                .tint(visualTheme.accent)
        }
        .sheet(
            isPresented: $showingTriggerProviderManagement,
            onDismiss: { Task { await load() } }
        ) {
            TriggerProviderManagementView()
                .tint(visualTheme.accent)
        }
        .confirmationDialog(
            "Delete this trigger?",
            isPresented: Binding(
                get: { triggerToDelete != nil },
                set: { if !$0 { triggerToDelete = nil } }
            ),
            titleVisibility: .visible,
            presenting: triggerToDelete
        ) { trigger in
            Button("Delete \(trigger.name)", role: .destructive) {
                Task { await deleteTrigger(trigger) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("Existing webhook requests will stop being accepted.")
        }
        .sheet(isPresented: $showingNewTrigger) {
            CompanionTriggerEditorView(
                accountOptions: triggerAccountOptions,
                create: { try await createTrigger($0) },
                update: { id, input in try await updateTrigger(id: id, input: input) }
            ) {
                showingNewTrigger = false
                Task { await load() }
            }
            .tint(visualTheme.accent)
        }
        .sheet(item: $editingTrigger) { trigger in
            CompanionTriggerEditorView(
                initial: trigger,
                accountOptions: triggerAccountOptions,
                create: { try await createTrigger($0) },
                update: { id, input in try await updateTrigger(id: id, input: input) }
            ) {
                editingTrigger = nil
                Task { await load() }
            }
            .tint(visualTheme.accent)
        }
        .sheet(item: $historyTrigger) { trigger in
            NavigationStack {
                CompanionTriggerHistoryView(
                    companionID: companion.id,
                    triggerID: trigger.id,
                    triggerName: trigger.name
                )
            }
            .tint(visualTheme.accent)
        }
        .accessibilityIdentifier("companion.details.resources")
    }

    private func resourceList(_ resources: CompanionConnectedResources) -> some View {
        LazyVStack(alignment: .leading, spacing: 22) {
                if let error {
                    CompanionErrorNotice(message: error)
                }
                if let success {
                    CompanionSuccessNotice(message: success)
                }
                if let resourceActionError {
                    CompanionErrorNotice(message: resourceActionError)
                }
                resourceSection(
                    title: "Skills",
                    symbol: "shippingbox",
                    count: currentCompanion.selectedSkillIDs.count
                ) {
                    if currentCompanion.selectedSkillIDs.isEmpty {
                        emptyRow(
                            title: "No Skills connected",
                            detail: "Attached Skills will appear here.",
                            identifier: "companion.details.skills.empty"
                        )
                    } else {
                        ForEach(Array(resources.skills.enumerated()), id: \.element.id) { index, skill in
                            if index > 0 { resourceDivider }
                            skillRow(skill)
                        }
                        if resources.hiddenSkillCount > 0 {
                            if !resources.skills.isEmpty { resourceDivider }
                            hiddenSkillsRow(count: resources.hiddenSkillCount)
                        }
                    }
                }

                resourceSection(
                    title: "Connected plugins",
                    symbol: "puzzlepiece.extension",
                    count: attachedPlugins.count
                ) {
                    if attachedPlugins.isEmpty {
                        emptyRow(
                            title: "No plugins attached",
                            detail: canManagePlugins
                                ? "Add one of your connected accounts to make its tools available."
                                : "No attached plugin accounts are available to you.",
                            identifier: "companion.details.plugins.empty"
                        )
                    } else {
                        ForEach(Array(attachedPlugins.enumerated()), id: \.element.id) { index, plugin in
                            if index > 0 { resourceDivider }
                            pluginRow(plugin)
                        }
                    }
                    if unavailablePluginCount > 0 {
                        if !attachedPlugins.isEmpty { resourceDivider }
                        unavailablePluginsRow(count: unavailablePluginCount)
                    }
                    if canManagePlugins {
                        resourceDivider
                        Button("Add plugin", systemImage: "plus") {
                            showingPluginChoices = true
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .padding(.horizontal, 16)
                        .disabled(mutatingPluginID != nil || lifecycleActive)
                        .accessibilityIdentifier("companion.details.plugins.add")
                    } else if currentCompanion.access == .editor {
                        resourceDivider
                        Text("Only the Companion Owner can change plugin attachments. This protects private accounts already attached by other members.")
                            .font(.caption)
                            .foregroundStyle(Color.companionMuted)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(16)
                            .accessibilityIdentifier("companion.details.plugins.owner-only")
                    }
                }

                resourceSection(
                    title: "Triggers",
                    symbol: "bolt",
                    count: resources.triggers.count
                ) {
                    triggerProviderAvailability
                    resourceDivider
                    if resources.triggers.isEmpty {
                        emptyRow(
                            title: "No triggers connected",
                            detail: "Webhook prompts will appear here.",
                            identifier: "companion.details.triggers.empty"
                        )
                    } else {
                        ForEach(Array(resources.triggers.enumerated()), id: \.element.id) { index, trigger in
                            if index > 0 { resourceDivider }
                            triggerRow(trigger)
                        }
                    }
                }

                runtimeSection
            }
            .padding(.bottom, 2)
    }

    private func resourceSection<Content: View>(
        title: String,
        symbol: String,
        count: Int,
        @ViewBuilder content: () -> Content
    ) -> some View {
        CompanionSheetCard {
            VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Label(title, systemImage: symbol)
                    .font(.headline)
                    .foregroundStyle(Color.companionInk)
                Spacer()
                if canEditResources, title == "Triggers" {
                    Button {
                        showingNewTrigger = true
                    } label: {
                        Image(systemName: "plus")
                            .font(.body.weight(.semibold))
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Add a trigger")
                    .accessibilityIdentifier("companion.details.triggers.add")
                }
                Text("\(count)")
                    .font(.caption.monospacedDigit().weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
                    .accessibilityLabel("\(count) \(title.lowercased())")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .accessibilityAddTraits(.isHeader)

            Divider()
                .overlay(Color.companionDivider)

                content()
            }
        }
    }

    private func skillRow(_ skill: CompanionSkillSummary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(skill.displayName)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                if skill.displayName != skill.slug {
                    Text(skill.slug)
                        .font(.caption.monospaced())
                        .foregroundStyle(Color.companionMuted)
                        .textSelection(.enabled)
                }
                Text(skill.description.isEmpty ? "No description provided." : skill.description)
                    .font(.footnote)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            statusBadge(.active, activeLabel: "Enabled")
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(skill.displayName). \(skill.description.isEmpty ? "No description provided." : skill.description). Enabled")
        .accessibilityIdentifier("companion.details.skill.\(skill.id)")
    }

    private func hiddenSkillsRow(count: Int) -> some View {
        Label(
            "\(count) selected \(count == 1 ? "Skill is" : "Skills are") not visible to you.",
            systemImage: "eye.slash"
        )
        .font(.footnote)
        .foregroundStyle(Color.companionMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityIdentifier("companion.details.skills.hidden")
    }

    private func pluginRow(_ plugin: CompanionPluginAccount) -> some View {
        HStack(alignment: .center, spacing: 12) {
            PluginMark(provider: plugin.provider, size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(pluginProviderName(plugin.provider))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                HStack(spacing: 5) {
                    Text(plugin.label)
                    Image(systemName: plugin.connected ? "checkmark" : "exclamationmark")
                        .foregroundStyle(plugin.connected ? CompanionIOSTheme.toggleGreen : CompanionIOSTheme.danger)
                }
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .padding(.horizontal, 10)
                .frame(height: 30)
                .background(CompanionIOSTheme.chip, in: Capsule())
                .accessibilityLabel(
                    plugin.connected ? "\(plugin.label), attached" : "\(plugin.label), connection unavailable"
                )
                .accessibilityIdentifier("companion.details.plugin-account.\(plugin.id)")
                Text(plugin.connected ? "Available to this Companion" : "Reconnect this account from Plugins")
                    .font(.caption)
                    .foregroundStyle(Color.companionMuted)
            }
            Spacer(minLength: 8)
            if canManagePlugins {
                Button("Detach") {
                    Task { await setPlugin(plugin, attached: false) }
                }
                .font(.caption.weight(.semibold))
                .frame(minWidth: 44, minHeight: 44)
                .disabled(mutatingPluginID != nil || lifecycleActive)
                .accessibilityLabel("Detach \(pluginProviderName(plugin.provider)) account \(plugin.label)")
                .accessibilityIdentifier("companion.details.plugin.detach.\(plugin.id)")
            }
        }
        .padding(16)
        .accessibilityElement(children: canManagePlugins ? .contain : .combine)
        .accessibilityIdentifier("companion.details.plugin.\(plugin.id)")
    }

    private func unavailablePluginsRow(count: Int) -> some View {
        Label(
            "\(count) attached plugin \(count == 1 ? "account could" : "accounts could") not be loaded.",
            systemImage: "eye.slash"
        )
        .font(.footnote)
        .foregroundStyle(Color.companionMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityIdentifier("companion.details.plugins.hidden")
    }

    private func triggerRow(_ trigger: CompanionTrigger) -> some View {
        let providerConnected = triggerProviderConnected(trigger)
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(trigger.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Text(trigger.providerName)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionInk.opacity(0.82))
                Text(trigger.mode == .notify ? "Notify me" : "Ask the Companion")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(Color.companionMuted)
                Text(providerConnected ? trigger.registrationDescription : "Registration blocked · provider disconnected")
                    .font(.caption)
                    .foregroundStyle(
                        !providerConnected || trigger.registrationStatus == .failed
                            ? Color.companionDanger
                            : Color.companionMuted
                    )
                if let lastFire = MemberTimezone.formatInstant(
                    trigger.lastFiredAt,
                    in: effectiveMemberTimezone
                ) {
                    Text("Last fired \(lastFire) · \(effectiveMemberTimezone)")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                }
                if let message = trigger.lastRegistrationError ?? trigger.lastErrorMessage {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !providerConnected {
                    Text("Reconnect this member provider to resume registration and incoming events for every dependent Companion.")
                        .font(.caption)
                        .foregroundStyle(Color.companionDanger)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 8)
            statusBadge(providerConnected ? trigger.status : .error)
            Button {
                historyTrigger = trigger
            } label: {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.body.weight(.semibold))
                    .frame(width: 32, height: 32)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Fire history for \(trigger.name)")
            .accessibilityIdentifier("companion.details.trigger-history.\(trigger.id)")
            if canEditResources,
               providerConnected,
               (trigger.registrationStatus == .failed || trigger.registrationStatus == .unregistered),
               busyResourceID != trigger.id {
                Button {
                    Task { await retryTriggerRegistration(trigger) }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.body.weight(.semibold))
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Retry registration for \(trigger.name)")
                .accessibilityIdentifier("companion.details.trigger-retry.\(trigger.id)")
            }
            if canEditResources {
                if busyResourceID == trigger.id {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Updating trigger \(trigger.name)")
                } else {
                    Menu {
                        Button(trigger.enabled ? "Turn off" : "Turn on") {
                            Task { await toggleTrigger(trigger) }
                        }
                        Button("Edit", systemImage: "pencil") {
                            editingTrigger = trigger
                        }
                        if providerConnected,
                           (trigger.registrationStatus == .failed || trigger.registrationStatus == .unregistered) {
                            Button("Retry registration", systemImage: "arrow.clockwise") {
                                Task { await retryTriggerRegistration(trigger) }
                            }
                        }
                        if trigger.webhookURL != nil {
                            Button("Copy technical URL", systemImage: "doc.on.doc") {
                                copyWebhookURL(trigger)
                            }
                            Button(
                                confirmingRotateTriggerID == trigger.id ? "Confirm rotate secret" : "Rotate secret",
                                systemImage: "arrow.triangle.2.circlepath"
                            ) {
                                if confirmingRotateTriggerID == trigger.id {
                                    Task { await rotateTriggerSecret(trigger) }
                                } else {
                                    confirmingRotateTriggerID = trigger.id
                                }
                            }
                        }
                        Button("Delete", systemImage: "trash", role: .destructive) {
                            triggerToDelete = trigger
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.body.weight(.semibold))
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Actions for trigger \(trigger.name)")
                    .accessibilityIdentifier("companion.details.trigger-actions.\(trigger.id)")
                }
            }
        }
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            triggerAccessibilityLabel(trigger)
        )
        .accessibilityIdentifier("companion.details.trigger.\(trigger.id)")
    }

    private var runtimeSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Label("Runtime", systemImage: "server.rack")
                    .font(.headline)
                    .foregroundStyle(Color.companionInk)
                Spacer()
                CompanionStatusBadge(runtime: currentCompanion.runtime)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .accessibilityAddTraits(.isHeader)

            Divider().overlay(Color.companionDivider)

            VStack(alignment: .leading, spacing: 14) {
                Text(runtimeMessage)
                    .font(.footnote)
                    .foregroundStyle(runtimeMessageColor)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("companion.details.runtime.status")

                if canEdit {
                    Text("Advanced recovery recycles only the Companion process. The Box and its files stay in place.")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                        .fixedSize(horizontal: false, vertical: true)

                    Button("Restart", systemImage: "arrow.clockwise") {
                        restartTarget = .pi
                    }
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .disabled(runtimeControlsDisabled)
                    .accessibilityHint("May interrupt active work; recycles Pi asynchronously and keeps the Box online")
                    .accessibilityIdentifier("companion.details.restart.companion")
                } else {
                    Text("You have read-only access. An Owner or Editor can restart this Companion.")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("companion.details.runtime.read-only")
                }
            }
            .padding(16)
        }
        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func statusBadge(
        _ status: CompanionConnectedResourceStatus,
        activeLabel: String? = nil
    ) -> some View {
        let label = status == .active ? activeLabel ?? status.label : status.label
        return HStack(spacing: 5) {
            Circle()
                .fill(statusColor(status))
                .frame(width: 7, height: 7)
            Text(label)
                .font(.caption2.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(Color.companionInk.opacity(0.80))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(statusColor(status).opacity(0.10), in: Capsule())
        .accessibilityElement(children: .combine)
    }

    private func statusColor(_ status: CompanionConnectedResourceStatus) -> Color {
        switch status {
        case .active: .companionSuccess
        case .disabled: .companionMuted
        case .error: .companionDanger
        }
    }

    private func triggerAccessibilityLabel(_ trigger: CompanionTrigger) -> String {
        var parts = [
            trigger.name,
            trigger.providerName,
            trigger.mode == .notify ? "Notify me" : "Ask the Companion",
            trigger.registrationDescription
        ]
        if let last = MemberTimezone.formatInstant(trigger.lastFiredAt, in: effectiveMemberTimezone) {
            parts.append("Last fired \(last) in \(effectiveMemberTimezone)")
        }
        parts.append(trigger.status.label)
        return parts.joined(separator: ". ")
    }

    private func emptyRow(title: String, detail: String, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color.companionInk)
            Text(detail)
                .font(.footnote)
                .foregroundStyle(Color.companionMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    private var resourceDivider: some View {
        Divider()
            .overlay(Color.companionDivider)
            .padding(.leading, 16)
    }

    private var loadingState: some View {
        VStack(spacing: 22) {
            ForEach(0..<3, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 12) {
                    Text("Companion details")
                        .font(.headline)
                    Text("Loading section")
                    Text("Details are loading")
                        .font(.footnote)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
        }
        .redacted(reason: .placeholder)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading Companion details")
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("Companion details unavailable", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try again") { Task { await load() } }
                .buttonStyle(.glassProminent)
        }
        .padding(24)
    }

    private var visualTheme: CompanionVisualTheme {
        CompanionVisualTheme(icon: currentCompanion.icon)
    }

    private var canEdit: Bool {
        currentCompanion.access.canEditCompanionSettings
    }

    private var attachedPlugins: [CompanionPluginAccount] {
        let attachedIDs = Set(currentCompanion.selectedMCPAccountIDs)
        return plugins
            .filter { attachedIDs.contains($0.id) }
            .sorted {
                let left = pluginProviderName($0.provider)
                let right = pluginProviderName($1.provider)
                if left != right { return left.localizedCaseInsensitiveCompare(right) == .orderedAscending }
                return $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
            }
    }

    private var availablePlugins: [CompanionPluginAccount] {
        let attachedIDs = Set(currentCompanion.selectedMCPAccountIDs)
        return plugins
            .filter { $0.connected && !attachedIDs.contains($0.id) }
            .sorted {
                let left = pluginProviderName($0.provider)
                let right = pluginProviderName($1.provider)
                if left != right { return left.localizedCaseInsensitiveCompare(right) == .orderedAscending }
                return $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
            }
    }

    private var unavailablePluginCount: Int {
        max(0, currentCompanion.selectedMCPAccountIDs.count - attachedPlugins.count)
    }

    private var canManagePlugins: Bool {
        currentCompanion.access == .owner
    }

    private var latestLifecycle: CompanionLifecycleReceipt? {
        acceptedLifecycle ?? currentCompanion.runtime.latestLifecycle
    }

    private var lifecycleActive: Bool {
        latestLifecycle?.isActive == true
    }

    private var runtimeOnline: Bool {
        currentCompanion.runtime.state == .running
            && currentCompanion.runtime.daemonState == .running
    }

    private var runtimeControlsDisabled: Bool {
        restartingTarget != nil
            || mutatingPluginID != nil
            || lifecycleActive
            || hasUnsavedSettings
    }

    private var runtimeMessage: String {
        if let lifecycle = latestLifecycle {
            let label = lifecycleLabel(lifecycle.intent)
            switch lifecycle.status {
            case .pending:
                return "\(label) is queued. Status refreshes automatically."
            case .running:
                if currentCompanion.runtime.state == .stopping { return "The server is stopping for \(label.lowercased())." }
                if currentCompanion.runtime.state == .provisioning { return "The server is starting after \(label.lowercased())." }
                return "\(label) is in progress."
            case .succeeded:
                return "\(label) completed."
            case .failed, .interrupted, .cancelled:
                return lifecycle.error?.message ?? "\(label) did not complete. Retry when it is safe."
            case .unknown:
                return "Runtime lifecycle status is unavailable."
            }
        }
        if let lastError = currentCompanion.runtime.lastError, !lastError.isEmpty { return lastError }
        if runtimeOnline {
            if hasUnsavedSettings { return "Save your Companion settings before restarting." }
            return "Advanced recovery asynchronously recycles Pi while the Box and saved files stay in place."
        }
        return "Advanced recovery remains available while this Companion is offline. It recycles Pi only; sending remains the normal wake action."
    }

    private var runtimeMessageColor: Color {
        guard let lifecycle = latestLifecycle else {
            return currentCompanion.runtime.state == .error ? .companionDanger : .companionMuted
        }
        switch lifecycle.status {
        case .failed, .interrupted, .cancelled: return .companionDanger
        default: return .companionMuted
        }
    }

    private var runtimePollingID: String {
        let lifecycle = latestLifecycle
        return "\(currentCompanion.id):\(lifecycle?.id ?? "none"):\(lifecycle?.status.rawValue ?? "none"):\(currentCompanion.runtime.state.rawValue)"
    }

    private var needsRuntimePolling: Bool {
        lifecycleActive
            || currentCompanion.runtime.state == .provisioning
            || currentCompanion.runtime.state == .stopping
    }

    private var restartConfirmationTitle: String {
        restartTarget == nil ? "Restart Companion?" : "Restart \(currentCompanion.name)?"
    }

    private func restartConfirmationButton(_ target: CompanionRuntimeRestartTarget) -> String {
        _ = target
        return "Restart"
    }

    private func lifecycleLabel(_ kind: CompanionLifecycleIntent) -> String {
        switch kind {
        case .recyclePi: "Companion restart"
        case .archive: "Archive"
        case .prepare: "Preparation"
        case .delete: "Deletion"
        case .unknown: "Runtime lifecycle"
        }
    }

    private func pluginProviderName(_ provider: String) -> String {
        switch provider.lowercased() {
        case "github": "GitHub"
        case "linear": "Linear"
        case "notion": "Notion"
        case "conductor": "Conductor"
        case "slack": "Slack"
        case "gmail": "Gmail"
        case "sentry": "Sentry"
        default: provider.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
        }
    }

    private var canEditResources: Bool {
        currentCompanion.access.canEditCompanionSettings
    }

    private var triggerAccountOptions: [CompanionTriggerProviderAccount] {
        triggerProviderAccounts
    }

    private var sortedTriggerProviderAccounts: [CompanionTriggerProviderAccount] {
        triggerProviderAccounts
            .sorted {
                let left = pluginProviderName($0.provider.rawValue)
                let right = pluginProviderName($1.provider.rawValue)
                if left != right { return left.localizedCaseInsensitiveCompare(right) == .orderedAscending }
                return $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending
            }
    }

    @ViewBuilder
    private var triggerProviderAvailability: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Shared providers")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(Color.companionInk)
                    Text("Connected once for every Companion")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                }
                Spacer()
                Button(triggerProviderAccounts.isEmpty ? "Connect" : "Manage") {
                    showingTriggerProviderManagement = true
                }
                .font(.caption.weight(.semibold))
                .accessibilityIdentifier("companion.details.triggers.manage-providers")
            }

            if triggerProviderAccounts.isEmpty {
                Text("No trigger provider connected. Connect GitHub, Sentry, or Linear once to make it live for every Companion.")
                    .font(.caption)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(sortedTriggerProviderAccounts) { account in
                    HStack(spacing: 9) {
                        PluginMark(provider: account.provider.rawValue, size: 28)
                        Text("\(pluginProviderName(account.provider.rawValue)) · \(account.label)")
                            .font(.caption.weight(.medium))
                            .foregroundStyle(Color.companionInk)
                            .lineLimit(1)
                        Spacer()
                        Label(
                            account.status == .connected ? "Connected" : "Disconnected",
                            systemImage: account.status == .connected
                                ? "checkmark.circle.fill"
                                : "exclamationmark.circle.fill"
                        )
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(
                                account.status == .connected
                                    ? Color.companionSuccess
                                    : Color.companionDanger
                            )
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel(
                        "\(pluginProviderName(account.provider.rawValue)) \(account.label), shared provider \(account.status.rawValue)"
                    )
                }
            }

            Text("No Companion attachment is required. MCP tool attachments are managed separately above.")
                .font(.caption2)
                .foregroundStyle(Color.companionMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .accessibilityIdentifier("companion.details.triggers.providers")
    }

    private func triggerProviderConnected(_ trigger: CompanionTrigger) -> Bool {
        let provider = trigger.provider.lowercased()
        guard provider == "github" || provider == "linear" || provider == "sentry" else { return true }
        if let accountID = trigger.providerAccountID {
            return triggerProviderAccounts.contains { $0.id == accountID && $0.status == .connected }
        }
        return triggerProviderAccounts.contains { $0.provider.rawValue == provider && $0.status == .connected }
    }

    private var effectiveMemberTimezone: String {
        sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier
    }

    private func createTrigger(_ input: CreateCompanionTriggerInput) async throws -> CompanionTrigger {
        guard canEditResources else { throw APIError(status: 403, code: "forbidden", message: "You cannot edit this Companion.") }
        if let create = services?.createTrigger { return try await create(input) }
        return try await sessionStore.createCompanionTrigger(companionID: companion.id, input: input)
    }

    private func updateTrigger(
        id: String,
        input: UpdateCompanionTriggerInput
    ) async throws -> CompanionTrigger {
        guard canEditResources else { throw APIError(status: 403, code: "forbidden", message: "You cannot edit this Companion.") }
        if let update = services?.updateTrigger { return try await update(id, input) }
        return try await sessionStore.updateCompanionTrigger(
            companionID: companion.id,
            triggerID: id,
            input: input
        )
    }

    private func deleteTrigger(_ trigger: CompanionTrigger) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = trigger.id
        resourceActionError = nil
        triggerToDelete = nil
        do {
            if let delete = services?.deleteTrigger {
                try await delete(trigger.id)
            } else {
                try await sessionStore.deleteCompanionTrigger(companionID: companion.id, triggerID: trigger.id)
            }
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(error, fallback: "The trigger could not be deleted.")
        }
        busyResourceID = nil
    }

    private func toggleTrigger(_ trigger: CompanionTrigger) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = trigger.id
        resourceActionError = nil
        do {
            _ = try await updateTrigger(
                id: trigger.id,
                input: UpdateCompanionTriggerInput(enabled: !trigger.enabled)
            )
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(error, fallback: "The trigger could not be updated.")
        }
        busyResourceID = nil
    }

    private func copyWebhookURL(_ trigger: CompanionTrigger) {
        guard canEditResources, let webhookURL = trigger.webhookURL else { return }
        UIPasteboard.general.string = webhookURL
        resourceActionError = nil
    }

    private func rotateTriggerSecret(_ trigger: CompanionTrigger) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = trigger.id
        resourceActionError = nil
        confirmingRotateTriggerID = nil
        do {
            if let rotate = services?.rotateTriggerSecret {
                _ = try await rotate(trigger.id)
            } else {
                _ = try await sessionStore.rotateCompanionTriggerSecret(
                    companionID: companion.id,
                    triggerID: trigger.id
                )
            }
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(error, fallback: "The webhook secret could not be rotated.")
        }
        busyResourceID = nil
    }

    private func retryTriggerRegistration(_ trigger: CompanionTrigger) async {
        guard canEditResources, busyResourceID == nil else { return }
        busyResourceID = trigger.id
        resourceActionError = nil
        do {
            if let retry = services?.retryTriggerRegistration {
                _ = try await retry(trigger.id)
            } else {
                _ = try await sessionStore.retryCompanionTriggerRegistration(
                    companionID: companion.id,
                    triggerID: trigger.id
                )
            }
            await load()
        } catch {
            resourceActionError = companionDisplayMessage(
                error,
                fallback: "The provider registration could not be retried."
            )
        }
        busyResourceID = nil
    }

    private func load() async {
        loadGeneration += 1
        let generation = loadGeneration
        if resources == nil { loading = true }
        do {
            let next: CompanionConnectedResources
            if let services {
                next = try await services.load()
            } else {
                next = try await sessionStore.connectedResources(for: currentCompanion)
            }
            guard !Task.isCancelled, generation == loadGeneration else { return }
            resources = next
            error = nil
            await loadPlugins(expectedGeneration: generation)
            await loadTriggerProviderAccounts(expectedGeneration: generation)
            await refreshRuntime()
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            self.error = "Companion details could not be refreshed. Check your connection and try again."
        }
        if generation == loadGeneration { loading = false }
    }

    private func loadPlugins(expectedGeneration: Int? = nil) async {
        do {
            let next = if let services {
                try await services.listPlugins()
            } else {
                try await sessionStore.listCompanionPlugins()
            }
            guard !Task.isCancelled,
                  expectedGeneration == nil || expectedGeneration == loadGeneration else { return }
            plugins = next
            error = nil
            if availablePlugins.isEmpty, canManagePlugins {
                showingPluginChoices = false
            }
        } catch {
            guard !Task.isCancelled,
                  expectedGeneration == nil || expectedGeneration == loadGeneration else { return }
            self.error = companionDisplayMessage(error, fallback: "Plugin accounts could not be refreshed.")
        }
    }

    private func loadTriggerProviderAccounts(expectedGeneration: Int? = nil) async {
        do {
            let next: [CompanionTriggerProviderAccount]
            if let list = services?.listTriggerProviderAccounts {
                next = try await list()
            } else if services == nil {
                next = try await sessionStore.listCompanionTriggerProviderAccounts()
            } else {
                next = []
            }
            guard !Task.isCancelled,
                  expectedGeneration == nil || expectedGeneration == loadGeneration else { return }
            triggerProviderAccounts = next
        } catch {
            guard !Task.isCancelled,
                  expectedGeneration == nil || expectedGeneration == loadGeneration else { return }
            self.error = companionDisplayMessage(
                error,
                fallback: "Trigger provider accounts could not be refreshed."
            )
        }
    }

    private func setPlugin(_ plugin: CompanionPluginAccount, attached: Bool) async {
        guard canManagePlugins, mutatingPluginID == nil else { return }
        mutatingPluginID = plugin.id
        error = nil
        success = nil
        var selection = Set(currentCompanion.selectedMCPAccountIDs)
        if attached { selection.insert(plugin.id) } else { selection.remove(plugin.id) }
        do {
            let updated: CompanionSummary
            if let services {
                updated = try await services.updatePluginSelection(selection.sorted())
            } else {
                updated = try await sessionStore.updateCompanionPluginSelection(
                    companionID: currentCompanion.id,
                    selectedMCPAccountIDs: selection.sorted()
                )
            }
            currentCompanion = updated.preservingListProjection(from: currentCompanion)
            acceptedLifecycle = updated.runtime.latestLifecycle
            onCompanionUpdated(currentCompanion)
            success = attached
                ? "\(pluginProviderName(plugin.provider)) · \(plugin.label) attached."
                : "\(pluginProviderName(plugin.provider)) · \(plugin.label) detached."
        } catch {
            self.error = companionDisplayMessage(
                error,
                fallback: attached ? "The plugin could not be attached." : "The plugin could not be detached."
            )
        }
        mutatingPluginID = nil
    }

    private func restart(_ target: CompanionRuntimeRestartTarget) async {
        guard canEdit,
              !hasUnsavedSettings,
              !lifecycleActive,
              restartingTarget == nil else { return }
        restartingTarget = target
        restartTarget = nil
        error = nil
        success = nil
        let requestID = restartRequestIDs[target] ?? UUID()
        restartRequestIDs[target] = requestID
        do {
            let lifecycle: CompanionLifecycleReceipt
            if let services {
                lifecycle = try await services.restart(target, requestID)
            } else {
                lifecycle = try await sessionStore.restartCompanion(
                    companionID: currentCompanion.id,
                    target: target,
                    requestID: requestID
                )
            }
            restartRequestIDs[target] = nil
            acceptedLifecycle = lifecycle
            success = "Restart accepted. It joins any recovery already in progress."
        } catch {
            if let apiError = error as? APIError, apiError.status == 0 {
                self.error = "The restart response was not received. Retry safely reuses the same request."
            } else {
                self.error = companionDisplayMessage(error, fallback: "This Companion could not be restarted.")
            }
        }
        restartingTarget = nil
    }

    private func pollRuntimeWhileNeeded() async {
        guard needsRuntimePolling else { return }
        while !Task.isCancelled, needsRuntimePolling {
            await refreshRuntime()
            guard !Task.isCancelled, needsRuntimePolling else { return }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private func refreshRuntime() async {
        do {
            let updated: CompanionSummary
            if let services {
                updated = try await services.loadCompanion()
            } else {
                updated = try await sessionStore.companionRuntime(companionID: currentCompanion.id)
            }
            guard !Task.isCancelled else { return }
            currentCompanion = updated.preservingListProjection(from: currentCompanion)
            acceptedLifecycle = updated.runtime.latestLifecycle
        } catch {
            guard !Task.isCancelled else { return }
            self.error = companionDisplayMessage(error, fallback: "Restart status could not be refreshed.")
        }
    }
}

#if DEBUG
@MainActor
enum CompanionResourceDemoFixtures {
    static var companion: CompanionSummary {
        let selectedSkillIDs = ProcessInfo.processInfo.environment["COMPANION_DETAIL_DEMO_EMPTY"] == "skills"
            ? "[]"
            : #"["11111111-1111-4111-8111-111111111111","22222222-2222-4222-8222-222222222222"]"#
        return decode(#"""
        {
          "id":"c96ab360-00f3-4497-a51a-51442db8add1",
          "name":"Luna",
          "persona":"Keep releases calm",
          "model_id":"claude-sonnet",
          "selected_skill_ids":\#(selectedSkillIDs),
          "selected_mcp_account_ids":["55555555-5555-4555-8555-555555555555"],
          "icon":{"shape":6,"mouth":1,"accessory":6,"color":2},
          "access":"viewer",
          "hidden":false,
          "unread":false,
          "last_message":null,
          "runtime":{"state":"running","daemon_state":"running","replying":false,"last_error":null}
        }
        """#)
    }

    static var resources: CompanionConnectedResources {
        let emptySection = ProcessInfo.processInfo.environment["COMPANION_DETAIL_DEMO_EMPTY"]
        return CompanionConnectedResources(
            skills: emptySection == "skills" ? [] : [decode(#"""
            {
              "id":"11111111-1111-4111-8111-111111111111",
              "slug":"incident-summary",
              "display":{"name":"Incident Summary"},
              "description":"Summarizes incidents into concise operational updates."
            }
            """#)],
            hiddenSkillCount: emptySection == "skills" ? 0 : 1,
            routines: emptySection == "routines" ? [] : [decode(#"""
            {
              "id":"33333333-3333-4333-8333-333333333333",
              "name":"Weekday brief",
              "cron":"0 9 * * 1-5",
              "timezone":"America/New_York",
              "enabled":true,
              "next_fire_at":"2026-08-27T13:00:00.000Z",
              "last_error_message":null
            }
            """#)],
            triggers: emptySection == "triggers" ? [] : [decode(#"""
            {
              "id":"44444444-4444-4444-8444-444444444444",
              "name":"Pull request opened",
              "prompt":"Summarize the pull request.",
              "mode":"relay",
              "provider":"github",
              "provider_account_id":"55555555-5555-4555-8555-555555555555",
              "registration_status":"registered",
              "remote_hook_account_id":"55555555-5555-4555-8555-555555555555",
              "remote_hook_id":"hook-42",
              "enabled":true,
              "last_error_message":null
            }
            """#)]
        )
    }

    static var plugins: [CompanionPluginAccount] {
        [decode(#"{"id":"55555555-5555-4555-8555-555555555555","provider":"github","label":"work","transport":"http","endpoint":"https://api.githubcopilot.com/mcp","connected":true,"created_at":"2026-08-25T08:00:00.000Z","updated_at":"2026-08-25T08:00:00.000Z"}"#)]
    }

    static func restartOperation(_: CompanionRuntimeRestartTarget) -> CompanionLifecycleReceipt {
        decode(#"{"id":"77777777-7777-4777-8777-777777777777","kind":"restart_pi","status":"pending","error":null}"#)
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}
#endif
