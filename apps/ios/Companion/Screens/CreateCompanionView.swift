import SwiftUI
import CompanionKit

@MainActor
struct CreateCompanionServices {
    let listProviders: () async throws -> CompanionProvidersResponse
    let listPlugins: () async throws -> [CompanionPluginAccount]
    let createCompanion: (CreateCompanionInput) async throws -> CompanionSummary
}

struct CreateCompanionView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let onCreated: (CompanionSummary) -> Void
    private let services: CreateCompanionServices?

    @State private var name = ""
    @State private var title = ""
    @State private var icon = CompanionSummary.Icon(shape: 6, mouth: 1, accessory: 6, color: 2)
    @State private var providers: CompanionProvidersResponse?
    @State private var plugins: [CompanionPluginAccount] = []
    @State private var providerID = ""
    @State private var modelID = ""
    @State private var selectedPluginIDs: Set<String> = []
    @State private var loading = true
    @State private var submitting = false
    @State private var error: String?
    @State private var showingProviders = false
    @State private var showingPlugins = false
    @FocusState private var focusedField: Field?

    private enum Field { case name, title }

    init(
        services: CreateCompanionServices? = nil,
        onCreated: @escaping (CompanionSummary) -> Void
    ) {
        self.services = services
        self.onCreated = onCreated
    }

    var body: some View {
        NavigationStack {
            CompanionIOSTheme.canvas
                .ignoresSafeArea()
                .overlay {
                ScrollView {
                    VStack(spacing: 24) {
                        CharacterMark(name: displayName, icon: icon, size: 96)
                            .padding(.top, 12)

                        if let error { CompanionErrorNotice(message: error) }

                        VStack(spacing: 12) {
                            TextField("Name", text: $name)
                                .textInputAutocapitalization(.words)
                                .autocorrectionDisabled()
                                .font(.system(size: 17, weight: .semibold))
                                .padding(.horizontal, 16)
                                .frame(height: 52)
                                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18))
                                .focused($focusedField, equals: .name)
                                .accessibilityIdentifier("companion.create.name")

                            TextField("Title (optional)", text: $title)
                                .font(.system(size: 16))
                                .padding(.horizontal, 16)
                                .frame(height: 52)
                                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18))
                                .focused($focusedField, equals: .title)
                                .accessibilityIdentifier("companion.create.title")
                        }

                        CharacterPicker(
                            selection: $icon,
                            accessibilityIdentifierPrefix: "companion.create.icon"
                        )

                        if loading {
                            ProgressView("Preparing workspace…")
                        } else if connectedProviders.isEmpty {
                            Button("Connect a model provider") { showingProviders = true }
                                .buttonStyle(.borderedProminent)
                                .tint(CompanionIOSTheme.primaryCTA)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 24)
                }
                .scrollIndicators(.hidden)
                }
            .navigationTitle("New Bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitting ? "Creating…" : "Create") { Task { await create() } }
                        .disabled(!canCreate || submitting)
                }
            }
            .sheet(isPresented: $showingProviders, onDismiss: { Task { await loadWorkspace() } }) {
                ProviderManagementView()
            }
            .sheet(isPresented: $showingPlugins, onDismiss: { Task { await loadWorkspace() } }) {
                PluginManagementView()
            }
            .task { await loadWorkspace() }
            .task { focusedField = .name }
            .onChange(of: providerID) { selectDefaultModel() }
        }
    }

    private var identityCard: some View {
        CompanionManagementCard("Identity") {
            HStack(spacing: 18) {
                CompanionAvatar(name: displayName, icon: icon, size: 86, state: .thinking)
                    .accessibilityLabel("Preview for \(displayName)")

                VStack(alignment: .leading, spacing: 10) {
                    TextField("Companion name", text: $name)
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .font(.title3.weight(.semibold))
                        .padding(14)
                        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 18, style: .continuous)
                                .stroke(Color.companionBorder, lineWidth: 0.7)
                        }
                        .accessibilityLabel("Companion name")
                }
            }
        }
    }

    private var iconCard: some View {
        CompanionManagementCard("Icon") {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    iconPickerDetail
                    Spacer(minLength: 8)
                    randomizeButton
                }

                VStack(alignment: .leading, spacing: 10) {
                    iconPickerDetail
                    randomizeButton
                }
            }

            CharacterPicker(
                selection: $icon,
                accessibilityIdentifierPrefix: "companion.create.icon"
            )
        }
    }

    private var iconPickerDetail: some View {
        Text("Choose every part of your Companion's icon.")
            .font(.subheadline)
            .foregroundStyle(Color.companionMuted)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var randomizeButton: some View {
        Button("Surprise me", systemImage: "dice.fill") { randomizeIcon() }
            .buttonStyle(.glass)
            .accessibilityIdentifier("companion.create.randomize-icon")
    }

    @ViewBuilder
    private var providerCard: some View {
        CompanionManagementCard("Intelligence") {
            if connectedProviders.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    Text("Connect a model provider first")
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                    Text("API keys and subscription credentials are encrypted and never shown again.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                    Button("Open providers", systemImage: "cpu") { showingProviders = true }
                        .buttonStyle(.glassProminent)
                }
            } else {
                CompanionFieldLabel("Model provider")
                Picker("Model provider", selection: $providerID) {
                    ForEach(connectedProviders) { provider in
                        Text(provider.name).tag(provider.id)
                    }
                }
                .pickerStyle(.menu)

                if let provider = selectedProvider {
                    CompanionFieldLabel(
                        "Model",
                        detail: provider.description
                    )
                    Picker("Model", selection: $modelID) {
                        ForEach(provider.models) { model in
                            Text(model.name).tag(model.id)
                        }
                    }
                    .pickerStyle(.menu)
                }

                Button("Manage providers", systemImage: "slider.horizontal.3") {
                    showingProviders = true
                }
                .buttonStyle(.glass)
            }
        }
    }

    private var pluginCard: some View {
        CompanionManagementCard("Plugins") {
            if plugins.isEmpty {
                VStack(alignment: .leading, spacing: 9) {
                    Text("No plugins yet")
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                    Text("You can create this Companion without plugins, or connect an MCP server now.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionMuted)
                    Button("Add a plugin", systemImage: "plus") { showingPlugins = true }
                        .buttonStyle(.glass)
                }
            } else {
                Text("Choose only the tools this Companion needs. You can change them later.")
                    .font(.subheadline)
                    .foregroundStyle(Color.companionMuted)

                ForEach(Array(pluginGroups.enumerated()), id: \.element.provider) { index, group in
                    if index > 0 { Divider().overlay(Color.companionDivider) }
                    Toggle(isOn: pluginGroupSelection(group)) {
                        HStack(spacing: 11) {
                            PluginMark(provider: group.provider, size: 38)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(group.title)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Color.companionInk)
                                Text(group.accounts.count == 1 ? "1 connected account" : "\(group.accounts.count) connected accounts")
                                    .font(.caption)
                                    .foregroundStyle(Color.companionMuted)
                            }
                        }
                    }
                    .tint(Color.companionAccent)
                    .padding(.vertical, 3)
                    .accessibilityIdentifier("create.plugin.\(group.provider)")

                    if groupIsSelected(group) {
                        HStack(spacing: 10) {
                            CompanionFieldLabel("Account")
                            Spacer()
                            if group.accounts.count == 1, let account = group.accounts.first {
                                Text(account.label)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(Color.companionMuted)
                            } else {
                                Picker("\(group.title) account", selection: selectedAccount(in: group)) {
                                    ForEach(group.accounts) { account in
                                        Text(account.label).tag(account.id)
                                    }
                                }
                                .pickerStyle(.menu)
                                .accessibilityIdentifier("create.plugin-account.\(group.provider)")
                            }
                        }
                        .padding(.leading, 49)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }

                Button("Manage plugins", systemImage: "puzzlepiece.extension") {
                    showingPlugins = true
                }
                .buttonStyle(.glass)
            }
        }
    }

    private struct PluginGroup {
        let provider: String
        let title: String
        let accounts: [CompanionPluginAccount]
    }

    private var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? "New Companion" : trimmed
    }

    private var connectedProviders: [CompanionProviderDefinition] {
        providers?.connectedDefinitions ?? []
    }

    private var selectedProvider: CompanionProviderDefinition? {
        connectedProviders.first(where: { $0.id == providerID })
    }

    private var canCreate: Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmedName.isEmpty
            && trimmedName.count <= 120
            && selectedProvider?.models.contains(where: { $0.id == modelID }) == true
    }

    private var pluginGroups: [PluginGroup] {
        Dictionary(grouping: plugins, by: \.provider)
            .map { provider, accounts in
                PluginGroup(
                    provider: provider,
                    title: pluginTitle(provider),
                    accounts: accounts.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
                )
            }
            .sorted { $0.title.localizedCaseInsensitiveCompare($1.title) == .orderedAscending }
    }

    private func pluginGroupSelection(_ group: PluginGroup) -> Binding<Bool> {
        Binding(
            get: { groupIsSelected(group) },
            set: { selected in
                let accountIDs = Set(group.accounts.map(\.id))
                if selected {
                    if selectedPluginIDs.isDisjoint(with: accountIDs), let first = group.accounts.first {
                        selectedPluginIDs.insert(first.id)
                    }
                } else {
                    selectedPluginIDs.subtract(accountIDs)
                }
            }
        )
    }

    private func selectedAccount(in group: PluginGroup) -> Binding<String> {
        let accountIDs = Set(group.accounts.map(\.id))
        return Binding(
            get: {
                selectedPluginIDs.first(where: { accountIDs.contains($0) }) ?? group.accounts.first?.id ?? ""
            },
            set: { accountID in
                selectedPluginIDs.subtract(accountIDs)
                if accountIDs.contains(accountID) { selectedPluginIDs.insert(accountID) }
            }
        )
    }

    private func groupIsSelected(_ group: PluginGroup) -> Bool {
        !selectedPluginIDs.isDisjoint(with: Set(group.accounts.map(\.id)))
    }

    private func pluginTitle(_ provider: String) -> String {
        switch provider.lowercased() {
        case "github": return "GitHub"
        case "linear": return "Linear"
        case "notion": return "Notion"
        case "conductor": return "Conductor"
        case "slack": return "Slack"
        case "gmail": return "Gmail"
        case "sentry": return "Sentry"
        default:
            return provider.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
        }
    }

    private func loadWorkspace() async {
        loading = true
        do {
            let (providerResponse, pluginResponse) = try await loadWorkspaceResources()
            providers = providerResponse
            plugins = pluginResponse
            let validPluginIDs = Set(pluginResponse.map(\.id))
            selectedPluginIDs.formIntersection(validPluginIDs)
            selectInitialProvider(from: providerResponse)
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The workspace configuration could not be loaded.")
        }
        loading = false
    }

    private func loadWorkspaceResources() async throws -> (
        CompanionProvidersResponse,
        [CompanionPluginAccount]
    ) {
        if let services {
            let nextProviders = try await services.listProviders()
            let nextPlugins = try await services.listPlugins()
            return (nextProviders, nextPlugins)
        }

        async let nextProviders = sessionStore.listCompanionProviders()
        async let nextPlugins = sessionStore.listCompanionPlugins()
        return try await (nextProviders, nextPlugins)
    }

    private func selectInitialProvider(from response: CompanionProvidersResponse) {
        let connectedIDs = Set(response.connections.map(\.providerID))
        let preferred = response.defaultProviderID.flatMap { connectedIDs.contains($0) ? $0 : nil }
        if !connectedIDs.contains(providerID) {
            providerID = preferred ?? response.connectedDefinitions.first?.id ?? ""
        }
        selectDefaultModel()
    }

    private func selectDefaultModel() {
        guard let provider = selectedProvider else {
            modelID = ""
            return
        }
        if !provider.models.contains(where: { $0.id == modelID }) {
            modelID = provider.defaultModelID ?? ""
        }
    }

    private func create() async {
        guard canCreate else { return }
        submitting = true
        error = nil
        let input = CreateCompanionInput(
            name: name.trimmingCharacters(in: .whitespacesAndNewlines),
            persona: title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? nil
                : title.trimmingCharacters(in: .whitespacesAndNewlines),
            providerID: providerID,
            modelID: modelID,
            selectedMCPAccountIDs: selectedPluginIDs.sorted(),
            icon: icon
        )
        do {
            let companion: CompanionSummary
            if let services {
                companion = try await services.createCompanion(input)
            } else {
                companion = try await sessionStore.createCompanion(input)
            }
            onCreated(companion)
            dismiss()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The Companion could not be created.")
        }
        submitting = false
    }

    private func randomizeIcon() {
        let updated = CompanionSummary.Icon(
            shape: .random(in: 0..<8),
            mouth: .random(in: 0..<5),
            accessory: .random(in: 0..<7),
            color: .random(in: 0..<11)
        )
        if reduceMotion {
            icon = updated
        } else {
            withAnimation(.easeOut(duration: 0.2)) {
                icon = updated
            }
        }
    }
}

