import Foundation
import Observation

public enum CompanionPreferenceKeys {
    public static let automaticReview = "companion.preferences.automatic-review"
    public static let automaticTimezone = "companion.preferences.automatic-timezone"
    public static let notifications = "companion.preferences.notifications"
    public static let appearance = "companion.preferences.appearance"
    public static let haptics = "companion.preferences.haptics"
    public static let notificationPrefix = "companion.preferences.bot-notifications."
}

public struct MemberSettingsSheetModel: Equatable, Sendable {
    private let originalName: String
    private let originalTimezone: String?
    public private(set) var name: String
    public private(set) var timezone: String
    public private(set) var usesAutomaticTimezone: Bool

    public init(
        name: String?,
        savedTimezone: String?,
        deviceTimezone: String,
        usesAutomaticTimezone: Bool
    ) {
        let normalizedName = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        self.originalName = normalizedName
        self.originalTimezone = savedTimezone
        self.name = normalizedName
        self.usesAutomaticTimezone = usesAutomaticTimezone
        self.timezone = usesAutomaticTimezone ? deviceTimezone : (savedTimezone ?? deviceTimezone)
    }

    public mutating func updateName(_ value: String) {
        name = String(value.prefix(120))
    }

    public mutating func updateTimezone(_ value: String) {
        timezone = value
        usesAutomaticTimezone = false
    }

    public mutating func setAutomaticTimezone(_ enabled: Bool, deviceTimezone: String) {
        usesAutomaticTimezone = enabled
        if enabled { timezone = deviceTimezone }
    }

    public var normalizedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var timezoneForSave: String {
        timezone
    }

    public var hasProfileChanges: Bool {
        normalizedName != originalName || timezone != originalTimezone
    }

    public var canSaveProfile: Bool {
        !normalizedName.isEmpty && hasProfileChanges
    }
}

public enum CompanionPluginConnectionState: String, Equatable, Sendable {
    case add
    case authorize
    case added

    public var label: String {
        switch self {
        case .add: "Add"
        case .authorize: "Authorize"
        case .added: "Added"
        }
    }
}

public struct CompanionPluginCatalogItem: Identifiable, Hashable, Sendable {
    public let id: String
    public let provider: String
    public let title: String
    public let detail: String
    public let category: String
    public let featured: Bool

    public init(
        id: String,
        provider: String,
        title: String,
        detail: String,
        category: String,
        featured: Bool
    ) {
        self.id = id
        self.provider = provider
        self.title = title
        self.detail = detail
        self.category = category
        self.featured = featured
    }
}

public struct CompanionPluginSheetRow: Identifiable, Equatable, Sendable {
    public let item: CompanionPluginCatalogItem
    public let accounts: [CompanionPluginAccount]

    public var id: String { item.id }

    public var connectionState: CompanionPluginConnectionState {
        if accounts.contains(where: \.connected) { return .added }
        if !accounts.isEmpty { return .authorize }
        return .add
    }

    public var connectedAccountLabels: [String] {
        accounts.filter(\.connected).map(\.label).sorted {
            $0.localizedCaseInsensitiveCompare($1) == .orderedAscending
        }
    }
}

public struct CompanionPluginSheetSection: Identifiable, Equatable, Sendable {
    public let title: String
    public let rows: [CompanionPluginSheetRow]

    public var id: String { title }
}

public struct CompanionPluginSheetModel: Equatable, Sendable {
    public static let catalog = [
        CompanionPluginCatalogItem(
            id: "app.linear/linear",
            provider: "linear",
            title: "Linear",
            detail: "Projects, issues, and team workflows",
            category: "Planning",
            featured: true
        ),
        CompanionPluginCatalogItem(
            id: "io.github.github/github-mcp-server",
            provider: "github",
            title: "GitHub",
            detail: "Repositories, issues, pull requests, and Git operations",
            category: "Developer tools",
            featured: true
        ),
        CompanionPluginCatalogItem(
            id: "com.google.workspace/gmail",
            provider: "gmail",
            title: "Gmail",
            detail: "Search and read email, and create drafts for review in Gmail. Never sends mail",
            category: "Communication",
            featured: true
        ),
        CompanionPluginCatalogItem(
            id: "com.notion/mcp",
            provider: "notion",
            title: "Notion",
            detail: "Pages, databases, and workspace search",
            category: "Knowledge",
            featured: false
        ),
        CompanionPluginCatalogItem(
            id: "build.conductor/mcp",
            provider: "conductor",
            title: "Conductor",
            detail: "Cloud workspaces, sessions, and coding agents",
            category: "Developer tools",
            featured: false
        ),
        CompanionPluginCatalogItem(
            id: "com.slack/mcp",
            provider: "slack",
            title: "Slack",
            detail: "Send messages to channels, direct messages, and threads",
            category: "Communication",
            featured: false
        ),
        CompanionPluginCatalogItem(
            id: "io.sentry/mcp",
            provider: "sentry",
            title: "Sentry",
            detail: "Issues, events, traces, releases, and debugging context",
            category: "Developer tools",
            featured: true
        ),
    ]

