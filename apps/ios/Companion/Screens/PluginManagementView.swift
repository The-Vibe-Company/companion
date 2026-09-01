import SwiftUI
import CompanionKit

struct CuratedCompanionPlugin: Identifiable, Hashable {
    let id: String
    let provider: String
    let title: String
    let detail: String
}

let curatedCompanionPlugins = [
    CuratedCompanionPlugin(
        id: "app.linear/linear",
        provider: "linear",
        title: "Linear",
        detail: "Projects, issues, and team workflows."
    ),
    CuratedCompanionPlugin(
        id: "io.github.github/github-mcp-server",
        provider: "github",
        title: "GitHub",
        detail: "Repositories, issues, pull requests, and Git operations."
    ),
    CuratedCompanionPlugin(
        id: "com.notion/mcp",
        provider: "notion",
        title: "Notion",
        detail: "Pages, databases, and workspace search."
    ),
    CuratedCompanionPlugin(
        id: "build.conductor/mcp",
        provider: "conductor",
        title: "Conductor",
        detail: "Cloud workspaces, sessions, and coding agents."
    ),
    CuratedCompanionPlugin(
        id: "com.slack/mcp",
        provider: "slack",
        title: "Slack",
        detail: "Send messages to channels, direct messages, and threads."
    ),
    CuratedCompanionPlugin(
        id: "com.google.workspace/gmail",
        provider: "gmail",
        title: "Gmail",
        detail: "Search and read email, and create drafts for review in Gmail. It never sends mail."
    ),
    CuratedCompanionPlugin(
        id: "io.sentry/mcp",
        provider: "sentry",
        title: "Sentry",
        detail: "Issues, events, traces, releases, and debugging context."
    ),
]

