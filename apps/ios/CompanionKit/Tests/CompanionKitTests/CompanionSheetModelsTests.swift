import Foundation
import Testing
@testable import CompanionKit

@Test
func appearancePreferencesKeepSystemAdaptiveAndBlackExplicit() {
    #expect(CompanionAppearancePreference.system.label == "System")
    #expect(!CompanionAppearancePreference.system.forcesBlackPalette)
    #expect(CompanionAppearancePreference.black.label == "Black")
    #expect(CompanionAppearancePreference.black.forcesBlackPalette)
}

@Test
func approvedAppearancePaletteMatchesTheDesignContract() {
    #expect(CompanionAppearancePalette.Light.canvas == 0xFFFFFF)
    #expect(CompanionAppearancePalette.Light.card == 0xF2F2F7)
    #expect(CompanionAppearancePalette.Light.botBubble == 0xEFEFF1)
    #expect(CompanionAppearancePalette.Light.innerBubble == 0xFFFFFF)
    #expect(CompanionAppearancePalette.Light.chip == 0xEFEFF1)
    #expect(CompanionAppearancePalette.Light.userBubble == 0x0B0B0F)
    #expect(CompanionAppearancePalette.Light.userBubbleText == 0xFFFFFF)
    #expect(CompanionAppearancePalette.Light.textPrimary == 0x111111)
    #expect(CompanionAppearancePalette.Light.separator == 0xE5E5EA)
    #expect(CompanionAppearancePalette.Light.primaryCTA == 0x0B0B0F)
    #expect(CompanionAppearancePalette.Light.primaryCTAText == 0xFFFFFF)
    #expect(CompanionAppearancePalette.Black.canvas == 0x000000)
    #expect(CompanionAppearancePalette.Black.card == 0x1C1C1E)
    #expect(CompanionAppearancePalette.Black.botBubble == 0x1C1C1E)
    #expect(CompanionAppearancePalette.Black.innerBubble == 0x1C1C1E)
    #expect(CompanionAppearancePalette.Black.chip == 0x1C1C1E)
    #expect(CompanionAppearancePalette.Black.userBubble == 0xFFFFFF)
    #expect(CompanionAppearancePalette.Black.userBubbleText == 0x000000)
    #expect(CompanionAppearancePalette.Black.textPrimary == 0xF2F2F7)
    #expect(CompanionAppearancePalette.Black.separator == 0x38383A)
    #expect(CompanionAppearancePalette.Black.primaryCTA == 0xFFFFFF)
    #expect(CompanionAppearancePalette.Black.primaryCTAText == 0x000000)
    #expect(CompanionAppearancePalette.textSecondary == 0x8E8E93)
    #expect(CompanionAppearancePalette.actionBlue == 0x007AFF)
    #expect(CompanionAppearancePalette.actionBlueBlack == 0x0A84FF)
    #expect(CompanionAppearancePalette.dangerTextLight == 0xC21429)
    #expect(CompanionAppearancePalette.successTextLight == 0x10733B)
    #expect(CompanionAppearancePalette.warningTextLight == 0x955000)
    #expect(CompanionAppearancePalette.characterMarks.count == 11)
}

private let sheetTestCompanionID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
private let sheetTestRoutineID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
private let sheetTestTimestamp = "2026-08-27T18:00:00.000Z"

private struct RoutineRunDetailFixtureEnvelope: Decodable {
    let run: CompanionRoutineRunDetail
}