    public var query: String
    public var yoursOnly: Bool
    public var accounts: [CompanionPluginAccount]

    public init(
        query: String = "",
        yoursOnly: Bool = false,
        accounts: [CompanionPluginAccount]
    ) {
        self.query = query
        self.yoursOnly = yoursOnly
        self.accounts = accounts
    }

    /// Deterministic multi-account state used by the DEBUG plugin-sheet showcase.
    public static var linearMultiAccountDemo: Self {
        let timestamp = "2026-08-28T09:51:00.000Z"
        return Self(accounts: [
            CompanionPluginAccount(
                id: "11111111-1111-4111-8111-111111111111",
                provider: "linear",
                label: "work",
                transport: .http,
                endpoint: "https://mcp.linear.app/mcp",
                connected: true,
                createdAt: timestamp,
                updatedAt: timestamp
            ),
            CompanionPluginAccount(
                id: "22222222-2222-4222-8222-222222222222",
                provider: "linear",
                label: "client",
                transport: .http,
                endpoint: "https://mcp.linear.app/mcp",
                connected: true,
                createdAt: timestamp,
                updatedAt: timestamp
            ),
        ])
    }

    public var sections: [CompanionPluginSheetSection] {
        let accountsByProvider = Dictionary(grouping: accounts, by: \.provider)
        let knownProviders = Set(Self.catalog.map(\.provider))
        let customItems = accountsByProvider.keys
            .filter { !knownProviders.contains($0) }
            .sorted()
            .map { provider in
                CompanionPluginCatalogItem(
                    id: "custom:\(provider)",
                    provider: provider,
                    title: provider.split(separator: "-").map { $0.capitalized }.joined(separator: " "),
                    detail: "Custom MCP connection",
                    category: "Custom MCP",
                    featured: false
                )
            }
        let catalog = Self.catalog + customItems
        let rows = catalog.compactMap { item -> CompanionPluginSheetRow? in
            let row = CompanionPluginSheetRow(item: item, accounts: accountsByProvider[item.provider] ?? [])
            guard !yoursOnly || !row.accounts.isEmpty else { return nil }
            guard matches(row) else { return nil }
            return row
        }
        var result: [CompanionPluginSheetSection] = []
        let featured = rows.filter(\.item.featured)
        if !featured.isEmpty {
            result.append(CompanionPluginSheetSection(title: "Featured", rows: featured))
        }
        let categoryNames = catalog.map(\.category).reduce(into: [String]()) { values, category in
            if !values.contains(category) { values.append(category) }
        }
        for category in categoryNames {
            let categoryRows = rows.filter { !$0.item.featured && $0.item.category == category }
            if !categoryRows.isEmpty {
                result.append(CompanionPluginSheetSection(title: category, rows: categoryRows))
            }
        }
        return result
    }

    private func matches(_ row: CompanionPluginSheetRow) -> Bool {
        let value = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return true }
        return row.item.title.localizedCaseInsensitiveContains(value)
            || row.item.detail.localizedCaseInsensitiveContains(value)
            || row.item.category.localizedCaseInsensitiveContains(value)
            || row.accounts.contains { $0.label.localizedCaseInsensitiveContains(value) }
    }
}

public struct CompanionBotDetailSheetModel: Equatable, Sendable {
    public let companion: CompanionSummary
    public var name: String
    public var icon: CompanionSummary.Icon
    public var routines: [CompanionRoutine]

    public init(companion: CompanionSummary, routines: [CompanionRoutine] = []) {
        self.companion = companion
        self.name = companion.name
        self.icon = companion.icon ?? .init(shape: 1, mouth: 0, accessory: 0, color: 2)
        self.routines = routines
    }

    public var normalizedName: String {
        name.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public var hasIdentityChanges: Bool {
        normalizedName != companion.name
            || icon != (companion.icon ?? .init(shape: 1, mouth: 0, accessory: 0, color: 2))
    }

    public var canSaveIdentity: Bool {
        companion.access.canEditCompanionSettings
            && !normalizedName.isEmpty
            && normalizedName.count <= 120
            && hasIdentityChanges
    }

    public func promptPreview(for routine: CompanionRoutine, limit: Int = 140) -> String {
        let normalized = (routine.prompt ?? "")
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
        guard normalized.count > limit else { return normalized }
        return String(normalized.prefix(max(0, limit - 1))) + "…"
    }
}

@MainActor
@Observable
public final class CompanionRoutineRunListStore {
    public typealias FetchPage = @MainActor (_ cursor: String?) async throws -> CompanionRoutineRunList