private struct LegacyPluginManagementView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var plugins: [CompanionPluginAccount] = []
    @State private var loading = true
    @State private var error: String?
    @State private var success: String?
    @State private var showingAddPlugin = false
    @State private var curatedPlugin: CuratedCompanionPlugin?
    @State private var pluginToDisconnect: CompanionPluginAccount?

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    VStack(spacing: 14) {
                        CompanionManagementHeader(
                            eyebrow: "Tools",
                            title: "Plugins",
                            detail: "Connect MCP servers once, then choose exactly which tools each Companion can use.",
                            symbol: "puzzlepiece.extension.fill"
                        )

                        if let error { CompanionErrorNotice(message: error) }
                        if let success { CompanionSuccessNotice(message: success) }

                        if loading && plugins.isEmpty {
                            ProgressView("Loading plugins…")
                                .padding(28)
                                .frame(maxWidth: .infinity)
                                .companionGlass(radius: 18)
                        } else if plugins.isEmpty {
                            CompanionEmptyCard(
                                symbol: "puzzlepiece.extension",
                                title: "No plugins connected",
                                detail: "Add an HTTP or command-based MCP server to give Companions new capabilities."
                            )
                            Button("Add a plugin", systemImage: "plus") { showingAddPlugin = true }
                                .buttonStyle(.glassProminent)
                        } else {
                            connectedPlugins
                        }

                        availablePlugins

                        Button("Add custom MCP", systemImage: "terminal.fill") {
                            showingAddPlugin = true
                        }
                        .buttonStyle(.glass)
                        .frame(maxWidth: .infinity, alignment: .leading)

                        Label(
                            "Credentials are encrypted and write-only. Removing a plugin detaches it from every Companion that uses it.",
                            systemImage: "lock.shield.fill"
                        )
                        .font(.footnote)
                        .foregroundStyle(Color.companionMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollIndicators(.hidden)
                .refreshable { await reload() }
            }
            .navigationTitle("Plugins")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Add", systemImage: "plus") { showingAddPlugin = true }
                }
            }
            .sheet(isPresented: $showingAddPlugin) {
                AddPluginView {
                    showingAddPlugin = false
                    success = "Plugin connected."
                    Task { await reload() }
                }
            }
            .sheet(item: $curatedPlugin) { plugin in
                ConnectCuratedPluginView(plugin: plugin) {
                    curatedPlugin = nil
                    success = "\(plugin.title) account connected."
                    Task { await reload() }
                }
            }
            .confirmationDialog(
                "Remove \(pluginToDisconnect?.label ?? "plugin")?",
                isPresented: Binding(
                    get: { pluginToDisconnect != nil },
                    set: { if !$0 { pluginToDisconnect = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove plugin", role: .destructive) {
                    guard let plugin = pluginToDisconnect else { return }
                    pluginToDisconnect = nil
                    Task { await disconnect(plugin) }
                }
                Button("Cancel", role: .cancel) { pluginToDisconnect = nil }
            } message: {
                Text("This member-wide account becomes unavailable to every Companion. MCP tool attachments stop working, and dependent triggers cannot register or receive events until the provider is reconnected.")
            }
            .task { await reload() }
        }
    }

    private var connectedPlugins: some View {
        CompanionManagementCard("Connected accounts") {
            ForEach(Array(pluginGroups.enumerated()), id: \.element.provider) { groupIndex, group in
                if groupIndex > 0 { Divider().overlay(Color.companionDivider) }
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 11) {
                        PluginMark(provider: group.provider, size: 40)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(pluginTitle(group.provider))
                                .font(.headline)
                                .foregroundStyle(Color.companionInk)
                            Text(group.accounts.count == 1 ? "1 account" : "\(group.accounts.count) accounts")
                                .font(.caption)
                                .foregroundStyle(Color.companionMuted)
                        }
                        Spacer()
                        if let catalogEntry = curatedCompanionPlugins.first(where: { $0.provider == group.provider }) {
                            Button("Add account", systemImage: "plus") {
                                curatedPlugin = catalogEntry
                            }
                            .font(.caption.weight(.semibold))
                            .buttonStyle(.glass)
                        }
                    }

                    ForEach(group.accounts) { account in
                        accountRow(account)
                    }
                }
                .padding(.vertical, 4)
            }
        }
    }

    private var availablePlugins: some View {
        CompanionManagementCard("Available plugins") {
            ForEach(Array(curatedCompanionPlugins.enumerated()), id: \.element.id) { index, plugin in
                if index > 0 { Divider().overlay(Color.companionDivider) }
                HStack(spacing: 12) {
                    PluginMark(provider: plugin.provider, size: 42)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 7) {
                            Text(plugin.title)
                                .font(.headline)
                                .foregroundStyle(Color.companionInk)
                            let count = plugins.filter { $0.provider == plugin.provider }.count
                            if count > 0 {
                                Text(count == 1 ? "1 ACCOUNT" : "\(count) ACCOUNTS")
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(Color.companionAccent)
                            }
                        }
                        Text(plugin.detail)
                            .font(.caption)
                            .foregroundStyle(Color.companionMuted)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    Button(plugins.contains(where: { $0.provider == plugin.provider }) ? "Add" : "Connect") {
                        curatedPlugin = plugin
                    }
                    .buttonStyle(.glass)
                }
                .padding(.vertical, 4)
                .accessibilityIdentifier("plugins.catalog.\(plugin.provider)")
            }
        }
    }

    private func accountRow(_ plugin: CompanionPluginAccount) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(plugin.label)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Text(plugin.endpoint)
                    .font(.caption2.monospaced())
                    .foregroundStyle(Color.companionMuted)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(plugin.transport == .http ? "HTTP" : "COMMAND")
                .font(.caption2.weight(.bold))
                .foregroundStyle(Color.companionMuted)
            Menu {
                Button("Remove", systemImage: "trash", role: .destructive) {
                    pluginToDisconnect = plugin
                }
            } label: {
                Image(systemName: "ellipsis")
                    .frame(width: 44, height: 44)
            }
            .accessibilityLabel("Manage \(plugin.label)")
        }
        .padding(.leading, 51)
    }

    private var pluginGroups: [(provider: String, accounts: [CompanionPluginAccount])] {
        let grouped = Dictionary(grouping: plugins, by: \.provider)
        let catalogOrder = Dictionary(uniqueKeysWithValues: curatedCompanionPlugins.enumerated().map {
            ($0.element.provider, $0.offset)
        })
        return grouped.map { (provider: $0.key, accounts: $0.value) }.sorted {
            let left = catalogOrder[$0.provider] ?? Int.max
            let right = catalogOrder[$1.provider] ?? Int.max
            return left == right ? $0.provider < $1.provider : left < right
        }
    }

    private func pluginTitle(_ provider: String) -> String {
        curatedCompanionPlugins.first(where: { $0.provider == provider })?.title
            ?? provider.split(separator: "-").map { $0.capitalized }.joined(separator: " ")
    }

    private func reload() async {
        loading = true
        do {
            plugins = try await sessionStore.listCompanionPlugins()
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Plugins are temporarily unavailable.")
        }
        loading = false
    }

    private func disconnect(_ plugin: CompanionPluginAccount) async {
        do {
            try await sessionStore.deleteCompanionPlugin(accountID: plugin.id)
            success = "\(plugin.label) removed."
            error = nil
            await reload()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "\(plugin.label) could not be removed.")
        }
    }
}

