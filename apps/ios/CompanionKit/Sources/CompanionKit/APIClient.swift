import Foundation
import Security

private final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    private let onProgress: @Sendable (Double) -> Void

    init(onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64,
        totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        onProgress(min(1, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }
}

final class NoRedirectURLSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

struct APIClientRedirectDelegateFactory: @unchecked Sendable {
    private let builder: (Bool) -> URLSessionTaskDelegate?

    init(builder: @escaping (Bool) -> URLSessionTaskDelegate?) {
        self.builder = builder
    }

    func make(followRedirects: Bool) -> URLSessionTaskDelegate? {
        builder(followRedirects)
    }

    static let production = Self { followRedirects in
        followRedirects ? nil : NoRedirectURLSessionDelegate()
    }
}

public struct APIError: Error, LocalizedError, Equatable, Sendable {
    public let status: Int
    public let code: String?
    public let message: String

    public init(status: Int, code: String?, message: String) {
        self.status = status
        self.code = code
        self.message = message
    }

    public var errorDescription: String? { message }
}

public actor APIClient {
    public struct GoogleAuthorization: Equatable, Sendable {
        public let proxyURL: URL
        public let nativeState: String

        public init(proxyURL: URL, nativeState: String) {
            self.proxyURL = proxyURL
            self.nativeState = nativeState
        }
    }

    private struct ErrorPayload: Decodable {
        let code: String?
        let error: String?
        let message: String?
    }

    private struct CompanionListEnvelope: Decodable {
        let companions: [CompanionSummary]
    }

    private struct ThreadEnvelope: Decodable {
        let thread: CompanionThread
    }

    private struct CompanionEnvelope: Decodable {
        let companion: CompanionSummary
    }

    private struct SectionListEnvelope: Decodable {
        let sections: [CompanionSection]
    }

    private struct SectionEnvelope: Decodable {
        let section: CompanionSection
    }

    private struct LifecycleEnvelope: Decodable {
        let lifecycle: CompanionLifecycleReceipt
    }

    private struct TurnThreadEnvelope: Decodable {
        let turn: CompanionTurn
        let thread: CompanionThread
    }

    private struct ProviderConnectionEnvelope: Decodable {
        let connection: CompanionProviderConnection
    }

    private struct PluginListEnvelope: Decodable {
        let accounts: [CompanionPluginAccount]
    }

    private struct PluginAccountEnvelope: Decodable {
        let account: CompanionPluginAccount
    }

    private struct TriggerProviderAccountListEnvelope: Decodable {
        let accounts: [CompanionTriggerProviderAccount]
    }

    private struct TriggerProviderAccountEnvelope: Decodable {
        let account: CompanionTriggerProviderAccount
    }

    private struct RoutineListEnvelope: Decodable {
        let routines: [CompanionRoutine]
    }

    private struct RoutineEnvelope: Decodable {
        let routine: CompanionRoutine
    }

    private struct RoutineRunListEnvelope: Decodable {
        let runs: [CompanionRoutineRunSummary]
        let nextCursor: String?

        enum CodingKeys: String, CodingKey {
            case runs
            case nextCursor = "next_cursor"
        }
    }

    private struct RoutineRunDetailEnvelope: Decodable {
        let run: CompanionRoutineRunDetail
    }

    private struct TriggerListEnvelope: Decodable {
        let triggers: [CompanionTrigger]
    }

    private struct TriggerEnvelope: Decodable {
        let trigger: CompanionTrigger
    }

    private struct TriggerRunDetailEnvelope: Decodable {
        let run: CompanionTriggerRunDetail
    }

    private struct SocialSignInResponse: Decodable {
        let url: URL
        let redirect: Bool
    }

    private enum PluginOAuthRedirect {
        case connected
        case failed(String)
    }

    private let baseURL: URL
    private let session: URLSession
    private let redirectDelegateFactory: APIClientRedirectDelegateFactory
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var authority: Session?
    private var providerOAuthCookie: String?
    private var companionPluginOAuthCookie: String?
    private var googleOAuthState: String?
    private var companionPluginOAuthState: String?
    private var companionPluginOAuthCallbackURL: URL?

    public init(
        baseURL: URL,
        session: URLSession? = nil,
        initialAuthority: Session? = nil
    ) {
        self.baseURL = baseURL
        authority = initialAuthority
        self.redirectDelegateFactory = .production
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.httpCookieAcceptPolicy = .never
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            configuration.timeoutIntervalForRequest = 30
            self.session = URLSession(configuration: configuration)
        }
    }

    init(
        baseURL: URL,
        session: URLSession? = nil,
        redirectDelegateFactory: APIClientRedirectDelegateFactory
    ) {
        self.baseURL = baseURL
        self.redirectDelegateFactory = redirectDelegateFactory
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpShouldSetCookies = false
            configuration.httpCookieAcceptPolicy = .never
            configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
            configuration.timeoutIntervalForRequest = 30
            self.session = URLSession(configuration: configuration)
        }
    }

    public func setAuthority(_ authority: Session?) {
        self.authority = authority
    }

    public func currentAuthority() -> Session? {
        authority
    }

    public func signIn(email: String, password: String) async throws -> Session {
        authority = nil
        let body = try encoder.encode([
            "email": email,
            "password": password,
            "name": email.split(separator: "@").first.map(String.init) ?? email,
        ])
        let (_, response) = try await perform(
            path: "/v1/auth/login",
            method: "POST",
            body: body,
            acceptedStatuses: 200..<300
        )
        guard let cookie = Self.sessionCookie(from: response) else {
            throw APIError(status: 500, code: "missing_session", message: "The server did not return a session.")
        }
        authority = Session(
            cookie: cookie,
            orgID: nil,
            needsOnboarding: true,
            user: .init(id: "pending", email: email, name: nil)
        )
        let identity = try await whoAmI()
        let authenticated = Session(cookie: authority?.cookie ?? cookie, identity: identity)
        authority = authenticated
        return authenticated
    }

    public func signOut() async {
        _ = try? await perform(path: "/v1/auth/logout", method: "POST", body: nil)
        authority = nil
        companionPluginOAuthCookie = nil
        googleOAuthState = nil
        companionPluginOAuthState = nil
        companionPluginOAuthCallbackURL = nil
    }

    public func beginGoogleSignIn(callbackScheme: String) async throws -> GoogleAuthorization {
        authority = nil
        let nativeState = try Self.randomOAuthState()
        googleOAuthState = nativeState
        var started = false
        defer {
            if !started { googleOAuthState = nil }
        }
        let originURL = "\(callbackScheme)://"
        let callbackURL = "\(originURL)?native_state=\(nativeState)"
        let body = try encoder.encode([
            "provider": "google",
            "callbackURL": callbackURL,
            "newUserCallbackURL": callbackURL,
            "errorCallbackURL": callbackURL,
        ])
        let (data, response) = try await perform(
            path: "/auth/sign-in/social",
            method: "POST",
            body: body,
            additionalHeaders: [
                "expo-origin": originURL,
                "x-skip-oauth-proxy": "true",
            ]
        )
        let social: SocialSignInResponse
        do {
            social = try decoder.decode(SocialSignInResponse.self, from: data)
        } catch {
            throw APIError(status: 500, code: "google_unavailable", message: "Google sign-in is unavailable.")
        }
        guard social.redirect else {
            throw APIError(status: 500, code: "google_unavailable", message: "Google sign-in is unavailable.")
        }
        var components = URLComponents(
            url: URL(string: "/auth/expo-authorization-proxy", relativeTo: baseURL)!,
            resolvingAgainstBaseURL: true
        )
        var items = [URLQueryItem(name: "authorizationURL", value: social.url.absoluteString)]
        if let oauthState = Self.cookieValue(suffix: ".oauth_state", from: response) {
            items.append(URLQueryItem(name: "oauthState", value: oauthState))
        }
        components?.queryItems = items
        guard let proxyURL = components?.url else {
            throw APIError(status: 0, code: "invalid_google_url", message: "Google sign-in could not be started.")
        }
        started = true
        return GoogleAuthorization(proxyURL: proxyURL, nativeState: nativeState)
    }

    public func completeGoogleSignIn(
        callbackURL: URL,
        callbackScheme: String
    ) async throws -> Session {
        guard let expectedNativeState = googleOAuthState,
              let setCookie = CompanionOAuthCallbackPolicy.googleCookie(
            from: callbackURL,
            callbackScheme: callbackScheme,
            expectedNativeState: expectedNativeState
        ),
              let cookie = Self.sessionCookie(fromSetCookieHeader: setCookie) else {
            throw APIError(status: 401, code: "invalid_google_callback", message: "Google did not return a session.")
        }
        defer { googleOAuthState = nil }
        authority = Session(
            cookie: cookie,
            orgID: nil,
            needsOnboarding: true,
            user: .init(id: "pending", email: "pending", name: nil)
        )
        let identity = try await whoAmI()
        let authenticated = Session(cookie: authority?.cookie ?? cookie, identity: identity)
        authority = authenticated
        return authenticated
    }

    public func cancelGoogleSignIn(expectedNativeState: String) {
        guard googleOAuthState == expectedNativeState else { return }
        googleOAuthState = nil
    }

    public func whoAmI() async throws -> WhoAmI {
        try await decode(WhoAmI.self, path: "/v1/auth/whoami")
    }

    public func userAvatarData(at pathOrURL: String) async throws -> Data {
        guard let avatarURL = URL(string: pathOrURL, relativeTo: baseURL)?.absoluteURL else {
            throw APIError(status: 0, code: "invalid_avatar_url", message: "The account photo URL is invalid.")
        }
        let request: URLRequest
        if avatarURL.scheme == baseURL.scheme && avatarURL.host == baseURL.host
            && avatarURL.port == baseURL.port {
            request = try makeRequest(
                path: pathOrURL,
                method: "GET",
                body: nil,
                timeout: 15,
                additionalHeaders: ["Accept": "image/*"]
            )
        } else {
            var publicRequest = URLRequest(url: avatarURL)
            publicRequest.timeoutInterval = 15
            publicRequest.setValue("image/*", forHTTPHeaderField: "Accept")
            request = publicRequest
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(status: (response as? HTTPURLResponse)?.statusCode ?? 0,
                           code: "avatar_unavailable",
                           message: "The account photo is unavailable.")
        }
        return data
    }

    public func updateUserProfile(
        name: String? = nil,
        timezone: String? = nil
    ) async throws -> UserProfile {
        let body = try encoder.encode(UpdateUserProfileInput(name: name, timezone: timezone))
        return try await decode(
            UserProfile.self,
            path: "/v1/users/me",
            method: "PUT",
            body: body
        )
    }

    public func listCompanions() async throws -> [CompanionSummary] {
        try await decode(CompanionListEnvelope.self, path: "/v1/companions").companions
    }

    public func synchronizeCompanionRoster(
        cursor: String?
    ) async throws -> CompanionSyncMeasurement<CompanionRosterDelta> {
        try await decodeMeasured(
            CompanionRosterDelta.self,
            path: Self.cursorPath("/v1/companions/sync", cursor: cursor)
        )
    }

    public func listCompanionSections() async throws -> [CompanionSection] {
        try await decode(SectionListEnvelope.self, path: "/v1/companion-sections").sections
    }

    public func createCompanionSection(name: String) async throws -> CompanionSection {
        let body = try encoder.encode(CompanionSectionNameInput(name: name))
        return try await decode(
            SectionEnvelope.self,
            path: "/v1/companion-sections",
            method: "POST",
            body: body
        ).section
    }

    public func updateCompanionSection(sectionID: String, name: String) async throws -> CompanionSection {
        let id = Self.encodedPathComponent(sectionID)
        let body = try encoder.encode(CompanionSectionNameInput(name: name))
        return try await decode(
            SectionEnvelope.self,
            path: "/v1/companion-sections/\(id)",
            method: "PATCH",
            body: body
        ).section
    }

    public func deleteCompanionSection(sectionID: String) async throws {
        let id = Self.encodedPathComponent(sectionID)
        _ = try await perform(path: "/v1/companion-sections/\(id)", method: "DELETE", body: nil)
    }

    public func reorderCompanionSections(sectionIDs: [String]) async throws -> [CompanionSection] {
        let body = try encoder.encode(CompanionSectionReorderInput(sectionIDs: sectionIDs))
        return try await decode(
            SectionListEnvelope.self,
            path: "/v1/companion-sections/reorder",
            method: "PUT",
            body: body
        ).sections
    }

    public func assignCompanionSection(
        companionID: String,
        sectionID: String?
    ) async throws -> CompanionSummary {
        let id = Self.encodedPathComponent(companionID)
        let body = try encoder.encode(CompanionSectionAssignmentInput(sectionID: sectionID))
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions/\(id)/section",
            method: "PUT",
            body: body
        ).companion
    }

    public func connectedResources(
        companionID: String,
        selectedSkillIDs: [String]
    ) async throws -> CompanionConnectedResources {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        async let availableSkills = decode(
            [CompanionSkillSummary].self,
            path: "/v1/skills?lib=accessible"
        )
        async let routineEnvelope = decode(
            RoutineListEnvelope.self,
            path: "/v1/companions/\(id)/routines"
        )
        async let triggerEnvelope = decode(
            TriggerListEnvelope.self,
            path: "/v1/companions/\(id)/triggers"
        )
        let (skillRows, routineResult, triggerResult) = try await (
            availableSkills,
            routineEnvelope,
            triggerEnvelope
        )

        var skillsByID: [String: CompanionSkillSummary] = [:]
        for skill in skillRows { skillsByID[skill.id] = skill }
        let skills = selectedSkillIDs.compactMap { skillsByID[$0] }
        return CompanionConnectedResources(
            skills: skills,
            hiddenSkillCount: selectedSkillIDs.count - skills.count,
            routines: routineResult.routines,
            triggers: triggerResult.triggers
        )
    }

    public func listCompanionRoutines(companionID: String) async throws -> [CompanionRoutine] {
        let companion = Self.encodedPathComponent(companionID)
        return try await decode(
            RoutineListEnvelope.self,
            path: "/v1/companions/\(companion)/routines"
        ).routines
    }

    /// Reads a bounded, newest-first routine history page. This is PostgreSQL-backed by the API
    /// and never starts or contacts the Companion runtime.
    public func listCompanionRoutineRuns(
        companionID: String,
        routineID: String,
        limit: Int = 50,
        cursor: String? = nil
    ) async throws -> CompanionRoutineRunList {
        let companion = Self.encodedPathComponent(companionID)
        let routine = Self.encodedPathComponent(routineID)
        var query = "limit=\(limit)"
        if let cursor {
            query += "&cursor=\(Self.encodedQueryComponent(cursor))"
        }
        let envelope = try await decode(
            RoutineRunListEnvelope.self,
            path: "/v1/companions/\(companion)/routines/\(routine)/runs?\(query)"
        )
        return CompanionRoutineRunList(runs: envelope.runs, nextCursor: envelope.nextCursor)
    }

    /// Reads one bounded page of the private routine transcript. Surfaced output remains in main
    /// chat; this route only returns the routine's internal entries.
    public func readCompanionRoutineRun(
        companionID: String,
        runID: String,
        entryLimit: Int = 50,
        entryCursor: Int? = nil
    ) async throws -> CompanionRoutineRunDetail {
        let companion = Self.encodedPathComponent(companionID)
        let run = Self.encodedPathComponent(runID)
        var query = "entry_limit=\(entryLimit)"
        if let entryCursor {
            query += "&entry_cursor=\(entryCursor)"
        }
        return try await decode(
            RoutineRunDetailEnvelope.self,
            path: "/v1/companions/\(companion)/routine-runs/\(run)?\(query)"
        ).run
    }

    public func listCompanionTriggers(companionID: String) async throws -> [CompanionTrigger] {
        let companion = Self.encodedPathComponent(companionID)
        return try await decode(
            TriggerListEnvelope.self,
            path: "/v1/companions/\(companion)/triggers"
        ).triggers
    }

    public func createCompanionRoutine(
        companionID: String,
        input: CreateCompanionRoutineInput
    ) async throws -> CompanionRoutine {
        let companion = Self.encodedPathComponent(companionID)
        let body = try encoder.encode(input)
        return try await decode(
            RoutineEnvelope.self,
            path: "/v1/companions/\(companion)/routines",
            method: "POST",
            body: body
        ).routine
    }

    public func updateCompanionRoutine(
        companionID: String,
        routineID: String,
        input: UpdateCompanionRoutineInput
    ) async throws -> CompanionRoutine {
        let companion = Self.encodedPathComponent(companionID)
        let routine = Self.encodedPathComponent(routineID)
        let body = try encoder.encode(input)
        return try await decode(
            RoutineEnvelope.self,
            path: "/v1/companions/\(companion)/routines/\(routine)",
            method: "PATCH",
            body: body
        ).routine
    }

    public func deleteCompanionRoutine(
        companionID: String,
        routineID: String
    ) async throws {
        let companion = Self.encodedPathComponent(companionID)
        let routine = Self.encodedPathComponent(routineID)
        _ = try await perform(
            path: "/v1/companions/\(companion)/routines/\(routine)",
            method: "DELETE",
            body: nil
        )
    }

    public func createCompanionTrigger(
        companionID: String,
        input: CreateCompanionTriggerInput
    ) async throws -> CompanionTrigger {
        let companion = Self.encodedPathComponent(companionID)
        let body = try encoder.encode(input)
        return try await decode(
            TriggerEnvelope.self,
            path: "/v1/companions/\(companion)/triggers",
            method: "POST",
            body: body
        ).trigger
    }

    public func updateCompanionTrigger(
        companionID: String,
        triggerID: String,
        input: UpdateCompanionTriggerInput
    ) async throws -> CompanionTrigger {
        let companion = Self.encodedPathComponent(companionID)
        let trigger = Self.encodedPathComponent(triggerID)
        let body = try encoder.encode(input)
        return try await decode(
            TriggerEnvelope.self,
            path: "/v1/companions/\(companion)/triggers/\(trigger)",
            method: "PATCH",
            body: body
        ).trigger
    }

    public func deleteCompanionTrigger(
        companionID: String,
        triggerID: String
    ) async throws {
        let companion = Self.encodedPathComponent(companionID)
        let trigger = Self.encodedPathComponent(triggerID)
        _ = try await perform(
            path: "/v1/companions/\(companion)/triggers/\(trigger)",
            method: "DELETE",
            body: nil
        )
    }

    public func rotateCompanionTriggerSecret(
        companionID: String,
        triggerID: String
    ) async throws -> CompanionTrigger {
        let companion = Self.encodedPathComponent(companionID)
        let trigger = Self.encodedPathComponent(triggerID)
        return try await decode(
            TriggerEnvelope.self,
            path: "/v1/companions/\(companion)/triggers/\(trigger)/rotate-secret",
            method: "POST",
            body: Data("{}".utf8)
        ).trigger
    }

    public func retryCompanionTriggerRegistration(
        companionID: String,
        triggerID: String
    ) async throws -> CompanionTrigger {
        let companion = Self.encodedPathComponent(companionID)
        let trigger = Self.encodedPathComponent(triggerID)
        return try await decode(
            TriggerEnvelope.self,
            path: "/v1/companions/\(companion)/triggers/\(trigger)/registration",
            method: "POST",
            body: Data("{}".utf8)
        ).trigger
    }

    public func listCompanionTriggerRuns(
        companionID: String,
        triggerID: String,
        limit: Int = 50,
        cursor: String? = nil
    ) async throws -> CompanionTriggerRunList {
        let companion = Self.encodedPathComponent(companionID)
        let trigger = Self.encodedPathComponent(triggerID)
        var query = "limit=\(limit)"
        if let cursor { query += "&cursor=\(Self.encodedPathComponent(cursor))" }
        return try await decode(
            CompanionTriggerRunList.self,
            path: "/v1/companions/\(companion)/triggers/\(trigger)/runs?\(query)"
        )
    }

    public func readCompanionTriggerRun(
        companionID: String,
        runID: String,
        entryLimit: Int = 50,
        entryCursor: Int? = nil
    ) async throws -> CompanionTriggerRunDetail {
        let companion = Self.encodedPathComponent(companionID)
        let run = Self.encodedPathComponent(runID)
        var query = "entry_limit=\(entryLimit)"
        if let entryCursor { query += "&entry_cursor=\(entryCursor)" }
        return try await decode(
            TriggerRunDetailEnvelope.self,
            path: "/v1/companions/\(companion)/trigger-runs/\(run)?\(query)"
        ).run
    }

    public func registerNotificationDevice(
        installationID: UUID,
        registration: NotificationDeviceRegistration
    ) async throws {
        let body = try encoder.encode(registration)
        _ = try await perform(
            path: "/v1/notification-devices/\(installationID.uuidString.lowercased())",
            method: "PUT",
            body: body
        )
    }

    public func unregisterNotificationDevice(installationID: UUID) async throws {
        _ = try await perform(
            path: "/v1/notification-devices/\(installationID.uuidString.lowercased())",
            method: "DELETE",
            body: nil
        )
    }

    public func createCompanion(_ input: CreateCompanionInput) async throws -> CompanionSummary {
        let body = try encoder.encode(input)
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions",
            method: "POST",
            body: body
        ).companion
    }

    public func updateCompanion(
        companionID: String,
        input: UpdateCompanionInput
    ) async throws -> CompanionSummary {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        let body = try encoder.encode(input)
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions/\(id)",
            method: "PATCH",
            body: body
        ).companion
    }

    public func updateCompanionMemberState(
        companionID: String,
        patch: CompanionMemberStatePatch
    ) async throws -> CompanionSummary {
        let id = Self.encodedPathComponent(companionID)
        let body = try encoder.encode(patch)
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions/\(id)/member-state",
            method: "PATCH",
            body: body
        ).companion
    }

    public func duplicateCompanion(companionID: String) async throws -> CompanionSummary {
        let id = Self.encodedPathComponent(companionID)
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions/\(id)/duplicate",
            method: "POST",
            body: nil
        ).companion
    }

    public func updateCompanionPluginSelection(
        companionID: String,
        selectedMCPAccountIDs: [String]
    ) async throws -> CompanionSummary {
        let id = Self.encodedPathComponent(companionID)
        let body = try encoder.encode(
            UpdateCompanionPluginSelectionInput(selectedMCPAccountIDs: selectedMCPAccountIDs)
        )
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions/\(id)",
            method: "PATCH",
            body: body
        ).companion
    }

    public func companionRuntime(companionID: String) async throws -> CompanionSummary {
        let id = Self.encodedPathComponent(companionID)
        return try await decode(
            CompanionEnvelope.self,
            path: "/v1/companions/\(id)/runtime"
        ).companion
    }

    /// Mints a fresh, short-lived URL for the existing Box desktop. This route authorizes
    /// Owner/Editor access but cannot start or wake the Box.
    public func openCompanionDesktop(companionID: String) async throws -> CompanionDesktop {
        let id = Self.encodedPathComponent(companionID)
        return try await decode(
            CompanionDesktop.self,
            path: "/v1/companions/\(id)/runtime/desktop",
            method: "POST",
            body: nil
        )
    }

    public func restartCompanion(
        companionID: String,
        target: CompanionRuntimeRestartTarget,
        requestID: UUID
    ) async throws -> CompanionLifecycleReceipt {
        let id = Self.encodedPathComponent(companionID)
        let body = try encoder.encode(["target": target.rawValue])
        return try await decode(
            LifecycleEnvelope.self,
            path: "/v1/companions/\(id)/runtime/restart",
            method: "POST",
            body: body,
            additionalHeaders: ["Idempotency-Key": requestID.uuidString.lowercased()]
        ).lifecycle
    }

    public func deleteCompanion(
        companionID: String,
        requestID: UUID
    ) async throws -> CompanionLifecycleReceipt {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        return try await decode(
            LifecycleEnvelope.self,
            path: "/v1/companions/\(id)",
            method: "DELETE",
            body: nil,
            additionalHeaders: ["Idempotency-Key": requestID.uuidString.lowercased()]
        ).lifecycle
    }

    public func listCompanionProviders() async throws -> CompanionProvidersResponse {
        try await decode(CompanionProvidersResponse.self, path: "/v1/companion-providers")
    }

    public func transcribeCompanionAudio(
        companionID: String,
        audio: Data
    ) async throws -> CompanionTranscription {
        guard !audio.isEmpty else { throw CompanionTranscriptionError.emptyAudio }
        guard audio.count <= companionTranscriptionAudioMaximumBytes else {
            throw CompanionTranscriptionError.audioTooLarge
        }
        let companion = Self.encodedPathComponent(companionID)
        let boundary = "CompanionTranscriptionBoundary-\(UUID().uuidString)"
        let body = Self.transcriptionMultipartBody(boundary: boundary, audio: audio)
        return try await decode(
            CompanionTranscription.self,
            path: "/v1/companions/\(companion)/transcriptions",
            method: "POST",
            body: body,
            additionalHeaders: ["Content-Type": "multipart/form-data; boundary=\(boundary)"],
            timeout: 90
        )
    }

    public func saveCompanionProvider(
        providerID: String,
        credential: String
    ) async throws -> CompanionProviderConnection {
        let id = providerID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? providerID
        let body = try encoder.encode([
            "auth_method": "api_key",
            "credential": credential,
        ])
        return try await decode(
            ProviderConnectionEnvelope.self,
            path: "/v1/companion-providers/\(id)",
            method: "PUT",
            body: body
        ).connection
    }

    public func setDefaultCompanionProvider(providerID: String) async throws {
        let body = try encoder.encode(["provider_id": providerID])
        _ = try await perform(
            path: "/v1/companion-providers/default",
            method: "PUT",
            body: body
        )
    }

    public func deleteCompanionProvider(providerID: String) async throws {
        let id = providerID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? providerID
        _ = try await perform(
            path: "/v1/companion-providers/\(id)",
            method: "DELETE",
            body: nil
        )
    }

    public func startCompanionProviderOAuth(
        providerID: String
    ) async throws -> CompanionProviderOAuthStart {
        let body = try encoder.encode(["provider_id": providerID])
        let (data, response) = try await perform(
            path: "/v1/companion-providers/oauth/start",
            method: "POST",
            body: body,
            timeout: 35
        )
        guard let cookie = Self.cookie(suffix: "companion_provider_oauth", from: response) else {
            throw APIError(
                status: 500,
                code: "missing_oauth_session",
                message: "The server did not return a provider sign-in session."
            )
        }
        providerOAuthCookie = cookie
        do {
            return try decoder.decode(CompanionProviderOAuthStart.self, from: data)
        } catch {
            providerOAuthCookie = nil
            throw APIError(status: 500, code: "invalid_response", message: "The provider sign-in response was unreadable.")
        }
    }

    public func completeCompanionProviderOAuth(
        authorizationCode: String
    ) async throws -> CompanionProviderConnection {
        let body = try encoder.encode(["authorization_code": authorizationCode])
        let result = try await decode(
            ProviderConnectionEnvelope.self,
            path: "/v1/companion-providers/oauth/complete",
            method: "POST",
            body: body,
            additionalHeaders: providerOAuthHeaders(),
            timeout: 35
        ).connection
        providerOAuthCookie = nil
        return result
    }

    public func pollCompanionProviderOAuth() async throws -> CompanionProviderOAuthPoll {
        let result = try await decode(
            CompanionProviderOAuthPoll.self,
            path: "/v1/companion-providers/oauth/poll",
            method: "POST",
            body: nil,
            additionalHeaders: providerOAuthHeaders(),
            timeout: 65
        )
        if result.status == .connected { providerOAuthCookie = nil }
        return result
    }

    public func cancelCompanionProviderOAuth() {
        providerOAuthCookie = nil
    }

    public func listCompanionPlugins() async throws -> [CompanionPluginAccount] {
        try await decode(PluginListEnvelope.self, path: "/v1/companion-plugins").accounts
    }

    public func listCompanionTriggerProviderAccounts() async throws -> [CompanionTriggerProviderAccount] {
        try await decode(
            TriggerProviderAccountListEnvelope.self,
            path: "/v1/companion-trigger-provider-accounts"
        ).accounts
    }

    public func saveCompanionTriggerProviderAccount(
        _ input: CreateCompanionTriggerProviderAccountInput
    ) async throws -> CompanionTriggerProviderAccount {
        let body = try encoder.encode(input)
        return try await decode(
            TriggerProviderAccountEnvelope.self,
            path: "/v1/companion-trigger-provider-accounts",
            method: "POST",
            body: body
        ).account
    }

    public func disconnectCompanionTriggerProviderAccount(
        accountID: String
    ) async throws -> CompanionTriggerProviderAccount {
        let account = Self.encodedPathComponent(accountID)
        return try await decode(
            TriggerProviderAccountEnvelope.self,
            path: "/v1/companion-trigger-provider-accounts/\(account)",
            method: "DELETE"
        ).account
    }

    public func listAccessibleCompanionSkills() async throws -> [CompanionSkillReference] {
        try await decode([CompanionSkillReference].self, path: "/v1/skills?lib=accessible")
    }

    public func saveCompanionPlugin(
        _ input: SaveCompanionPluginInput
    ) async throws -> CompanionPluginAccount {
        let body = try encoder.encode(input)
        return try await decode(
            PluginAccountEnvelope.self,
            path: "/v1/companion-plugins",
            method: "POST",
            body: body
        ).account
    }

    /// Starts the existing authenticated flow and retains only its short-lived callback cookie
    /// in this client actor until the exact Universal Link callback is consumed.
    public func startCompanionPluginOAuth(
        serverName: String,
        label: String,
        companionID: String? = nil,
        controlRequestID: String? = nil
    ) async throws -> CompanionPluginOAuthStart {
        companionPluginOAuthCookie = nil
        companionPluginOAuthState = nil
        companionPluginOAuthCallbackURL = nil
        var input = [
            "server_name": serverName,
            "label": label,
        ]
        if let companionID, let controlRequestID {
            input["companion_id"] = companionID
            input["control_request_id"] = controlRequestID
        }
        let body = try encoder.encode(input)
        let (data, response) = try await perform(
            path: "/v1/companion-plugins/oauth/start",
            method: "POST",
            body: body,
            timeout: 12
        )
        guard let cookie = Self.cookie(prefix: "companion_mcp_oauth_", from: response) else {
            throw APIError(
                status: 500,
                code: "missing_oauth_session",
                message: "The server did not return a plugin sign-in session."
            )
        }
        let started: CompanionPluginOAuthStart
        do {
            started = try decoder.decode(CompanionPluginOAuthStart.self, from: data)
        } catch {
            companionPluginOAuthCookie = nil
            throw APIError(
                status: 500,
                code: "invalid_response",
                message: "The plugin sign-in response was unreadable."
            )
        }
        guard let callbackURL = Self.pluginOAuthCallbackURL(from: started.authorizationURL),
              let callbackState = CompanionOAuthCallbackPolicy.queryValue(
                  named: "state",
                  from: started.authorizationURL
              ),
              !callbackState.isEmpty else {
            companionPluginOAuthCookie = nil
            throw APIError(
                status: 500,
                code: "missing_oauth_binding",
                message: "The plugin sign-in response did not include a valid callback binding."
            )
        }
        companionPluginOAuthCookie = cookie
        companionPluginOAuthState = callbackState
        companionPluginOAuthCallbackURL = callbackURL
        return started
    }

    public func completeCompanionPluginOAuth(callbackURL: URL) async throws {
        guard let expectedCallbackURL = companionPluginOAuthCallbackURL,
              let expectedCallbackState = companionPluginOAuthState,
              CompanionOAuthCallbackPolicy.isPluginCallback(
                  callbackURL,
                  expectedCallbackURL: expectedCallbackURL
              ),
              CompanionOAuthCallbackPolicy.queryValue(named: "state", from: callbackURL) == expectedCallbackState else {
            throw APIError(
                status: 400,
                code: "invalid_oauth_callback",
                message: "The plugin sign-in callback was not recognized."
            )
        }
        defer {
            companionPluginOAuthCookie = nil
            companionPluginOAuthState = nil
            companionPluginOAuthCallbackURL = nil
        }
        let headers = try companionPluginOAuthHeaders()
        let (_, response) = try await perform(
            url: callbackURL,
            method: "GET",
            body: nil,
            acceptedStatuses: 200..<400,
            timeout: 35,
            additionalHeaders: headers,
            followRedirects: false
        )

        guard response.statusCode == 303,
              let location = Self.header(named: "location", from: response),
              let redirect = Self.pluginOAuthRedirect(
                  from: location,
                  expectedCallbackURL: expectedCallbackURL
              ) else {
            throw APIError(
                status: response.statusCode,
                code: "invalid_oauth_redirect",
                message: "The plugin sign-in response was not recognized."
            )
        }
        if case .failed(let error) = redirect {
            throw APIError(status: 400, code: error, message: "The provider did not complete authorization.")
        }
    }

    public func cancelCompanionPluginOAuth() {
        companionPluginOAuthCookie = nil
        companionPluginOAuthState = nil
        companionPluginOAuthCallbackURL = nil
    }

    public func deleteCompanionPlugin(accountID: String) async throws {
        let id = accountID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? accountID
        _ = try await perform(
            path: "/v1/companion-plugins/\(id)",
            method: "DELETE",
            body: nil
        )
    }

    public func thread(companionID: String) async throws -> CompanionThread {
        var response = try await companionThreadWindow(companionID: companionID)
        var metadata = response.value.thread
        var entriesByID = Dictionary(
            uniqueKeysWithValues: response.value.entries.map { ($0.eventID, $0) }
        )
        var notifyByRun = Dictionary(
            uniqueKeysWithValues: response.value.notifyReturns.map { ($0.runID, $0) }
        )
        var before = response.value.olderCursor
        var seenCursors: Set<String> = []
        while let cursor = before {
            guard seenCursors.insert(cursor).inserted else {
                throw APIError(
                    status: 500,
                    code: "invalid_response",
                    message: "The Companion history cursor did not advance."
                )
            }
            response = try await companionThreadWindow(companionID: companionID, before: cursor)
            metadata = response.value.thread
            response.value.entries.forEach { entriesByID[$0.eventID] = $0 }
            response.value.notifyReturns.forEach { notifyByRun[$0.runID] = $0 }
            before = response.value.olderCursor
        }
        let ordered = entriesByID.values.sorted {
            $0.ordinal == $1.ordinal ? $0.eventID < $1.eventID : $0.ordinal < $1.ordinal
        }
        let notifyReturns = companionMergedRoutineNotifyReturns(
            existing: [],
            changed: Array(notifyByRun.values),
            entries: ordered
        )
        return metadata.thread(entries: companionCollapsedRoutineNotifyEntries(
            ordered,
            notifyReturns: notifyReturns
        ))
    }

    public func companionThreadWindow(
        companionID: String,
        before: String? = nil,
        limit: Int = 50
    ) async throws -> CompanionSyncMeasurement<CompanionThreadWindow> {
        let id = Self.encodedPathComponent(companionID)
        var components = URLComponents()
        components.path = "/v1/companions/\(id)/thread-window"
        var queryItems = [URLQueryItem(name: "limit", value: String(min(max(limit, 1), 100)))]
        if let before { queryItems.append(URLQueryItem(name: "before", value: before)) }
        components.queryItems = queryItems
        return try await decodeMeasured(
            CompanionThreadWindow.self,
            path: components.string ?? "/v1/companions/\(id)/thread-window?limit=50"
        )
    }

    public func synchronizeCompanionThread(
        companionID: String,
        cursor: String?
    ) async throws -> CompanionSyncMeasurement<CompanionThreadDelta> {
        let id = Self.encodedPathComponent(companionID)
        return try await decodeMeasured(
            CompanionThreadDelta.self,
            path: Self.cursorPath("/v1/companions/\(id)/thread-delta", cursor: cursor)
        )
    }

    public func decideCompanionDecision(
        companionID: String,
        requestID: String,
        action: CompanionDecisionAction
    ) async throws -> CompanionThread {
        let companion = Self.encodedPathComponent(companionID)
        let request = Self.encodedPathComponent(requestID)
        let body = try encoder.encode(action)
        return try await decode(
            ThreadEnvelope.self,
            path: "/v1/companions/\(companion)/decisions/\(request)",
            method: "POST",
            body: body
        ).thread
    }

    public func cancelCompanionTurn(
        companionID: String,
        turnID: String
    ) async throws -> CompanionThread {
        let companion = Self.encodedPathComponent(companionID)
        let turn = Self.encodedPathComponent(turnID)
        return try await decode(
            TurnThreadEnvelope.self,
            path: "/v1/companions/\(companion)/turns/\(turn)/cancel",
            method: "POST",
            body: Data("{}".utf8)
        ).thread
    }

    public func sendMessage(
        companionID: String,
        content: String,
        clientMessageID: UUID,
        attachments: [CompanionMessageAttachment] = [],
        uploadProgress: (@Sendable (Double) -> Void)? = nil
    ) async throws {
        let id = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        if !attachments.isEmpty {
            guard attachments.count <= companionMessageAttachmentMaximumCount else {
                throw CompanionMessageAttachmentError.tooMany
            }
            let boundary = "CompanionBoundary-\(UUID().uuidString)"
            let uploadFile = try Self.writeMultipartMessageFile(
                boundary: boundary,
                content: content,
                clientMessageID: clientMessageID,
                attachments: attachments
            )
            defer { try? FileManager.default.removeItem(at: uploadFile) }
            uploadProgress?(0)
            _ = try await perform(
                path: "/v1/companions/\(id)/messages",
                method: "POST",
                body: nil,
                acceptedStatuses: 200..<300,
                additionallyAcceptedStatus: 409,
                timeout: 120,
                additionalHeaders: ["Content-Type": "multipart/form-data; boundary=\(boundary)"],
                uploadProgress: uploadProgress,
                uploadFile: uploadFile
            )
            uploadProgress?(1)
            return
        }
        let body = try encoder.encode([
            "content": content,
            "client_message_id": clientMessageID.uuidString.lowercased(),
        ])
        _ = try await perform(
            path: "/v1/companions/\(id)/messages",
            method: "POST",
            body: body,
            acceptedStatuses: 200..<300,
            additionallyAcceptedStatus: 409,
            timeout: 210
        )
    }

    public func attachmentData(companionID: String, attachmentID: String) async throws -> Data {
        let companion = companionID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? companionID
        let attachment = attachmentID.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? attachmentID
        let (data, _) = try await perform(
            path: "/v1/companions/\(companion)/attachments/\(attachment)",
            method: "GET",
            body: nil,
            timeout: 60
        )
        return data
    }

    private func decode<T: Decodable>(
        _ type: T.Type,
        path: String,
        method: String = "GET",
        body: Data? = nil,
        additionalHeaders: [String: String] = [:],
        timeout: TimeInterval = 30
    ) async throws -> T {
        let (data, _) = try await perform(
            path: path,
            method: method,
            body: body,
            timeout: timeout,
            additionalHeaders: additionalHeaders
        )
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw APIError(status: 500, code: "invalid_response", message: "The server returned an unreadable response.")
        }
    }

    private func decodeMeasured<T: Decodable & Sendable>(
        _ type: T.Type,
        path: String
    ) async throws -> CompanionSyncMeasurement<T> {
        let startedAt = ContinuousClock.now
        let (data, _) = try await perform(path: path, method: "GET", body: nil)
        do {
            return CompanionSyncMeasurement(
                value: try decoder.decode(type, from: data),
                receivedBytes: data.count,
                networkMilliseconds: companionMilliseconds(from: startedAt.duration(to: .now))
            )
        } catch {
            throw APIError(
                status: 500,
                code: "invalid_response",
                message: "The server returned an unreadable response."
            )
        }
    }

    private func providerOAuthHeaders() throws -> [String: String] {
        guard let providerOAuthCookie else {
            throw APIError(
                status: 400,
                code: "oauth_not_started",
                message: "Start provider sign-in before completing it."
            )
        }
        let cookies = [authority?.cookie, providerOAuthCookie].compactMap { $0 }
        return ["Cookie": cookies.joined(separator: "; ")]
    }

    private func companionPluginOAuthHeaders() throws -> [String: String] {
        guard let companionPluginOAuthCookie else {
            throw APIError(
                status: 400,
                code: "oauth_not_started",
                message: "Start plugin sign-in before completing it."
            )
        }
        let cookies = [authority?.cookie, companionPluginOAuthCookie].compactMap { $0 }
        return ["Cookie": cookies.joined(separator: "; ")]
    }

    @discardableResult
    private func perform(
        path: String,
        method: String,
        body: Data?,
        acceptedStatuses: Range<Int> = 200..<300,
        additionallyAcceptedStatus: Int? = nil,
        timeout: TimeInterval = 30,
        additionalHeaders: [String: String] = [:],
        uploadProgress: (@Sendable (Double) -> Void)? = nil,
        uploadFile: URL? = nil,
        followRedirects: Bool = true
    ) async throws -> (Data, HTTPURLResponse) {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError(status: 0, code: "invalid_url", message: "The API address is invalid.")
        }
        return try await perform(
            url: url,
            method: method,
            body: body,
            acceptedStatuses: acceptedStatuses,
            additionallyAcceptedStatus: additionallyAcceptedStatus,
            timeout: timeout,
            additionalHeaders: additionalHeaders,
            uploadProgress: uploadProgress,
            uploadFile: uploadFile,
            followRedirects: followRedirects
        )
    }

    @discardableResult
    private func perform(
        url: URL,
        method: String,
        body: Data?,
        acceptedStatuses: Range<Int> = 200..<300,
        additionallyAcceptedStatus: Int? = nil,
        timeout: TimeInterval = 30,
        additionalHeaders: [String: String] = [:],
        uploadProgress: (@Sendable (Double) -> Void)? = nil,
        uploadFile: URL? = nil,
        followRedirects: Bool = true
    ) async throws -> (Data, HTTPURLResponse) {
        var request = try makeRequest(
            url: url,
            method: method,
            body: body,
            timeout: timeout,
            additionalHeaders: additionalHeaders
        )

        let data: Data
        let response: URLResponse
        do {
            if let uploadFile {
                request.httpBody = nil
                let delegate = uploadProgress.map { UploadProgressDelegate(onProgress: $0) }
                (data, response) = try await session.upload(
                    for: request,
                    fromFile: uploadFile,
                    delegate: delegate
                )
            } else {
                let redirectDelegate = redirectDelegateFactory.make(followRedirects: followRedirects)
                (data, response) = try await session.data(for: request, delegate: redirectDelegate)
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw APIError(status: 0, code: "network_error", message: "The server could not be reached.")
        }
        guard let http = response as? HTTPURLResponse else {
            throw APIError(status: 0, code: "invalid_response", message: "The server returned an invalid response.")
        }
        if let cookie = Self.sessionCookie(from: http), let authority {
            self.authority = Session(
                cookie: cookie,
                orgID: authority.orgID,
                needsOnboarding: authority.needsOnboarding,
                user: authority.user
            )
        }
        guard acceptedStatuses.contains(http.statusCode) || http.statusCode == additionallyAcceptedStatus else {
            let payload = try? decoder.decode(ErrorPayload.self, from: data)
            throw APIError(
                status: http.statusCode,
                code: payload?.code,
                message: payload?.message ?? payload?.error ?? "Request failed with status \(http.statusCode)."
            )
        }
        return (data, http)
    }

    private func makeRequest(
        path: String,
        method: String,
        body: Data?,
        timeout: TimeInterval,
        additionalHeaders: [String: String] = [:]
    ) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw APIError(status: 0, code: "invalid_url", message: "The API address is invalid.")
        }
        return try makeRequest(
            url: url,
            method: method,
            body: body,
            timeout: timeout,
            additionalHeaders: additionalHeaders
        )
    }

    private func makeRequest(
        url: URL,
        method: String,
        body: Data?,
        timeout: TimeInterval,
        additionalHeaders: [String: String] = [:]
    ) throws -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.httpBody = body
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
        if let authority {
            request.setValue(authority.cookie, forHTTPHeaderField: "Cookie")
            if let orgID = authority.orgID {
                request.setValue(orgID, forHTTPHeaderField: "x-companion-org")
            }
        }
        if method != "GET" && method != "HEAD" && additionalHeaders["expo-origin"] == nil {
            request.setValue(
                baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")),
                forHTTPHeaderField: "Origin"
            )
        }
        for (name, value) in additionalHeaders {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }

    private static func writeMultipartMessageFile(
        boundary: String,
        content: String,
        clientMessageID: UUID,
        attachments: [CompanionMessageAttachment]
    ) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("companion-message-\(UUID().uuidString).multipart")
        guard FileManager.default.createFile(
            atPath: url.path,
            contents: nil,
            attributes: [.posixPermissions: 0o600]
        ) else {
            throw APIError(status: 0, code: "upload_prepare_failed", message: "The attachments could not be prepared.")
        }
        let handle: FileHandle
        do {
            handle = try FileHandle(forWritingTo: url)
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        do {
            func append(_ string: String) throws {
                try handle.write(contentsOf: Data(string.utf8))
            }
            func appendField(name: String, value: String) throws {
                try append("--\(boundary)\r\n")
                try append("Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
                try append(value)
                try append("\r\n")
            }

            try appendField(name: "content", value: content)
            try appendField(name: "client_message_id", value: clientMessageID.uuidString.lowercased())
            for attachment in attachments {
                let filename = attachment.filename
                    .replacingOccurrences(of: "\\", with: "\\\\")
                    .replacingOccurrences(of: "\"", with: "\\\"")
                    .replacingOccurrences(of: "\r", with: "_")
                    .replacingOccurrences(of: "\n", with: "_")
                try append("--\(boundary)\r\n")
                try append("Content-Disposition: form-data; name=\"file\"; filename=\"\(filename)\"\r\n")
                try append("Content-Type: \(attachment.contentType.rawValue)\r\n\r\n")
                try handle.write(contentsOf: attachment.data)
                try append("\r\n")
            }
            try append("--\(boundary)--\r\n")
            try handle.close()
            return url
        } catch {
            try? handle.close()
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    private static func transcriptionMultipartBody(boundary: String, audio: Data) -> Data {
        var body = Data()
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data(
            "Content-Disposition: form-data; name=\"audio\"; filename=\"recording.m4a\"\r\n".utf8
        ))
        body.append(Data("Content-Type: audio/mp4\r\n\r\n".utf8))
        body.append(audio)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    static func sessionCookie(from response: HTTPURLResponse) -> String? {
        if let cookie = cookie(suffix: ".session_token", from: response) {
            return cookie
        }
        guard let header = header(named: "set-cookie", from: response) else { return nil }
        return sessionCookie(fromSetCookieHeader: header)
    }

    static func sessionCookie(fromSetCookieHeader header: String) -> String? {
        header
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .compactMap { value -> String? in
                guard let pair = value.split(separator: ";", maxSplits: 1).first,
                      pair.split(separator: "=", maxSplits: 1).first?.hasSuffix(".session_token") == true else { return nil }
                return String(pair)
            }
            .first
    }

    private static func cookieValue(suffix: String, from response: HTTPURLResponse) -> String? {
        guard let cookie = cookie(suffix: suffix, from: response),
              let separator = cookie.firstIndex(of: "=") else { return nil }
        return String(cookie[cookie.index(after: separator)...])
    }

    private static func cookie(suffix: String, from response: HTTPURLResponse) -> String? {
        cookie(matching: { $0.hasSuffix(suffix) }, from: response)
    }

    private static func cookie(prefix: String, from response: HTTPURLResponse) -> String? {
        cookie(matching: { $0.hasPrefix(prefix) }, from: response)
    }

    private static func cookie(
        matching predicate: (String) -> Bool,
        from response: HTTPURLResponse
    ) -> String? {
        var fields: [String: String] = [:]
        for (key, value) in response.allHeaderFields {
            guard let key = key as? String else { continue }
            fields[key] = String(describing: value)
        }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: fields, for: response.url ?? URL(string: "https://localhost")!)
        if let cookie = cookies.first(where: { predicate($0.name) }) {
            return "\(cookie.name)=\(cookie.value)"
        }
        guard let header = header(named: "set-cookie", from: response) else { return nil }
        return header
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .compactMap { value -> String? in
                guard let pair = value.split(separator: ";", maxSplits: 1).first,
                      let name = pair.split(separator: "=", maxSplits: 1).first,
                      predicate(String(name)) else { return nil }
                return String(pair)
            }
            .first
    }

    private static func pluginOAuthCallbackURL(from authorizationURL: URL) -> URL? {
        guard let rawCallbackURL = CompanionOAuthCallbackPolicy.queryValue(
            named: "redirect_uri",
            from: authorizationURL
        ),
              let callbackURL = URL(string: rawCallbackURL),
              CompanionOAuthCallbackPolicy.isPluginCallback(
                  callbackURL,
                  expectedCallbackURL: callbackURL
              ) else {
            return nil
        }
        return callbackURL
    }

    private static func pluginOAuthRedirect(
        from location: String,
        expectedCallbackURL: URL
    ) -> PluginOAuthRedirect? {
        guard let redirectURL = URL(
            string: location.trimmingCharacters(in: .whitespacesAndNewlines),
            relativeTo: expectedCallbackURL
        )?.absoluteURL,
              let expectedScheme = expectedCallbackURL.scheme,
              let expectedHost = expectedCallbackURL.host,
              (expectedScheme.caseInsensitiveCompare("https") == .orderedSame
                  || expectedScheme.caseInsensitiveCompare("http") == .orderedSame),
              expectedCallbackURL.path == CompanionOAuthCallbackPolicy.pluginCallbackPath,
              expectedCallbackURL.user == nil,
              expectedCallbackURL.password == nil,
              expectedCallbackURL.fragment == nil,
              redirectURL.scheme?.caseInsensitiveCompare(expectedScheme) == .orderedSame,
              redirectURL.host?.caseInsensitiveCompare(expectedHost) == .orderedSame,
              redirectURL.path == "/companions",
              Self.effectivePort(for: redirectURL) == Self.effectivePort(for: expectedCallbackURL),
              redirectURL.user == nil,
              redirectURL.password == nil,
              redirectURL.fragment == nil,
              let queryItems = URLComponents(url: redirectURL, resolvingAgainstBaseURL: false)?.queryItems else {
            return nil
        }

        let oauth = queryItems.filter { $0.name == "oauth" }
        let errors = queryItems.filter { $0.name == "oauth_error" }
        guard oauth.count <= 1, errors.count <= 1, oauth.isEmpty || errors.isEmpty else { return nil }
        if oauth.count == 1 {
            guard oauth[0].value == "connected" else { return nil }
            return .connected
        }
        guard errors.count == 1, let value = errors[0].value, !value.isEmpty else { return nil }
        return .failed(value)
    }

    private static func effectivePort(for url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    private static func randomOAuthState() throws -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer -> Int32 in
            guard let baseAddress = buffer.baseAddress else { return errSecParam }
            return SecRandomCopyBytes(kSecRandomDefault, buffer.count, baseAddress)
        }
        guard status == errSecSuccess else {
            throw APIError(
                status: 0,
                code: "oauth_state_unavailable",
                message: "Sign-in could not be started securely."
            )
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    private static func header(named name: String, from response: HTTPURLResponse) -> String? {
        response.allHeaderFields.first { key, _ in
            (key as? String)?.caseInsensitiveCompare(name) == .orderedSame
        }.map { String(describing: $0.value) }
    }

    private static func encodedPathComponent(_ value: String) -> String {
        let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    private static func cursorPath(_ path: String, cursor: String?) -> String {
        guard let cursor else { return path }
        var components = URLComponents()
        components.path = path
        components.queryItems = [URLQueryItem(name: "cursor", value: cursor)]
        return components.string ?? path
    }

    private static func encodedQueryComponent(_ value: String) -> String {
        let unreserved = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}
