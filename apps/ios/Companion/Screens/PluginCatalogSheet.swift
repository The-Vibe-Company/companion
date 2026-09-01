import SwiftUI
import CompanionKit

struct CompanionPluginControlRequest: Equatable {
    let provider: String
    let companionID: String
    let requestID: String
}

struct PluginManagementView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var model = CompanionPluginSheetModel(accounts: [])
    @State private var loading = true
    @State private var error: String?
    @State private var success: String?
    @State private var showingAddPlugin = false
    @State private var curatedPlugin: CuratedCompanionPlugin?
    @State private var pluginToDisconnect: CompanionPluginAccount?
    private let demoMode: Bool
    private let controlRequest: CompanionPluginControlRequest?

    init(
        demoModel: CompanionPluginSheetModel? = nil,
        controlRequest: CompanionPluginControlRequest? = nil
    ) {
        demoMode = demoModel != nil
        self.controlRequest = controlRequest
        _model = State(initialValue: demoModel ?? CompanionPluginSheetModel(accounts: []))
        _loading = State(initialValue: demoModel == nil)
    }

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 20) {
                    CompanionSheetHeader(
                        title: "Plugins",
                        leadingStyle: .back,
                        leadingAction: { dismiss() }
                    ) {
                        Button {
                            model.yoursOnly.toggle()
                        } label: {
                            Text("Yours")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(
                                    model.yoursOnly ? CompanionIOSTheme.primaryCTAText : CompanionIOSTheme.textPrimary
                                )
                                .padding(.horizontal, 16)
                                .frame(height: 36)
                                .background(
                                    model.yoursOnly ? CompanionIOSTheme.primaryCTA : CompanionIOSTheme.card,
                                    in: Capsule()
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityValue(model.yoursOnly ? "Selected" : "Not selected")
                        .accessibilityIdentifier("plugins.yours")
                    }

                    searchField
                    if let error { CompanionErrorNotice(message: error) }
                    if let success { CompanionSuccessNotice(message: success) }

                    if loading && model.accounts.isEmpty {
                        loadingRows
                    } else if model.sections.isEmpty {
                        ContentUnavailableView.search(text: model.query)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 28)
                    } else {
                        ForEach(model.sections) { section in
                            pluginSection(section)
                        }
                    }

                    Button {
                        guard !demoMode else { return }
                        showingAddPlugin = true
                    } label: {
                        Label("Add custom MCP", systemImage: "terminal")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(CompanionIOSTheme.textPrimary)
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .background(CompanionIOSTheme.card, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("plugins.add-custom")

                    Text("Gmail can search and read email, then create drafts for review. Companion never sends mail.")
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .refreshable {
                guard !demoMode else { return }
                await reload()
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .toolbar(.hidden, for: .navigationBar)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .sheet(isPresented: $showingAddPlugin) {
            AddPluginView {
                showingAddPlugin = false
                success = "Plugin connected."
                Task { await reload() }
            }
        }
        .sheet(item: $curatedPlugin) { plugin in
            ConnectCuratedPluginView(
                plugin: plugin,
                controlRequest: controlRequest?.provider == plugin.provider ? controlRequest : nil
            ) {
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
        .task {
            guard !demoMode else { return }
            await reload()
            if let controlRequest,
               let requested = curatedCompanionPlugins.first(where: {
                   $0.provider == controlRequest.provider
               }) {
                curatedPlugin = requested
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(CompanionIOSTheme.textSecondary)
            TextField("Search plugins", text: $model.query)
                .font(.system(size: 16))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 44)
        .background(CompanionIOSTheme.card, in: Capsule())
        .accessibilityIdentifier("plugins.search")
    }

    private var loadingRows: some View {
        VStack(spacing: 12) {
            ForEach(0..<3, id: \.self) { _ in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: 12).frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 6) {
                        RoundedRectangle(cornerRadius: 4).frame(width: 110, height: 16)
                        RoundedRectangle(cornerRadius: 4).frame(height: 13)
                    }
                }
                .foregroundStyle(CompanionIOSTheme.textSecondary.opacity(0.16))
                .padding(16)
                .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 18))
                .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading plugins")
    }

    private func pluginSection(_ section: CompanionPluginSheetSection) -> some View {
        CompanionSheetSection(section.title) {
            CompanionSheetCard {
                ForEach(Array(section.rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { CompanionSheetSeparator(leading: 72) }
                    pluginRow(row)
                }
            }
        }
    }

    private func pluginRow(_ row: CompanionPluginSheetRow) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 12) {
                PluginMark(provider: row.item.provider, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.item.title)
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                    Text(row.item.detail)
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                trailingState(row)
            }

            if !row.accounts.isEmpty {
                accountChips(row)
                    .padding(.leading, 56)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .accessibilityIdentifier("plugins.catalog.\(row.item.provider)")
    }

    @ViewBuilder
    private func trailingState(_ row: CompanionPluginSheetRow) -> some View {
        switch row.connectionState {
        case .add:
            Button("Add") { connect(row.item) }
                .pluginStateStyle(background: CompanionIOSTheme.chip, foreground: CompanionIOSTheme.textPrimary)
        case .authorize:
            Button("Authorize") { connect(row.item) }
                .pluginStateStyle(background: CompanionIOSTheme.actionBlue, foreground: Color.white)
        case .added:
            Text("Added")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .padding(.horizontal, 14)
                .frame(height: 34)
                .background(CompanionIOSTheme.chip, in: Capsule())
                .accessibilityLabel("Added")
        }
    }

    private func accountChips(_ row: CompanionPluginSheetRow) -> some View {
        FlowLayout(spacing: 7) {
            ForEach(row.accounts.sorted(by: accountOrder)) { account in
                Menu {
                    if !account.connected, row.item.id.hasPrefix("custom:") == false {
                        Button("Authorize") { connect(row.item, suggestedLabel: account.label) }
                    }
                    Button("Remove", systemImage: "trash", role: .destructive) {
                        guard !demoMode else { return }
                        pluginToDisconnect = account
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(account.label)
                        if account.connected {
                            Image(systemName: "checkmark")
                                .foregroundStyle(CompanionIOSTheme.toggleGreen)
                        }
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .background(CompanionIOSTheme.chip, in: Capsule())
                }
                .accessibilityIdentifier("plugins.account.\(row.item.provider).\(account.id)")
                .accessibilityLabel(
                    account.connected ? "\(account.label), connected" : "\(account.label), authorization required"
                )
            }

            if !row.item.id.hasPrefix("custom:") {
                Button {
                    connect(row.item)
                } label: {
                    Label("Account", systemImage: "plus")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(CompanionIOSTheme.chip, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Add another \(row.item.title) account")
                .accessibilityIdentifier("plugins.account.add.\(row.item.provider)")
            }
        }
    }

    private func connect(_ item: CompanionPluginCatalogItem, suggestedLabel: String? = nil) {
        guard !demoMode else { return }
        guard !item.id.hasPrefix("custom:") else {
            showingAddPlugin = true
            return
        }
        curatedPlugin = CuratedCompanionPlugin(
            id: item.id,
            provider: item.provider,
            title: item.title,
            detail: item.detail
        )
    }

    private func accountOrder(_ left: CompanionPluginAccount, _ right: CompanionPluginAccount) -> Bool {
        if left.connected != right.connected { return left.connected }
        return left.label.localizedCaseInsensitiveCompare(right.label) == .orderedAscending
    }

    private func reload() async {
        loading = true
        do {
            model.accounts = try await sessionStore.listCompanionPlugins()
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Plugins are temporarily unavailable.")
        }
        loading = false
    }

    private func disconnect(_ plugin: CompanionPluginAccount) async {
        guard !demoMode else { return }
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

private struct TriggerProviderKeyTarget: Identifiable {
    let provider: CompanionTriggerProviderAccountProvider
    let label: String?

    var id: String { "\(provider.rawValue):\(label ?? "new")" }
}

private struct TriggerProviderCatalogEntry: Identifiable {
    let provider: CompanionTriggerProviderAccountProvider
    let title: String
    let plugin: CuratedCompanionPlugin?

    var id: CompanionTriggerProviderAccountProvider { provider }
}

private let triggerProviderCatalog: [TriggerProviderCatalogEntry] = [
    TriggerProviderCatalogEntry(
        provider: .github,
        title: "GitHub",
        plugin: CuratedCompanionPlugin(
            id: "io.github.github/github-mcp-server",
            provider: "github",
            title: "GitHub",
            detail: "One OAuth account powers MCP tools and member-wide trigger registration."
        )
    ),
    TriggerProviderCatalogEntry(
        provider: .sentry,
        title: "Sentry",
        plugin: CuratedCompanionPlugin(
            id: "io.sentry/mcp",
            provider: "sentry",
            title: "Sentry",
            detail: "One OAuth account powers MCP tools and member-wide trigger registration."
        )
    ),
    TriggerProviderCatalogEntry(provider: .linear, title: "Linear", plugin: nil),
]

/// Member-wide trigger authority. Unlike MCP tools, these accounts are never attached per Companion.
struct TriggerProviderManagementView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    @State private var accounts: [CompanionTriggerProviderAccount] = []
    @State private var loading = true
    @State private var error: String?
    @State private var success: String?
    @State private var oauthTarget: (plugin: CuratedCompanionPlugin, label: String?)?
    @State private var keyTarget: TriggerProviderKeyTarget?
    @State private var disconnectTarget: CompanionTriggerProviderAccount?
    @State private var disconnectingID: String?

    var body: some View {
        CompanionSheetCanvas {
            ScrollView {
                VStack(spacing: 20) {
                    CompanionSheetHeader(
                        title: "Trigger providers",
                        leadingStyle: .back,
                        leadingAction: { dismiss() }
                    )

                    Text("Connect once at member level. Every Companion can create its own triggers immediately—there is no attachment step.")
                        .font(.system(size: 15))
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    if let error { CompanionErrorNotice(message: error) }
                    if let success { CompanionSuccessNotice(message: success) }

                    if loading && accounts.isEmpty {
                        ProgressView("Loading trigger providers…")
                            .frame(maxWidth: .infinity)
                            .padding(28)
                    }

                    ForEach(triggerProviderCatalog) { item in
                        providerCard(item)
                    }

                    Label(
                        "Trigger providers are live for every Companion. MCP tool accounts still use separate per-Companion attachments.",
                        systemImage: "person.2.badge.gearshape"
                    )
                    .font(.footnote)
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .refreshable { await reload() }
        }
        .toolbar(.hidden, for: .navigationBar)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .task { await reload() }
        .sheet(item: $keyTarget) { target in
            TriggerProviderAPIKeyView(provider: target.provider, initialLabel: target.label) {
                keyTarget = nil
                success = "\(providerTitle(target.provider)) connected for every Companion."
                Task { await reload() }
            }
        }
        .sheet(
            isPresented: Binding(
                get: { oauthTarget != nil },
                set: { if !$0 { oauthTarget = nil } }
            )
        ) {
            if let target = oauthTarget {
                ConnectCuratedPluginView(plugin: target.plugin, initialLabel: target.label) {
                    oauthTarget = nil
                    success = "\(target.plugin.title) connected for MCP and every Companion's triggers."
                    Task { await reload() }
                }
            }
        }
        .confirmationDialog(
            "Disconnect \(disconnectTarget?.label ?? "provider")?",
            isPresented: Binding(
                get: { disconnectTarget != nil },
                set: { if !$0 { disconnectTarget = nil } }
            ),
            titleVisibility: .visible,
            presenting: disconnectTarget
        ) { account in
            Button("Disconnect provider", role: .destructive) {
                disconnectTarget = nil
                Task { await disconnect(account) }
            }
            Button("Cancel", role: .cancel) { disconnectTarget = nil }
        } message: { account in
            let count = account.dependentTriggerCount
            let triggerLabel = count == 1 ? "1 dependent trigger" : "\(count) dependent triggers"
            Text(
                "\(triggerLabel) across all Companions will become unregistered and cannot receive events until reconnect plus registration retry."
                + (account.mcpAccountID == nil ? "" : " The shared MCP tool account will also be removed.")
            )
        }
    }

    private func providerCard(
        _ item: TriggerProviderCatalogEntry
    ) -> some View {
        let providerAccounts = accounts.filter { $0.provider == item.provider }
        let hasConnectedAccount = providerAccounts.contains { $0.status == .connected }
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                PluginMark(provider: item.provider.rawValue, size: 42)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(.headline)
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                    Text(providerDetail(item.provider))
                        .font(.caption)
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
                Spacer()
            }

            ForEach(providerAccounts) { account in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.label)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(CompanionIOSTheme.textPrimary)
                        Text("\(account.credentialSource == .mcpOAuth ? "SHARED OAUTH" : "ENCRYPTED API KEY") · \(account.dependentTriggerCount) \(account.dependentTriggerCount == 1 ? "TRIGGER" : "TRIGGERS")")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                    }
                    Spacer()
                    Label(
                        account.status == .connected ? "Connected" : "Disconnected",
                        systemImage: account.status == .connected ? "checkmark.circle.fill" : "exclamationmark.circle.fill"
                    )
                    .labelStyle(.iconOnly)
                    .foregroundStyle(account.status == .connected ? Color.companionSuccess : Color.companionDanger)
                    Menu {
                        if account.status == .connected {
                            Button("Disconnect", systemImage: "trash", role: .destructive) {
                                disconnectTarget = account
                            }
                        } else if account.provider == .linear || account.credentialSource == .apiKey {
                            Button("Reconnect", systemImage: "arrow.clockwise") {
                                keyTarget = TriggerProviderKeyTarget(provider: account.provider, label: account.label)
                            }
                        } else if let plugin = item.plugin {
                            Button("Reconnect", systemImage: "arrow.clockwise") {
                                oauthTarget = (plugin, account.label)
                            }
                        }
                    } label: {
                        if disconnectingID == account.id {
                            ProgressView().controlSize(.small).frame(width: 44, height: 44)
                        } else {
                            Image(systemName: "ellipsis").frame(width: 44, height: 44)
                        }
                    }
                    .disabled(disconnectingID != nil)
                }
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("trigger-providers.account.\(account.id)")
            }

            HStack(spacing: 12) {
                if let plugin = item.plugin {
                    Button("Connect \(item.title)") { oauthTarget = (plugin, nil) }
                        .buttonStyle(.glass)
                    if !hasConnectedAccount {
                        Button("Use API key") {
                            keyTarget = TriggerProviderKeyTarget(provider: item.provider, label: nil)
                        }
                        .font(.caption.weight(.semibold))
                    }
                } else {
                    Button("Connect Linear") {
                        keyTarget = TriggerProviderKeyTarget(provider: .linear, label: nil)
                    }
                    .buttonStyle(.glass)
                }
            }
        }
        .padding(16)
        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 22, style: .continuous)
                .stroke(CompanionIOSTheme.separator, lineWidth: 0.5)
        }
    }

    private func providerTitle(_ provider: CompanionTriggerProviderAccountProvider) -> String {
        triggerProviderCatalog.first(where: { $0.provider == provider })?.title ?? provider.rawValue
    }

    private func providerDetail(_ provider: CompanionTriggerProviderAccountProvider) -> String {
        switch provider {
        case .github: "Registers repository hooks with the same OAuth account as GitHub MCP."
        case .sentry: "Registers project hooks with the same OAuth account as Sentry MCP."
        case .linear: "Stores one write-only webhook key for every Companion to reuse."
        }
    }

    private func reload() async {
        loading = true
        do {
            accounts = try await sessionStore.listCompanionTriggerProviderAccounts()
            error = nil
        } catch {
            self.error = companionDisplayMessage(error, fallback: "Trigger providers are temporarily unavailable.")
        }
        loading = false
    }

    private func disconnect(_ account: CompanionTriggerProviderAccount) async {
        guard disconnectingID == nil else { return }
        disconnectingID = account.id
        error = nil
        do {
            _ = try await sessionStore.disconnectCompanionTriggerProviderAccount(accountID: account.id)
            success = "\(account.label) disconnected. Dependent triggers are preserved as unregistered."
            await reload()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "\(account.label) could not be disconnected.")
        }
        disconnectingID = nil
    }
}

private struct TriggerProviderAPIKeyView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.dismiss) private var dismiss
    let provider: CompanionTriggerProviderAccountProvider
    let onConnected: () -> Void
    @State private var label: String
    @State private var credential = ""
    @State private var saving = false
    @State private var error: String?

    init(
        provider: CompanionTriggerProviderAccountProvider,
        initialLabel: String? = nil,
        onConnected: @escaping () -> Void
    ) {
        self.provider = provider
        self.onConnected = onConnected
        _label = State(initialValue: initialLabel ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Account label", text: $label)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("API key", text: $credential)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } footer: {
                    Text("The key is encrypted and write-only. Companion creates and maintains the remote webhooks for you.")
                }
                if let error { CompanionErrorNotice(message: error) }
            }
            .navigationTitle("Connect \(provider.rawValue.capitalized)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Connecting…" : "Connect") { Task { await save() } }
                        .disabled(saving || trimmedLabel.isEmpty || trimmedCredential.isEmpty)
                }
            }
        }
    }

    private var trimmedLabel: String { label.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var trimmedCredential: String { credential.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func save() async {
        guard !trimmedLabel.isEmpty, !trimmedCredential.isEmpty, !saving else { return }
        saving = true
        error = nil
        do {
            _ = try await sessionStore.saveCompanionTriggerProviderAccount(
                CreateCompanionTriggerProviderAccountInput(
                    provider: provider,
                    label: trimmedLabel,
                    credential: trimmedCredential
                )
            )
            onConnected()
            dismiss()
        } catch {
            self.error = companionDisplayMessage(error, fallback: "This provider could not be connected.")
        }
        saving = false
    }
}

private extension View {
    func pluginStateStyle(background: Color, foreground: Color) -> some View {
        self
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(foreground)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(background, in: Capsule())
            .buttonStyle(.plain)
    }
}

private struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        layout(proposal: proposal, subviews: subviews).size
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        let result = layout(proposal: ProposedViewSize(width: bounds.width, height: proposal.height), subviews: subviews)
        for (index, point) in result.points.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y), proposal: .unspecified)
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, points: [CGPoint]) {
        let width = proposal.width ?? .greatestFiniteMagnitude
        var points: [CGPoint] = []
        var cursor = CGPoint.zero
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if cursor.x > 0, cursor.x + size.width > width {
                cursor.x = 0
                cursor.y += rowHeight + spacing
                rowHeight = 0
            }
            points.append(cursor)
            cursor.x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
            usedWidth = max(usedWidth, cursor.x - spacing)
        }
        return (CGSize(width: min(width, usedWidth), height: cursor.y + rowHeight), points)
    }
}