private final class RoutineRunsURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        do {
            let result = try Self.handler?(request)
            guard let result else { throw URLError(.badServerResponse) }
            client?.urlProtocol(self, didReceive: result.0, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: result.1)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

@Test
func settingsSheetModelKeepsAutomaticAndManualTimezonesExplicit() {
    var model = MemberSettingsSheetModel(
        name: "  Ada  ",
        savedTimezone: nil,
        deviceTimezone: "America/New_York",
        usesAutomaticTimezone: true
    )

    #expect(model.name == "Ada")
    #expect(model.timezone == "America/New_York")
    #expect(model.canSaveProfile)

    model.updateTimezone("Europe/Paris")
    #expect(!model.usesAutomaticTimezone)
    #expect(model.timezoneForSave == "Europe/Paris")

    model.setAutomaticTimezone(true, deviceTimezone: "Asia/Tokyo")
    #expect(model.usesAutomaticTimezone)
    #expect(model.timezoneForSave == "Asia/Tokyo")

    model.updateName(String(repeating: "n", count: 140))
    #expect(model.name.count == 120)
}

@Test
func pluginSheetProjectsTrailingStateSearchAndMultipleAccountChips() throws {
    let accounts = [
        CompanionPluginAccount(
            id: "11111111-1111-4111-8111-111111111111",
            provider: "github",
            label: "quivr",
            transport: .http,
            endpoint: "https://api.githubcopilot.com/mcp/",
            connected: true,
            createdAt: sheetTestTimestamp,
            updatedAt: sheetTestTimestamp
        ),
        CompanionPluginAccount(
            id: "22222222-2222-4222-8222-222222222222",
            provider: "github",
            label: "default",
            transport: .http,
            endpoint: "https://api.githubcopilot.com/mcp/",
            connected: true,
            createdAt: sheetTestTimestamp,
            updatedAt: sheetTestTimestamp
        ),
        CompanionPluginAccount(
            id: "33333333-3333-4333-8333-333333333333",
            provider: "notion",
            label: "perso",
            transport: .http,
            endpoint: "https://mcp.notion.com/mcp",
            connected: false,
            createdAt: sheetTestTimestamp,
            updatedAt: sheetTestTimestamp
        ),
    ]

    var model = CompanionPluginSheetModel(accounts: accounts)
    let rows = model.sections.flatMap(\.rows)
    let github = try #require(rows.first(where: { $0.item.provider == "github" }))
    let notion = try #require(rows.first(where: { $0.item.provider == "notion" }))
    let slack = try #require(rows.first(where: { $0.item.provider == "slack" }))
    let sentry = try #require(rows.first(where: { $0.item.provider == "sentry" }))
    #expect(github.connectionState == .added)
    #expect(github.connectedAccountLabels == ["default", "quivr"])
    #expect(notion.connectionState == .authorize)
    #expect(slack.connectionState == .add)
    #expect(sentry.connectionState == .add)

    model.yoursOnly = true
    #expect(Set(model.sections.flatMap(\.rows).map(\.item.provider)) == ["github", "notion"])

    model.query = "quivr"
    #expect(model.sections.flatMap(\.rows).map(\.item.provider) == ["github"])
}

@Test
func pluginSheetMultiAccountDemoKeepsTwoConnectedLinearAccounts() throws {
    let linear = try #require(
        CompanionPluginSheetModel.linearMultiAccountDemo.sections
            .flatMap(\.rows)
            .first(where: { $0.item.provider == "linear" })
    )

    #expect(linear.connectionState == .added)
    #expect(linear.connectedAccountLabels == ["client", "work"])
}

@Test
func botDetailSheetValidatesInlineIdentityAndBoundsRoutinePreview() throws {
    let companionData = Data("""
    {
      "id":"\(sheetTestCompanionID)",
      "name":"Main CI watcher",
      "persona":"Watch the release lane.",
      "model_id":"anthropic/claude-sonnet-4",
      "icon":{"shape":2,"mouth":4,"accessory":6,"color":7},
      "access":"owner",
      "runtime":{"state":"running","daemon_state":"running","replying":false,"provider_ids":["anthropic"]}
    }
    """.utf8)
    let companion = try JSONDecoder().decode(CompanionSummary.self, from: companionData)
    let routine = CompanionRoutine(
        id: sheetTestRoutineID,
        name: "Release watch",
        cron: "0 9 * * 1-5",
        timezone: "America/New_York",
        enabled: true,
        nextFireAt: nil,
        lastErrorMessage: nil,
        prompt: String(repeating: "Watch   the release lane carefully. ", count: 8)
    )

    var model = CompanionBotDetailSheetModel(companion: companion, routines: [routine])
    #expect(!model.canSaveIdentity)
    model.name = "  Main release watcher  "
    #expect(model.canSaveIdentity)
    #expect(model.normalizedName == "Main release watcher")
    #expect(model.promptPreview(for: routine).count == 140)
    #expect(model.promptPreview(for: routine).hasSuffix("…"))
}