struct ConnectCuratedPluginView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(ExternalOAuthCoordinator.self) private var externalOAuth
    @Environment(\.dismiss) private var dismiss
    let plugin: CuratedCompanionPlugin
    let controlRequest: CompanionPluginControlRequest?
    let onConnected: () -> Void

    @State private var label = ""
    @State private var submitting = false
    @State private var cancellationPending = false
    @State private var oauthGeneration = UUID()
    @State private var error: String?

    init(
        plugin: CuratedCompanionPlugin,
        initialLabel: String? = nil,
        controlRequest: CompanionPluginControlRequest? = nil,
        onConnected: @escaping () -> Void
    ) {
        self.plugin = plugin
        self.controlRequest = controlRequest
        self.onConnected = onConnected
        _label = State(initialValue: initialLabel ?? "")
    }

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    VStack(spacing: 14) {
                        CompanionManagementHeader(
                            eyebrow: "New account",
                            title: "Connect \(plugin.title)",
                            detail: "Add another account to this plugin category and give it a short label.",
                            symbol: "link.badge.plus"
                        )

                        if let error { CompanionErrorNotice(message: error) }

                        CompanionManagementCard("Account") {
                            HStack(spacing: 12) {
                                PluginMark(provider: plugin.provider, size: 44)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(plugin.title)
                                        .font(.headline)
                                        .foregroundStyle(Color.companionInk)
                                    Text(plugin.detail)
                                        .font(.caption)
                                        .foregroundStyle(Color.companionMuted)
                                }
                            }
                            CompanionFieldLabel(
                                "Account label",
                                detail: "Use a label such as work, personal, or client-name. Labels are unique inside this plugin."
                            )
                            TextField("work", text: $label)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .padding(14)
                                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                                        .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
                                }
                        }

                        Label(
                            authorizationDetail,
                            systemImage: "lock.shield.fill"
                        )
                        .font(.footnote)
                        .foregroundStyle(Color.companionMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)

                        if pluginFlowActive {
                            pluginWaitingSurface
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("Connect account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(cancellationPending ? "Cancelling…" : "Cancel") {
                        requestCancellation(dismissAfterwards: true)
                    }
                    .disabled(submitting || cancellationPending || externalOAuth.phase == .completing)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitting ? "Opening…" : "Continue") { Task { await connect() } }
                        .disabled(
                            trimmedLabel.isEmpty
                                || trimmedLabel.count > 40
                                || submitting
                                || cancellationPending
                                || pluginFlowActive
                        )
                }
            }
            .onChange(of: externalOAuth.callbackGeneration) { _, _ in
                guard pluginFlowActive,
                      let callbackURL = externalOAuth.takeCallback() else { return }
                Task { await completePluginOAuth(callbackURL) }
            }
            .onDisappear {
                guard (submitting && !pluginFlowActive)
                    || (pluginFlowActive && externalOAuth.phase != .completing) else { return }
                requestCancellation(fromDisappear: true)
            }
            .interactiveDismissDisabled(
                submitting || cancellationPending || externalOAuth.phase == .completing
            )
        }
    }

    private var pluginFlowActive: Bool {
        externalOAuth.activeFlow?.isPlugin == true
    }

    @ViewBuilder
    private var pluginWaitingSurface: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Plugin authorization", systemImage: "arrow.up.right.square")
                .font(.headline)
                .foregroundStyle(Color.companionInk)

            switch externalOAuth.phase {
            case .waiting:
                Text("The provider is open in your default browser. Return here after you finish authorizing \(plugin.title).")
            case .timedOut:
                Text("No callback arrived. Reopen this authorization or cancel this attempt.")
            case .failed(let message):
                Text(message)
            case .completing:
                Text("Finishing plugin authorization…")
            case .idle:
                EmptyView()
            }

            if externalOAuth.phase != .completing {
                HStack(spacing: 10) {
                    Button("Reopen", systemImage: "arrow.clockwise") {
                        reopenPluginAuthorization()
                    }
                    .buttonStyle(.glass)
                    .accessibilityIdentifier("plugins.oauth.reopen.\(plugin.provider)")

                    Button(cancellationPending ? "Cancelling…" : "Cancel", systemImage: "xmark") {
                        requestCancellation()
                    }
                    .buttonStyle(.glass)
                    .disabled(cancellationPending)
                    .accessibilityIdentifier("plugins.oauth.cancel.\(plugin.provider)")
                }
            }
        }
        .font(.subheadline)
        .foregroundStyle(Color.companionMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .companionGlass(radius: 18)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("plugins.oauth.waiting.\(plugin.provider)")
    }

    private var trimmedLabel: String {
        label.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var authorizationDetail: String {
        if plugin.provider.lowercased() == "gmail" {
            return "Authorize read and draft access on Google. Companion cannot send mail; drafts stay in Gmail for your review. Tokens remain encrypted and write-only."
        }
        if plugin.provider.lowercased() == "github" || plugin.provider.lowercased() == "sentry" {
            return "Authorize once. Trigger registration becomes live for every Companion immediately; MCP tools still require their separate per-Companion attachment. Tokens remain encrypted and write-only."
        }
        return "Authorization happens on \(plugin.title). Tokens stay encrypted and write-only."
    }

    private func connect() async {
        guard !trimmedLabel.isEmpty, trimmedLabel.count <= 40 else { return }
        await startOAuthFlow()
    }

    private func startOAuthFlow() async {
        guard !trimmedLabel.isEmpty,
              trimmedLabel.count <= 40,
              !submitting,
              !cancellationPending else { return }
        submitting = true
        error = nil
        let generation = oauthGeneration
        defer { submitting = false }
        do {
            let started = try await sessionStore.startCompanionPluginOAuth(
                serverName: plugin.id,
                label: trimmedLabel,
                companionID: controlRequest?.companionID,
                controlRequestID: controlRequest?.requestID
            )
            guard generation == oauthGeneration, !cancellationPending else {
                return
            }
            guard externalOAuth.beginPlugin(authorizationURL: started.authorizationURL) else {
                await sessionStore.cancelCompanionPluginOAuth()
                self.error = "The plugin authorization response was not recognized. Try again."
                return
            }
        } catch {
            guard generation == oauthGeneration, !cancellationPending else { return }
            self.error = companionDisplayMessage(error, fallback: "The plugin connection could not be started.")
        }
    }

    private func reopenPluginAuthorization() {
        externalOAuth.reopen()
    }

    private func requestCancellation(
        dismissAfterwards: Bool = false,
        fromDisappear: Bool = false
    ) {
        guard !cancellationPending,
              fromDisappear || (!submitting && externalOAuth.phase != .completing) else { return }
        cancellationPending = true
        let cancellationGeneration = UUID()
        oauthGeneration = cancellationGeneration
        externalOAuth.cancel()
        Task { @MainActor in
            await finishCancellation(
                generation: cancellationGeneration,
                dismissAfterwards: dismissAfterwards
            )
        }
    }

    private func finishCancellation(generation: UUID, dismissAfterwards: Bool) async {
        await sessionStore.cancelCompanionPluginOAuth()
        guard oauthGeneration == generation else { return }
        if dismissAfterwards {
            dismiss()
        }
        cancellationPending = false
    }

    private func completePluginOAuth(_ callbackURL: URL) async {
        guard !cancellationPending else { return }
        submitting = true
        error = nil
        let generation = oauthGeneration
        defer { submitting = false }
        do {
            try await sessionStore.completeCompanionPluginOAuth(callbackURL: callbackURL)
            guard generation == oauthGeneration, !cancellationPending else { return }
            externalOAuth.completeSuccessfully()
            onConnected()
            dismiss()
        } catch {
            guard generation == oauthGeneration, !cancellationPending else { return }
            externalOAuth.fail("The plugin authorization could not be completed.")
            self.error = companionDisplayMessage(
                error,
                fallback: "The plugin authorization could not be completed."
            )
        }
    }
}