#if DEBUG
struct CreateCompanionDemoView: View {
    @State private var createdCompanion: CompanionSummary?

    var body: some View {
        if let createdCompanion {
            ContentUnavailableView(
                "\(createdCompanion.name) created",
                systemImage: "checkmark.circle",
                description: Text("The deterministic creation fixture accepted the selected identity.")
            )
        } else {
            CreateCompanionView(
                services: CreateCompanionDemoFixtures.services,
                onCreated: { createdCompanion = $0 }
            )
        }
    }
}

@MainActor
private enum CreateCompanionDemoFixtures {
    static let services = CreateCompanionServices(
        listProviders: { await providers },
        listPlugins: { [] },
        createCompanion: { input in companion(input: input) }
    )

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
          "connections":[{
            "provider_id":"anthropic",
            "auth_method":"api_key",
            "connected_by":"user-1",
            "created_at":"2026-08-26T08:00:00.000Z",
            "updated_at":"2026-08-26T08:00:00.000Z"
          }],
          "default_provider_id":"anthropic",
          "can_manage":true
        }
        """#)
    }

    private static func companion(input: CreateCompanionInput) -> CompanionSummary {
        let object: [String: Any] = [
            "id": "c96ab360-00f3-4497-a51a-51442db8add1",
            "name": input.name,
            "persona": NSNull(),
            "model_id": input.modelID,
            "selected_skill_ids": [],
            "selected_mcp_account_ids": input.selectedMCPAccountIDs,
            "icon": [
                "shape": input.icon.shape,
                "mouth": input.icon.mouth,
                "accessory": input.icon.accessory,
                "color": input.icon.color,
            ],
            "access": "owner",
            "hidden": false,
            "unread": false,
            "last_message": NSNull(),
            "runtime": [
                "state": "not_created",
                "daemon_state": "stopped",
                "replying": false,
                "last_error": NSNull(),
                "provider_ids": [input.providerID],
                "lifecycle_intent": "prepare",
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(CompanionSummary.self, from: data)
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}
#endif