@Test
func routineRunModelsDecodeThe459ListAndPrivateDetailContract() throws {
    let data = Data("""
    {
      "run": {
        "run_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        "companion_id":"\(sheetTestCompanionID)",
        "routine":{"id":"\(sheetTestRoutineID)","name":"Release watch"},
        "status":"succeeded",
        "outcome":"surfaced",
        "surface_mode":"notify",
        "main_entry_event_id":"routine-return:notice",
        "relay_turn_id":null,
        "created_at":"\(sheetTestTimestamp)",
        "started_at":"\(sheetTestTimestamp)",
        "settled_at":"\(sheetTestTimestamp)",
        "error":null,
        "internal_entries":[{
          "event_id":"routine:work:1",
          "ordinal":0,
          "role":"assistant",
          "content":"Checked the deployment.",
          "reasoning":null,
          "tool":null,
          "decision":null,
          "created_at":"\(sheetTestTimestamp)"
        }],
        "next_entry_cursor":0
      }
    }
    """.utf8)

    let envelope = try JSONDecoder().decode(RoutineRunDetailFixtureEnvelope.self, from: data)
    #expect(envelope.run.outcome == .surfaced)
    #expect(envelope.run.surfaceMode == .notify)
    #expect(envelope.run.internalEntries.map(\.content) == ["Checked the deployment."])
    #expect(envelope.run.nextEntryCursor == 0)
}

@Test
func pluginOAuthCallbackPolicyBindsOriginPortPathAndSingleState() throws {
    let expected = try #require(URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback"))
    let accepted = try #require(URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback?code=one&state=signed"))
    #expect(CompanionOAuthCallbackPolicy.isPluginCallback(accepted, expectedCallbackURL: expected))
    #expect(CompanionOAuthCallbackPolicy.queryValue(named: "state", from: accepted) == "signed")

    let wrongOrigin = try #require(URL(string: "https://evil.example/v1/companion-plugins/oauth/callback?state=signed"))
    let wrongPath = try #require(URL(string: "https://thecompanion.sh/companions?state=signed"))
    let duplicateState = try #require(URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback?state=one&state=two"))
    #expect(!CompanionOAuthCallbackPolicy.isPluginCallback(wrongOrigin, expectedCallbackURL: expected))
    #expect(!CompanionOAuthCallbackPolicy.isPluginCallback(wrongPath, expectedCallbackURL: expected))
    #expect(CompanionOAuthCallbackPolicy.queryValue(named: "state", from: duplicateState) == nil)
}

@Test
func routineRunClientUses459ListAndEntryPaginationRoutes() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RoutineRunsURLProtocol.self]
    var requestedURLs: [URL] = []
    RoutineRunsURLProtocol.handler = { request in
        let url = try #require(request.url)
        requestedURLs.append(url)
        let body: Data
        if url.path.hasSuffix("/runs") {
            body = Data("{\"runs\":[],\"next_cursor\":null}".utf8)
        } else {
            body = Data("""
            {"run":{
              "run_id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              "companion_id":"\(sheetTestCompanionID)",
              "routine":{"id":"\(sheetTestRoutineID)","name":"Release watch"},
              "status":"succeeded","outcome":"no_output","surface_mode":null,
              "main_entry_event_id":null,"relay_turn_id":null,
              "created_at":"\(sheetTestTimestamp)","started_at":null,"settled_at":"\(sheetTestTimestamp)",
              "error":null,"internal_entries":[],"next_entry_cursor":null
            }}
            """.utf8)
        }
        let response = try #require(HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Cache-Control": "private, no-store"]
        ))
        return (response, body)
    }
    defer { RoutineRunsURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "ada@example.com", name: "Ada")
    ))

    _ = try await client.listCompanionRoutineRuns(
        companionID: sheetTestCompanionID,
        routineID: sheetTestRoutineID,
        limit: 25,
        cursor: "page two"
    )
    _ = try await client.readCompanionRoutineRun(
        companionID: sheetTestCompanionID,
        runID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        entryLimit: 40,
        entryCursor: 7
    )

    let listComponents = try #require(URLComponents(url: requestedURLs[0], resolvingAgainstBaseURL: false))
    #expect(listComponents.path == "/v1/companions/\(sheetTestCompanionID)/routines/\(sheetTestRoutineID)/runs")
    #expect(listComponents.queryItems == [
        URLQueryItem(name: "limit", value: "25"),
        URLQueryItem(name: "cursor", value: "page two"),
    ])
    let detailComponents = try #require(URLComponents(url: requestedURLs[1], resolvingAgainstBaseURL: false))
    #expect(detailComponents.path == "/v1/companions/\(sheetTestCompanionID)/routine-runs/cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    #expect(detailComponents.queryItems == [
        URLQueryItem(name: "entry_limit", value: "40"),
        URLQueryItem(name: "entry_cursor", value: "7"),
    ])
}