struct AddPluginView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let onConnected: () -> Void

    @State private var provider = "custom"
    @State private var label = ""
    @State private var transport: CompanionPluginTransport = .http
    @State private var remoteURL = ""
    @State private var command = ""
    @State private var arguments = ""
    @State private var credentialName = ""
    @State private var credentialValue = ""
    @State private var submitting = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    VStack(spacing: 14) {
                        CompanionManagementHeader(
                            eyebrow: "Custom MCP",
                            title: "Add a plugin",
                            detail: "Connect a remote MCP endpoint or a command available inside the Companion Box.",
                            symbol: "terminal.fill"
                        )

                        if let error { CompanionErrorNotice(message: error) }

                        CompanionManagementCard("Identity") {
                            CompanionFieldLabel(
                                "Provider ID",
                                detail: "Lowercase letters, numbers, and hyphens — for example linear or custom."
                            )
                            styledField("custom", text: $provider, capitalization: .never)
                            CompanionFieldLabel("Display name")
                            styledField("Team Linear", text: $label)
                        }

                        CompanionManagementCard("Connection") {
                            Picker("Transport", selection: $transport) {
                                Text("HTTP").tag(CompanionPluginTransport.http)
                                Text("Command").tag(CompanionPluginTransport.stdio)
                            }
                            .pickerStyle(.segmented)

                            if transport == .http {
                                CompanionFieldLabel(
                                    "MCP URL",
                                    detail: "HTTPS is recommended. HTTP is supported for trusted local services."
                                )
                                styledField("https://mcp.example.com", text: $remoteURL, capitalization: .never)
                                    .keyboardType(.URL)
                            } else {
                                CompanionFieldLabel(
                                    "Command",
                                    detail: "The executable must already exist in the Companion Box."
                                )
                                styledField("npx", text: $command, capitalization: .never)
                                CompanionFieldLabel(
                                    "Arguments",
                                    detail: "One argument per line. Leave blank when no arguments are needed."
                                )
                                TextEditor(text: $arguments)
                                    .font(.body.monospaced())
                                    .frame(minHeight: 92)
                                    .scrollContentBackground(.hidden)
                                    .padding(10)
                                    .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                                            .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
                                    }
                            }
                        }

                        CompanionManagementCard("Optional credential") {
                            CompanionFieldLabel(
                                transport == .http ? "Header name" : "Environment variable",
                                detail: transport == .http ? "For example Authorization or X-API-Key." : "For example LINEAR_API_KEY."
                            )
                            styledField(
                                transport == .http ? "Authorization" : "PLUGIN_API_KEY",
                                text: $credentialName,
                                capitalization: .never
                            )
                            CompanionFieldLabel(
                                "Secret value",
                                detail: "Encrypted when saved and never returned by the API."
                            )
                            SecureField("Paste secret", text: $credentialValue)
                                .textContentType(.password)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .padding(14)
                                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                                        .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
                                }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }
                .scrollIndicators(.hidden)
            }
            .navigationTitle("New plugin")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(submitting ? "Adding…" : "Add") { Task { await save() } }
                        .disabled(!isValid || submitting)
                }
            }
        }
    }

    private func styledField(
        _ prompt: String,
        text: Binding<String>,
        capitalization: TextInputAutocapitalization = .sentences
    ) -> some View {
        TextField(prompt, text: text)
            .textInputAutocapitalization(capitalization)
            .autocorrectionDisabled()
            .padding(14)
            .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
            }
    }

    private var providerSlug: String {
        provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var trimmedLabel: String {
        label.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var hasValidCredentialPair: Bool {
        let name = credentialName.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = credentialValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty && value.isEmpty { return true }
        guard !name.isEmpty, !value.isEmpty else { return false }
        return name.range(of: "^[A-Za-z_][A-Za-z0-9_-]{0,127}$", options: .regularExpression) != nil
            && !value.contains("\n")
            && !value.contains("\r")
    }

    private var isValid: Bool {
        guard providerSlug.range(of: "^[a-z][a-z0-9-]{0,62}$", options: .regularExpression) != nil,
              !trimmedLabel.isEmpty,
              trimmedLabel.count <= 40,
              hasValidCredentialPair else { return false }
        switch transport {
        case .http:
            guard let url = URL(string: remoteURL.trimmingCharacters(in: .whitespacesAndNewlines)),
                  let scheme = url.scheme?.lowercased() else { return false }
            return scheme == "https" || scheme == "http"
        case .stdio:
            let value = command.trimmingCharacters(in: .whitespacesAndNewlines)
            return !value.isEmpty && !value.contains("\n") && !value.contains("\r")
        }
    }

    private func save() async {
        guard isValid else { return }
        submitting = true
        error = nil
        let name = credentialName.trimmingCharacters(in: .whitespacesAndNewlines)
        let value = credentialValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let args = arguments
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        let input = SaveCompanionPluginInput(
            provider: providerSlug,
            label: trimmedLabel,
            transport: transport,
            url: transport == .http ? remoteURL.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
            command: transport == .stdio ? command.trimmingCharacters(in: .whitespacesAndNewlines) : nil,
            args: transport == .stdio ? args : [],
            credentialName: name.isEmpty ? nil : name,
            credentialValue: value.isEmpty ? nil : value
        )
        do {
            _ = try await sessionStore.saveCompanionPlugin(input)
            onConnected()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "The plugin could not be connected.")
        }
        submitting = false
    }
}

struct PluginMark: View {
    let provider: String
    var size: CGFloat = 42

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.40, weight: .semibold))
            .foregroundStyle(Color.companionInk)
            .frame(width: size, height: size)
            .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
            }
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch provider.lowercased() {
        case "linear": return "line.3.horizontal.decrease"
        case "github": return "chevron.left.forwardslash.chevron.right"
        case "notion": return "doc.richtext"
        case "slack": return "number"
        case "conductor": return "square.stack.3d.up.fill"
        case "gmail": return "envelope.fill"
        case "sentry": return "exclamationmark.triangle.fill"
        default: return "puzzlepiece.extension.fill"
        }
    }

}