    public private(set) var runs: [CompanionRoutineRunSummary] = []
    public private(set) var nextCursor: String?
    public private(set) var loading = false
    public private(set) var loaded = false
    public private(set) var errorMessage: String?

    private let fetchPage: FetchPage
    private var generation = 0

    public init(fetchPage: @escaping FetchPage) {
        self.fetchPage = fetchPage
    }

    public var canLoadMore: Bool { loaded && nextCursor != nil && !loading }

    public func reload() async {
        generation += 1
        let requestGeneration = generation
        loading = true
        errorMessage = nil
        do {
            let page = try await fetchPage(nil)
            guard requestGeneration == generation else { return }
            runs = Self.deduplicated(page.runs)
            nextCursor = page.nextCursor
            loaded = true
        } catch {
            guard requestGeneration == generation else { return }
            errorMessage = error.localizedDescription
        }
        if requestGeneration == generation { loading = false }
    }

    public func loadMore() async {
        guard let cursor = nextCursor, !loading else { return }
        let requestGeneration = generation
        loading = true
        errorMessage = nil
        do {
            let page = try await fetchPage(cursor)
            guard requestGeneration == generation else { return }
            runs = Self.deduplicated(runs + page.runs)
            nextCursor = page.nextCursor
        } catch {
            guard requestGeneration == generation else { return }
            errorMessage = error.localizedDescription
        }
        if requestGeneration == generation { loading = false }
    }

    private static func deduplicated(_ values: [CompanionRoutineRunSummary]) -> [CompanionRoutineRunSummary] {
        var seen = Set<String>()
        return values.filter { seen.insert($0.runID).inserted }
    }
}

@MainActor
@Observable
public final class CompanionRoutineRunDetailStore {
    public typealias FetchPage = @MainActor (_ cursor: Int?) async throws -> CompanionRoutineRunDetail

    public private(set) var detail: CompanionRoutineRunDetail?
    public private(set) var entries: [CompanionRoutineRunEntry] = []
    public private(set) var nextCursor: Int?
    public private(set) var loading = false
    public private(set) var loaded = false
    public private(set) var errorMessage: String?

    private let fetchPage: FetchPage
    private var generation = 0

    public init(fetchPage: @escaping FetchPage) {
        self.fetchPage = fetchPage
    }

    public var canLoadMore: Bool { loaded && nextCursor != nil && !loading }

    public func reload() async {
        generation += 1
        await load(cursor: nil, replacing: true, requestGeneration: generation)
    }

    /// Refreshes recovery metadata and the newest transcript page without discarding pages that
    /// are already visible. This keeps reading position and loaded private history stable while a
    /// pending/running cleanup is polled.
    public func refreshPreservingLoadedPages() async {
        guard loaded, !loading else { return }
        generation += 1
        let requestGeneration = generation
        loading = true
        do {
            let page = try await fetchPage(nil)
            guard requestGeneration == generation else { return }
            detail = page
            entries = Self.deduplicated(entries + page.internalEntries)
            errorMessage = nil
        } catch {
            guard requestGeneration == generation else { return }
            // Preserve the loaded transcript and retry on the next synchronization cycle.
        }
        if requestGeneration == generation { loading = false }
    }

    public func loadMore() async {
        guard let nextCursor, !loading else { return }
        await load(cursor: nextCursor, replacing: false, requestGeneration: generation)
    }

    private func load(cursor: Int?, replacing: Bool, requestGeneration: Int) async {
        loading = true
        errorMessage = nil
        do {
            let page = try await fetchPage(cursor)
            guard requestGeneration == generation else { return }
            detail = page
            entries = Self.deduplicated(replacing ? page.internalEntries : entries + page.internalEntries)
            nextCursor = page.nextEntryCursor
            loaded = true
        } catch {
            guard requestGeneration == generation else { return }
            errorMessage = error.localizedDescription
        }
        if requestGeneration == generation { loading = false }
    }

    private static func deduplicated(_ values: [CompanionRoutineRunEntry]) -> [CompanionRoutineRunEntry] {
        var seen = Set<String>()
        return values.filter { seen.insert($0.eventID).inserted }.sorted { $0.ordinal < $1.ordinal }
    }
}
