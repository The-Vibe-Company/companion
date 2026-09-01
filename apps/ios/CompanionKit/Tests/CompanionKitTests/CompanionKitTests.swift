import Foundation
import Testing
@testable import CompanionKit

private final class MockURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class ManagementMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var deleteAttempts = 0

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

private final class PluginOAuthRedirectMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var authorizationURL = "https://mcp.linear.app/authorize?state=signed-state&redirect_uri=https%3A%2F%2Fthecompanion.sh%2Fv1%2Fcompanion-plugins%2Foauth%2Fcallback"
    nonisolated(unsafe) static var redirectLocation = ""
    nonisolated(unsafe) static var unexpectedRedirectRequests = 0

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

private final class RedirectDelegateFactoryRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var decisions: [Bool] = []

    func record(followRedirects: Bool) {
        lock.lock()
        decisions.append(followRedirects)
        lock.unlock()
    }

    func snapshot() -> [Bool] {
        lock.lock()
        let snapshot = decisions
        lock.unlock()
        return snapshot
    }
}

private final class RuntimeManagementMockURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class NotificationMockURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class DecisionMockURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var expectedActions: [[String: String]] = []

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

private final class TurnActionMockURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class AttachmentMockURLProtocol: URLProtocol, @unchecked Sendable {
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

private final class ConnectedResourcesMockURLProtocol: URLProtocol, @unchecked Sendable {
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

private actor AsyncBooleanProbe {
    private var value = false

    func mark() {
        value = true
    }

    func read() -> Bool {
        value
    }
}

private final class UploadProgressRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Double] = []

    func append(_ value: Double) {
        lock.lock()
        values.append(value)
        lock.unlock()
    }

    func snapshot() -> [Double] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try #require(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
        if count == 0 { break }
        data.append(buffer, count: count)
    }
    return data
}

@Test
func usesTheSharedAPIContract() {
    #expect(CompanionKit.apiRootPath == "/v1")
}

@Test
func classifiesAssistantMarkdownLinksWithTheSharedPolicy() throws {
    struct LinkCase {
        let source: String
        let expected: CompanionLinkRoute
    }

    let cases = [
        LinkCase(source: "https://example.com/docs", expected: .system),
        LinkCase(source: "HTTP://EXAMPLE.COM/docs", expected: .system),
        LinkCase(source: "mailto:ops@example.com", expected: .system),
        LinkCase(source: "ConDuCtOr://workspace?id=workspace-1", expected: .conductor),
        LinkCase(source: "javascript:alert(1)", expected: .blocked),
        LinkCase(source: "custom://workspace?id=workspace-1", expected: .blocked),
        LinkCase(source: "workspace?id=workspace-1", expected: .blocked),
    ]

    for linkCase in cases {
        let url = try #require(CompanionLinkPolicy.parse(linkCase.source))
        #expect(CompanionLinkPolicy.route(for: url) == linkCase.expected)
        #expect(CompanionLinkPolicy.route(for: linkCase.source) == linkCase.expected)
    }

    #expect(CompanionLinkPolicy.route(for: "not a valid URL") == .blocked)
}

@Test
func keepsTheLinkSchemeAllowlistCaseInsensitiveAndFailClosed() throws {
    let cases: [(scheme: String?, allowed: Bool)] = [
        ("http", true),
        ("HTTPS", true),
        ("MailTo", true),
        ("CONDUCTOR", true),
        ("javascript", false),
        ("tel", false),
        ("unknown", false),
        (nil, false),
        ("", false),
    ]

    for linkCase in cases {
        #expect(CompanionLinkPolicy.isAllowedScheme(linkCase.scheme) == linkCase.allowed)
    }

    let conductorURL = try #require(CompanionLinkPolicy.parse("CONDUCTOR://workspace?id=workspace-1"))
    #expect(CompanionLinkPolicy.isConductor(conductorURL))
}

@Test
func detectsBareMessageURLsWithoutTrailingPunctuationOrBlockedSchemes() throws {
    let source = "See 😀 https://github.com/The-Vibe-Company/companion, then ftp://example.com/file."
    let links = CompanionMessageLinkDetector.detect(in: source)

    let link = try #require(links.first)
    #expect(links.count == 1)
    #expect(link.url.absoluteString == "https://github.com/The-Vibe-Company/companion")
    #expect((source as NSString).substring(with: link.nsRange) == link.url.absoluteString)
}

@Test
func mapsEveryRuntimeStateToTheCompactStatusIndicator() {
    let expected: [(CompanionRuntimeState, CompanionStatusIndicatorState)] = [
        (.notCreated, .inactive),
        (.provisioning, .inactive),
        (.running, .live),
        (.stopping, .inactive),
        (.stopped, .inactive),
        (.error, .error),
        (.unknown, .inactive),
    ]

    for (runtimeState, status) in expected {
        #expect(
            CompanionStatusIndicatorState(
                runtimeState: runtimeState,
                isReplying: false
            ) == status
        )
    }

    let replying = CompanionStatusIndicatorState(runtimeState: .running, isReplying: true)
    #expect(replying == .replying)
    #expect(replying.tint == .live)
}

@Test
func replyingIndicatorFallsBackToAStaticLiveDotForReducedMotion() {
    let replying = CompanionStatusIndicatorState(runtimeState: .running, isReplying: true)

    #expect(replying.shouldPulse(reduceMotion: false))
    #expect(!replying.shouldPulse(reduceMotion: true))
    #expect(replying.tint == .live)
}

@Test
func routesOnlyPendingExternalOAuthCallbackShapes() throws {
    let googleScheme = "dev.companion.mobile.dev"
    let googleState = "native-state"
    let google = try #require(URL(string: "\(googleScheme)://?cookie=better-auth.session_token%3Dgoogle-session&native_state=\(googleState)"))
    let staleGoogle = try #require(URL(string: "\(googleScheme)://?cookie=better-auth.session_token%3Dgoogle-session&native_state=stale-state"))
    let wrongGoogleScheme = try #require(URL(string: "dev.companion.mobile://?cookie=session"))
    let plugin = try #require(URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback?code=code&state=state"))
    let pluginCallback = try #require(URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback"))
    let stalePlugin = try #require(URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback?code=code&state=stale-state"))
    let customPluginCallback = try #require(URL(string: "https://oauth.example/v1/companion-plugins/oauth/callback"))
    let customPlugin = try #require(URL(string: "https://oauth.example/v1/companion-plugins/oauth/callback?code=code&state=state"))
    let localPluginCallback = try #require(URL(string: "http://127.0.0.1:3001/v1/companion-plugins/oauth/callback"))
    let localPlugin = try #require(URL(string: "http://127.0.0.1:3001/v1/companion-plugins/oauth/callback?code=code&state=state"))
    let wrongPluginPath = try #require(URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/start?code=code"))
    let wrongPluginHost = try #require(URL(string: "https://api.thecompanion.sh/v1/companion-plugins/oauth/callback?code=code&state=state"))
    let pluginWithUserInfo = try #require(URL(string: "https://attacker@thecompanion.sh/v1/companion-plugins/oauth/callback?code=code&state=state"))

    #expect(CompanionOAuthCallbackPolicy.route(
        for: google,
        googleCallbackScheme: googleScheme,
        googleNativeState: googleState
    ) == .google)
    #expect(CompanionOAuthCallbackPolicy.googleCookie(
        from: google,
        callbackScheme: googleScheme,
        expectedNativeState: googleState
    ) == "better-auth.session_token=google-session")
    #expect(CompanionOAuthCallbackPolicy.route(
        for: staleGoogle,
        googleCallbackScheme: googleScheme,
        googleNativeState: googleState
    ) == .blocked)
    #expect(CompanionOAuthCallbackPolicy.route(
        for: wrongGoogleScheme,
        googleCallbackScheme: googleScheme,
        googleNativeState: googleState
    ) == .blocked)
    #expect(CompanionOAuthCallbackPolicy.route(
        for: plugin,
        googleCallbackScheme: googleScheme,
        pluginCallbackURL: pluginCallback,
        pluginCallbackState: "state"
    ) == .plugin)
    #expect(CompanionOAuthCallbackPolicy.route(
        for: stalePlugin,
        googleCallbackScheme: nil,
        pluginCallbackURL: pluginCallback,
        pluginCallbackState: "state"
    ) == .blocked)
    #expect(CompanionOAuthCallbackPolicy.route(
        for: localPlugin,
        googleCallbackScheme: nil,
        pluginCallbackURL: localPluginCallback,
        pluginCallbackState: "state"
    ) == .plugin)
    #expect(CompanionOAuthCallbackPolicy.route(
        for: customPlugin,
        googleCallbackScheme: nil,
        pluginCallbackURL: customPluginCallback,
        pluginCallbackState: "state"
    ) == .plugin)
    #expect(CompanionOAuthCallbackPolicy.route(
        for: wrongPluginPath,
        googleCallbackScheme: nil,
        pluginCallbackURL: pluginCallback,
        pluginCallbackState: "state"
    ) == .blocked)
    #expect(CompanionOAuthCallbackPolicy.route(
        for: wrongPluginHost,
        googleCallbackScheme: nil,
        pluginCallbackURL: pluginCallback,
        pluginCallbackState: "state"
    ) == .blocked)
    #expect(CompanionOAuthCallbackPolicy.route(
        for: pluginWithUserInfo,
        googleCallbackScheme: nil,
        pluginCallbackURL: pluginCallback,
        pluginCallbackState: "state"
    ) == .blocked)
}