@Test @MainActor
func routineRunListStorePaginatesAndDeduplicatesByDurableRunID() async {
    let first = routineRunSummary(id: "11111111-1111-4111-8111-111111111111")
    let second = routineRunSummary(id: "22222222-2222-4222-8222-222222222222")
    var cursors: [String?] = []
    let store = CompanionRoutineRunListStore { cursor in
        cursors.append(cursor)
        if cursor == nil {
            return CompanionRoutineRunList(runs: [first], nextCursor: first.runID)
        }
        return CompanionRoutineRunList(runs: [first, second], nextCursor: nil)
    }

    await store.reload()
    #expect(store.runs.map(\.runID) == [first.runID])
    #expect(store.canLoadMore)
    await store.loadMore()
    #expect(store.runs.map(\.runID) == [first.runID, second.runID])
    #expect(cursors.count == 2)
    #expect(cursors[1] == first.runID)
    #expect(!store.canLoadMore)
}

@Test @MainActor
func routineRunDetailStorePaginatesEntriesWithoutRepeatingTheBoundaryRow() async {
    let first = routineRunEntry(id: "routine:1", ordinal: 0)
    let second = routineRunEntry(id: "routine:2", ordinal: 1)
    let store = CompanionRoutineRunDetailStore { cursor in
        routineRunDetail(
            entries: cursor == nil ? [first] : [first, second],
            nextCursor: cursor == nil ? 0 : nil
        )
    }

    await store.reload()
    #expect(store.entries.map(\.eventID) == [first.eventID])
    await store.loadMore()
    #expect(store.entries.map(\.eventID) == [first.eventID, second.eventID])
    #expect(store.detail?.outcome == .surfaced)
    #expect(!store.canLoadMore)
}

@Test @MainActor
func routineRunDetailRecoveryRefreshPreservesLoadedTranscriptPages() async {
    let first = routineRunEntry(id: "routine:1", ordinal: 0)
    let second = routineRunEntry(id: "routine:2", ordinal: 1)
    var nilCursorRequests = 0
    let store = CompanionRoutineRunDetailStore { cursor in
        if cursor == nil {
            nilCursorRequests += 1
            return routineRunDetail(
                entries: [first],
                nextCursor: 0,
                recoveryStatus: nilCursorRequests == 1 ? .running : .completed
            )
        }
        return routineRunDetail(entries: [second], nextCursor: nil, recoveryStatus: .running)
    }

    await store.reload()
    await store.loadMore()
    await store.refreshPreservingLoadedPages()

    #expect(store.entries.map(\.eventID) == [first.eventID, second.eventID])
    #expect(store.detail?.recoveryStatus == .completed)
    #expect(!store.canLoadMore)
}

private func routineRunSummary(id: String) -> CompanionRoutineRunSummary {
    CompanionRoutineRunSummary(
        runID: id,
        companionID: sheetTestCompanionID,
        routine: CompanionRoutineIdentitySnapshot(id: sheetTestRoutineID, name: "Release watch"),
        status: .succeeded,
        outcome: .surfaced,
        surfaceMode: .notify,
        mainEntryEventID: "routine-return:\(id)",
        relayTurnID: nil,
        createdAt: sheetTestTimestamp,
        startedAt: sheetTestTimestamp,
        settledAt: sheetTestTimestamp,
        error: nil,
        recoveryStatus: nil
    )
}

private func routineRunEntry(id: String, ordinal: Int) -> CompanionRoutineRunEntry {
    CompanionRoutineRunEntry(
        eventID: id,
        ordinal: ordinal,
        role: "assistant",
        content: "Entry \(ordinal)",
        createdAt: sheetTestTimestamp
    )
}

private func routineRunDetail(
    entries: [CompanionRoutineRunEntry],
    nextCursor: Int?,
    recoveryStatus: CompanionRecoveryStatus? = nil
) -> CompanionRoutineRunDetail {
    let recovering = recoveryStatus != nil
    return CompanionRoutineRunDetail(
        runID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        companionID: sheetTestCompanionID,
        routine: CompanionRoutineIdentitySnapshot(id: sheetTestRoutineID, name: "Release watch"),
        status: recovering ? .interrupted : .succeeded,
        outcome: recovering ? .error : .surfaced,
        surfaceMode: recovering ? nil : .notify,
        mainEntryEventID: recovering ? nil : "routine-return:notice",
        relayTurnID: nil,
        createdAt: sheetTestTimestamp,
        startedAt: sheetTestTimestamp,
        settledAt: sheetTestTimestamp,
        error: recovering
            ? CompanionRuntimeSafeError(
                code: "turn_stalled",
                message: "The routine stopped making progress.",
                action: "retry"
            )
            : nil,
        internalEntries: entries,
        nextEntryCursor: nextCursor,
        recoveryStatus: recoveryStatus
    )
}
