import Foundation
import Testing
@testable import CompanionKit

private struct FixedSessionStorage: SessionStorage {
    let data: Data?
    func load() throws -> Data? { data }
    func save(_ data: Data) throws {}
    func remove() throws {}
}

private struct WriteFailingSnapshotCache: CompanionSnapshotCache {
    func roster(scope: String) throws -> CompanionRosterSnapshot? { nil }

    func saveRoster(_ snapshot: CompanionRosterSnapshot, scope: String) throws {
        throw SQLiteCompanionSnapshotCache.CacheError.tooLarge
    }

    func thread(scope: String, companionID: String) throws -> CompanionThreadSnapshot? { nil }

    func saveThread(
        _ snapshot: CompanionThreadSnapshot,
        scope: String,
        companionID: String
    ) throws {
        throw SQLiteCompanionSnapshotCache.CacheError.tooLarge
    }

    func remove(scope: String) throws {}
}

private final class SuspendedThreadSyncURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var releaseResponse = DispatchSemaphore(value: 0)
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requestDidStart = false
    private nonisolated(unsafe) static var requestedURL: URL?

    static func reset() {
        lock.lock()
        requestDidStart = false
        requestedURL = nil
        lock.unlock()
        releaseResponse = DispatchSemaphore(value: 0)
    }

    static var hasStarted: Bool {
        lock.lock()
        defer { lock.unlock() }
        return requestDidStart
    }

    static var capturedURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return requestedURL
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requestedURL = request.url
        Self.requestDidStart = true
        Self.lock.unlock()
        _ = Self.releaseResponse.wait(timeout: .now() + 5)
        let payload = #"""
        {
          "cursor":"next-cursor",
          "reset_entries":false,
          "changed_entries":[],
          "deleted_event_ids":[],
          "thread":{
            "companion_id":"22222222-2222-4222-8222-222222222222",
            "viewer_id":"user-1",
            "read_only":false,
            "can_send":true,
            "transcription_available":true,
            "active_turn":null,
            "queued_count":0,
            "interrupted_turn":null
          }
        }
        """#
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class BackgroundRefreshURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requestCount = 0

    static func reset() {
        lock.lock()
        requestCount = 0
        lock.unlock()
    }

    static var requestsStarted: Int {
        lock.lock()
        defer { lock.unlock() }
        return requestCount
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requestCount += 1
        Self.lock.unlock()
        let path = request.url?.path ?? ""
        let payload: String
        if path == "/v1/companions/sync" {
            payload = #"""
            {
              "cursor":"fresh-roster","changed_companions":[
                {
                  "id":"33333333-3333-4333-8333-333333333333","name":"Background",
                  "persona":"Help","model_id":"model","selected_skill_ids":[],
                  "selected_mcp_account_ids":[],"icon":null,"section_id":null,"access":"owner",
                  "pinned":false,"hidden":false,"muted":false,"unread":false,"last_message":null,
                  "runtime":{"state":"running","daemon_state":"running","replying":false,
                    "last_error":null,"provider_ids":[],"lifecycle_intent":"prepare"}
                }
              ],"deleted_companion_ids":[],
              "companion_ids":["33333333-3333-4333-8333-333333333333"],
              "changed_sections":[],"deleted_section_ids":[],"section_ids":[]
            }
            """#
        } else {
            payload = #"""
            {
              "cursor":"fresh-thread","reset_entries":true,
              "changed_entries":[],"deleted_event_ids":[],
              "thread":{
                "companion_id":"33333333-3333-4333-8333-333333333333","viewer_id":"user-1",
                "read_only":false,"can_send":true,"transcription_available":true,
                "active_turn":null,"queued_count":0,"interrupted_turn":null
              }
            }
            """#
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class OversizedThreadCursorURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requestedURL: URL?

    static func reset() {
        lock.lock()
        requestedURL = nil
        lock.unlock()
    }

    static var capturedURL: URL? {
        lock.lock()
        defer { lock.unlock() }
        return requestedURL
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.requestedURL = request.url
        Self.lock.unlock()
        let payload = #"{"cursor":"transport-safe","reset_entries":true,"changed_entries":[{"event_id":"event:900","ordinal":900,"role":"assistant","content":"Recovered","reasoning":null,"author_id":null,"author_name":null,"decision":null,"tool":null,"routine":null,"turn_id":null,"queued":false,"attachments":[],"created_at":"2026-08-29T00:00:00Z"}],"deleted_event_ids":[],"thread":{"companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-1","read_only":false,"can_send":true,"transcription_available":true,"active_turn":null,"queued_count":0,"interrupted_turn":null}}"#
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class RejectedThreadCursorURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requestedCursors: [String?] = []
    private nonisolated(unsafe) static var rejectedStatusCode = 431

    static func reset(statusCode: Int = 431) {
        lock.lock()
        requestedCursors = []
        rejectedStatusCode = statusCode
        lock.unlock()
    }

    static var capturedCursors: [String?] {
        lock.lock()
        defer { lock.unlock() }
        return requestedCursors
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        if request.url?.path.hasSuffix("/thread-window") == true {
            let payload = #"{"thread":{"companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-1","read_only":false,"can_send":true,"transcription_available":true,"active_turn":null,"queued_count":0,"interrupted_turn":null},"entries":[],"older_cursor":null,"sync_cursor":"transport-safe","notify_returns":[]}"#
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(payload.utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let cursor = URLComponents(
            url: request.url!,
            resolvingAgainstBaseURL: false
        )?.queryItems?.first(where: { $0.name == "cursor" })?.value
        Self.lock.lock()
        Self.requestedCursors.append(cursor)
        let rejectedStatusCode = Self.rejectedStatusCode
        Self.lock.unlock()
        let statusCode = cursor == nil ? 200 : rejectedStatusCode
        let payload = cursor == nil
            ? #"{"cursor":"transport-safe","reset_entries":true,"changed_entries":[],"deleted_event_ids":[],"thread":{"companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-1","read_only":false,"can_send":true,"transcription_available":true,"active_turn":null,"queued_count":0,"interrupted_turn":null}}"#
            : ""
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: cursor == nil ? ["Content-Type": "application/json"] : nil
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class PagedThreadSyncURLProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var requestedURLs: [URL] = []

    static func reset(host: String) {
        lock.lock()
        requestedURLs.removeAll { $0.host == host }
        lock.unlock()
    }

    static func capturedURLs(host: String) -> [URL] {
        lock.lock()
        defer { lock.unlock() }
        return requestedURLs.filter { $0.host == host }
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        Self.lock.lock()
        Self.requestedURLs.append(url)
        Self.lock.unlock()
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let cursor = query.first(where: { $0.name == "cursor" })?.value
        let before = query.first(where: { $0.name == "before" })?.value
        let payload: String
        if url.path.hasSuffix("/thread-window"), before == "older-one" {
            payload = Self.windowPayload(
                entries: Self.entry(ordinal: 0),
                olderCursor: nil,
                syncCursor: "sync-3"
            )
        } else if url.path.hasSuffix("/thread-window") {
            payload = Self.windowPayload(
                entries: "\(Self.entry(ordinal: 1)),\(Self.entry(ordinal: 2))",
                olderCursor: "older-one",
                syncCursor: "sync-1"
            )
        } else if url.path.hasSuffix("/thread-delta"), cursor == "sync-1" {
            payload = Self.deltaPayload(entry: Self.entry(ordinal: 3), cursor: "sync-2", hasMore: true)
        } else if url.path.hasSuffix("/thread-delta"), cursor == "sync-2" {
            payload = Self.deltaPayload(entry: Self.entry(ordinal: 4), cursor: "sync-3", hasMore: false)
        } else {
            finish(statusCode: 404, payload: #"{"code":"not_found","message":"Unexpected request"}"#)
            return
        }
        finish(statusCode: 200, payload: payload)
    }

    private static func entry(ordinal: Int) -> String {
        #"{"event_id":"event:\#(ordinal)","ordinal":\#(ordinal),"role":"assistant","content":"Message \#(ordinal)","reasoning":null,"author_id":null,"author_name":null,"decision":null,"tool":null,"routine":null,"turn_id":null,"queued":false,"attachments":[],"created_at":"2026-08-29T00:00:00Z"}"#
    }

    private static func metadata() -> String {
        #"{"companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-1","read_only":false,"can_send":true,"transcription_available":true,"active_turn":null,"queued_count":0,"interrupted_turn":null}"#
    }

    private static func windowPayload(
        entries: String,
        olderCursor: String?,
        syncCursor: String
    ) -> String {
        let older = olderCursor.map { "\"\($0)\"" } ?? "null"
        return #"{"thread":\#(metadata()),"entries":[\#(entries)],"older_cursor":\#(older),"sync_cursor":"\#(syncCursor)","notify_returns":[]}"#
    }

    private static func deltaPayload(entry: String, cursor: String, hasMore: Bool) -> String {
        #"{"cursor":"\#(cursor)","reset_entries":false,"changed_entries":[\#(entry)],"deleted_event_ids":[],"thread":\#(metadata()),"has_more":\#(hasMore),"notify_returns":[]}"#
    }

    private func finish(statusCode: Int, payload: String) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class SuspendedRosterSyncURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var releaseResponse = DispatchSemaphore(value: 0)
    private static let lock = NSLock()
    private nonisolated(unsafe) static var rosterRequestDidStart = false
    private nonisolated(unsafe) static var oldThreadRequestDidStart = false

    static func reset() {
        lock.lock()
        rosterRequestDidStart = false
        oldThreadRequestDidStart = false
        lock.unlock()
        releaseResponse = DispatchSemaphore(value: 0)
    }

    static var hasStartedRosterRequest: Bool {
        lock.lock()
        defer { lock.unlock() }
        return rosterRequestDidStart
    }

    static var hasStartedOldThreadRequest: Bool {
        lock.lock()
        defer { lock.unlock() }
        return oldThreadRequestDidStart
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let statusCode: Int
        let headers: [String: String]?
        let payload: String
        switch path {
        case "/v1/companions/sync":
            Self.lock.lock()
            Self.rosterRequestDidStart = true
            Self.lock.unlock()
            let releaseResponse = Self.releaseResponse
            DispatchQueue.global().async { [weak self] in
                _ = releaseResponse.wait(timeout: .now() + 5)
                self?.finish(
                    statusCode: 200,
                    headers: ["Content-Type": "application/json"],
                    payload: #"{"cursor":"old-fresh","changed_companions":[],"deleted_companion_ids":[],"companion_ids":[],"changed_sections":[],"deleted_section_ids":[],"section_ids":[]}"#
                )
            }
            return
        case let path where path.hasSuffix("/thread-delta"):
            let cursor = URLComponents(
                url: request.url!,
                resolvingAgainstBaseURL: false
            )?.queryItems?.first(where: { $0.name == "cursor" })?.value
            if cursor == "old-thread" {
                Self.lock.lock()
                Self.oldThreadRequestDidStart = true
                Self.lock.unlock()
                let releaseResponse = Self.releaseResponse
                DispatchQueue.global().async { [weak self] in
                    _ = releaseResponse.wait(timeout: .now() + 5)
                    self?.finish(
                        statusCode: 200,
                        headers: ["Content-Type": "application/json"],
                        payload: #"{"cursor":"old-thread-fresh","reset_entries":false,"changed_entries":[],"deleted_event_ids":[],"thread":{"companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-1","read_only":false,"can_send":true,"transcription_available":true,"active_turn":null,"queued_count":0,"interrupted_turn":null}}"#
                    )
                }
                return
            }
            statusCode = 200
            headers = ["Content-Type": "application/json"]
            payload = #"{"cursor":"new-thread-fresh","reset_entries":false,"changed_entries":[],"deleted_event_ids":[],"thread":{"companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-2","read_only":false,"can_send":true,"transcription_available":true,"active_turn":null,"queued_count":0,"interrupted_turn":null}}"#
        case "/v1/auth/logout":
            statusCode = 200
            headers = nil
            payload = "{}"
        case "/v1/auth/login":
            statusCode = 200
            headers = ["Set-Cookie": "better-auth.session_token=new-session; Path=/; HttpOnly"]
            payload = "{}"
        case "/v1/auth/whoami":
            statusCode = 200
            headers = ["Content-Type": "application/json"]
            payload = #"{"userId":"user-2","email":"new@example.com","name":"New","timezone":"UTC","org":{"org_id":"org-2","name":"New workspace"},"onboarded":true,"needsOnboarding":false}"#
        default:
            statusCode = 404
            headers = ["Content-Type": "application/json"]
            payload = #"{"code":"not_found","message":"Unexpected test request"}"#
        }
        finish(statusCode: statusCode, headers: headers, payload: payload)
    }

    private func finish(statusCode: Int, headers: [String: String]?, payload: String) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private final class StaleUnauthorizedThreadURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var releaseResponse = DispatchSemaphore(value: 0)
    nonisolated(unsafe) static var releaseWhoAmI = DispatchSemaphore(value: 0)
    private static let lock = NSLock()
    private nonisolated(unsafe) static var oldRequestDidStart = false
    private nonisolated(unsafe) static var whoAmIRequestDidStart = false

    static func reset() {
        lock.lock()
        oldRequestDidStart = false
        whoAmIRequestDidStart = false
        lock.unlock()
        releaseResponse = DispatchSemaphore(value: 0)
        releaseWhoAmI = DispatchSemaphore(value: 0)
    }

    static var hasStartedOldRequest: Bool {
        lock.lock()
        defer { lock.unlock() }
        return oldRequestDidStart
    }

    static var hasStartedWhoAmIRequest: Bool {
        lock.lock()
        defer { lock.unlock() }
        return whoAmIRequestDidStart
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let cursor = URLComponents(
            url: request.url!,
            resolvingAgainstBaseURL: false
        )?.queryItems?.first(where: { $0.name == "cursor" })?.value
        if path.hasSuffix("/thread-delta"), cursor == "old-thread-unauthorized" {
            Self.lock.lock()
            Self.oldRequestDidStart = true
            Self.lock.unlock()
            DispatchQueue.global().async { [weak self] in
                _ = Self.releaseResponse.wait(timeout: .now() + 5)
                self?.finish(
                    statusCode: 401,
                    headers: ["Content-Type": "application/json"],
                    payload: #"{"code":"unauthorized","message":"Old session expired"}"#
                )
            }
            return
        }
        if path == "/v1/auth/whoami" {
            Self.lock.lock()
            Self.whoAmIRequestDidStart = true
            Self.lock.unlock()
            DispatchQueue.global().async { [weak self] in
                Self.releaseWhoAmI.wait()
                self?.finish(
                    statusCode: 200,
                    headers: ["Content-Type": "application/json"],
                    payload: #"{"userId":"user-2","email":"new@example.com","name":"New","timezone":"UTC","org":{"org_id":"org-2","name":"New workspace"},"onboarded":true,"needsOnboarding":false}"#
                )
            }
            return
        }
        let statusCode: Int
        let headers: [String: String]?
        let payload: String
        if path.hasSuffix("/thread-delta") {
            statusCode = 200
            payload = #"{"cursor":"new-thread-fresh","reset_entries":false,"changed_entries":[],"deleted_event_ids":[],"thread":{"companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-2","read_only":false,"can_send":true,"transcription_available":true,"active_turn":null,"queued_count":0,"interrupted_turn":null}}"#
            headers = ["Content-Type": "application/json"]
        } else if path == "/v1/auth/login" {
            statusCode = 200
            headers = ["Set-Cookie": "better-auth.session_token=new-session; Path=/; HttpOnly"]
            payload = "{}"
        } else {
            statusCode = 404
            headers = ["Content-Type": "application/json"]
            payload = #"{"code":"not_found","message":"Unexpected test request"}"#
        }
        finish(statusCode: statusCode, headers: headers, payload: payload)
    }

    private func finish(statusCode: Int, headers: [String: String]?, payload: String) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: nil,
            headerFields: headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(payload.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@Test
func sqliteCachePersistsRestoresScopesAndBoundedThreadTail() throws {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let cache = try SQLiteCompanionSnapshotCache(
        url: directory.appending(path: "cache.sqlite3", directoryHint: .notDirectory)
    )
    let roster = CompanionRosterSnapshot(
        cursor: "roster-cursor",
        companions: [try companionSummary()],
        sections: [],
        syncedAt: Date(timeIntervalSince1970: 1_777_680_000)
    )
    try cache.saveRoster(roster, scope: "org-a:user-a")
    #expect(try cache.roster(scope: "org-a:user-a") == roster)
    #expect(try cache.roster(scope: "org-a:user-b") == nil)

    let entries = try (0..<300).map { try transcriptEntry(ordinal: $0) }
    let snapshot = CompanionThreadSnapshot(
        cursor: "thread-cursor",
        thread: try companionThread(entries: entries)
    )
    #expect(snapshot.thread.entries.count == 300)
    try cache.saveThread(snapshot, scope: "org-a:user-a", companionID: snapshot.thread.companionID)
    let restoredSnapshot = try cache.thread(
        scope: "org-a:user-a",
        companionID: snapshot.thread.companionID
    )
    let restored = try #require(restoredSnapshot)
    #expect(restored.isPartial)
    #expect(restored.thread.entries.count == 150)
    #expect(restored.thread.entries.first?.ordinal == 150)
}

@Test
func threadDeltaKeepsFullLiveHistoryAndResetsExceptionalHistory() throws {
    let entries = try (0..<300).map { try transcriptEntry(ordinal: $0) }
    let thread = try companionThread(entries: [])
    let delta = CompanionThreadDelta(
        cursor: "full-cursor",
        resetEntries: true,
        changedEntries: entries,
        deletedEventIDs: [],
        thread: CompanionThreadMetadata(
            companionID: thread.companionID,
            viewerID: thread.viewerID,
            readOnly: thread.readOnly,
            canSend: thread.canSend,
            transcriptionAvailable: thread.transcriptionAvailable,
            activeTurn: thread.activeTurn,
            queuedCount: thread.queuedCount,
            queuedTurn: thread.queuedTurn,
            preparation: thread.preparation,
            backgroundBusy: thread.backgroundBusy,
            interruptedTurn: thread.interruptedTurn
        )
    )

    let live = delta.applying(to: CompanionThreadSnapshot(
        cursor: "stale-cursor",
        thread: try companionThread(entries: [try transcriptEntry(ordinal: 999)])
    ))
    #expect(live.thread.entries.count == 300)
    #expect(live.thread.entries.first?.ordinal == 0)
    #expect(live.thread.entries.last?.ordinal == 299)
}

@Test
func threadDeltaClearsCachedInterruptedTailAfterServerSettlement() throws {
    let interrupted: CompanionThread = try decodeFixture(#"""
    {
      "companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-1",
      "read_only":false,"can_send":true,"transcription_available":true,
      "entries":[],"active_turn":null,"queued_count":0,
      "interrupted_turn":{
        "id":"33333333-3333-4333-8333-333333333333",
        "companion_id":"22222222-2222-4222-8222-222222222222",
        "client_message_id":"44444444-4444-4444-8444-444444444444",
        "status":"interrupted","queue_sequence":2,"replying":false,
        "error":{"code":"cold_start_deadline_exceeded","message":"Did not start.","action":"retry"},
        "state_changed_at":"2026-08-29T00:00:00Z","settled_at":"2026-08-29T00:00:00Z",
        "created_at":"2026-08-29T00:00:00Z","updated_at":"2026-08-29T00:00:00Z"
      }
    }
    """#)
    #expect(interrupted.visibleInterruptedTurn != nil)

    let delta = CompanionThreadDelta(
        cursor: "settled-cursor",
        resetEntries: false,
        changedEntries: [],
        deletedEventIDs: [],
        thread: CompanionThreadMetadata(
            companionID: interrupted.companionID,
            viewerID: interrupted.viewerID,
            readOnly: interrupted.readOnly,
            canSend: interrupted.canSend,
            transcriptionAvailable: interrupted.transcriptionAvailable,
            activeTurn: nil,
            queuedCount: 0,
            queuedTurn: nil,
            preparation: nil,
            backgroundBusy: false,
            interruptedTurn: nil
        )
    )
    let merged = delta.applying(to: CompanionThreadSnapshot(
        cursor: "cached-cursor",
        thread: interrupted
    ))

    #expect(merged.thread.interruptedTurn == nil)
    #expect(merged.thread.visibleInterruptedTurn == nil)
}

@Test
func threadWindowsAndDeltasPreserveRoutineNotifyGroupingEvidence() throws {
    let routineID = "33333333-3333-4333-8333-333333333333"
    let firstRunID = "44444444-4444-4444-8444-444444444444"
    let secondRunID = "55555555-5555-4555-8555-555555555555"
    let thread = try companionThread(entries: [])
    let metadata = CompanionThreadMetadata(
        companionID: thread.companionID,
        viewerID: thread.viewerID,
        readOnly: thread.readOnly,
        canSend: thread.canSend,
        transcriptionAvailable: thread.transcriptionAvailable,
        activeTurn: thread.activeTurn,
        queuedCount: thread.queuedCount,
        queuedTurn: thread.queuedTurn,
        preparation: thread.preparation,
        backgroundBusy: thread.backgroundBusy,
        interruptedTurn: thread.interruptedTurn
    )
    let firstEntries = routineNotifyPair(
        routineID: routineID,
        routineName: "Daily report",
        runID: firstRunID,
        ordinal: 0
    )
    let firstReturn = CompanionRoutineNotifyReturn(
        runID: firstRunID,
        routineID: routineID,
        routineName: "Daily report",
        mainEntryEventID: firstEntries[1].eventID
    )
    let initial = CompanionThreadWindow(
        thread: metadata,
        entries: firstEntries,
        olderCursor: nil,
        syncCursor: "sync-1",
        notifyReturns: [firstReturn]
    ).snapshot()
    #expect(initial.thread.entries.count == 2)
    #expect(initial.thread.entries.last?.routineNotifyGroup == nil)

    let secondEntries = routineNotifyPair(
        routineID: routineID,
        routineName: "Daily report",
        runID: secondRunID,
        ordinal: 2
    )
    let secondReturn = CompanionRoutineNotifyReturn(
        runID: secondRunID,
        routineID: routineID,
        routineName: "Daily report",
        mainEntryEventID: secondEntries[1].eventID
    )
    let merged = CompanionThreadDelta(
        cursor: "sync-2",
        resetEntries: false,
        changedEntries: secondEntries,
        deletedEventIDs: [],
        thread: metadata,
        notifyReturns: [secondReturn]
    ).applying(to: initial)

    #expect(merged.thread.entries.count == 2)
    let group = try #require(merged.thread.entries.last?.routineNotifyGroup)
    #expect(group.routineID == routineID)
    #expect(group.routineName == "Daily report")
    #expect(group.totalCount == 2)
    #expect(group.hiddenEntries.map(\.eventID) == firstEntries.map(\.eventID))
    #expect(Set(merged.notifyReturns?.map(\.runID) ?? []) == Set([firstRunID, secondRunID]))
}

@Test @MainActor
func offlineSessionRestoresRosterWithoutWaitingForNetwork() throws {
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let snapshot = CompanionRosterSnapshot(
        cursor: "roster-cursor",
        companions: [try companionSummary()],
        sections: [],
        syncedAt: Date(timeIntervalSince1970: 1_777_680_000)
    )
    try fixture.cache.saveRoster(snapshot, scope: "org-1:user-1")

    let store = SessionStore(
        apiURL: URL(string: "https://offline.invalid")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: fixture.cache
    )

    #expect(store.phase == .active(session))
    let restored = try #require(store.initialRosterSnapshot)
    #expect(restored.schemaVersion == snapshot.schemaVersion)
    #expect(restored.cursor == snapshot.cursor)
    #expect(restored.companions == snapshot.companions)
    #expect(restored.sections == snapshot.sections)
    #expect((store.initialCacheRestoreMilliseconds ?? .infinity) < 50)
}

@Test @MainActor
func sessionScopeChangesFenceInFlightCacheRefreshes() async throws {
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    do {
        SuspendedRosterSyncURLProtocol.reset()
        let session = testSession()
        let cached = CompanionRosterSnapshot(
            cursor: "old-cursor",
            companions: [try companionSummary()],
            sections: []
        )
        try fixture.cache.saveRoster(cached, scope: "org-1:user-1")
        let store = SessionStore(
            apiURL: URL(string: "https://example.test")!,
            storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
            cache: fixture.cache,
            apiClient: suspendedRosterClient(initialAuthority: session)
        )
        let synchronization = Task { try await store.synchronizeRoster() }
        for _ in 0..<500 where !SuspendedRosterSyncURLProtocol.hasStartedRosterRequest {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(SuspendedRosterSyncURLProtocol.hasStartedRosterRequest)

        await store.signOut()
        SuspendedRosterSyncURLProtocol.releaseResponse.signal()
        do {
            _ = try await synchronization.value
            Issue.record("The signed-out session roster refresh should be cancelled")
        } catch is CancellationError {}

        #expect(store.phase == .signedOut)
        #expect(store.initialRosterSnapshot == nil)
        #expect(try fixture.cache.roster(scope: "org-1:user-1") == nil)
    }

    do {
        SuspendedRosterSyncURLProtocol.reset()
        let oldSession = testSession()
        let oldRoster = CompanionRosterSnapshot(
            cursor: "old-cursor",
            companions: [try companionSummary(name: "Old account")],
            sections: []
        )
        let newRoster = CompanionRosterSnapshot(
            cursor: "new-cursor",
            companions: [try companionSummary(
                id: "33333333-3333-4333-8333-333333333333",
                name: "New account"
            )],
            sections: []
        )
        try fixture.cache.saveRoster(oldRoster, scope: "org-1:user-1")
        try fixture.cache.saveRoster(newRoster, scope: "org-2:user-2")
        let store = SessionStore(
            apiURL: URL(string: "https://example.test")!,
            storage: FixedSessionStorage(data: try JSONEncoder().encode(oldSession)),
            cache: fixture.cache,
            apiClient: suspendedRosterClient(initialAuthority: oldSession)
        )
        let synchronization = Task { try await store.synchronizeRoster() }
        for _ in 0..<500 where !SuspendedRosterSyncURLProtocol.hasStartedRosterRequest {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(SuspendedRosterSyncURLProtocol.hasStartedRosterRequest)

        try await store.signIn(email: "new@example.com", password: "password")
        #expect(store.initialRosterSnapshot?.cursor == "new-cursor")
        SuspendedRosterSyncURLProtocol.releaseResponse.signal()
        do {
            _ = try await synchronization.value
            Issue.record("The old account roster refresh should be cancelled")
        } catch is CancellationError {}

        #expect(store.currentSession?.user.id == "user-2")
        #expect(store.initialRosterSnapshot?.cursor == "new-cursor")
        #expect(store.initialRosterSnapshot?.companions.map(\.name) == ["New account"])
    }

    do {
        SuspendedRosterSyncURLProtocol.reset()
        let oldSession = testSession()
        let companionID = "22222222-2222-4222-8222-222222222222"
        let oldThread = CompanionThreadSnapshot(
            cursor: "old-thread",
            thread: try companionThread(entries: [try transcriptEntry(ordinal: 1)])
        )
        let newThread = CompanionThreadSnapshot(
            cursor: "new-thread",
            thread: try companionThread(entries: [try transcriptEntry(ordinal: 2)])
        )
        try fixture.cache.saveThread(
            oldThread,
            scope: "org-1:user-1",
            companionID: companionID
        )
        try fixture.cache.saveThread(
            newThread,
            scope: "org-2:user-2",
            companionID: companionID
        )
        let store = SessionStore(
            apiURL: URL(string: "https://example.test")!,
            storage: FixedSessionStorage(data: try JSONEncoder().encode(oldSession)),
            cache: fixture.cache,
            apiClient: suspendedRosterClient(initialAuthority: oldSession)
        )
        let oldSynchronization = Task {
            try await store.synchronizeThread(companionID: companionID)
        }
        for _ in 0..<500 where !SuspendedRosterSyncURLProtocol.hasStartedOldThreadRequest {
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        #expect(SuspendedRosterSyncURLProtocol.hasStartedOldThreadRequest)

        try await store.signIn(email: "new@example.com", password: "password")
        let newSynchronization = try await store.synchronizeThread(companionID: companionID)
        #expect(newSynchronization.value.cursor == "new-thread-fresh")
        SuspendedRosterSyncURLProtocol.releaseResponse.signal()
        do {
            _ = try await oldSynchronization.value
            Issue.record("The old account thread refresh should be cancelled")
        } catch is CancellationError {}

        #expect(store.currentSession?.user.id == "user-2")
        #expect(store.cachedThread(companionID: companionID)?.cursor == "new-thread-fresh")
        #expect(store.cachedThread(companionID: companionID)?.thread.viewerID == "user-2")
    }

}

@Test @MainActor
func staleUnauthorizedThreadResponseDoesNotClearNewAccount() async throws {
    StaleUnauthorizedThreadURLProtocol.reset()
    defer {
        StaleUnauthorizedThreadURLProtocol.releaseResponse.signal()
        StaleUnauthorizedThreadURLProtocol.releaseWhoAmI.signal()
    }
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let oldSession = testSession()
    let companionID = "22222222-2222-4222-8222-222222222222"
    try fixture.cache.saveThread(
        CompanionThreadSnapshot(
            cursor: "old-thread-unauthorized",
            thread: try companionThread(entries: [try transcriptEntry(ordinal: 3)])
        ),
        scope: "org-1:user-1",
        companionID: companionID
    )
    try fixture.cache.saveThread(
        CompanionThreadSnapshot(
            cursor: "new-thread",
            thread: try companionThread(entries: [try transcriptEntry(ordinal: 4)])
        ),
        scope: "org-2:user-2",
        companionID: companionID
    )
    let store = SessionStore(
        apiURL: URL(string: "https://example.test")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(oldSession)),
        cache: fixture.cache,
        apiClient: staleUnauthorizedThreadClient(initialAuthority: oldSession)
    )
    let oldSynchronization = Task {
        try await store.synchronizeThread(companionID: companionID)
    }
    for _ in 0..<500 where !StaleUnauthorizedThreadURLProtocol.hasStartedOldRequest {
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(StaleUnauthorizedThreadURLProtocol.hasStartedOldRequest)

    let signIn = Task {
        try await store.signIn(email: "new@example.com", password: "password")
    }
    for _ in 0..<500 where !StaleUnauthorizedThreadURLProtocol.hasStartedWhoAmIRequest {
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(StaleUnauthorizedThreadURLProtocol.hasStartedWhoAmIRequest)

    StaleUnauthorizedThreadURLProtocol.releaseResponse.signal()
    do {
        _ = try await oldSynchronization.value
        Issue.record("The stale unauthorized response should be cancelled")
    } catch is CancellationError {}

    #expect(store.currentSession?.user.id == "user-1")
    #expect(store.phase != .signedOut)
    StaleUnauthorizedThreadURLProtocol.releaseWhoAmI.signal()
    try await signIn.value
    let newSynchronization = try await store.synchronizeThread(companionID: companionID)
    #expect(newSynchronization.value.cursor == "new-thread-fresh")
    #expect(store.currentSession?.user.id == "user-2")
    #expect(store.cachedThread(companionID: companionID)?.cursor == "new-thread-fresh")
    #expect(store.phase != .signedOut)
}

@Test @MainActor
func cachedThreadRemainsRenderableWhileDeltaSynchronizationIsInFlight() async throws {
    SuspendedThreadSyncURLProtocol.reset()
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let cached = CompanionThreadSnapshot(
        cursor: "prior-cursor",
        thread: try companionThread(entries: try (0..<300).map {
            try transcriptEntry(ordinal: $0)
        })
    )
    try fixture.cache.saveThread(
        cached,
        scope: "org-1:user-1",
        companionID: cached.thread.companionID
    )

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SuspendedThreadSyncURLProtocol.self]
    let client = APIClient(
        baseURL: URL(string: "https://example.test")!,
        session: URLSession(configuration: configuration),
        initialAuthority: session
    )
    let store = SessionStore(
        apiURL: URL(string: "https://example.test")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: fixture.cache,
        apiClient: client
    )
    let rendered = try #require(store.cachedThread(companionID: cached.thread.companionID))
    let projection = CompanionThreadProjection(thread: rendered.thread)
    #expect(!projection.needsBlockingLoader)
    #expect(rendered.thread.readOnly)
    #expect(!rendered.thread.canSend)

    let synchronization = Task {
        try await store.synchronizeThread(companionID: cached.thread.companionID)
    }
    for _ in 0..<500 where !SuspendedThreadSyncURLProtocol.hasStarted {
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(SuspendedThreadSyncURLProtocol.hasStarted)

    // The request has reached the transport and is deliberately suspended. Cached content remains
    // the projection, so ChatView's loader predicate stays false throughout revalidation.
    #expect(!projection.needsBlockingLoader)
    #expect(store.cachedThread(companionID: cached.thread.companionID)?.thread.entries.count == 150)
    #expect(URLComponents(
        url: try #require(SuspendedThreadSyncURLProtocol.capturedURL),
        resolvingAgainstBaseURL: false
    )?.queryItems?.contains(URLQueryItem(name: "cursor", value: "prior-cursor")) == true)

    SuspendedThreadSyncURLProtocol.releaseResponse.signal()
    let refreshed = try await synchronization.value
    #expect(refreshed.value.thread.canSend)
    #expect(refreshed.value.cursor == "next-cursor")
    #expect(refreshed.value.isPartial)
}

@Test @MainActor
func oversizedLegacyThreadCursorRecoversWithAFullSynchronization() async throws {
    OversizedThreadCursorURLProtocol.reset()
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let companionID = "22222222-2222-4222-8222-222222222222"
    try fixture.cache.saveThread(
        CompanionThreadSnapshot(
            cursor: String(repeating: "A", count: 8_001),
            thread: try companionThread(entries: [try transcriptEntry(ordinal: 1)])
        ),
        scope: "org-1:user-1",
        companionID: companionID
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [OversizedThreadCursorURLProtocol.self]
    let client = APIClient(
        baseURL: URL(string: "https://example.test")!,
        session: URLSession(configuration: configuration),
        initialAuthority: session
    )
    let store = SessionStore(
        apiURL: URL(string: "https://example.test")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: fixture.cache,
        apiClient: client
    )

    let synchronization = try await store.synchronizeThread(companionID: companionID)
    let requestURL = try #require(OversizedThreadCursorURLProtocol.capturedURL)
    let cursor = URLComponents(
        url: requestURL,
        resolvingAgainstBaseURL: false
    )?.queryItems?.first(where: { $0.name == "cursor" })?.value
    #expect(cursor == nil)
    #expect(synchronization.value.cursor == "transport-safe")
    #expect(synchronization.value.thread.entries.map(\.content) == ["Recovered"])
}

@Test @MainActor
func rejectedThreadCursorRetriesOnceWithoutCursor() async throws {
    for statusCode in [400, 414, 431] {
        RejectedThreadCursorURLProtocol.reset(statusCode: statusCode)
        let fixture = try cacheFixture()
        defer { try? FileManager.default.removeItem(at: fixture.directory) }
        let session = testSession()
        let companionID = "22222222-2222-4222-8222-222222222222"
        try fixture.cache.saveThread(
            CompanionThreadSnapshot(
                cursor: "short-cursor",
                thread: try companionThread(entries: [try transcriptEntry(ordinal: 1)])
            ),
            scope: "org-1:user-1",
            companionID: companionID
        )
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [RejectedThreadCursorURLProtocol.self]
        let client = APIClient(
            baseURL: URL(string: "https://example.test")!,
            session: URLSession(configuration: configuration),
            initialAuthority: session
        )
        let store = SessionStore(
            apiURL: URL(string: "https://example.test")!,
            storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
            cache: fixture.cache,
            apiClient: client
        )

        let synchronization = try await store.synchronizeThread(companionID: companionID)
        #expect(RejectedThreadCursorURLProtocol.capturedCursors == ["short-cursor"])
        #expect(synchronization.value.cursor == "transport-safe")
        #expect(synchronization.value.thread.entries.isEmpty)
    }
}

@Test
func compatibilityThreadCallDrainsEveryOlderWindow() async throws {
    let host = "compatibility-thread.example.test"
    PagedThreadSyncURLProtocol.reset(host: host)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PagedThreadSyncURLProtocol.self]
    let client = APIClient(
        baseURL: URL(string: "https://\(host)")!,
        session: URLSession(configuration: configuration),
        initialAuthority: testSession()
    )

    let thread = try await client.thread(
        companionID: "22222222-2222-4222-8222-222222222222"
    )

    #expect(thread.entries.map(\.ordinal) == [0, 1, 2])
    let urls = PagedThreadSyncURLProtocol.capturedURLs(host: host)
    #expect(urls.count == 2)
    #expect(URLComponents(url: urls[1], resolvingAgainstBaseURL: false)?
        .queryItems?.contains(URLQueryItem(name: "before", value: "older-one")) == true)
}

@Test @MainActor
func pagedThreadBootstrapDrainsDeltasAndLoadsOlderHistory() async throws {
    let host = "paged-bootstrap.example.test"
    PagedThreadSyncURLProtocol.reset(host: host)
    let session = testSession()
    let companionID = "22222222-2222-4222-8222-222222222222"
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PagedThreadSyncURLProtocol.self]
    let client = APIClient(
        baseURL: URL(string: "https://\(host)")!,
        session: URLSession(configuration: configuration),
        initialAuthority: session
    )
    let store = SessionStore(
        apiURL: URL(string: "https://\(host)")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        apiClient: client
    )

    let bootstrap = try await store.synchronizeThread(companionID: companionID)
    #expect(bootstrap.value.cursor == "sync-1")
    #expect(bootstrap.value.olderCursor == "older-one")
    #expect(bootstrap.value.thread.entries.map(\.ordinal) == [1, 2])

    let drained = try await store.synchronizeThread(companionID: companionID)
    #expect(drained.value.cursor == "sync-3")
    #expect(drained.value.thread.entries.map(\.ordinal) == [1, 2, 3, 4])

    let history = try #require(try await store.loadOlderThreadWindow(companionID: companionID))
    #expect(history.value.cursor == "sync-3")
    #expect(history.value.olderCursor == nil)
    #expect(history.value.thread.entries.map(\.ordinal) == [0, 1, 2, 3, 4])

    let urls = PagedThreadSyncURLProtocol.capturedURLs(host: host)
    #expect(urls.count == 4)
    #expect(urls[0].path.hasSuffix("/thread-window"))
    #expect(URLComponents(url: urls[0], resolvingAgainstBaseURL: false)?
        .queryItems?.contains(URLQueryItem(name: "limit", value: "50")) == true)
    #expect(URLComponents(url: urls[1], resolvingAgainstBaseURL: false)?
        .queryItems?.contains(URLQueryItem(name: "cursor", value: "sync-1")) == true)
    #expect(URLComponents(url: urls[2], resolvingAgainstBaseURL: false)?
        .queryItems?.contains(URLQueryItem(name: "cursor", value: "sync-2")) == true)
    #expect(URLComponents(url: urls[3], resolvingAgainstBaseURL: false)?
        .queryItems?.contains(URLQueryItem(name: "before", value: "older-one")) == true)
}

@Test
func rosterDeltaMergesWithoutGapsDuplicatesAndPreservesServerOrder() throws {
    let first = try companionSummary(id: "22222222-2222-4222-8222-222222222222", name: "First")
    let second = try companionSummary(id: "33333333-3333-4333-8333-333333333333", name: "Second")
    let initial = CompanionRosterSnapshot(cursor: "one", companions: [first, second], sections: [])
    let changedSecond = try companionSummary(id: second.id, name: "Second updated")
    let delta = CompanionRosterDelta(
        cursor: "two",
        changedCompanions: [changedSecond],
        deletedCompanionIDs: [],
        companionIDs: [second.id, first.id],
        changedSections: [],
        deletedSectionIDs: [],
        sectionIDs: []
    )
    let merged = try delta.applying(to: initial)
    #expect(merged.companions.map(\.id) == [second.id, first.id])
    #expect(merged.companions.map(\.name) == ["Second updated", "First"])
    #expect(Set(merged.companions.map(\.id)).count == merged.companions.count)
}

@Test @MainActor
func companionInvalidationReachesTheVisibleThreadConsumer() async throws {
    let session = testSession()
    let store = SessionStore(
        apiURL: URL(string: "https://offline.invalid")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session))
    )
    let stream = store.companionInvalidations(companionID: "companion-x")
    let received = Task { @MainActor in
        for await _ in stream { return true }
        return false
    }
    #expect(store.hasVisibleInvalidationConsumer(companionID: "companion-x"))
    #expect(!store.hasVisibleInvalidationConsumer(companionID: "companion-y"))

    store.invalidateCompanion(companionID: "companion-x")
    #expect(await received.value)
}

@Test @MainActor
func preRegistrationInvalidationIsCoalescedAndReplayedToTheMatchingConsumer() async throws {
    let session = testSession()
    let store = SessionStore(
        apiURL: URL(string: "https://offline.invalid")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session))
    )
    let companionID = "companion-y"

    store.invalidateCompanion(companionID: companionID)
    store.invalidateCompanion(companionID: companionID)
    let stream = store.companionInvalidations(companionID: companionID)
    let received = Task { @MainActor in
        for await _ in stream { return true }
        return false
    }

    #expect(await received.value)
    #expect(store.hasVisibleInvalidationConsumer(companionID: companionID))
}

@Test @MainActor
func explicitBackgroundRefreshUpdatesRosterAndThreadCache() async throws {
    BackgroundRefreshURLProtocol.reset()
    let fixture = try cacheFixture()
    defer { try? FileManager.default.removeItem(at: fixture.directory) }
    let session = testSession()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [BackgroundRefreshURLProtocol.self]
    let client = APIClient(
        baseURL: URL(string: "https://example.test")!,
        session: URLSession(configuration: configuration),
        initialAuthority: session
    )
    let store = SessionStore(
        apiURL: URL(string: "https://example.test")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: fixture.cache,
        apiClient: client
    )
    let companionY = "33333333-3333-4333-8333-333333333333"
    let result = await store.refreshInvalidatedCompanion(companionID: companionY)

    #expect(result == .newData)
    #expect(BackgroundRefreshURLProtocol.requestsStarted >= 2)
    #expect(store.initialRosterSnapshot?.companions.map(\.id) == [companionY])
    #expect(store.cachedThread(companionID: companionY)?.cursor == "fresh-thread")
}

@Test @MainActor
func successfulSynchronizationSurvivesUnavailableOfflineCache() async throws {
    BackgroundRefreshURLProtocol.reset()
    let session = testSession()
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [BackgroundRefreshURLProtocol.self]
    let client = APIClient(
        baseURL: URL(string: "https://example.test")!,
        session: URLSession(configuration: configuration),
        initialAuthority: session
    )
    let store = SessionStore(
        apiURL: URL(string: "https://example.test")!,
        storage: FixedSessionStorage(data: try JSONEncoder().encode(session)),
        cache: WriteFailingSnapshotCache(),
        apiClient: client
    )
    let companionID = "33333333-3333-4333-8333-333333333333"

    let roster = try await store.synchronizeRoster()
    #expect(roster.value.companions.map(\.id) == [companionID])
    #expect(store.initialRosterSnapshot?.cursor == "fresh-roster")

    let thread = try await store.synchronizeThread(companionID: companionID)
    #expect(thread.value.cursor == "fresh-thread")
    #expect(thread.value.thread.canSend)

    let liveProjection = try #require(store.cachedThread(companionID: companionID))
    #expect(liveProjection.cursor == "fresh-thread")
    #expect(liveProjection.thread.readOnly)
    #expect(!liveProjection.thread.canSend)
}

private func cacheFixture() throws -> (directory: URL, cache: SQLiteCompanionSnapshotCache) {
    let directory = FileManager.default.temporaryDirectory
        .appending(path: UUID().uuidString, directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return (
        directory,
        try SQLiteCompanionSnapshotCache(
            url: directory.appending(path: "cache.sqlite3", directoryHint: .notDirectory)
        )
    )
}

private func suspendedRosterClient(initialAuthority: Session) -> APIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [SuspendedRosterSyncURLProtocol.self]
    return APIClient(
        baseURL: URL(string: "https://example.test")!,
        session: URLSession(configuration: configuration),
        initialAuthority: initialAuthority
    )
}

private func staleUnauthorizedThreadClient(initialAuthority: Session) -> APIClient {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [StaleUnauthorizedThreadURLProtocol.self]
    return APIClient(
        baseURL: URL(string: "https://example.test")!,
        session: URLSession(configuration: configuration),
        initialAuthority: initialAuthority
    )
}

private func testSession() -> Session {
    Session(
        cookie: "better-auth.session_token=test",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "owner@example.com", name: "Owner")
    )
}

private func companionSummary(
    id: String = "22222222-2222-4222-8222-222222222222",
    name: String = "Research"
) throws -> CompanionSummary {
    try decodeFixture(#"""
    {
      "id":"\#(id)","name":"\#(name)","persona":"Help","model_id":"model",
      "selected_skill_ids":[],"selected_mcp_account_ids":[],"icon":null,"section_id":null,
      "access":"owner","pinned":false,"hidden":false,"muted":false,"unread":false,
      "last_message":{"preview":"Ready","role":"assistant","created_at":"2026-08-29T00:00:00Z"},
      "runtime":{"state":"running","daemon_state":"running","replying":false,
        "last_error":null,"provider_ids":[],"lifecycle_intent":"prepare"}
    }
    """#)
}

private func companionThread(entries: [TranscriptEntry]) throws -> CompanionThread {
    let entriesData = try JSONEncoder().encode(entries)
    let entriesJSON = String(decoding: entriesData, as: UTF8.self)
    return try decodeFixture(#"""
    {
      "companion_id":"22222222-2222-4222-8222-222222222222","viewer_id":"user-1",
      "read_only":false,"can_send":true,"transcription_available":true,
      "entries":\#(entriesJSON),"active_turn":null,"queued_count":0,"interrupted_turn":null
    }
    """#)
}

private func transcriptEntry(ordinal: Int) throws -> TranscriptEntry {
    try decodeFixture(#"""
    {
      "event_id":"event:\#(ordinal)","ordinal":\#(ordinal),"role":"assistant",
      "content":"Message \#(ordinal)","reasoning":null,"author_id":null,"author_name":null,
      "decision":null,"tool":null,"routine":null,"turn_id":null,"queued":false,
      "attachments":[],"created_at":"2026-08-29T00:00:00Z"
    }
    """#)
}

private func routineNotifyPair(
    routineID: String,
    routineName: String,
    runID: String,
    ordinal: Int
) -> [TranscriptEntry] {
    [
        TranscriptEntry(
            eventID: "routine:\(runID)",
            ordinal: ordinal,
            role: "user",
            content: routineName,
            reasoning: nil,
            authorID: nil,
            authorName: nil,
            decision: nil,
            tool: nil,
            routine: CompanionTranscriptRoutineOrigin(id: routineID, name: routineName, runID: runID),
            routineNotifyGroup: nil,
            turnID: runID,
            queued: false,
            attachments: [],
            createdAt: "2026-08-29T00:00:00Z"
        ),
        TranscriptEntry(
            eventID: "return:\(runID)",
            ordinal: ordinal + 1,
            role: "assistant",
            content: "Done",
            reasoning: nil,
            authorID: nil,
            authorName: nil,
            decision: nil,
            tool: nil,
            routine: nil,
            routineNotifyGroup: nil,
            turnID: runID,
            queued: false,
            attachments: [],
            createdAt: "2026-08-29T00:00:01Z"
        ),
    ]
}

private func decodeFixture<Value: Decodable>(_ json: String) throws -> Value {
    try JSONDecoder().decode(Value.self, from: Data(json.utf8))
}
