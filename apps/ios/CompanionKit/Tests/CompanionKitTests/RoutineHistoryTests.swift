import Foundation
import Testing
@testable import CompanionKit

private final class RoutineHistoryMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            let handler = try #require(Self.handler)
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

private struct RoutineRunDetailFixtureEnvelope: Encodable {
    let run: CompanionRoutineRunDetail
}

private let routineRunSummaryFixture = CompanionRoutineRunSummary(
    runID: "33333333-3333-4333-8333-333333333333",
    companionID: "11111111-1111-4111-8111-111111111111",
    routine: CompanionRoutineIdentitySnapshot(
        id: "22222222-2222-4222-8222-222222222222",
        name: "Morning brief"
    ),
    status: .interrupted,
    outcome: .error,
    surfaceMode: nil,
    mainEntryEventID: nil,
    relayTurnID: nil,
    createdAt: "2026-08-27T09:00:00.000Z",
    startedAt: "2026-08-27T09:00:01.000Z",
    settledAt: "2026-08-27T09:00:05.000Z",
    error: CompanionRuntimeSafeError(
        code: "turn_stalled",
        message: "The routine stopped making progress.",
        action: "retry"
    ),
    recoveryStatus: .completed
)

private let routineRunDetailFixture = CompanionRoutineRunDetail(
    runID: routineRunSummaryFixture.runID,
    companionID: routineRunSummaryFixture.companionID,
    routine: routineRunSummaryFixture.routine,
    status: routineRunSummaryFixture.status,
    outcome: routineRunSummaryFixture.outcome,
    surfaceMode: routineRunSummaryFixture.surfaceMode,
    mainEntryEventID: routineRunSummaryFixture.mainEntryEventID,
    relayTurnID: routineRunSummaryFixture.relayTurnID,
    createdAt: routineRunSummaryFixture.createdAt,
    startedAt: routineRunSummaryFixture.startedAt,
    settledAt: routineRunSummaryFixture.settledAt,
    error: routineRunSummaryFixture.error,
    internalEntries: [CompanionRoutineRunEntry(
        eventID: "routine:assistant:1",
        ordinal: 0,
        role: "assistant",
        content: "Checked the deployment.",
        reasoning: "Compared release notes.",
        createdAt: "2026-08-27T09:00:02.000Z"
    )],
    nextEntryCursor: 0,
    recoveryStatus: .completed
)

@Test
func requestsAndDecodesRoutineHistoryUsingTheSharedContract() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RoutineHistoryMockURLProtocol.self]
    RoutineHistoryMockURLProtocol.handler = { request in
        let url = try #require(request.url)
        let components = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false))
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=session")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-1")

        if components.percentEncodedPath == "/v1/companions/companion%20id/routines/routine%20id/runs" {
            let query = try #require(components.queryItems)
            #expect(query == [
                URLQueryItem(name: "limit", value: "20"),
                URLQueryItem(name: "cursor", value: "cursor id"),
            ])
            let response = try #require(HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            let payload = CompanionRoutineRunList(
                runs: [routineRunSummaryFixture],
                nextCursor: nil
            )
            return (response, try JSONEncoder().encode(payload))
        }

        if components.percentEncodedPath == "/v1/companions/companion%20id/routine-runs/run%20id" {
            let query = try #require(components.queryItems)
            #expect(query == [
                URLQueryItem(name: "entry_limit", value: "50"),
                URLQueryItem(name: "entry_cursor", value: "0"),
            ])
            let response = try #require(HTTPURLResponse(
                url: url,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            let payload = RoutineRunDetailFixtureEnvelope(run: routineRunDetailFixture)
            return (response, try JSONEncoder().encode(payload))
        }

        Issue.record("Unexpected routine history route: \(url.absoluteString)")
        let response = try #require(HTTPURLResponse(
            url: url,
            statusCode: 404,
            httpVersion: nil,
            headerFields: nil
        ))
        return (response, Data())
    }
    defer { RoutineHistoryMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "member@example.com", name: "Member")
    ))

    let list = try await client.listCompanionRoutineRuns(
        companionID: "companion id",
        routineID: "routine id",
        limit: 20,
        cursor: "cursor id"
    )
    #expect(list.runs.count == 1)
    #expect(list.runs[0].outcome == .error)
    #expect(list.runs[0].surfaceMode == nil)
    #expect(list.runs[0].recoveryStatus == .completed)

    let detail = try await client.readCompanionRoutineRun(
        companionID: "companion id",
        runID: "run id",
        entryLimit: 50,
        entryCursor: 0
    )
    #expect(detail.internalEntries.first?.ordinal == 0)
    #expect(detail.internalEntries.first?.reasoning == "Compared release notes.")
    #expect(detail.recoveryStatus == .completed)
}

@Test
func routineRecoveryStatusToleratesAbsentAndFutureValues() throws {
    let absent = try JSONDecoder().decode(
        CompanionRoutineRunSummary.self,
        from: Data(#"{"run_id":"run-1","companion_id":"companion-1","routine":{"id":null,"name":"Brief"},"status":"interrupted","outcome":"error","surface_mode":null,"main_entry_event_id":null,"relay_turn_id":null,"created_at":"2026-08-27T09:00:00.000Z","started_at":null,"settled_at":"2026-08-27T09:10:00.000Z","error":null}"#.utf8)
    )
    let future = try JSONDecoder().decode(
        CompanionRoutineRunSummary.self,
        from: Data(#"{"run_id":"run-2","companion_id":"companion-1","routine":{"id":null,"name":"Brief"},"status":"interrupted","outcome":"error","surface_mode":null,"main_entry_event_id":null,"relay_turn_id":null,"created_at":"2026-08-27T09:00:00.000Z","started_at":null,"settled_at":"2026-08-27T09:10:00.000Z","error":null,"recovery_status":"verifying"}"#.utf8)
    )

    #expect(absent.recoveryStatus == nil)
    #expect(future.recoveryStatus == .unknown)
}

@Test
func decodesRoutineOriginWithAndWithoutDurableRunID() throws {
    let withRun = try JSONDecoder().decode(
        TranscriptEntry.self,
        from: Data(#"{"event_id":"msg:1","ordinal":0,"role":"user","content":"private prompt","author_id":null,"author_name":null,"routine":{"id":"22222222-2222-4222-8222-222222222222","name":"Morning brief","run_id":"33333333-3333-4333-8333-333333333333"},"turn_id":"33333333-3333-4333-8333-333333333333","queued":false,"attachments":[],"created_at":"2026-08-27T09:00:00.000Z"}"#.utf8)
    )
    #expect(withRun.routine?.id == "22222222-2222-4222-8222-222222222222")
    #expect(withRun.routine?.runID == "33333333-3333-4333-8333-333333333333")

    let oldMarker = try JSONDecoder().decode(
        TranscriptEntry.self,
        from: Data(#"{"event_id":"msg:2","ordinal":1,"role":"user","content":"old prompt","author_id":null,"author_name":null,"routine":{"id":null,"name":"Deleted routine"},"turn_id":null,"queued":false,"attachments":[],"created_at":"2026-08-27T09:01:00.000Z"}"#.utf8)
    )
    #expect(oldMarker.routine?.id == nil)
    #expect(oldMarker.routine?.runID == nil)
}