@Test
func decodesTheVersionedCompanionNotificationPayload() throws {
    let payload = try JSONDecoder().decode(CompanionNotificationPayload.self, from: Data(#"""
    {
      "version":1,
      "org_id":"66666666-6666-4666-8666-666666666666",
      "companion_id":"11111111-1111-4111-8111-111111111111",
      "event":"input_required"
    }
    """#.utf8))
    #expect(payload.version == 1)
    #expect(payload.orgID == "66666666-6666-4666-8666-666666666666")
    #expect(payload.companionID == "11111111-1111-4111-8111-111111111111")
    #expect(payload.event == .inputRequired)
}

@Test
func synchronizesAndRemovesTheCurrentNotificationInstallation() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [NotificationMockURLProtocol.self]
    let installationID = try #require(UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"))
    NotificationMockURLProtocol.handler = { request in
        #expect(request.url?.path == "/v1/notification-devices/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(request.httpMethod == "PUT")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-1")
        let body = try requestBody(request)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(json == [
            "platform": "ios",
            "device_token": String(repeating: "ab", count: 32),
            "environment": "sandbox",
            "bundle_id": "dev.companion.mobile.dev",
        ])
        let response = try #require(HTTPURLResponse(
            url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil
        ))
        return (response, Data())
    }
    defer { NotificationMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "stan@example.com", name: "Stan")
    ))
    try await client.registerNotificationDevice(
        installationID: installationID,
        registration: .init(
            deviceToken: String(repeating: "ab", count: 32),
            environment: .sandbox,
            bundleID: "dev.companion.mobile.dev"
        )
    )

    NotificationMockURLProtocol.handler = { request in
        #expect(request.url?.path == "/v1/notification-devices/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
        #expect(request.httpMethod == "DELETE")
        let response = try #require(HTTPURLResponse(
            url: request.url!, statusCode: 204, httpVersion: nil, headerFields: nil
        ))
        return (response, Data())
    }
    try await client.unregisterNotificationDevice(installationID: installationID)
}

@Test
func decodesUnknownRuntimeStateWithoutRejectingTheRoster() throws {
    let data = Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"glm-5.3",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{"state":"future_state","replying":false,"last_error":null},
      "future_field":true
    }
    """#.utf8)
    let companion = try JSONDecoder().decode(CompanionSummary.self, from: data)
    #expect(companion.runtime.state == .unknown)
}

@Test
func decodesAndPreservesCompanionPluginSelectionAndDaemonState() throws {
    let selectedIDs = [
        "b4d8a690-32d2-4dff-b6e0-3f742c056f95",
        "c5e9b7a1-43e3-4eff-c7f1-4a853d1670a6",
    ]
    let selected = try JSONDecoder().decode(CompanionSummary.self, from: Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"claude-sonnet",
      "selected_mcp_account_ids":["b4d8a690-32d2-4dff-b6e0-3f742c056f95","c5e9b7a1-43e3-4eff-c7f1-4a853d1670a6"],
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{"state":"running","daemon_state":"running","replying":false,"last_error":null}
    }
    """#.utf8))
    #expect(selected.selectedMCPAccountIDs == selectedIDs)
    #expect(selected.runtime.daemonState == .running)

    let missingSelectionAndDaemon = try JSONDecoder().decode(CompanionSummary.self, from: Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"claude-sonnet",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{"state":"running","replying":false,"last_error":null}
    }
    """#.utf8))
    #expect(missingSelectionAndDaemon.selectedMCPAccountIDs == [])
    #expect(missingSelectionAndDaemon.runtime.daemonState == .unknown)

    let merged = selected.preservingListProjection(from: missingSelectionAndDaemon)
    #expect(merged.selectedMCPAccountIDs == selectedIDs)
}

@Test
func decodesCompanionIconCatalogIndexes() throws {
    let data = Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"glm-5.3",
      "icon":{"shape":6,"mouth":3,"accessory":5,"color":7},
      "hidden":false,
      "unread":true,
      "last_message":null,
      "runtime":{"state":"running","replying":false,"last_error":null}
    }
    """#.utf8)
    let companion = try JSONDecoder().decode(CompanionSummary.self, from: data)
    #expect(companion.icon == .init(shape: 6, mouth: 3, accessory: 5, color: 7))
}

@Test
func decodesCompanionSettingsAuthorityAndDurableDeletion() throws {
    let data = Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":"Keep releases calm",
      "model_id":"claude-sonnet",
      "icon":{"shape":6,"mouth":3,"accessory":5,"color":7},
      "access":"owner",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{
        "state":"running",
        "replying":false,
        "last_error":null,
        "provider_ids":["anthropic"],
        "latest_operation":{
          "id":"14757274-8d64-455c-a394-334665a258f0",
          "source_turn_id":null,
          "kind":"delete",
          "status":"failed",
          "error":{"code":"delete_failed","message":"Deletion could not complete.","action":"retry"}
        }
      }
    }
    """#.utf8)
    let companion = try JSONDecoder().decode(CompanionSummary.self, from: data)
    #expect(companion.access == .owner)
    #expect(companion.access.canEditCompanionSettings)
    #expect(companion.access.canDeleteCompanion)
    #expect(companion.runtime.providerIDs == ["anthropic"])
    #expect(companion.deletionOperation?.status == .failed)
    #expect(companion.deletionOperation?.error?.message == "Deletion could not complete.")
}

@Test
func companionAccessKeepsEditorsEditableAndViewersReadOnly() throws {
    #expect(CompanionAccess.editor.canEditCompanionSettings)
    #expect(!CompanionAccess.editor.canDeleteCompanion)
    #expect(!CompanionAccess.viewer.canEditCompanionSettings)
    #expect(!CompanionAccess.viewer.canDeleteCompanion)

    let data = Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"claude-sonnet",
      "access":"future_role",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{"state":"running","replying":false,"last_error":null}
    }
    """#.utf8)
    let companion = try JSONDecoder().decode(CompanionSummary.self, from: data)
    #expect(companion.access == .viewer)
    #expect(!companion.access.canEditCompanionSettings)
    #expect(!companion.access.canDeleteCompanion)
}

@Test
func loadsConnectedResourcesFromTheSharedFirstPartyRoutes() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ConnectedResourcesMockURLProtocol.self]
    ConnectedResourcesMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        #expect(request.httpMethod == "GET")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-1")
        let data: Data
        switch requestURL.path {
        case "/v1/skills":
            let components = try #require(URLComponents(url: requestURL, resolvingAgainstBaseURL: false))
            #expect(components.queryItems == [URLQueryItem(name: "lib", value: "accessible")])
            data = Data(#"""
            [
              {"id":"11111111-1111-4111-8111-111111111111","slug":"incident-summary","description":"Summarizes incidents.","display":{"name":"Incident Summary"}},
              {"id":"99999999-9999-4999-8999-999999999999","slug":"not-selected","description":"Not connected."}
            ]
            """#.utf8)
        case "/v1/companions/companion-1/routines":
            data = Data(#"""
            {"routines":[{
              "id":"33333333-3333-4333-8333-333333333333",
              "name":"Weekday brief",
              "cron":"0 9 * * 1-5",
              "timezone":"America/New_York",
              "enabled":true,
              "next_fire_at":"2026-08-27T13:00:00.000Z",
              "last_error_message":null
            }]}
            """#.utf8)
        case "/v1/companions/companion-1/triggers":
            data = Data(#"""
            {"triggers":[{
              "id":"44444444-4444-4444-8444-444444444444",
              "name":"Pull request opened",
              "prompt":"Summarize the pull request.",
              "provider":"github",
              "registration_status":"registered",
              "enabled":false,
              "last_error_message":null
            }]}
            """#.utf8)
        default:
            Issue.record("Unexpected connected-resources route: \(requestURL.absoluteString)")
            data = Data()
        }
        let response = try #require(HTTPURLResponse(
            url: requestURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Cache-Control": "private, no-store"]
        ))
        return (response, data)
    }
    defer { ConnectedResourcesMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "stan@example.com", name: "Stan")
    ))

    let resources = try await client.connectedResources(
        companionID: "companion-1",
        selectedSkillIDs: [
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
        ]
    )

    #expect(resources.skills.map(\.slug) == ["incident-summary"])
    #expect(resources.skills.map(\.displayName) == ["Incident Summary"])
    #expect(resources.hiddenSkillCount == 1)
    #expect(resources.routines.first?.scheduleDescription == "Weekdays at 09:00")
    #expect(resources.routines.first?.status == .active)
    #expect(resources.triggers.first?.prompt == "Summarize the pull request.")
    #expect(resources.triggers.first?.providerName == "GitHub")
    #expect(resources.triggers.first?.registrationDescription == "Webhook registered")
    #expect(resources.triggers.first?.status == .disabled)
}

@Test
func humanizesCommonRoutineSchedules() throws {
    let examples = [
        ("*/15 * * * *", "Every 15 minutes"),
        ("0 * * * *", "Every hour"),
        ("30 14 * * *", "Every day at 14:30"),
        ("0 9 * * 1-5", "Weekdays at 09:00"),
        ("0 8 1 * *", "Custom schedule"),
    ]
    for (cron, expected) in examples {
        let data = Data(#"""
        {
          "id":"33333333-3333-4333-8333-333333333333",
          "name":"Schedule",
          "cron":"\#(cron)",
          "timezone":"UTC",
          "enabled":true,
          "next_fire_at":null,
          "last_error_message":null
        }
        """#.utf8)
        let routine = try JSONDecoder().decode(CompanionRoutine.self, from: data)
        #expect(routine.scheduleDescription == expected)
    }
}

@Test
func settingsUpdatePreservesTheRosterMessageProjection() throws {
    let previous = try JSONDecoder().decode(CompanionSummary.self, from: Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":"Keep releases calm",
      "model_id":"claude-sonnet",
      "access":"owner",
      "hidden":false,
      "unread":true,
      "last_message":{"preview":"Release notes are ready.","role":"assistant","created_at":"2026-08-25T08:00:00.000Z"},
      "runtime":{"state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"]}
    }
    """#.utf8))
    let response = try JSONDecoder().decode(CompanionSummary.self, from: Data(#"""
    {
      "id":"companion-1",
      "name":"Luna Prime",
      "persona":null,
      "model_id":"claude-sonnet",
      "access":"owner",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{"state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"]}
    }
    """#.utf8))

    let updated = response.preservingListProjection(from: previous)
    #expect(updated.name == "Luna Prime")
    #expect(updated.lastMessage == previous.lastMessage)
}

@Test
func rosterRemovesACompanionOptimisticallyAndRestoresItsPositionAfterFailure() throws {
    let luna = try rosterCompanion(id: "companion-1", name: "Luna")
    let nova = try rosterCompanion(id: "companion-2", name: "Nova")
    var roster = CompanionRosterState(companions: [luna, nova])

    let removed = roster.removeOptimistically(companionID: luna.id)

    #expect(removed == luna)
    #expect(roster.companions.map(\.id) == [nova.id])

    let restored = roster.restoreDeletion(companionID: luna.id)

    #expect(restored == luna)
    #expect(roster.companions.map(\.id) == [luna.id, nova.id])
}

@Test
func rosterKeepsAnAcceptedDeletionRemovedUntilTheServerReconcilesIt() throws {
    let luna = try rosterCompanion(id: "companion-1", name: "Luna")
    let nova = try rosterCompanion(id: "companion-2", name: "Nova")
    let operation = try rosterDeletionOperation(status: "pending")
    var roster = CompanionRosterState(companions: [luna, nova])

    roster.removeOptimistically(companionID: luna.id)
    roster.reconcileDeletionResponse(companionID: luna.id, operation: operation)

    #expect(roster.companions.map(\.id) == [nova.id])
    #expect(roster.restoreDeletion(companionID: luna.id) == nil)

    roster.reconcile(with: [luna, nova])

    #expect(roster.companions.map(\.id) == [luna.id, nova.id])
}

@Test
func rosterRestoresATerminalDeletionReplayForAFreshRetry() throws {
    let luna = try rosterCompanion(id: "companion-1", name: "Luna")
    let operation = try rosterDeletionOperation(status: "failed")
    var roster = CompanionRosterState(companions: [luna])

    roster.removeOptimistically(companionID: luna.id)
    let restored = roster.reconcileDeletionResponse(companionID: luna.id, operation: operation)

    #expect(restored == luna)
    #expect(roster.companions == [luna])
}

@Test
func rosterDoesNotDuplicateACompanionThatReappearsBeforeFailureRestoration() throws {
    let luna = try rosterCompanion(id: "companion-1", name: "Luna")
    var roster = CompanionRosterState(companions: [luna])

    roster.removeOptimistically(companionID: luna.id)
    roster.reconcile(with: [luna])

    #expect(roster.restoreDeletion(companionID: luna.id) == nil)
    #expect(roster.companions == [luna])
}

@Test
func rosterDoesNotRestoreACompanionAfterTheServerOmitsIt() throws {
    let luna = try rosterCompanion(id: "companion-1", name: "Luna")
    let nova = try rosterCompanion(id: "companion-2", name: "Nova")
    var roster = CompanionRosterState(companions: [luna, nova])

    roster.removeOptimistically(companionID: luna.id)
    roster.reconcile(with: [nova])

    #expect(roster.restoreDeletion(companionID: luna.id) == nil)
    #expect(roster.companions == [nova])
}

@Test
func rosterSectionsPinnedVisibleAndHiddenCompanionsWithoutChangingServerOrder() throws {
    let earlyPin = try rosterCompanion(id: "companion-1", name: "Luna", pinned: true)
    let laterPin = try rosterCompanion(id: "companion-2", name: "Nova", pinned: true)
    let visible = try rosterCompanion(id: "companion-3", name: "Orbit")
    let hidden = try rosterCompanion(id: "companion-4", name: "Quill", hidden: true)
    let roster = CompanionRosterState(companions: [earlyPin, laterPin, visible, hidden])

    #expect(roster.sections.pinned.map(\.id) == [earlyPin.id, laterPin.id])
    #expect(roster.sections.unpinned.map(\.id) == [visible.id])
    #expect(roster.sections.hidden.map(\.id) == [hidden.id])
}

@Test
func rosterRepartitionsMemberStateResponsesUntilServerOrderingReconciles() throws {
    let pinned = try rosterCompanion(id: "companion-1", name: "Luna", pinned: true)
    let nova = try rosterCompanion(id: "companion-2", name: "Nova")
    let orbit = try rosterCompanion(id: "companion-3", name: "Orbit")
    var roster = CompanionRosterState(companions: [pinned, nova, orbit])

    let newlyPinned = try rosterCompanion(id: nova.id, name: nova.name, pinned: true)
    let replacedPinned = roster.replaceAndRepartition(newlyPinned)
    #expect(replacedPinned)
    #expect(roster.companions.map(\.id) == [pinned.id, nova.id, orbit.id])

    let newlyHidden = try rosterCompanion(id: pinned.id, name: pinned.name, hidden: true)
    let replacedHidden = roster.replaceAndRepartition(newlyHidden)
    #expect(replacedHidden)
    #expect(roster.companions.map(\.id) == [nova.id, orbit.id, pinned.id])
    #expect(roster.sections.hidden.map(\.id) == [pinned.id])
}

@Test
func rosterKeepsOrderForUnreadOnlyMemberStateResponses() throws {
    let luna = try rosterCompanion(id: "companion-1", name: "Luna")
    let nova = try rosterCompanion(id: "companion-2", name: "Nova")
    var roster = CompanionRosterState(companions: [luna, nova])

    let unreadLuna = try rosterCompanion(id: luna.id, name: luna.name, unread: true)
    let replacedUnread = roster.replaceAndRepartition(unreadLuna)
    #expect(replacedUnread)
    #expect(roster.companions.map(\.id) == [luna.id, nova.id])
    #expect(roster.companions.first?.unread == true)
}

private func rosterCompanion(
    id: String,
    name: String,
    pinned: Bool = false,
    hidden: Bool = false,
    unread: Bool = false
) throws -> CompanionSummary {
    try JSONDecoder().decode(CompanionSummary.self, from: Data(#"""
    {
      "id":"\#(id)",
      "name":"\#(name)",
      "persona":null,
      "model_id":"claude-sonnet",
      "access":"owner",
      "pinned":\#(pinned),
      "hidden":\#(hidden),
      "unread":\#(unread),
      "last_message":null,
      "runtime":{"state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"]}
    }
    """#.utf8))
}

private func rosterDeletionOperation(status: String) throws -> CompanionOperationSummary {
    try JSONDecoder().decode(CompanionOperationSummary.self, from: Data(#"""
    {
      "id":"operation-1",
      "kind":"delete",
      "status":"\#(status)",
      "error":null
    }
    """#.utf8))
}

@Test
func resourceScreenReconcilesParentRuntimeWithoutHidingFreshWork() throws {
    let active = try JSONDecoder().decode(CompanionSummary.self, from: Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"claude-sonnet",
      "access":"owner",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{
        "state":"running",
        "daemon_state":"running",
        "replying":false,
        "last_error":null,
        "provider_ids":["anthropic"],
        "latest_operation":{
          "id":"14757274-8d64-455c-a394-334665a258f0",
          "source_turn_id":null,
          "kind":"restart_box",
          "status":"pending",
          "error":null
        }
      }
    }
    """#.utf8))
    let stale = try JSONDecoder().decode(CompanionSummary.self, from: Data(#"""
    {
      "id":"companion-1",
      "name":"Luna",
      "persona":null,
      "model_id":"claude-sonnet",
      "access":"owner",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{
        "state":"running",
        "daemon_state":"running",
        "replying":false,
        "last_error":null,
        "provider_ids":["anthropic"],
        "latest_operation":null
      }
    }
    """#.utf8))
    let protected = stale.reconcilingParentProjection(from: active)
    #expect(protected.runtime.latestOperation?.status == .pending)

    let fresh = active.reconcilingParentProjection(from: stale)
    #expect(fresh.runtime.latestOperation?.status == .pending)
}

@Test
func usesCompanionPluginSelectionAndRuntimeLifecycleRoutes() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [RuntimeManagementMockURLProtocol.self]
    let companionID = "c96ab360-00f3-4497-a51a-51442db8add1"
    let selectedIDs = [
        "b4d8a690-32d2-4dff-b6e0-3f742c056f95",
        "c5e9b7a1-43e3-4eff-c7f1-4a853d1670a6",
    ]
    let summaryData = Data(#"""
    {"companion":{
      "id":"c96ab360-00f3-4497-a51a-51442db8add1",
      "name":"Luna",
      "persona":"Keep releases calm",
      "model_id":"claude-sonnet",
      "selected_mcp_account_ids":["b4d8a690-32d2-4dff-b6e0-3f742c056f95","c5e9b7a1-43e3-4eff-c7f1-4a853d1670a6"],
      "access":"owner",
      "hidden":false,
      "unread":false,
      "last_message":null,
      "runtime":{"state":"running","daemon_state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"]}
    }}
    """#.utf8)
    RuntimeManagementMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        let response: HTTPURLResponse
        let data: Data
        switch (requestURL.path, request.httpMethod) {
        case ("/v1/companions/\(companionID)", "PATCH"):
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(Set(json.keys) == Set(["selected_mcp_account_ids"]))
            #expect(json["selected_mcp_account_ids"] as? [String] == selectedIDs)
            response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            data = summaryData

        case ("/v1/companions/\(companionID)/runtime", "GET"):
            #expect(request.httpBody == nil)
            response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            data = summaryData

        case ("/v1/companions/\(companionID)/runtime/restart", "POST"):
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
            let target = try #require(json["target"])
            #expect(Set(json.keys) == Set(["target"]))
            #expect(target == "pi" || target == "box")
            let expectedRequestID = target == "pi"
                ? "14f2690b-9e55-4d45-9d0c-3f9e20bc4888"
                : "25f3701c-af66-4e56-ae1d-4a0f31cd5999"
            #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == expectedRequestID)
            let operationKind = target == "pi" ? "restart_pi" : "restart_box"
            response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 202,
                httpVersion: nil,
                headerFields: nil
            ))
            data = Data(#"{"operation":{"id":"14757274-8d64-455c-a394-334665a258f0","source_turn_id":null,"kind":"\#(operationKind)","status":"pending","error":null}}"#.utf8)

        default:
            Issue.record("Unexpected Companion management route: \(requestURL.absoluteString)")
            response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            ))
            data = Data()
        }
        return (response, data)
    }
    defer { RuntimeManagementMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "stan@example.com", name: "Stan")
    ))

    let updated = try await client.updateCompanionPluginSelection(
        companionID: companionID,
        selectedMCPAccountIDs: selectedIDs
    )
    #expect(updated.selectedMCPAccountIDs == selectedIDs)
    #expect(updated.runtime.daemonState == .running)

    let runtime = try await client.companionRuntime(companionID: companionID)
    #expect(runtime.selectedMCPAccountIDs == selectedIDs)
    #expect(runtime.runtime.daemonState == .running)

    let piRequestID = try #require(UUID(uuidString: "14f2690b-9e55-4d45-9d0c-3f9e20bc4888"))
    let piOperation = try await client.restartCompanion(
        companionID: companionID,
        target: .pi,
        requestID: piRequestID
    )
    #expect(piOperation.kind == .restartPi)
    #expect(piOperation.status == .pending)

    let boxRequestID = try #require(UUID(uuidString: "25f3701c-af66-4e56-ae1d-4a0f31cd5999"))
    let boxOperation = try await client.restartCompanion(
        companionID: companionID,
        target: .box,
        requestID: boxRequestID
    )
    #expect(boxOperation.kind == .restartBox)
    #expect(boxOperation.status == .pending)
}

@Test
func decodesViewerAndAuthorIdentityForSharedThreads() throws {
    let data = Data(#"""
    {
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "viewer_id":"viewer-1",
      "read_only":false,
      "can_send":true,
      "transcription_available":true,
      "entries":[{
        "event_id":"msg:17f8b827-8a06-4ef8-9352-58cc03c849a4",
        "ordinal":1,
        "role":"user",
        "content":"Shared update",
        "author_id":"editor-2",
        "author_name":"Morgan",
        "queued":false,
        "created_at":"2026-08-24T11:00:00.000Z"
      }],
      "queued_count":0
    }
    """#.utf8)
    let thread = try JSONDecoder().decode(CompanionThread.self, from: data)
    #expect(thread.viewerID == "viewer-1")
    #expect(thread.transcriptionAvailable == true)
    #expect(thread.entries.first?.authorID == "editor-2")
    #expect(thread.entries.first?.authorName == "Morgan")
    #expect(thread.entries.first?.attachments == [])
    #expect(thread.activeTurn == nil)
}

@Test
func decodesAssistantReasoningAndPreservesLegacyTranscriptEntries() throws {
    func decodeEntry(reasoningJSON: String?) throws -> TranscriptEntry {
        let reasoningField = reasoningJSON.map { "\"reasoning\":\($0),\n      " } ?? ""
        let data = Data("""
        {
          "event_id":"msg:reasoning-1",
          "ordinal":1,
          "role":"assistant",
          "content":"The answer is ready.",
          \(reasoningField)"queued":false,
          "created_at":"2026-08-24T11:00:00.000Z"
        }
        """.utf8)
        return try JSONDecoder().decode(TranscriptEntry.self, from: data)
    }

    let present = try decodeEntry(reasoningJSON: "\"Reviewing the transcript contract.\"")
    let missing = try decodeEntry(reasoningJSON: nil)
    let null = try decodeEntry(reasoningJSON: "null")

    #expect(present.reasoning == "Reviewing the transcript contract.")
    #expect(missing.reasoning == nil)
    #expect(null.reasoning == nil)
}

@Test
func decodesRoutineNotifyGroupAndHiddenEntries() throws {
    let entry = try JSONDecoder().decode(TranscriptEntry.self, from: Data(#"""
    {
      "event_id":"routine-return:latest",
      "ordinal":4,
      "role":"assistant",
      "content":"The latest update is ready.",
      "routine_notify_group":{
        "routine_name":"Skills Hub",
        "total_count":2,
        "hidden_entries":[
          {
            "event_id":"msg:routine-old",
            "ordinal":1,
            "role":"user",
            "content":"Check for updates.",
            "author_id":"owner-1",
            "author_name":"Owner",
            "routine":{
              "id":"11111111-1111-4111-8111-111111111111",
              "name":"Skills Hub",
              "run_id":"22222222-2222-4222-8222-222222222222"
            },
            "turn_id":"22222222-2222-4222-8222-222222222222",
            "queued":false,
            "attachments":[],
            "created_at":"2026-08-27T12:00:00.000Z"
          },
          {
            "event_id":"routine-return:old",
            "ordinal":2,
            "role":"assistant",
            "content":"The previous update is ready.",
            "queued":false,
            "attachments":[],
            "created_at":"2026-08-27T12:00:01.000Z"
          }
        ]
      },
      "queued":false,
      "attachments":[],
      "created_at":"2026-08-28T12:00:01.000Z"
    }
    """#.utf8))

    let group = try #require(entry.routineNotifyGroup)
    #expect(group.routineName == "Skills Hub")
    #expect(group.totalCount == 2)
    #expect(group.hiddenEntries.map(\.eventID) == ["msg:routine-old", "routine-return:old"])
    #expect(group.hiddenEntries.first?.routine?.runID == "22222222-2222-4222-8222-222222222222")
    #expect(group.hiddenEntries.allSatisfy { $0.routineNotifyGroup == nil })
}

@Test
func routineNotifyDisplayExpansionIsDeterministicAndKeepsLatestMarkerInOrder() throws {
    func payload(
        eventID: String,
        ordinal: Int,
        role: String,
        content: String,
        routine: [String: Any]? = nil,
        routineNotifyGroup: [String: Any]? = nil
    ) -> [String: Any] {
        [
            "event_id": eventID,
            "ordinal": ordinal,
            "role": role,
            "content": content,
            "author_id": NSNull(),
            "author_name": NSNull(),
            "routine": routine ?? NSNull(),
            "routine_notify_group": routineNotifyGroup ?? NSNull(),
            "queued": false,
            "attachments": [],
            "created_at": "2026-08-28T12:00:00.000Z",
        ]
    }

    let routine: [String: Any] = [
        "id": "11111111-1111-4111-8111-111111111111",
        "name": "Morning check",
        "run_id": "22222222-2222-4222-8222-222222222222",
    ]
    let oldMarker = payload(
        eventID: "marker-old",
        ordinal: 1,
        role: "user",
        content: "",
        routine: routine
    )
    let oldUpdate = payload(
        eventID: "update-old",
        ordinal: 2,
        role: "assistant",
        content: "Older update"
    )
    let latestMarker = payload(
        eventID: "marker-latest",
        ordinal: 3,
        role: "user",
        content: "",
        routine: routine
    )
    let group: [String: Any] = [
        "routine_name": "Morning check",
        "total_count": 2,
        "hidden_entries": [oldMarker, oldUpdate],
    ]
    let latestUpdate = payload(
        eventID: "update-latest",
        ordinal: 4,
        role: "assistant",
        content: "Latest update",
        routineNotifyGroup: group
    )
    let entries = try [
        payload(eventID: "before", ordinal: 0, role: "assistant", content: "Before routine"),
        latestMarker,
        latestUpdate,
    ].map { try JSONDecoder().decode(
        TranscriptEntry.self,
        from: JSONSerialization.data(withJSONObject: $0)
    ) }

    let collapsed = CompanionTranscriptProjection.displayItems(from: entries)
    #expect(collapsed.map(\.id) == [
        "before",
        "routine-notify.update-latest.disclosure",
        "marker-latest",
        "update-latest",
    ])
    guard case let .routineNotifyDisclosure(name, totalCount, latestEventID) = collapsed[1].kind else {
        Issue.record("Expected a routine notify disclosure")
        return
    }
    #expect(name == "Morning check")
    #expect(totalCount == 2)
    #expect(latestEventID == "update-latest")

    let expanded = CompanionTranscriptProjection.displayItems(
        from: entries,
        expandedRoutineNotifyEventIDs: ["update-latest"]
    )
    #expect(expanded.map(\.id) == [
        "before",
        "routine-notify.update-latest.disclosure",
        "routine-notify.update-latest.hidden.0.marker-old",
        "routine-notify.update-latest.hidden.1.update-old",
        "marker-latest",
        "update-latest",
    ])
    #expect(expanded.compactMap { $0.transcriptEntry?.eventID } == [
        "before", "marker-old", "update-old", "marker-latest", "update-latest",
    ])
    #expect(expanded == CompanionTranscriptProjection.displayItems(
        from: entries,
        expandedRoutineNotifyEventIDs: ["update-latest"]
    ))
}

@Test
func decodesActiveTurnAndTranscriptTurnIdentity() throws {
    let data = Data(#"""
    {
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "viewer_id":"owner-1",
      "read_only":false,
      "can_send":true,
      "entries":[{
        "event_id":"msg:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "ordinal":1,
        "role":"user",
        "content":"Please continue",
        "turn_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "queued":false,
        "created_at":"2026-08-26T06:00:00.000Z"
      }],
      "active_turn":{
        "id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
        "client_message_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "status":"running",
        "queue_sequence":20,
        "latest_attempt":{
          "id":"cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          "turn_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "attempt_number":1,
          "retry_id":null,
          "status":"running",
          "dispatch_state":"accepted",
          "pi_invocation_id":"pi-invocation-1",
          "dispatch_accepted_at":"2026-08-26T06:00:01.000Z",
          "error":null,
          "started_at":"2026-08-26T06:00:00.000Z",
          "settled_at":null
        },
        "replying":true,
        "error":null,
        "state_changed_at":"2026-08-26T06:00:00.000Z",
        "settled_at":null,
        "created_at":"2026-08-26T06:00:00.000Z",
        "updated_at":"2026-08-26T06:00:00.000Z"
      },
      "queued_count":0,
      "interrupted_turn":null
    }
    """#.utf8)

    let thread = try JSONDecoder().decode(CompanionThread.self, from: data)
    #expect(thread.activeTurn?.id == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
    #expect(thread.activeTurn?.replying == true)
    #expect(thread.activeTurn?.latestAttempt?.id == "cccccccc-cccc-4ccc-8ccc-cccccccccccc")
    #expect(thread.entries.first?.turnID == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}

@Test
func decodesAttachmentMetadataWithoutAStorageURL() throws {
    let entry = try JSONDecoder().decode(TranscriptEntry.self, from: Data(#"""
    {
      "event_id":"msg:17f8b827-8a06-4ef8-9352-58cc03c849a4",
      "ordinal":1,
      "role":"user",
      "content":"Look at this",
      "author_id":"editor-2",
      "author_name":"Morgan",
      "queued":false,
      "attachments":[{
        "id":"7c1f0b52-8a2e-4c3d-9f10-0b1c2d3e4f50",
        "kind":"user_upload",
        "content_type":"image/png",
        "byte_size":2048,
        "filename":"Q3_chart.PNG",
        "position":0
      }],
      "created_at":"2026-08-24T11:00:00.000Z"
    }
    """#.utf8))
    let attachment = try #require(entry.attachments.first)
    #expect(attachment.kind == .userUpload)
    #expect(attachment.contentType == .png)
    #expect(attachment.byteSize == 2_048)
    #expect(attachment.filename == "Q3_chart.PNG")
}

@Test
func decodesQueuedTurnIdentityForExistingCancelRoute() throws {
    let entry = try JSONDecoder().decode(TranscriptEntry.self, from: Data(#"""
    {
      "event_id":"msg:17f8b827-8a06-4ef8-9352-58cc03c849a4",
      "ordinal":9,
      "role":"user",
      "content":"Review these screenshots next",
      "author_id":"owner-1",
      "author_name":"Stan",
      "turn_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "queued":true,
      "attachments":[],
      "created_at":"2026-08-26T11:00:00.000Z"
    }
    """#.utf8))

    #expect(entry.queued)
    #expect(entry.turnID == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}

@Test
func validatesAttachmentsFromBytesBeforeUpload() throws {
    let png = try CompanionMessageAttachment(
        id: try #require(UUID(uuidString: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")),
        data: Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
        filename: "photo",
        declaredContentType: "application/octet-stream"
    )
    #expect(png.contentType == .png)
    #expect(png.filename == "photo.png")

    #expect(throws: CompanionMessageAttachmentError.unsupportedType) {
        try CompanionMessageAttachment(
            data: Data("not a png".utf8),
            filename: "fake.png",
            declaredContentType: "image/png"
        )
    }
    #expect(throws: CompanionMessageAttachmentError.unsupportedType) {
        try CompanionMessageAttachment(
            data: Data([0x61, 0x00, 0x62]),
            filename: "bad.txt",
            declaredContentType: "text/plain"
        )
    }
    #expect(throws: CompanionMessageAttachmentError.tooLarge) {
        try CompanionMessageAttachment(
            data: Data(repeating: 0x61, count: companionAttachmentMaximumBytes + 1),
            filename: "large.txt",
            declaredContentType: "text/plain"
        )
    }
    #expect(CompanionMessageAttachmentError.tooMany.localizedDescription == "You can attach up to five files.")
}

@Test
func sendsAttachmentsAsRepeatedMultipartFilePartsAndReadsThemWithAuthority() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AttachmentMockURLProtocol.self]
    let messageID = try #require(UUID(uuidString: "17f8b827-8a06-4ef8-9352-58cc03c849a4"))
    let pngBytes = Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
    let files = [
        try CompanionMessageAttachment(data: pngBytes, filename: "Q3 chart.PNG"),
        try CompanionMessageAttachment(
            data: Data("a,b\n1,2\n".utf8),
            filename: "rows.csv",
            declaredContentType: "text/csv"
        ),
    ]
    let progress = UploadProgressRecorder()
    AttachmentMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=session")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-1")
        if request.httpMethod == "POST" {
            #expect(requestURL.path == "/v1/companions/companion-1/messages")
            let contentType = try #require(request.value(forHTTPHeaderField: "Content-Type"))
            #expect(contentType.hasPrefix("multipart/form-data; boundary=CompanionBoundary-"))
            let body = try requestBody(request)
            let text = try #require(String(data: body, encoding: .isoLatin1))
            #expect(text.contains("name=\"content\"\r\n\r\nLook at these"))
            #expect(text.contains("name=\"client_message_id\"\r\n\r\n17f8b827-8a06-4ef8-9352-58cc03c849a4"))
            #expect(text.components(separatedBy: "name=\"file\"").count - 1 == 2)
            #expect(text.contains("filename=\"Q3 chart.PNG\""))
            #expect(text.contains("Content-Type: image/png"))
            #expect(text.contains("Content-Type: text/csv"))
            let response = try #require(HTTPURLResponse(
                url: requestURL, statusCode: 202, httpVersion: nil, headerFields: nil
            ))
            return (response, Data(#"{"turn":{"id":"turn-1"}}"#.utf8))
        }
        #expect(request.httpMethod == "GET")
        #expect(requestURL.path == "/v1/companions/companion-1/attachments/attachment-1")
        let response = try #require(HTTPURLResponse(
            url: requestURL,
            statusCode: 200,
            httpVersion: nil,
            headerFields: ["Content-Type": "image/png"]
        ))
        return (response, pngBytes)
    }
    defer { AttachmentMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "stan@example.com", name: "Stan")
    ))
    try await client.sendMessage(
        companionID: "companion-1",
        content: "Look at these",
        clientMessageID: messageID,
        attachments: files,
        uploadProgress: { progress.append($0) }
    )
    #expect(progress.snapshot().first == 0)
    #expect(progress.snapshot().last == 1)
    let downloaded = try await client.attachmentData(
        companionID: "companion-1",
        attachmentID: "attachment-1"
    )
    #expect(downloaded == pngBytes)
}

@Test
func decodesEveryCompanionDecisionKindAndProposal() throws {
    let data = Data(#"""
    {
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "viewer_id":"owner-1",
      "read_only":false,
      "can_send":true,
      "entries":[
        {
          "event_id":"decision:shell","ordinal":1,"role":"decision","content":"pnpm test",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:00.000Z",
          "decision":{"request_id":"shell-1","kind":"shell","name":"shell","title":"pnpm test","detail":"Runs the test suite","status":"pending","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T06:10:00.000Z","proposal":null}
        },
        {
          "event_id":"decision:file","ordinal":2,"role":"decision","content":"Package.swift",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:01.000Z",
          "decision":{"request_id":"file-1","kind":"file","name":"edit","title":"Package.swift","detail":null,"status":"denied","answer":null,"decided_by_id":"owner-1","decided_by_name":"Stan","decided_at":"2026-08-26T06:00:02.000Z","expires_at":"2026-08-26T06:10:00.000Z","proposal":null}
        },
        {
          "event_id":"decision:question","ordinal":3,"role":"decision","content":"Which release?",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:03.000Z",
          "decision":{"request_id":"question-1","kind":"question","name":"ask_user","title":"Which release?","detail":null,"status":"answered","answer":"The stable release","decided_by_id":"owner-1","decided_by_name":"Stan","decided_at":"2026-08-26T06:00:04.000Z","expires_at":"2026-08-26T06:10:00.000Z","proposal":null}
        },
        {
          "event_id":"decision:config","ordinal":4,"role":"decision","content":"Update configuration",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:05.000Z",
          "decision":{"request_id":"config-1","kind":"config","name":"config","title":"Update configuration","detail":null,"status":"allowed","answer":null,"decided_by_id":"owner-1","decided_by_name":"Stan","decided_at":"2026-08-26T06:00:06.000Z","expires_at":"2026-08-26T06:10:00.000Z","proposal":{"kind":"config","add_skill_ids":["11111111-1111-4111-8111-111111111111"],"remove_skill_ids":[],"attach_plugin_ids":["22222222-2222-4222-8222-222222222222"],"detach_plugin_ids":[],"model_id":"claude-sonnet","persona":null}}
        },
        {
          "event_id":"decision:routine","ordinal":5,"role":"decision","content":"Progress check",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:07.000Z",
          "decision":{"request_id":"routine-1","kind":"routine","name":"routine","title":"Progress check","detail":null,"status":"pending","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T06:10:00.000Z","proposal":{"kind":"routine","name":"conductor-progress-check","prompt":"Check progress","cron":"*/30 * * * *","timezone":"Europe/Paris"}}
        },
        {
          "event_id":"decision:trigger","ordinal":6,"role":"decision","content":"GitHub release",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:08.000Z",
          "decision":{"request_id":"trigger-1","kind":"trigger","name":"trigger","title":"GitHub release","detail":null,"status":"expired","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":"2026-08-26T06:10:00.000Z","expires_at":"2026-08-26T06:10:00.000Z","proposal":{"kind":"trigger","name":"release-watch","prompt":"Review releases","provider":"github","target":{"repo":"companion/app","events":["release"]}}}
        },
        {
          "event_id":"decision:cancelled","ordinal":7,"role":"decision","content":"Superseded question",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:09.000Z",
          "decision":{"request_id":"question-closed","kind":"question","name":"ask_user","title":"Superseded question","detail":null,"status":"cancelled","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":"2026-08-26T06:00:10.000Z","expires_at":"2026-08-26T06:10:00.000Z","proposal":null}
        }
      ],
      "queued_count":0
    }
    """#.utf8)

    let thread = try JSONDecoder().decode(CompanionThread.self, from: data)
    #expect(thread.entries.compactMap { $0.decision?.kind } == [
        .shell, .file, .question, .config, .routine, .trigger, .question,
    ])
    #expect(thread.entries[1].decision?.status == .denied)
    #expect(thread.entries[2].decision?.answer == "The stable release")
    #expect(thread.entries[6].decision?.status == .cancelled)

    guard case .config(let config) = thread.entries[3].decision?.proposal else {
        Issue.record("Expected a config proposal")
        return
    }
    #expect(config.addSkillIDs == ["11111111-1111-4111-8111-111111111111"])
    #expect(config.includesPersona)
    #expect(config.persona == nil)

    guard case .routine(let routine) = thread.entries[4].decision?.proposal else {
        Issue.record("Expected a routine proposal")
        return
    }
    #expect(routine.cron == "*/30 * * * *")
    #expect(routine.timezone == "Europe/Paris")

    guard case .trigger(let trigger) = thread.entries[5].decision?.proposal else {
        Issue.record("Expected a trigger proposal")
        return
    }
    #expect(trigger.target?.repo == "companion/app")
    #expect(trigger.target?.events == ["release"])
}

@Test
func decodesAPluginConnectionDecisionWithoutTrustingPayloadLabels() throws {
    let data = Data(#"""
    {
      "request_id":"config-connect-1",
      "kind":"config",
      "name":"config",
      "title":"Connect GitHub",
      "detail":null,
      "status":"pending",
      "answer":null,
      "decided_by_id":null,
      "decided_by_name":null,
      "decided_at":null,
      "expires_at":"2026-08-26T06:10:00.000Z",
      "proposal":{"kind":"config","connect_plugin":{"server_name":"github","reason":"Watch releases"}}
    }
    """#.utf8)

    let decision = try JSONDecoder().decode(CompanionDecision.self, from: data)
    guard case .config(let proposal) = decision.proposal else {
        Issue.record("Expected a config proposal")
        return
    }
    #expect(proposal.connectPlugin?.serverName == "github")
    #expect(proposal.connectPlugin?.reason == "Watch releases")
    #expect(proposal.addSkillIDs.isEmpty)
}

@Test
func decodesControlDecisionAndDelegationMetadata() throws {
    let data = Data(#"""
    {
      "event_id":"control:11111111-1111-4111-8111-111111111111",
      "ordinal":8,
      "role":"decision",
      "content":"",
      "author_id":null,
      "author_name":null,
      "created_at":"2026-08-31T20:00:00.000Z",
      "decision":{
        "request_id":"11111111-1111-4111-8111-111111111111",
        "kind":"control",
        "name":"grant_peer_access",
        "title":"Allow delegation to Orbit",
        "detail":null,
        "status":"allowed",
        "answer":null,
        "decided_by_id":"owner-1",
        "decided_by_name":"Stan",
        "decided_at":"2026-08-31T20:01:00.000Z",
        "expires_at":"2026-09-01T20:00:00.000Z",
        "required_access":"owner",
        "control_status":"applying",
        "proposal":{
          "kind":"control",
          "request_kind":"peer_access",
          "action":"grant_peer_access",
          "summary":"Allow delegation to Orbit",
          "payload":{"target_name":"Orbit","enabled":true}
        }
      },
      "delegation":{
        "id":"22222222-2222-4222-8222-222222222222",
        "direction":"response",
        "companion_id":"33333333-3333-4333-8333-333333333333",
        "companion_name":"Orbit",
        "response_mode":"relay",
        "status":"succeeded"
      }
    }
    """#.utf8)

    let entry = try JSONDecoder().decode(TranscriptEntry.self, from: data)
    #expect(entry.decision?.kind == .control)
    #expect(entry.decision?.requiredAccess == .owner)
    #expect(entry.decision?.controlStatus == .applying)
    guard case .control(let proposal) = entry.decision?.proposal else {
        Issue.record("Expected a control proposal")
        return
    }
    #expect(proposal.requestKind == "peer_access")
    #expect(proposal.payload["target_name"] == .string("Orbit"))
    #expect(entry.delegation?.companionName == "Orbit")
    #expect(entry.delegation?.direction == .response)
}

@Test
func keepsUnknownTranscriptAndDecisionKindsReadable() throws {
    let data = Data(#"""
    {
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "viewer_id":"viewer-1",
      "read_only":true,
      "can_send":false,
      "entries":[
        {
          "event_id":"future:1","ordinal":1,"role":"future_role","content":"Future content",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:00.000Z"
        },
        {
          "event_id":"decision:future","ordinal":2,"role":"decision","content":"Future request",
          "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:01.000Z",
          "decision":{"request_id":"future-1","kind":"future_kind","name":"future","title":"Future request","detail":null,"status":"future_status","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T06:10:00.000Z","proposal":{"kind":"future_kind","value":true}}
        }
      ],
      "queued_count":0
    }
    """#.utf8)

    let thread = try JSONDecoder().decode(CompanionThread.self, from: data)
    #expect(thread.entries[0].role == "future_role")
    #expect(thread.entries[1].decision?.kind == .unknown)
    #expect(thread.entries[1].decision?.status == .unknown)
    #expect(thread.entries[1].decision?.proposal == nil)
}

@Test
func submitsEveryCompanionDecisionActionThroughTheSharedRoute() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [DecisionMockURLProtocol.self]
    DecisionMockURLProtocol.expectedActions = [
        ["action": "allow"],
        ["action": "deny"],
        ["action": "answer", "answer": "Ship the stable release"],
    ]
    DecisionMockURLProtocol.handler = { request in
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString.contains(
            "/v1/companions/companion~one/decisions/request%2Fone"
        ) == true)
        #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=session")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-1")
        let body = try requestBody(request)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
        #expect(json == DecisionMockURLProtocol.expectedActions.removeFirst())
        let response = try #require(HTTPURLResponse(
            url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil
        ))
        let data = Data(#"{"thread":{"companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911","viewer_id":"owner-1","read_only":false,"can_send":true,"entries":[],"queued_count":0}}"#.utf8)
        return (response, data)
    }
    defer {
        DecisionMockURLProtocol.handler = nil
        DecisionMockURLProtocol.expectedActions = []
    }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "owner-1", email: "stan@example.com", name: "Stan")
    ))

    for action in [
        CompanionDecisionAction.allow,
        .deny,
        .answer("Ship the stable release"),
    ] {
        let thread = try await client.decideCompanionDecision(
            companionID: "companion~one",
            requestID: "request/one",
            action: action
        )
        #expect(thread.canSend)
    }
    #expect(DecisionMockURLProtocol.expectedActions.isEmpty)
}

@Test
func decodesInterruptedTurnAndItsSafeRecoveryAction() throws {
    let data = Data(#"""
    {
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "viewer_id":"owner-1",
      "read_only":false,
      "can_send":true,
      "entries":[],
      "queued_count":2,
      "interrupted_turn":{
        "id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
        "client_message_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "status":"interrupted",
        "queue_sequence":20,
        "latest_attempt":null,
        "replying":false,
        "error":{"code":"cold_start_deadline_exceeded","message":"The Companion did not start before its deadline.","action":"retry"},
        "state_changed_at":"2026-08-26T05:59:33.505Z",
        "settled_at":"2026-08-26T05:59:33.505Z",
        "created_at":"2026-08-26T05:55:12.466Z",
        "updated_at":"2026-08-26T05:59:33.505Z"
      }
    }
    """#.utf8)

    let thread = try JSONDecoder().decode(CompanionThread.self, from: data)
    #expect(thread.queuedCount == 2)
    #expect(thread.interruptedTurn?.status == .interrupted)
    #expect(thread.interruptedTurn?.error?.action == "retry")
    #expect(thread.interruptedTurn?.latestAttempt == nil)
}

@Test
func retriesAndCancelsInterruptedTurnsThroughSharedRoutes() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [TurnActionMockURLProtocol.self]
    let retryID = UUID(uuidString: "dddddddd-dddd-4ddd-8ddd-dddddddddddd")!
    var requestCount = 0
    TurnActionMockURLProtocol.handler = { request in
        requestCount += 1
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=session")
        #expect(request.value(forHTTPHeaderField: "x-companion-org") == "org-1")
        let response = try #require(HTTPURLResponse(
            url: request.url!, statusCode: 202, httpVersion: nil, headerFields: nil
        ))

        if requestCount == 1 {
            #expect(request.url?.absoluteString.contains(
                "/v1/companions/companion%2Fone/turns/turn%2Fone/retry"
            ) == true)
            let body = try #require(
                JSONSerialization.jsonObject(with: requestBody(request)) as? [String: String]
            )
            #expect(body == ["retry_id": retryID.uuidString.lowercased()])
            return (response, Data(#"""
            {"operation":{
              "id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
              "source_turn_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "kind":"start",
              "status":"pending",
              "error":null
            }}
            """#.utf8))
        }

        #expect(request.url?.absoluteString.contains(
            "/v1/companions/companion%2Fone/turns/turn%2Fone/cancel"
        ) == true)
        #expect(String(decoding: try requestBody(request), as: UTF8.self) == "{}")
        return (response, Data(#"""
        {
          "turn":{
            "id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
            "client_message_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "status":"cancelled","queue_sequence":20,"latest_attempt":null,"replying":false,
            "error":null,"state_changed_at":"2026-08-26T06:00:00.000Z",
            "settled_at":"2026-08-26T06:00:00.000Z","created_at":"2026-08-26T05:55:12.466Z",
            "updated_at":"2026-08-26T06:00:00.000Z"
          },
          "thread":{
            "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
            "viewer_id":"owner-1","read_only":false,"can_send":true,"entries":[],
            "queued_count":2,"interrupted_turn":null
          }
        }
        """#.utf8))
    }
    defer { TurnActionMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "owner-1", email: "stan@example.com", name: "Stan")
    ))

    let operation = try await client.retryCompanionTurn(
        companionID: "companion/one",
        turnID: "turn/one",
        retryID: retryID
    )
    #expect(operation.status == .pending)
    #expect(operation.sourceTurnID == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")

    let thread = try await client.cancelCompanionTurn(
        companionID: "companion/one",
        turnID: "turn/one"
    )
    #expect(thread.interruptedTurn == nil)
    #expect(thread.queuedCount == 2)
    #expect(requestCount == 2)
}

@Test
func decisionResponseInvalidatesAnOlderThreadPoll() throws {
    func thread(status: String) throws -> CompanionThread {
        try JSONDecoder().decode(CompanionThread.self, from: Data(#"""
        {
          "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
          "viewer_id":"owner-1",
          "read_only":false,
          "can_send":true,
          "entries":[{
            "event_id":"decision:question","ordinal":1,"role":"decision","content":"Which release?",
            "author_id":null,"author_name":null,"queued":false,"created_at":"2026-08-26T06:00:00.000Z",
            "decision":{"request_id":"question-1","kind":"question","name":"ask_user","title":"Which release?","detail":null,"status":"\#(status)","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T06:10:00.000Z","proposal":null}
          }],
          "queued_count":0
        }
        """#.utf8))
    }

    var projection = CompanionThreadProjection(thread: try thread(status: "pending"))
    let oldPoll = projection.beginRefresh()
    projection.replaceAfterMutation(with: try thread(status: "allowed"))

    #expect(!projection.accept(try thread(status: "pending"), refresh: oldPoll))
    #expect(projection.thread?.entries.first?.decision?.status == .allowed)
}

@Test
func resettingAThreadProjectionKeepsRefreshGenerationsMonotonic() {
    var projection = CompanionThreadProjection()
    let staleRefresh = projection.beginRefresh()

    projection.reset()
    let currentRefresh = projection.beginRefresh()

    #expect(!projection.accepts(refresh: staleRefresh))
    #expect(projection.accepts(refresh: currentRefresh))
    #expect(projection.thread == nil)
}

@Test
func transcriptWindowStartsWithNewestFiftyEntries() {
    var window = CompanionTranscriptWindow()

    window.refresh(totalCount: 120)

    #expect(window.totalCount == 120)
    #expect(window.exposedCount == 50)
    #expect(window.visibleRange == (70..<120))
    #expect(window.hasEarlierEntries)
}

@Test
func transcriptWindowExpandsByFiftyUntilEverythingIsExposed() {
    var window = CompanionTranscriptWindow(totalCount: 120)

    let firstExpansion = window.loadEarlier()
    #expect(firstExpansion)
    #expect(window.exposedCount == 100)
    #expect(window.visibleRange == (20..<120))
    let secondExpansion = window.loadEarlier()
    #expect(secondExpansion)
    #expect(window.exposedCount == 120)
    #expect(window.visibleRange == (0..<120))
    #expect(!window.hasEarlierEntries)
    let exhaustedExpansion = window.loadEarlier()
    #expect(!exhaustedExpansion)
}

@Test
func transcriptWindowKeepsSmallTranscriptsFullyExposed() {
    var window = CompanionTranscriptWindow()

    window.refresh(totalCount: 12)

    #expect(window.exposedCount == 12)
    #expect(window.visibleRange == (0..<12))
    #expect(!window.hasEarlierEntries)
    let expansion = window.loadEarlier()
    #expect(!expansion)
}

@Test
func transcriptWindowRefreshGrowthPreservesExposedCount() {
    var window = CompanionTranscriptWindow(totalCount: 120)
    let expansion = window.loadEarlier()
    #expect(expansion)

    window.refresh(totalCount: 150)

    #expect(window.exposedCount == 100)
    #expect(window.visibleRange == (50..<150))
    #expect(window.hasEarlierEntries)
}

@Test
func transcriptWindowRefreshCanPreserveEntriesWhileReadingHistory() {
    var window = CompanionTranscriptWindow(totalCount: 120)

    window.refresh(totalCount: 123, preservingCurrentEntries: true)

    #expect(window.exposedCount == 53)
    #expect(window.visibleRange == (70..<123))
    #expect(window.hasEarlierEntries)
}

@Test
func transcriptWindowRevealsOlderPageAfterReplacingCachedTailWithCompleteHistory() {
    var window = CompanionTranscriptWindow(totalCount: 250)
    while window.loadEarlier() {}

    window.revealCompleteHistory(totalCount: 1_000)

    #expect(window.exposedCount == 250)
    #expect(window.visibleRange == (750..<1_000))
    #expect(window.hasEarlierEntries)
    let loadedEarlier = window.loadEarlier()
    #expect(loadedEarlier)
    #expect(window.exposedCount == 300)
    #expect(window.visibleRange == (700..<1_000))
}

@Test
func chatReadingPositionsRemainIsolatedByCompanion() {
    var store = CompanionChatReadingPositionStore()
    let luna = CompanionChatReadingPosition(
        anchorEventID: "luna-42",
        isFollowingTail: false,
        exposedEntryCount: 100,
        transcriptEntryCount: 120
    )
    let orbit = CompanionChatReadingPosition(
        anchorEventID: "orbit-80",
        isFollowingTail: true,
        exposedEntryCount: 50,
        transcriptEntryCount: 80
    )

    store.record(luna, for: "luna")
    store.record(orbit, for: "orbit")

    #expect(store.position(for: "luna") == luna)
    #expect(store.position(for: "orbit") == orbit)
    #expect(store.position(for: "new-companion") == nil)
}

@Test
func transcriptWindowRestorationKeepsSavedAnchorExposedAfterTailGrowth() {
    var window = CompanionTranscriptWindow()

    window.restore(
        totalCount: 125,
        previouslyExposedCount: 50,
        previousTotalCount: 120,
        anchorIndex: 70
    )

    #expect(window.exposedCount == 55)
    #expect(window.visibleRange == (70..<125))
    #expect(window.hasEarlierEntries)
}

@Test
func transcriptWindowRestorationExpandsFarEnoughForAnOlderSavedAnchor() {
    var window = CompanionTranscriptWindow()

    window.restore(
        totalCount: 125,
        previouslyExposedCount: 50,
        previousTotalCount: 120,
        anchorIndex: 20
    )

    #expect(window.exposedCount == 105)
    #expect(window.visibleRange == (20..<125))
}

@Test
func transcriptWindowResetStartsDisclosureOver() {
    var window = CompanionTranscriptWindow(totalCount: 120)
    let expansion = window.loadEarlier()
    #expect(expansion)

    window.reset()

    #expect(window.totalCount == 0)
    #expect(window.exposedCount == 0)
    #expect(window.visibleRange == (0..<0))
    #expect(!window.hasEarlierEntries)

    window.refresh(totalCount: 80)
    #expect(window.exposedCount == 50)
    #expect(window.visibleRange == (30..<80))
}

private func makeScrollTestEntry(
    eventID: String,
    ordinal: Int,
    content: String
) -> TranscriptEntry {
    let data = Data("""
    {
      "event_id":"\(eventID)",
      "ordinal":\(ordinal),
      "role":"assistant",
      "content":"\(content)",
      "queued":false,
      "attachments":[],
      "created_at":"2026-08-27T12:00:00.000Z"
    }
    """.utf8)
    return try! JSONDecoder().decode(TranscriptEntry.self, from: data)
}

private func makeScrollTestThread(queuedCount: Int) -> CompanionThread {
    let data = Data("""
    {
      "companion_id":"c96ab360-00f3-4497-a51a-51442db8add1",
      "viewer_id":"owner-1",
      "read_only":false,
      "can_send":true,
      "entries":[
        {"event_id":"queued","ordinal":99,"role":"user","content":"Later","queued":true,"created_at":"2026-08-27T12:02:00.000Z"},
        {"event_id":"tail","ordinal":12,"role":"assistant","content":"Tail","queued":false,"created_at":"2026-08-27T12:01:00.000Z"},
        {"event_id":"before-tail","ordinal":11,"role":"user","content":"Before","queued":false,"created_at":"2026-08-27T12:00:00.000Z"}
      ],
      "active_turn":null,
      "queued_count":\(queuedCount),
      "interrupted_turn":null
    }
    """.utf8)
    return try! JSONDecoder().decode(CompanionThread.self, from: data)
}

@Test
func scrollTailSnapshotOnlyTracksSortedVisibleTranscriptAndInterruptedPresentation() {
    let first = CompanionScrollTailSnapshot(thread: makeScrollTestThread(queuedCount: 1))
    let refreshed = CompanionScrollTailSnapshot(thread: makeScrollTestThread(queuedCount: 4))

    #expect(first.lastEntry?.eventID == "tail")
    #expect(first == refreshed)
}

@Test
func scrollCoordinatorKeepsLongThreadInitialAndStablePollsBounded() {
    var coordinator = CompanionScrollCoordinator()
    let initialTail = CompanionScrollTailSnapshot(
        lastEntry: makeScrollTestEntry(
            eventID: "long-120",
            ordinal: 120,
            content: "Long-thread message 120"
        )
    )

    let initialChanged = coordinator.observeTail(initialTail, source: .initial)
    #expect(initialChanged)
    #expect(coordinator.pendingRequest == nil)
    #expect(coordinator.issuedRequestBatchCount == 0)

    // Initial placement is declarative layout state, so geometry has no outstanding imperative
    // request to reinterpret while the long transcript is first being placed.
    _ = coordinator.observeGeometry(bottomDistance: 0, threshold: 80)
    #expect(coordinator.followState == .followingTail)
    #expect(!coordinator.isProgrammaticBottomScrollOutstanding)

    // Four-second polls with the same visible tail, including status/window refreshes, are no-ops.
    for _ in 0..<4 {
        let stableChanged = coordinator.observeTail(initialTail, source: .poll)
        let stableRequest = coordinator.takePendingRequest()
        #expect(!stableChanged)
        #expect(stableRequest == nil)
    }
    #expect(coordinator.issuedRequestBatchCount == 0)
}

@Test
func scrollCoordinatorScrollsOnceForEachRealTailRevisionAndIgnoresDuplicates() {
    var coordinator = CompanionScrollCoordinator()
    let firstTail = CompanionScrollTailSnapshot(
        lastEntry: makeScrollTestEntry(eventID: "message-1", ordinal: 1, content: "One")
    )
    let secondTail = CompanionScrollTailSnapshot(
        lastEntry: makeScrollTestEntry(eventID: "message-2", ordinal: 2, content: "Two")
    )

    _ = coordinator.observeTail(firstTail, source: .initial)
    _ = coordinator.takePendingRequest()
    _ = coordinator.observeGeometry(bottomDistance: 0, threshold: 80)

    let secondChanged = coordinator.observeTail(secondTail, source: .poll)
    #expect(secondChanged)
    #expect(coordinator.pendingRequest?.source == .poll)
    #expect(coordinator.pendingRequest?.animated == false)
    _ = coordinator.takePendingRequest()
    _ = coordinator.observeGeometry(bottomDistance: 0, threshold: 80)
    let duplicateChanged = coordinator.observeTail(secondTail, source: .poll)
    let duplicateRequest = coordinator.takePendingRequest()
    #expect(!duplicateChanged)
    #expect(duplicateRequest == nil)
    #expect(coordinator.issuedRequestBatchCount == 1)
}

@Test
func scrollCoordinatorDoesNotLoseARealTailWhenPriorBottomGeometryIsUnchanged() {
    var coordinator = CompanionScrollCoordinator()
    let firstTail = CompanionScrollTailSnapshot(
        lastEntry: makeScrollTestEntry(eventID: "message-1", ordinal: 1, content: "One")
    )
    let secondTail = CompanionScrollTailSnapshot(
        lastEntry: makeScrollTestEntry(eventID: "message-2", ordinal: 2, content: "Two")
    )

    _ = coordinator.observeTail(firstTail, source: .initial)
    coordinator.requestBottom(source: .userLatest, animated: false)
    _ = coordinator.takePendingRequest()
    #expect(coordinator.isProgrammaticBottomScrollOutstanding)

    // An already-bottom viewport is allowed to emit no geometry callback for the first request.
    // That guard protects geometry interpretation only; it must not swallow real reply content.
    let secondChanged = coordinator.observeTail(secondTail, source: .poll)
    let secondRequest = coordinator.takePendingRequest()
    #expect(secondChanged)
    #expect(secondRequest?.source == .poll)
    #expect(coordinator.issuedRequestBatchCount == 2)
}

@Test
func scrollCoordinatorDoesNotAutoFollowWhenReaderIsAwayFromTail() {
    let firstTail = CompanionScrollTailSnapshot(
        lastEntry: makeScrollTestEntry(eventID: "message-1", ordinal: 1, content: "One")
    )
    let secondTail = CompanionScrollTailSnapshot(
        lastEntry: makeScrollTestEntry(eventID: "message-2", ordinal: 2, content: "Two")
    )
    var coordinator = CompanionScrollCoordinator(
        followState: .userReading,
        lastActualTailSnapshot: firstTail
    )

    let changed = coordinator.observeTail(secondTail, source: .poll)
    #expect(changed)
    #expect(coordinator.followState == .userReading)
    #expect(coordinator.pendingRequest == nil)
    #expect(coordinator.issuedRequestBatchCount == 0)
}

@Test
func scrollCoordinatorCoalescesRestorationAndLoadEarlierByPriority() {
    var coordinator = CompanionScrollCoordinator()

    coordinator.requestBottom(source: .initial, animated: false)
    coordinator.requestEntry("older-anchor", source: .loadEarlier)
    coordinator.requestEntry("saved-anchor", source: .restoration)
    coordinator.requestEntry("newer-older-anchor", source: .loadEarlier)

    #expect(
        coordinator.pendingRequest == CompanionScrollRequest(
            destination: .entry("saved-anchor"),
            source: .restoration,
            animated: false
        )
    )
    let coalescedRequest = coordinator.takePendingRequest()
    #expect(coalescedRequest?.destination == .entry("saved-anchor"))
    #expect(coordinator.issuedRequestBatchCount == 1)
}

@Test
func scrollCoordinatorProtectsUserIntentAndReduceMotionSemantics() {
    var coordinator = CompanionScrollCoordinator(followState: .userReading)

    coordinator.requestBottom(source: .userLatest, animated: false)
    #expect(coordinator.followState == .followingTail)
    let latestRequest = coordinator.takePendingRequest()
    #expect(latestRequest?.animated == false)

    // Intermediate geometry cannot reinterpret the programmatic request as user scrolling.
    let intermediateChanged = coordinator.observeGeometry(bottomDistance: 480, threshold: 80)
    #expect(!intermediateChanged)
    #expect(coordinator.followState == .followingTail)
    let settledChanged = coordinator.observeGeometry(bottomDistance: 0, threshold: 80)
    #expect(!settledChanged)
    #expect(!coordinator.isProgrammaticBottomScrollOutstanding)

    let readerMoved = coordinator.observeGeometry(bottomDistance: 480, threshold: 80)
    #expect(readerMoved)
    #expect(coordinator.followState == .userReading)
}

@Test
func scrollCoordinatorLetsUserInteractionInterruptProgrammaticFollow() {
    var coordinator = CompanionScrollCoordinator(followState: .userReading)

    coordinator.requestBottom(source: .userLatest, animated: true)
    _ = coordinator.takePendingRequest()
    #expect(coordinator.isProgrammaticBottomScrollOutstanding)

    let interactionChanged = coordinator.beginUserInteraction(
        bottomDistance: 480,
        threshold: 80
    )
    #expect(interactionChanged)
    #expect(coordinator.followState == .userReading)
    #expect(!coordinator.isProgrammaticBottomScrollOutstanding)
    #expect(coordinator.pendingRequest == nil)
}

@Test
func transcriptPollDiffSkipsIdenticalLongPollsAndKeepsAppendWorkBounded() throws {
    func entry(_ eventID: String, ordinal: Int, content: String = "Reply") -> TranscriptEntry {
        let payload: [String: Any] = [
            "event_id": eventID,
            "ordinal": ordinal,
            "role": "assistant",
            "content": content,
            "author_id": NSNull(),
            "author_name": NSNull(),
            "decision": NSNull(),
            "tool": NSNull(),
            "turn_id": NSNull(),
            "queued": false,
            "attachments": [Any](),
            "created_at": "2026-08-26T12:00:00.000Z",
        ]
        return try! JSONDecoder().decode(
            TranscriptEntry.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }

    let previous = (0..<200).map { index in
        entry("event-\(index)", ordinal: index)
    }
    let identical = CompanionTranscriptPollDiff(
        previous: previous,
        next: previous,
        nextVisibleRange: 150..<200
    )

    #expect(identical.isIdentical)
    #expect(identical.changedEventIDs.isEmpty)
    #expect(identical.changedVisibleEventIDs.isEmpty)
    #expect(!identical.hasVisibleChanges)

    let appendedEntry = entry("event-200", ordinal: 200)
    let appended = CompanionTranscriptPollDiff(
        previous: previous,
        next: previous + [appendedEntry],
        nextVisibleRange: 151..<201
    )

    #expect(!appended.isIdentical)
    #expect(appended.appendedEventIDs == ["event-200"])
    #expect(appended.changedEventIDs == ["event-200"])
    #expect(appended.changedVisibleEventIDs == ["event-200"])
}

@Test
func transcriptUnseenTrackerCountsOnlyDistinctAwayEvents() {
    func entry(
        _ eventID: String,
        ordinal: Int,
        content: String,
        role: String = "assistant",
        queued: Bool = false
    ) -> TranscriptEntry {
        let payload: [String: Any] = [
            "event_id": eventID,
            "ordinal": ordinal,
            "role": role,
            "content": content,
            "author_id": NSNull(),
            "author_name": NSNull(),
            "decision": NSNull(),
            "tool": NSNull(),
            "turn_id": NSNull(),
            "queued": queued,
            "attachments": [Any](),
            "created_at": "2026-08-26T12:00:00.000Z",
        ]
        return try! JSONDecoder().decode(
            TranscriptEntry.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }

    let first = entry("reply-1", ordinal: 1, content: "First")
    let second = entry("reply-2", ordinal: 2, content: "Second")
    let queued = entry("queued-1", ordinal: 3, content: "Waiting", queued: true)
    var tracker = CompanionTranscriptUnseenTracker()

    #expect(tracker.observe(entries: [first], isNearBottom: false) == 0)
    #expect(tracker.unseenEventIDs.isEmpty)

    // New data observed at the bottom establishes the latest baseline without a badge.
    #expect(tracker.observe(entries: [first, second, queued], isNearBottom: true) == 0)
    let nearBottomRevision = entry("reply-1", ordinal: 1, content: "First, extended at bottom")
    #expect(tracker.observe(entries: [nearBottomRevision, second, queued], isNearBottom: true) == 0)

    let revisedSecond = entry("reply-2", ordinal: 2, content: "Second, extended")
    #expect(tracker.observe(entries: [nearBottomRevision, revisedSecond, queued], isNearBottom: false) == 1)
    #expect(tracker.unseenEventIDs == ["reply-2"])

    // Repeated polls for the same event do not increment the distinct-ID count.
    #expect(tracker.observe(entries: [nearBottomRevision, revisedSecond, queued], isNearBottom: false) == 1)
    let third = entry("reply-3", ordinal: 4, content: "Third")
    #expect(tracker.observe(entries: [nearBottomRevision, revisedSecond, third, queued], isNearBottom: false) == 2)
    #expect(tracker.unseenEventIDs == ["reply-2", "reply-3"])
}

@Test
func transcriptUnseenTrackerCountsCompactCardRevisions() {
    func entry(
        _ eventID: String,
        ordinal: Int,
        role: String,
        toolStatus: String? = nil,
        toolDetail: String? = nil,
        decisionStatus: String? = nil
    ) -> TranscriptEntry {
        let tool: Any
        if let toolStatus {
            tool = [
                "call_id": "call-1",
                "kind": "shell",
                "name": "verify",
                "title": toolStatus == "running" ? "Verifying" : "Verified",
                "status": toolStatus,
                "detail": toolDetail
                    ?? String(repeating: "x", count: toolStatus == "running" ? 4_000 : 8_000),
                "screenshot": NSNull(),
            ] as [String: Any]
        } else {
            tool = NSNull()
        }
        let decision: Any
        if let decisionStatus {
            let decidedByID: Any = decisionStatus == "pending" ? NSNull() : "owner-1"
            let decidedByName: Any = decisionStatus == "pending" ? NSNull() : "Stan"
            let decidedAt: Any = decisionStatus == "pending"
                ? NSNull()
                : "2026-08-26T12:01:00.000Z"
            decision = [
                "request_id": "decision-1",
                "kind": "shell",
                "name": "shell",
                "title": "Run verification",
                "detail": NSNull(),
                "status": decisionStatus,
                "answer": NSNull(),
                "decided_by_id": decidedByID,
                "decided_by_name": decidedByName,
                "decided_at": decidedAt,
                "expires_at": "2026-08-26T12:10:00.000Z",
                "proposal": NSNull(),
            ] as [String: Any]
        } else {
            decision = NSNull()
        }
        let payload: [String: Any] = [
            "event_id": eventID,
            "ordinal": ordinal,
            "role": role,
            "content": "",
            "author_id": NSNull(),
            "author_name": NSNull(),
            "decision": decision,
            "tool": tool,
            "turn_id": NSNull(),
            "queued": false,
            "attachments": [Any](),
            "created_at": "2026-08-26T12:00:00.000Z",
        ]
        return try! JSONDecoder().decode(
            TranscriptEntry.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }

    let runningTool = entry("tool-1", ordinal: 1, role: "tool", toolStatus: "running")
    let pendingDecision = entry(
        "decision-1",
        ordinal: 2,
        role: "assistant",
        decisionStatus: "pending"
    )
    var tracker = CompanionTranscriptUnseenTracker()
    _ = tracker.observe(entries: [runningTool, pendingDecision], isNearBottom: true)

    let revisedRunningTool = entry(
        "tool-1",
        ordinal: 1,
        role: "tool",
        toolStatus: "running",
        toolDetail: String(repeating: "y", count: 4_000)
    )
    #expect(tracker.observe(entries: [revisedRunningTool, pendingDecision], isNearBottom: false) == 1)

    let completedTool = entry("tool-1", ordinal: 1, role: "tool", toolStatus: "ok")
    #expect(tracker.observe(entries: [completedTool, pendingDecision], isNearBottom: false) == 1)
    let answeredDecision = entry(
        "decision-1",
        ordinal: 2,
        role: "assistant",
        decisionStatus: "answered"
    )
    #expect(tracker.observe(entries: [completedTool, answeredDecision], isNearBottom: false) == 2)
    #expect(tracker.unseenEventIDs == ["tool-1", "decision-1"])

    // Unchanged compact markers remain distinct-ID stable even with large card details.
    #expect(tracker.observe(entries: [completedTool, answeredDecision], isNearBottom: false) == 2)
}

@Test
func transcriptUnseenTrackerClearsAtBottomAndResetRestoresBaseline() {
    func entry(_ eventID: String, ordinal: Int, content: String) -> TranscriptEntry {
        let payload: [String: Any] = [
            "event_id": eventID,
            "ordinal": ordinal,
            "role": "assistant",
            "content": content,
            "author_id": NSNull(),
            "author_name": NSNull(),
            "decision": NSNull(),
            "tool": NSNull(),
            "turn_id": NSNull(),
            "queued": false,
            "attachments": [Any](),
            "created_at": "2026-08-26T12:00:00.000Z",
        ]
        return try! JSONDecoder().decode(
            TranscriptEntry.self,
            from: JSONSerialization.data(withJSONObject: payload)
        )
    }

    let initial = entry("reply-1", ordinal: 1, content: "First")
    let arrival = entry("reply-2", ordinal: 2, content: "Arrival")
    var tracker = CompanionTranscriptUnseenTracker()
    _ = tracker.observe(entries: [initial], isNearBottom: true)
    #expect(tracker.observe(entries: [initial, arrival], isNearBottom: false) == 1)

    tracker.markReaderAtBottom()
    #expect(tracker.unseenCount == 0)
    #expect(tracker.unseenEventIDs.isEmpty)

    let nextArrival = entry("reply-3", ordinal: 3, content: "Next arrival")
    #expect(tracker.observe(entries: [initial, arrival, nextArrival], isNearBottom: false) == 1)
    #expect(tracker.observe(entries: [initial, arrival, nextArrival], isNearBottom: true) == 0)

    tracker.reset()
    #expect(tracker.unseenCount == 0)
    #expect(tracker.observe(entries: [initial, arrival], isNearBottom: false) == 0)
}

@Test
func threadMutationGateRejectsDoubleTapAndAllowsRetry() async {
    let gate = CompanionThreadMutationGate()
    let firstQuestion = await gate.acquire(mutationID: "decision:question-1")
    let duplicateQuestion = await gate.acquire(mutationID: "decision:question-1")
    #expect(firstQuestion)
    #expect(!duplicateQuestion)

    await gate.release(mutationID: "decision:question-1")
    let retryQuestion = await gate.acquire(mutationID: "decision:question-1")
    #expect(retryQuestion)
    await gate.release(mutationID: "decision:question-1")
}

@Test
func threadMutationGateSerializesDecisionAndCancellationSnapshots() async throws {
    let gate = CompanionThreadMutationGate()
    let secondAcquisition = AsyncBooleanProbe()
    #expect(await gate.acquire(mutationID: "decision:question-1"))

    let secondRequest = Task {
        let acquired = await gate.acquire(mutationID: "cancel:turn-2")
        await secondAcquisition.mark()
        return acquired
    }
    try await Task.sleep(for: .milliseconds(20))
    #expect(!(await secondAcquisition.read()))

    await gate.release(mutationID: "decision:question-1")
    #expect(await secondRequest.value)
    #expect(await secondAcquisition.read())
    await gate.release(mutationID: "cancel:turn-2")
}

@Test
func chatInputFocusPreservesExplicitTypingIntent() {
    var coordinator = CompanionChatInputFocusCoordinator()

    coordinator.userFocused(.composer)
    coordinator.pendingDecisionAppeared(requestID: "question-1")
    #expect(coordinator.focusedInput == .composer)
    #expect(coordinator.allowsAutomaticComposerFocus)

    coordinator.userFocused(.decision(requestID: "question-1"))
    coordinator.pendingDecisionAppeared(requestID: "question-2")
    coordinator.userBlurred(.composer)
    #expect(coordinator.focusedInput == .decision(requestID: "question-1"))
    #expect(!coordinator.allowsAutomaticComposerFocus)

    coordinator.decisionSettled(requestID: "question-2")
    #expect(coordinator.focusedInput == .decision(requestID: "question-1"))
    coordinator.decisionSettled(requestID: "question-1")
    #expect(coordinator.focusedInput == nil)
    #expect(coordinator.allowsAutomaticComposerFocus)
}

@Test
func decodesStructuredToolRunsIncludingOptionalPayloads() throws {
    let data = Data(#"""
    [
      {
        "call_id":"call-shell-1",
        "kind":"shell",
        "name":"run_command",
        "title":"pnpm test --filter CompanionKit",
        "status":"running",
        "detail":"$ pnpm test --filter CompanionKit",
        "screenshot":"data:image/png;base64,AA=="
      },
      {
        "call_id":null,
        "kind":"future_runtime_kind",
        "name":"future_tool",
        "title":"A newer runtime tool",
        "status":"ok",
        "detail":null,
        "screenshot":null
      }
    ]
    """#.utf8)

    let runs = try JSONDecoder().decode([CompanionToolRun].self, from: data)
    let shell = try #require(runs.first)
    let future = try #require(runs.last)

    #expect(shell.callID == "call-shell-1")
    #expect(shell.kind == .shell)
    #expect(shell.name == "run_command")
    #expect(shell.title == "pnpm test --filter CompanionKit")
    #expect(shell.status == .running)
    #expect(shell.detail == "$ pnpm test --filter CompanionKit")
    #expect(shell.screenshot == "data:image/png;base64,AA==")
    #expect(future.callID == nil)
    #expect(future.kind == .tool)
    #expect(future.name == "future_tool")
    #expect(future.title == "A newer runtime tool")
    #expect(future.status == .ok)
    #expect(future.detail == nil)
    #expect(future.screenshot == nil)
}

@Test
func decodesEveryStructuredToolRunStatus() throws {
    let statuses = ["running", "ok", "error", "timeout"]
    for rawStatus in statuses {
        let data = Data(#"""
        {
          "call_id":"call-status",
          "kind":"tool",
          "name":"status_tool",
          "title":"Status fixture",
          "status":"\#(rawStatus)",
          "detail":null,
          "screenshot":null
        }
        """#.utf8)
        let run = try JSONDecoder().decode(CompanionToolRun.self, from: data)
        #expect(run.status.rawValue == rawStatus)
    }
}

@Test
func preservesMaximumStructuredToolDetailAsLiteralText() throws {
    let untrusted = String(repeating: "<script>alert('literal')</script> & output\n", count: 500)
    let detail = String(untrusted.prefix(16_000))
    let data = try JSONSerialization.data(withJSONObject: [
        "call_id": "call-detail-16k",
        "kind": "computer",
        "name": "computer",
        "title": "Inspect the complete operation payload",
        "status": "ok",
        "detail": detail,
        "screenshot": "data:image/jpeg;base64,/9j/4AAQSkZJRg==",
    ])

    let run = try JSONDecoder().decode(CompanionToolRun.self, from: data)
    #expect(run.detail == detail)
    #expect(run.detail?.count == 16_000)
    #expect(run.detail?.hasPrefix("<script>") == true)
    #expect(run.screenshot == "data:image/jpeg;base64,/9j/4AAQSkZJRg==")
}

@Test
func unknownToolKindKeepsTheContainingThreadReadable() throws {
    let data = Data(#"""
    {
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "viewer_id":"viewer-1",
      "read_only":true,
      "can_send":false,
      "entries":[{
        "event_id":"tool:future-1",
        "ordinal":2,
        "role":"tool",
        "content":"",
        "author_id":null,
        "author_name":null,
        "tool":{
          "call_id":"future-call",
          "kind":"runtime_added_kind",
          "name":"future_tool",
          "title":"Future tool output",
          "status":"timeout",
          "detail":"The runtime added this family after the client shipped.",
          "screenshot":null
        },
        "queued":false,
        "created_at":"2026-08-24T11:00:00.000Z"
      }],
      "queued_count":0
    }
    """#.utf8)

    let thread = try JSONDecoder().decode(CompanionThread.self, from: data)
    #expect(thread.entries.first?.role == "tool")
    #expect(thread.entries.first?.tool?.kind == .tool)
    #expect(thread.entries.first?.tool?.status == .timeout)
}

@Test
func extractsOnlyTheSessionCookieFromAuthHeaders() throws {
    let response = try #require(HTTPURLResponse(
        url: URL(string: "http://127.0.0.1:3001/v1/auth/login")!,
        statusCode: 200,
        httpVersion: nil,
        headerFields: ["Set-Cookie": "better-auth.session_token=opaque; Path=/; HttpOnly; SameSite=Lax"]
    ))
    #expect(APIClient.sessionCookie(from: response) == "better-auth.session_token=opaque")
}

@Test
func extractsSessionCookieFromTheNativeGoogleCallback() {
    let header = "better-auth.session_token=google-session; Path=/; HttpOnly; SameSite=Lax"
    #expect(APIClient.sessionCookie(fromSetCookieHeader: header) == "better-auth.session_token=google-session")
}

@Test
func buildsTheGoogleAuthorizationProxyWithExpoState() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    MockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        switch requestURL.path {
        case "/auth/sign-in/social":
            #expect(request.value(forHTTPHeaderField: "expo-origin") == "dev.companion.mobile.dev://")
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
            let callbackURL = try #require(URL(string: json["callbackURL"] ?? ""))
            #expect(json["newUserCallbackURL"] == json["callbackURL"])
            #expect(json["errorCallbackURL"] == json["callbackURL"])
            #expect(CompanionOAuthCallbackPolicy.queryValue(
                named: CompanionOAuthCallbackPolicy.googleNativeStateQueryName,
                from: callbackURL
            ) != nil)
            let response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Set-Cookie": "better-auth.oauth_state=signed-state; Path=/; HttpOnly"]
            ))
            let data = Data(#"{"url":"https://accounts.google.com/o/oauth2/auth?state=state","redirect":true}"#.utf8)
            return (response, data)

        case "/v1/auth/whoami":
            #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=google-session")
            let response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            ))
            let data = Data(#"{"userId":"user-1","email":"stan@example.com","name":"Stan","timezone":"UTC","org":{"org_id":"org-1","name":"Workspace"},"onboarded":true,"needsOnboarding":false}"#.utf8)
            return (response, data)

        default:
            Issue.record("Unexpected Google request to \(requestURL)")
            throw APIError(status: 500, code: "unexpected_request", message: "Unexpected test request")
        }
    }
    defer { MockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    let authorization = try await client.beginGoogleSignIn(callbackScheme: "dev.companion.mobile.dev")
    #expect(authorization.nativeState.count == 64)
    let components = try #require(URLComponents(url: authorization.proxyURL, resolvingAgainstBaseURL: false))
    #expect(components.path == "/auth/expo-authorization-proxy")
    #expect(components.queryItems?.first(where: { $0.name == "oauthState" })?.value == "signed-state")
    #expect(components.queryItems?.first(where: { $0.name == "authorizationURL" })?.value?.hasPrefix("https://accounts.google.com/") == true)

    let replacement = try await client.beginGoogleSignIn(callbackScheme: "dev.companion.mobile.dev")
    #expect(replacement.nativeState != authorization.nativeState)
    await client.cancelGoogleSignIn(expectedNativeState: authorization.nativeState)
    var callbackComponents = URLComponents()
    callbackComponents.scheme = "dev.companion.mobile.dev"
    callbackComponents.queryItems = [
        URLQueryItem(name: CompanionOAuthCallbackPolicy.googleNativeStateQueryName, value: replacement.nativeState),
        URLQueryItem(name: "cookie", value: "better-auth.session_token=google-session"),
    ]
    let callbackURL = try #require(callbackComponents.url)
    let session = try await client.completeGoogleSignIn(
        callbackURL: callbackURL,
        callbackScheme: "dev.companion.mobile.dev"
    )
    #expect(session.user.id == "user-1")
}

@Test
func usesRealCompanionManagementRoutesAndRetainsProviderOAuthAuthority() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [ManagementMockURLProtocol.self]
    ManagementMockURLProtocol.deleteAttempts = 0
    ManagementMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        let response: HTTPURLResponse
        let data: Data
        switch requestURL.path {
        case "/v1/companion-providers":
            #expect(request.httpMethod == "GET")
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 200, httpVersion: nil, headerFields: nil))
            data = Data(#"{"catalog":[{"id":"anthropic","name":"Claude","auth_methods":["api_key","subscription"],"description":"Claude models","models":[{"id":"claude-sonnet","name":"Sonnet","default":true}]}],"connections":[{"provider_id":"anthropic","auth_method":"api_key","connected_by":"user-1","created_at":"2026-08-24T12:00:00.000Z","updated_at":"2026-08-24T12:00:00.000Z"}],"default_provider_id":"anthropic","can_manage":true}"#.utf8)

        case "/v1/companions":
            #expect(request.httpMethod == "POST")
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(json["name"] as? String == "Luna")
            #expect(json["provider_id"] as? String == "anthropic")
            #expect(json["model_id"] as? String == "claude-sonnet")
            #expect(json["selected_mcp_account_ids"] as? [String] == ["b4d8a690-32d2-4dff-b6e0-3f742c056f95"])
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 201, httpVersion: nil, headerFields: nil))
            data = Data(#"{"companion":{"id":"c96ab360-00f3-4497-a51a-51442db8add1","name":"Luna","persona":null,"model_id":"claude-sonnet","icon":{"shape":6,"mouth":1,"accessory":6,"color":2},"hidden":false,"unread":false,"last_message":null,"runtime":{"state":"not_created","replying":false,"last_error":null}}}"#.utf8)

        case "/v1/companions/c96ab360-00f3-4497-a51a-51442db8add1":
            if request.httpMethod == "PATCH" {
                let body = try requestBody(request)
                let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
                #expect(Set(json.keys) == Set(["name", "persona", "provider_id", "model_id", "icon"]))
                #expect(json["name"] as? String == "Luna Prime")
                #expect(json["persona"] is NSNull)
                #expect(json["selected_skill_ids"] == nil)
                #expect(json["selected_mcp_account_ids"] == nil)
                response = try #require(HTTPURLResponse(url: requestURL, statusCode: 200, httpVersion: nil, headerFields: nil))
                data = Data(#"{"companion":{"id":"c96ab360-00f3-4497-a51a-51442db8add1","name":"Luna Prime","persona":null,"model_id":"claude-sonnet","icon":{"shape":6,"mouth":1,"accessory":6,"color":2},"access":"owner","hidden":false,"unread":false,"last_message":null,"runtime":{"state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}}}"#.utf8)
            } else {
                #expect(request.httpMethod == "DELETE")
                #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "14f2690b-9e55-4d45-9d0c-3f9e20bc4888")
                ManagementMockURLProtocol.deleteAttempts += 1
                if ManagementMockURLProtocol.deleteAttempts == 1 { throw URLError(.networkConnectionLost) }
                response = try #require(HTTPURLResponse(url: requestURL, statusCode: 202, httpVersion: nil, headerFields: nil))
                data = Data(#"{"operation":{"id":"14757274-8d64-455c-a394-334665a258f0","kind":"delete","status":"pending","error":null}}"#.utf8)
            }

        case "/v1/companions/c96ab360-00f3-4497-a51a-51442db8add1/member-state":
            #expect(request.httpMethod == "PATCH")
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(json["pinned"] as? Bool == true)
            #expect(json["hidden"] == nil)
            #expect(json["unread"] == nil)
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 200, httpVersion: nil, headerFields: nil))
            data = Data(#"{"companion":{"id":"c96ab360-00f3-4497-a51a-51442db8add1","name":"Luna Prime","persona":null,"model_id":"claude-sonnet","icon":{"shape":6,"mouth":1,"accessory":6,"color":2},"access":"owner","pinned":true,"hidden":false,"unread":false,"last_message":null,"runtime":{"state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}}}"#.utf8)

        case "/v1/companions/c96ab360-00f3-4497-a51a-51442db8add1/duplicate":
            #expect(request.httpMethod == "POST")
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 201, httpVersion: nil, headerFields: nil))
            data = Data(#"{"companion":{"id":"a06a767f-2227-47d7-9e4b-b935f82cdd64","name":"Luna Prime copy","persona":null,"model_id":"claude-sonnet","icon":{"shape":6,"mouth":1,"accessory":6,"color":2},"access":"owner","pinned":false,"hidden":false,"unread":false,"last_message":null,"runtime":{"state":"not_created","replying":false,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}}}"#.utf8)

        case "/v1/companion-plugins":
            #expect(request.httpMethod == "POST")
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(json["transport"] as? String == "http")
            #expect(json["url"] as? String == "https://mcp.example.com")
            #expect(json["credential_name"] as? String == "Authorization")
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 201, httpVersion: nil, headerFields: nil))
            data = Data(#"{"account":{"id":"b4d8a690-32d2-4dff-b6e0-3f742c056f95","provider":"custom","label":"Team MCP","transport":"http","endpoint":"https://mcp.example.com","connected":true,"created_at":"2026-08-24T12:00:00.000Z","updated_at":"2026-08-24T12:00:00.000Z"}}"#.utf8)

        case "/v1/companion-plugins/oauth/start":
            #expect(request.httpMethod == "POST")
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
            #expect(json == ["server_name": "app.linear/linear", "label": "client-a"])
            response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Set-Cookie": "companion_mcp_oauth_nonce=opaque-flow; Path=/v1/companion-plugins/oauth/callback; HttpOnly"]
            ))
            data = Data(#"{"authorization_url":"https://mcp.linear.app/authorize?state=signed-state&redirect_uri=https%3A%2F%2Fthecompanion.sh%2Fv1%2Fcompanion-plugins%2Foauth%2Fcallback"}"#.utf8)

        case "/v1/companion-plugins/oauth/callback":
            #expect(request.httpMethod == "GET")
            #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=session; companion_mcp_oauth_nonce=opaque-flow")
            response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 303,
                httpVersion: nil,
                headerFields: [
                    "Location": "https://thecompanion.sh/companions?view=plugins&oauth=connected&provider=linear",
                ]
            ))
            data = Data()

        case "/v1/companion-providers/oauth/start":
            #expect(request.httpMethod == "POST")
            response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Set-Cookie": "companion_provider_oauth=signed-flow; Path=/v1/companion-providers/oauth; HttpOnly"]
            ))
            data = Data(#"{"flow":"device_code","provider_id":"openai-codex","verification_url":"https://auth.openai.com/device","user_code":"ABCD-EFGH","poll_interval_seconds":5,"expires_at":"2026-08-24T12:10:00.000Z"}"#.utf8)

        case "/v1/companion-providers/oauth/poll":
            #expect(request.httpMethod == "POST")
            let cookie = request.value(forHTTPHeaderField: "Cookie") ?? ""
            #expect(cookie.contains("better-auth.session_token=session"))
            #expect(cookie.contains("companion_provider_oauth=signed-flow"))
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 202, httpVersion: nil, headerFields: nil))
            data = Data(#"{"status":"pending"}"#.utf8)

        default:
            Issue.record("Unexpected management route: \(requestURL.path)")
            response = try #require(HTTPURLResponse(url: requestURL, statusCode: 404, httpVersion: nil, headerFields: nil))
            data = Data()
        }
        return (response, data)
    }
    defer { ManagementMockURLProtocol.handler = nil }

    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration)
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "stan@example.com", name: "Stan")
    ))

    let providers = try await client.listCompanionProviders()
    #expect(providers.defaultProviderID == "anthropic")
    #expect(providers.connectedDefinitions.map(\.id) == ["anthropic"])

    let companion = try await client.createCompanion(.init(
        name: "Luna",
        providerID: "anthropic",
        modelID: "claude-sonnet",
        selectedMCPAccountIDs: ["b4d8a690-32d2-4dff-b6e0-3f742c056f95"],
        icon: .init(shape: 6, mouth: 1, accessory: 6, color: 2)
    ))
    #expect(companion.name == "Luna")
    #expect(companion.access == .viewer)

    let updated = try await client.updateCompanion(
        companionID: companion.id,
        input: .init(
            name: "Luna Prime",
            persona: nil,
            providerID: "anthropic",
            modelID: "claude-sonnet",
            icon: .init(shape: 6, mouth: 1, accessory: 6, color: 2)
        )
    )
    #expect(updated.name == "Luna Prime")
    #expect(updated.runtime.providerIDs == ["anthropic"])

    let pinned = try await client.updateCompanionMemberState(
        companionID: companion.id,
        patch: .init(pinned: true)
    )
    #expect(pinned.pinned)

    let duplicate = try await client.duplicateCompanion(companionID: companion.id)
    #expect(duplicate.name == "Luna Prime copy")
    #expect(!duplicate.pinned)

    let deleteRequestID = try #require(UUID(uuidString: "14f2690b-9e55-4d45-9d0c-3f9e20bc4888"))
    do {
        _ = try await client.deleteCompanion(
            companionID: companion.id,
            requestID: deleteRequestID
        )
        Issue.record("Expected the first delete response to be lost")
    } catch {
        let apiError = try #require(error as? APIError)
        #expect(apiError.status == 0)
        #expect(apiError.code == "network_error")
    }
    let deleteOperation = try await client.deleteCompanion(
        companionID: companion.id,
        requestID: deleteRequestID
    )
    #expect(ManagementMockURLProtocol.deleteAttempts == 2)
    #expect(deleteOperation.kind == .delete)
    #expect(deleteOperation.status == .pending)

    let plugin = try await client.saveCompanionPlugin(.init(
        provider: "custom",
        label: "Team MCP",
        transport: .http,
        url: "https://mcp.example.com",
        credentialName: "Authorization",
        credentialValue: "Bearer secret"
    ))
    #expect(plugin.label == "Team MCP")

    let pluginOAuthStart = try await client.startCompanionPluginOAuth(
        serverName: "app.linear/linear",
        label: "client-a"
    )
    #expect(pluginOAuthStart.authorizationURL.absoluteString == "https://mcp.linear.app/authorize?state=signed-state&redirect_uri=https%3A%2F%2Fthecompanion.sh%2Fv1%2Fcompanion-plugins%2Foauth%2Fcallback")
    try await client.completeCompanionPluginOAuth(
        callbackURL: URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback?code=oauth-code&state=signed-state")!
    )

    let oauth = try await client.startCompanionProviderOAuth(providerID: "openai-codex")
    #expect(oauth.userCode == "ABCD-EFGH")
    let poll = try await client.pollCompanionProviderOAuth()
    #expect(poll.status == .pending)
}

@Test
func validatesCompanionPluginOAuthRedirectBeforeReturning() async throws {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PluginOAuthRedirectMockURLProtocol.self]
    PluginOAuthRedirectMockURLProtocol.redirectLocation = ""
    PluginOAuthRedirectMockURLProtocol.unexpectedRedirectRequests = 0
    PluginOAuthRedirectMockURLProtocol.handler = { request in
        let requestURL = try #require(request.url)
        switch requestURL.path {
        case "/v1/companion-plugins/oauth/start":
            #expect(request.httpMethod == "POST")
            let response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 200,
                httpVersion: nil,
                headerFields: [
                    "Set-Cookie": "companion_mcp_oauth_nonce=opaque-flow; Path=/v1/companion-plugins/oauth/callback; HttpOnly",
                ]
            ))
            return (response, Data(#"{"authorization_url":"\#(PluginOAuthRedirectMockURLProtocol.authorizationURL)"}"#.utf8))

        case "/v1/companion-plugins/oauth/callback":
            #expect(request.httpMethod == "GET")
            #expect(request.value(forHTTPHeaderField: "Cookie") == "better-auth.session_token=session; companion_mcp_oauth_nonce=opaque-flow")
            let response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 303,
                httpVersion: nil,
                headerFields: ["Location": PluginOAuthRedirectMockURLProtocol.redirectLocation]
            ))
            return (response, Data())

        default:
            PluginOAuthRedirectMockURLProtocol.unexpectedRedirectRequests += 1
            Issue.record("The plugin callback followed an unexpected redirect to \(requestURL)")
            let response = try #require(HTTPURLResponse(
                url: requestURL,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            ))
            return (response, Data())
        }
    }
    defer {
        PluginOAuthRedirectMockURLProtocol.handler = nil
        PluginOAuthRedirectMockURLProtocol.authorizationURL = "https://mcp.linear.app/authorize?state=signed-state&redirect_uri=https%3A%2F%2Fthecompanion.sh%2Fv1%2Fcompanion-plugins%2Foauth%2Fcallback"
        PluginOAuthRedirectMockURLProtocol.redirectLocation = ""
        PluginOAuthRedirectMockURLProtocol.unexpectedRedirectRequests = 0
    }

    let redirectRecorder = RedirectDelegateFactoryRecorder()
    let client = APIClient(
        baseURL: URL(string: "http://127.0.0.1:3001")!,
        session: URLSession(configuration: configuration),
        redirectDelegateFactory: APIClientRedirectDelegateFactory { followRedirects in
            redirectRecorder.record(followRedirects: followRedirects)
            return nil
        }
    )
    await client.setAuthority(Session(
        cookie: "better-auth.session_token=session",
        orgID: "org-1",
        needsOnboarding: false,
        user: .init(id: "user-1", email: "stan@example.com", name: "Stan")
    ))

    let callbackURL = URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback?code=oauth-code&state=signed-state")!
    let staleCallbackURL = URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback?code=old-code&state=old-state")!
    PluginOAuthRedirectMockURLProtocol.redirectLocation = "https://thecompanion.sh/companions?view=plugins&oauth=connected&provider=linear"
    _ = try await client.startCompanionPluginOAuth(serverName: "app.linear/linear", label: "client-a")
    do {
        try await client.completeCompanionPluginOAuth(callbackURL: staleCallbackURL)
        Issue.record("Expected a stale plugin callback to be rejected")
    } catch let error as APIError {
        #expect(error.code == "invalid_oauth_callback")
    }
    try await client.completeCompanionPluginOAuth(callbackURL: callbackURL)

    let cases: [(location: String, errorCode: String?)] = [
        (
            "https://thecompanion.sh/companions?view=plugins&oauth=connected&provider=linear",
            nil
        ),
        (
            "https://thecompanion.sh/companions?view=plugins&oauth_error=duplicate_label",
            "duplicate_label"
        ),
        (
            "https://evil.example/companions?view=plugins&oauth=connected",
            "invalid_oauth_redirect"
        ),
    ]

    for testCase in cases {
        PluginOAuthRedirectMockURLProtocol.redirectLocation = testCase.location
        _ = try await client.startCompanionPluginOAuth(
            serverName: "app.linear/linear",
            label: "client-a"
        )
        if let errorCode = testCase.errorCode {
            do {
                try await client.completeCompanionPluginOAuth(callbackURL: callbackURL)
                Issue.record("Expected plugin callback failure for \(testCase.location)")
            } catch let error as APIError {
                #expect(error.code == errorCode)
            }
        } else {
            try await client.completeCompanionPluginOAuth(callbackURL: callbackURL)
        }
    }

    PluginOAuthRedirectMockURLProtocol.authorizationURL = "https://mcp.linear.app/authorize?state=signed-state&redirect_uri=https%3A%2F%2Foauth.example%3A443%2Fv1%2Fcompanion-plugins%2Foauth%2Fcallback"
    let customCallbackURL = URL(string: "https://oauth.example:443/v1/companion-plugins/oauth/callback?code=oauth-code&state=signed-state")!
    let customLocations: [(location: String, errorCode: String?)] = [
        (
            "https://oauth.example/companions?view=plugins&oauth=connected&provider=linear",
            nil
        ),
        (
            "https://oauth.example:444/companions?view=plugins&oauth=connected",
            "invalid_oauth_redirect"
        ),
        (
            "http://oauth.example/companions?view=plugins&oauth=connected",
            "invalid_oauth_redirect"
        ),
        (
            "https://evil.example/companions?view=plugins&oauth=connected",
            "invalid_oauth_redirect"
        ),
    ]
    for testCase in customLocations {
        PluginOAuthRedirectMockURLProtocol.redirectLocation = testCase.location
        _ = try await client.startCompanionPluginOAuth(
            serverName: "app.linear/linear",
            label: "client-a"
        )
        if let errorCode = testCase.errorCode {
            do {
                try await client.completeCompanionPluginOAuth(callbackURL: customCallbackURL)
                Issue.record("Expected custom plugin callback failure for \(testCase.location)")
            } catch let error as APIError {
                #expect(error.code == errorCode)
            }
        } else {
            try await client.completeCompanionPluginOAuth(callbackURL: customCallbackURL)
        }
    }
    let redirectDecisions = redirectRecorder.snapshot()
    #expect(redirectDecisions.filter { !$0 }.count == cases.count + customLocations.count + 1)
    #expect(PluginOAuthRedirectMockURLProtocol.unexpectedRedirectRequests == 0)
}

@Test
func refusesCompanionPluginOAuthRedirects() throws {
    let session = URLSession(configuration: .ephemeral)
    let callbackURL = try #require(URL(string: "https://thecompanion.sh/v1/companion-plugins/oauth/callback"))
    let task = session.dataTask(with: callbackURL)
    let response = try #require(HTTPURLResponse(
        url: callbackURL,
        statusCode: 303,
        httpVersion: nil,
        headerFields: ["Location": "https://thecompanion.sh/companions?oauth=connected"]
    ))
    let delegate = NoRedirectURLSessionDelegate()
    var redirectedRequest: URLRequest?
    delegate.urlSession(
        session,
        task: task,
        willPerformHTTPRedirection: response,
        newRequest: URLRequest(url: URL(string: "https://thecompanion.sh/companions")!),
        completionHandler: { redirectedRequest = $0 }
    )
    #expect(redirectedRequest == nil)
    task.cancel()
}

@Test
func liveLocalManagementAccountWhenConfigured() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let rawURL = environment["COMPANION_IOS_MANAGEMENT_TEST_API_URL"],
          let apiURL = URL(string: rawURL),
          let email = environment["COMPANION_IOS_MANAGEMENT_TEST_EMAIL"],
          let password = environment["COMPANION_IOS_MANAGEMENT_TEST_PASSWORD"] else { return }

    let client = APIClient(baseURL: apiURL)
    let session = try await client.signIn(email: email, password: password)
    #expect(session.orgID != nil)

    let providers = try await client.listCompanionProviders()
    #expect(Set(providers.catalog.map(\.id)) == Set([
        "anthropic",
        "openai-codex",
        "kimi-coding",
        "moonshotai",
        "zai",
        "openai",
        "google",
    ]))

    let plugins = try await client.listCompanionPlugins()
    let linearLabels = plugins
        .filter { $0.provider == "linear" }
        .map(\.label)
        .sorted()
    #expect(linearLabels == ["client", "work"])
    #expect(Set(plugins.map(\.id)).count == plugins.count)
}

@Test
func liveLocalLoginRosterAndMessageWhenConfigured() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let rawURL = environment["COMPANION_IOS_E2E_API_URL"],
          let apiURL = URL(string: rawURL),
          let email = environment["COMPANION_IOS_E2E_EMAIL"],
          let password = environment["COMPANION_IOS_E2E_PASSWORD"] else { return }

    let client = APIClient(baseURL: apiURL)
    let session = try await client.signIn(email: email, password: password)
    #expect(session.orgID != nil)
    let companions = try await client.listCompanions()
    let companion = try #require(companions.first(where: { $0.name == "Zai E2E La Paz" }))
    let marker = "E2E_IOS_NATIVE_OK"
    let previousOrdinal = try await client.thread(companionID: companion.id).entries
        .map(\.ordinal)
        .max() ?? 0
    try await client.sendMessage(
        companionID: companion.id,
        content: "Réponds uniquement par \(marker)",
        clientMessageID: UUID()
    )

    for _ in 0..<45 {
        let thread = try await client.thread(companionID: companion.id)
        if thread.entries.contains(where: {
            $0.ordinal > previousOrdinal && $0.role == "assistant" && $0.content == marker
        }) {
            return
        }
        try await Task.sleep(for: .seconds(2))
    }
    Issue.record("The native API flow did not observe the expected z.ai reply.")
}
