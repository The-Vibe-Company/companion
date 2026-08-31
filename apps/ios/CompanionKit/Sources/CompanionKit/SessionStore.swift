import Foundation
import Observation
import Security

public protocol SessionStorage: Sendable {
    func load() throws -> Data?
    func save(_ data: Data) throws
    func remove() throws
}

public struct KeychainSessionStorage: SessionStorage {
    private let service: String
    private let account = "primary"

    public init(service: String = "dev.companion.mobile.session") {
        self.service = service
    }

    public func load() throws -> Data? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw StorageError(status: status) }
        return data
    }

    public func save(_ data: Data) throws {
        let updateStatus = SecItemUpdate(baseQuery as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else { throw StorageError(status: updateStatus) }
        var query = baseQuery
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(query as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw StorageError(status: addStatus) }
    }

    public func remove() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw StorageError(status: status) }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private struct StorageError: Error {
        let status: OSStatus
    }
}

@MainActor
@Observable
public final class SessionStore {
    /// Leaves ample room for the path, cookies, and proxy request-line limits around the cursor.
    private static let maximumThreadCursorRequestBytes = 8_000

    public enum Phase: Equatable, Sendable {
        case restoring
        case signedOut
        case onboarding(Session)
        case active(Session)
    }

    public private(set) var phase: Phase = .restoring
    public private(set) var bootstrapError: String?
    public private(set) var initialRosterSnapshot: CompanionRosterSnapshot?
    public private(set) var initialCacheRestoreMilliseconds: Double?

    private let client: APIClient
    private let storage: any SessionStorage
    private let cache: (any CompanionSnapshotCache)?
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    private var restored = false
    private var notificationInstallationID: UUID?
    private var persistedSession: Session?
    private var invalidationContinuations: [
        String: [UUID: AsyncStream<Void>.Continuation]
    ] = [:]
    private var pendingCompanionInvalidations: Set<String> = []
    private var sessionScopeGeneration = 0
    private var rosterSyncGeneration = 0
    private var threadSyncGenerations: [String: Int] = [:]
    private var companionsMarkedRead: Set<String> = []
    /// Full foreground projections live only for this process; SQLite intentionally keeps a tail.
    private var liveThreadSnapshots: [String: CompanionThreadSnapshot] = [:]

    public init(
        apiURL: URL,
        storage: any SessionStorage = KeychainSessionStorage(),
        notificationInstallationID: UUID? = nil,
        cache: (any CompanionSnapshotCache)? = nil,
        apiClient: APIClient? = nil
    ) {
        self.storage = storage
        self.cache = cache
        self.notificationInstallationID = notificationInstallationID

        let startedAt = ContinuousClock.now
        let bootstrapDecoder = JSONDecoder()
        let stored: Session?
        do {
            if let data = try storage.load(),
               let decoded = try? bootstrapDecoder.decode(Session.self, from: data),
               !decoded.cookie.isEmpty {
                stored = decoded
            } else {
                stored = nil
            }
        } catch {
            stored = nil
            bootstrapError = "Secure storage is temporarily unavailable."
        }
        persistedSession = stored
        client = apiClient ?? APIClient(baseURL: apiURL, initialAuthority: stored)
        if let stored {
            publish(stored)
            if let scope = Self.cacheScope(for: stored) {
                initialRosterSnapshot = try? cache?.roster(scope: scope)
            }
        } else if bootstrapError == nil {
            phase = .signedOut
        }
        initialCacheRestoreMilliseconds = startedAt.duration(to: .now).companionMilliseconds
    }

    public var currentSession: Session? {
        switch phase {
        case .restoring, .signedOut:
            return nil
        case .onboarding(let session), .active(let session):
            return session
        }
    }

    public var memberTimezone: String? {
        currentSession?.user.timezone
    }

    public func restore() async {
        guard !restored else { return }
        restored = true
        guard let stored = persistedSession else {
            if bootstrapError != nil { phase = .restoring }
            return
        }
        await client.setAuthority(stored)
        do {
            let identity = try await client.whoAmI()
            let refreshed = Session(cookie: await client.currentAuthority()?.cookie ?? stored.cookie, identity: identity)
            await client.setAuthority(refreshed)
            try? persist(refreshed)
            publish(refreshed)
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
        } catch {
            // Keep the last known-good authority on retryable network and server failures.
        }
    }

    public func retryRestore() async {
        do {
            guard let data = try storage.load(),
                  let stored = try? decoder.decode(Session.self, from: data),
                  !stored.cookie.isEmpty else {
                bootstrapError = nil
                phase = .signedOut
                return
            }
            persistedSession = stored
            await client.setAuthority(stored)
            publish(stored)
            if let scope = Self.cacheScope(for: stored) {
                initialRosterSnapshot = try? cache?.roster(scope: scope)
            }
            bootstrapError = nil
        } catch {
            bootstrapError = "Secure storage is temporarily unavailable."
            phase = .restoring
            return
        }
        restored = false
        await restore()
    }

    public func signIn(email: String, password: String) async throws {
        let authenticated = try await client.signIn(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password)
        try persist(authenticated)
        publish(authenticated)
    }

    public func beginGoogleSignIn(callbackScheme: String) async throws -> APIClient.GoogleAuthorization {
        try await client.beginGoogleSignIn(callbackScheme: callbackScheme)
    }

    public func completeGoogleSignIn(
        callbackURL: URL,
        callbackScheme: String
    ) async throws {
        let authenticated = try await client.completeGoogleSignIn(
            callbackURL: callbackURL,
            callbackScheme: callbackScheme
        )
        try persist(authenticated)
        publish(authenticated)
    }

    public func cancelGoogleSignIn(expectedNativeState: String) async {
        await client.cancelGoogleSignIn(expectedNativeState: expectedNativeState)
    }

    /// Updates the member's shared profile and rolls the returned values into the secure session
    /// snapshot so every first-party surface immediately uses the new timezone/name.
    public func updateUserProfile(
        name: String? = nil,
        timezone: String? = nil
    ) async throws -> UserProfile {
        do {
            let profile = try await client.updateUserProfile(name: name, timezone: timezone)
            if let current = currentSession {
                let updated = Session(
                    cookie: await client.currentAuthority()?.cookie ?? current.cookie,
                    orgID: current.orgID,
                    needsOnboarding: current.needsOnboarding,
                    user: .init(
                        id: profile.id,
                        email: current.user.email,
                        name: profile.name,
                        timezone: profile.timezone
                    )
                )
                await client.setAuthority(updated)
                try? persist(updated)
                publish(updated)
            }
            return profile
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func signOut() async {
        let scope = currentSession.flatMap { Self.cacheScope(for: $0) }
        if let notificationInstallationID {
            try? await client.unregisterNotificationDevice(installationID: notificationInstallationID)
        }
        await client.signOut()
        if let scope { try? cache?.remove(scope: scope) }
        await clearLocalSession()
    }

    public func cachedThread(companionID: String) -> CompanionThreadSnapshot? {
        guard let scope = currentSession.flatMap({ Self.cacheScope(for: $0) }) else { return nil }
        let snapshot = liveThreadSnapshots[companionID]
            ?? ((try? cache?.thread(scope: scope, companionID: companionID)) ?? nil)
        return snapshot?.readOnlyPresentation()
    }

    /// A narrow push/foreground invalidation seam. Consumers choose whether the matching resource
    /// is open; yielding does not mutate an observed thread or roster projection by itself.
    public func companionInvalidations(
        companionID: String,
        replayPending: Bool = true
    ) -> AsyncStream<Void> {
        let streamID = UUID()
        return AsyncStream { continuation in
            invalidationContinuations[companionID, default: [:]][streamID] = continuation
            if pendingCompanionInvalidations.remove(companionID) != nil, replayPending {
                continuation.yield()
            }
            continuation.onTermination = { @Sendable [weak self] _ in
                Task { @MainActor in
                    guard let self,
                          var continuations = self.invalidationContinuations[companionID] else { return }
                    continuations[streamID] = nil
                    self.invalidationContinuations[companionID] = continuations.isEmpty
                        ? nil
                        : continuations
                }
            }
        }
    }

    public func invalidateCompanion(companionID: String) {
        if hasVisibleInvalidationConsumer(companionID: companionID),
           let matchingContinuations = invalidationContinuations[companionID] {
            pendingCompanionInvalidations.remove(companionID)
            for continuation in matchingContinuations.values {
                continuation.yield()
            }
            return
        }
        pendingCompanionInvalidations.insert(companionID)
    }

    func hasVisibleInvalidationConsumer(companionID: String) -> Bool {
        invalidationContinuations[companionID]?.isEmpty == false
    }

    /// Completes the actual roster and transcript cache refresh for an APNs background callback.
    /// Callers can map the truthful outcome directly to `UIBackgroundFetchResult`.
    public func refreshInvalidatedCompanion(
        companionID: String
    ) async -> CompanionCacheRefreshResult {
        guard let session = currentSession,
              let scope = Self.cacheScope(for: session) else { return .failed }
        let previousRosterCursor = initialRosterSnapshot?.cursor
            ?? (try? cache?.roster(scope: scope))?.cursor
        let previousThreadCursor = (try? cache?.thread(
            scope: scope,
            companionID: companionID
        ))?.cursor
        do {
            async let roster = synchronizeRoster()
            async let thread = synchronizeThread(companionID: companionID)
            let (rosterResult, threadResult) = try await (roster, thread)
            return rosterResult.value.cursor != previousRosterCursor
                || threadResult.value.cursor != previousThreadCursor
                ? .newData
                : .noData
        } catch {
            return .failed
        }
    }

    public func registerNotificationDevice(
        installationID: UUID,
        registration: NotificationDeviceRegistration
    ) async throws {
        notificationInstallationID = installationID
        do {
            try await client.registerNotificationDevice(
                installationID: installationID,
                registration: registration
            )
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func unregisterNotificationDevice(installationID: UUID) async throws {
        do {
            try await client.unregisterNotificationDevice(installationID: installationID)
            if notificationInstallationID == installationID {
                notificationInstallationID = nil
            }
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanions() async throws -> [CompanionSummary] {
        do {
            let companions = try await client.listCompanions()
            await persistRollingAuthority()
            return companions
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func synchronizeRoster() async throws -> CompanionSyncMeasurement<CompanionRosterSnapshot> {
        guard let session = currentSession,
              let scope = Self.cacheScope(for: session) else {
            throw APIError(status: 401, code: "unauthorized", message: "Sign in again to continue.")
        }
        rosterSyncGeneration &+= 1
        let generation = rosterSyncGeneration
        let capturedSessionScopeGeneration = sessionScopeGeneration
        let baseline = initialRosterSnapshot ?? (try? cache?.roster(scope: scope))
        var response: CompanionSyncMeasurement<CompanionRosterDelta>
        do {
            response = try await authenticated(
                expectedScope: scope,
                expectedSessionScopeGeneration: capturedSessionScopeGeneration
            ) {
                try await client.synchronizeCompanionRoster(cursor: baseline?.cursor)
            }
        } catch let error as APIError where error.status == 400 && baseline?.cursor != nil {
            response = try await authenticated(
                expectedScope: scope,
                expectedSessionScopeGeneration: capturedSessionScopeGeneration
            ) {
                try await client.synchronizeCompanionRoster(cursor: nil)
            }
        }
        let snapshot: CompanionRosterSnapshot
        do {
            snapshot = try response.value.applying(to: baseline)
        } catch CompanionSyncMergeError.incompleteRoster where baseline?.cursor != nil {
            let replacement = try await authenticated(
                expectedScope: scope,
                expectedSessionScopeGeneration: capturedSessionScopeGeneration
            ) {
                try await client.synchronizeCompanionRoster(cursor: nil)
            }
            response = CompanionSyncMeasurement(
                value: replacement.value,
                receivedBytes: response.receivedBytes + replacement.receivedBytes,
                networkMilliseconds: response.networkMilliseconds + replacement.networkMilliseconds
            )
            snapshot = try response.value.applying(to: nil)
        }
        guard generation == rosterSyncGeneration,
              capturedSessionScopeGeneration == sessionScopeGeneration,
              currentSession.flatMap(Self.cacheScope(for:)) == scope else {
            throw CancellationError()
        }
        if let cache {
            // The cache is an offline acceleration layer. A full roster remains usable when the
            // device cannot persist it (for example, a full disk or a snapshot over the byte cap).
            // Do not turn a successful authoritative refresh into an app-visible sync failure.
            try? await Task.detached(priority: .utility) {
                try cache.saveRoster(snapshot, scope: scope)
            }.value
        }
        guard generation == rosterSyncGeneration,
              capturedSessionScopeGeneration == sessionScopeGeneration,
              currentSession.flatMap(Self.cacheScope(for:)) == scope else {
            throw CancellationError()
        }
        initialRosterSnapshot = snapshot
        return CompanionSyncMeasurement(
            value: snapshot,
            receivedBytes: response.receivedBytes,
            networkMilliseconds: response.networkMilliseconds
        )
    }

    public func connectedResources(for companion: CompanionSummary) async throws -> CompanionConnectedResources {
        do {
            let resources = try await client.connectedResources(
                companionID: companion.id,
                selectedSkillIDs: companion.selectedSkillIDs
            )
            await persistRollingAuthority()
            return resources
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionRoutines(companionID: String) async throws -> [CompanionRoutine] {
        do {
            let routines = try await client.listCompanionRoutines(companionID: companionID)
            await persistRollingAuthority()
            return routines
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionRoutineRuns(
        companionID: String,
        routineID: String,
        limit: Int = 50,
        cursor: String? = nil
    ) async throws -> CompanionRoutineRunList {
        do {
            let runs = try await client.listCompanionRoutineRuns(
                companionID: companionID,
                routineID: routineID,
                limit: limit,
                cursor: cursor
            )
            await persistRollingAuthority()
            return runs
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func readCompanionRoutineRun(
        companionID: String,
        runID: String,
        entryLimit: Int = 50,
        entryCursor: Int? = nil
    ) async throws -> CompanionRoutineRunDetail {
        do {
            let run = try await client.readCompanionRoutineRun(
                companionID: companionID,
                runID: runID,
                entryLimit: entryLimit,
                entryCursor: entryCursor
            )
            await persistRollingAuthority()
            return run
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionTriggers(companionID: String) async throws -> [CompanionTrigger] {
        do {
            let triggers = try await client.listCompanionTriggers(companionID: companionID)
            await persistRollingAuthority()
            return triggers
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func createCompanionRoutine(
        companionID: String,
        input: CreateCompanionRoutineInput
    ) async throws -> CompanionRoutine {
        do {
            let routine = try await client.createCompanionRoutine(companionID: companionID, input: input)
            await persistRollingAuthority()
            return routine
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func updateCompanionRoutine(
        companionID: String,
        routineID: String,
        input: UpdateCompanionRoutineInput
    ) async throws -> CompanionRoutine {
        do {
            let routine = try await client.updateCompanionRoutine(
                companionID: companionID,
                routineID: routineID,
                input: input
            )
            await persistRollingAuthority()
            return routine
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanionRoutine(companionID: String, routineID: String) async throws {
        do {
            try await client.deleteCompanionRoutine(companionID: companionID, routineID: routineID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func createCompanionTrigger(
        companionID: String,
        input: CreateCompanionTriggerInput
    ) async throws -> CompanionTrigger {
        do {
            let trigger = try await client.createCompanionTrigger(companionID: companionID, input: input)
            await persistRollingAuthority()
            return trigger
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func updateCompanionTrigger(
        companionID: String,
        triggerID: String,
        input: UpdateCompanionTriggerInput
    ) async throws -> CompanionTrigger {
        do {
            let trigger = try await client.updateCompanionTrigger(
                companionID: companionID,
                triggerID: triggerID,
                input: input
            )
            await persistRollingAuthority()
            return trigger
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanionTrigger(companionID: String, triggerID: String) async throws {
        do {
            try await client.deleteCompanionTrigger(companionID: companionID, triggerID: triggerID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func rotateCompanionTriggerSecret(
        companionID: String,
        triggerID: String
    ) async throws -> CompanionTrigger {
        do {
            let trigger = try await client.rotateCompanionTriggerSecret(
                companionID: companionID,
                triggerID: triggerID
            )
            await persistRollingAuthority()
            return trigger
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func retryCompanionTriggerRegistration(
        companionID: String,
        triggerID: String
    ) async throws -> CompanionTrigger {
        do {
            let trigger = try await client.retryCompanionTriggerRegistration(
                companionID: companionID,
                triggerID: triggerID
            )
            await persistRollingAuthority()
            return trigger
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionTriggerRuns(
        companionID: String,
        triggerID: String,
        limit: Int = 50,
        cursor: String? = nil
    ) async throws -> CompanionTriggerRunList {
        do {
            let runs = try await client.listCompanionTriggerRuns(
                companionID: companionID,
                triggerID: triggerID,
                limit: limit,
                cursor: cursor
            )
            await persistRollingAuthority()
            return runs
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func readCompanionTriggerRun(
        companionID: String,
        runID: String,
        entryLimit: Int = 50,
        entryCursor: Int? = nil
    ) async throws -> CompanionTriggerRunDetail {
        do {
            let run = try await client.readCompanionTriggerRun(
                companionID: companionID,
                runID: runID,
                entryLimit: entryLimit,
                entryCursor: entryCursor
            )
            await persistRollingAuthority()
            return run
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func createCompanion(_ input: CreateCompanionInput) async throws -> CompanionSummary {
        do {
            let companion = try await client.createCompanion(input)
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionSections() async throws -> [CompanionSection] {
        try await authenticated { try await client.listCompanionSections() }
    }

    public func userAvatarData(at pathOrURL: String) async throws -> Data {
        try await authenticated { try await client.userAvatarData(at: pathOrURL) }
    }

    public func createCompanionSection(name: String) async throws -> CompanionSection {
        try await authenticated { try await client.createCompanionSection(name: name) }
    }

    public func updateCompanionSection(sectionID: String, name: String) async throws -> CompanionSection {
        try await authenticated {
            try await client.updateCompanionSection(sectionID: sectionID, name: name)
        }
    }

    public func deleteCompanionSection(sectionID: String) async throws {
        try await authenticated { try await client.deleteCompanionSection(sectionID: sectionID) }
    }

    public func reorderCompanionSections(sectionIDs: [String]) async throws -> [CompanionSection] {
        try await authenticated { try await client.reorderCompanionSections(sectionIDs: sectionIDs) }
    }

    public func assignCompanionSection(
        companionID: String,
        sectionID: String?
    ) async throws -> CompanionSummary {
        try await authenticated {
            try await client.assignCompanionSection(companionID: companionID, sectionID: sectionID)
        }
    }

    public func updateCompanion(
        companionID: String,
        input: UpdateCompanionInput
    ) async throws -> CompanionSummary {
        do {
            let companion = try await client.updateCompanion(companionID: companionID, input: input)
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func updateCompanionMemberState(
        companionID: String,
        patch: CompanionMemberStatePatch
    ) async throws -> CompanionSummary {
        do {
            let companion = try await client.updateCompanionMemberState(
                companionID: companionID,
                patch: patch
            )
            if patch.unread == true {
                companionsMarkedRead.remove(companionID)
            } else if patch.unread == false {
                companionsMarkedRead.insert(companionID)
            }
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func duplicateCompanion(companionID: String) async throws -> CompanionSummary {
        do {
            let companion = try await client.duplicateCompanion(companionID: companionID)
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func updateCompanionPluginSelection(
        companionID: String,
        selectedMCPAccountIDs: [String]
    ) async throws -> CompanionSummary {
        do {
            let companion = try await client.updateCompanionPluginSelection(
                companionID: companionID,
                selectedMCPAccountIDs: selectedMCPAccountIDs
            )
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func companionRuntime(companionID: String) async throws -> CompanionSummary {
        do {
            let companion = try await client.companionRuntime(companionID: companionID)
            await persistRollingAuthority()
            return companion
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    /// Returns one in-memory desktop handoff for an already-running Companion Box. The URL is
    /// intentionally not cached in the session snapshot.
    public func openCompanionDesktop(companionID: String) async throws -> CompanionDesktop {
        do {
            let desktop = try await client.openCompanionDesktop(companionID: companionID)
            await persistRollingAuthority()
            return desktop
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func restartCompanion(
        companionID: String,
        target: CompanionRuntimeRestartTarget,
        requestID: UUID
    ) async throws -> CompanionOperationSummary {
        do {
            let operation = try await client.restartCompanion(
                companionID: companionID,
                target: target,
                requestID: requestID
            )
            await persistRollingAuthority()
            return operation
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanion(
        companionID: String,
        requestID: UUID
    ) async throws -> CompanionOperationSummary {
        do {
            let operation = try await client.deleteCompanion(
                companionID: companionID,
                requestID: requestID
            )
            await persistRollingAuthority()
            return operation
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionProviders() async throws -> CompanionProvidersResponse {
        do {
            let providers = try await client.listCompanionProviders()
            await persistRollingAuthority()
            return providers
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func transcribeCompanionAudio(
        companionID: String,
        audio: Data
    ) async throws -> CompanionTranscription {
        do {
            let transcription = try await client.transcribeCompanionAudio(
                companionID: companionID,
                audio: audio
            )
            await persistRollingAuthority()
            return transcription
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func saveCompanionProvider(
        providerID: String,
        credential: String
    ) async throws -> CompanionProviderConnection {
        do {
            let connection = try await client.saveCompanionProvider(
                providerID: providerID,
                credential: credential
            )
            await persistRollingAuthority()
            return connection
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func setDefaultCompanionProvider(providerID: String) async throws {
        do {
            try await client.setDefaultCompanionProvider(providerID: providerID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func deleteCompanionProvider(providerID: String) async throws {
        do {
            try await client.deleteCompanionProvider(providerID: providerID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func startCompanionProviderOAuth(
        providerID: String
    ) async throws -> CompanionProviderOAuthStart {
        do {
            let flow = try await client.startCompanionProviderOAuth(providerID: providerID)
            await persistRollingAuthority()
            return flow
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func completeCompanionProviderOAuth(
        authorizationCode: String
    ) async throws -> CompanionProviderConnection {
        do {
            let connection = try await client.completeCompanionProviderOAuth(
                authorizationCode: authorizationCode
            )
            await persistRollingAuthority()
            return connection
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func pollCompanionProviderOAuth() async throws -> CompanionProviderOAuthPoll {
        do {
            let result = try await client.pollCompanionProviderOAuth()
            await persistRollingAuthority()
            return result
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func cancelCompanionProviderOAuth() async {
        await client.cancelCompanionProviderOAuth()
    }

    public func listCompanionPlugins() async throws -> [CompanionPluginAccount] {
        do {
            let plugins = try await client.listCompanionPlugins()
            await persistRollingAuthority()
            return plugins
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listCompanionTriggerProviderAccounts() async throws -> [CompanionTriggerProviderAccount] {
        do {
            let accounts = try await client.listCompanionTriggerProviderAccounts()
            await persistRollingAuthority()
            return accounts
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func saveCompanionTriggerProviderAccount(
        _ input: CreateCompanionTriggerProviderAccountInput
    ) async throws -> CompanionTriggerProviderAccount {
        do {
            let account = try await client.saveCompanionTriggerProviderAccount(input)
            await persistRollingAuthority()
            return account
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func disconnectCompanionTriggerProviderAccount(
        accountID: String
    ) async throws -> CompanionTriggerProviderAccount {
        do {
            let account = try await client.disconnectCompanionTriggerProviderAccount(accountID: accountID)
            await persistRollingAuthority()
            return account
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func listAccessibleCompanionSkills() async throws -> [CompanionSkillReference] {
        do {
            let skills = try await client.listAccessibleCompanionSkills()
            await persistRollingAuthority()
            return skills
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func saveCompanionPlugin(
        _ input: SaveCompanionPluginInput
    ) async throws -> CompanionPluginAccount {
        do {
            let plugin = try await client.saveCompanionPlugin(input)
            await persistRollingAuthority()
            return plugin
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func startCompanionPluginOAuth(
        serverName: String,
        label: String
    ) async throws -> CompanionPluginOAuthStart {
        do {
            await client.cancelCompanionPluginOAuth()
            return try await client.startCompanionPluginOAuth(
                serverName: serverName,
                label: label
            )
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func completeCompanionPluginOAuth(callbackURL: URL) async throws {
        do {
            try await client.completeCompanionPluginOAuth(callbackURL: callbackURL)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func cancelCompanionPluginOAuth() async {
        await client.cancelCompanionPluginOAuth()
    }

    public func deleteCompanionPlugin(accountID: String) async throws {
        do {
            try await client.deleteCompanionPlugin(accountID: accountID)
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func thread(companionID: String) async throws -> CompanionThread {
        do {
            let snapshot = try await synchronizeThread(
                companionID: companionID,
                markRead: true
            ).value
            // Preserve the historical complete-thread contract for external callers. First-party
            // chat surfaces use synchronizeThread/loadOlderThreadWindow and never pay this drain.
            let thread: CompanionThread
            if snapshot.isPartial {
                thread = try await client.thread(companionID: companionID)
            } else {
                thread = snapshot.thread
            }
            await persistRollingAuthority()
            return thread
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func synchronizeThread(
        companionID: String,
        markRead: Bool = false
    ) async throws -> CompanionSyncMeasurement<CompanionThreadSnapshot> {
        guard let session = currentSession,
              let scope = Self.cacheScope(for: session) else {
            throw APIError(status: 401, code: "unauthorized", message: "Sign in again to continue.")
        }
        let generation = (threadSyncGenerations[companionID] ?? 0) &+ 1
        threadSyncGenerations[companionID] = generation
        let capturedSessionScopeGeneration = sessionScopeGeneration
        let baseline = liveThreadSnapshots[companionID]
            ?? (try? cache?.thread(scope: scope, companionID: companionID))
        let requestCursor = Self.transportSafeThreadCursor(baseline?.cursor)
        if requestCursor == nil {
            return try await bootstrapThreadWindow(
                companionID: companionID,
                scope: scope,
                generation: generation,
                sessionScopeGeneration: capturedSessionScopeGeneration,
                markRead: markRead
            )
        }
        var response: CompanionSyncMeasurement<CompanionThreadDelta>
        let responseBaseline: CompanionThreadSnapshot?
        do {
            response = try await authenticated(
                expectedScope: scope,
                expectedSessionScopeGeneration: capturedSessionScopeGeneration
            ) {
                try await client.synchronizeCompanionThread(
                    companionID: companionID,
                    cursor: requestCursor
                )
            }
            responseBaseline = baseline
        } catch let error as APIError where Self.shouldRetryThreadSyncWithoutCursor(
            error,
            requestCursor: requestCursor
        ) {
            return try await bootstrapThreadWindow(
                companionID: companionID,
                scope: scope,
                generation: generation,
                sessionScopeGeneration: capturedSessionScopeGeneration,
                markRead: markRead
            )
        }
        guard threadSyncGenerations[companionID] == generation,
              capturedSessionScopeGeneration == sessionScopeGeneration,
              currentSession.flatMap(Self.cacheScope(for:)) == scope else {
            throw CancellationError()
        }
        var snapshot = response.value.applying(to: responseBaseline)
        var receivedBytes = response.receivedBytes
        var networkMilliseconds = response.networkMilliseconds
        var receivedChanges = !response.value.changedEntries.isEmpty
        while response.value.hasMore == true {
            response = try await authenticated(
                expectedScope: scope,
                expectedSessionScopeGeneration: capturedSessionScopeGeneration
            ) {
                try await client.synchronizeCompanionThread(
                    companionID: companionID,
                    cursor: snapshot.cursor
                )
            }
            snapshot = response.value.applying(to: snapshot)
            receivedBytes += response.receivedBytes
            networkMilliseconds += response.networkMilliseconds
            receivedChanges = receivedChanges || !response.value.changedEntries.isEmpty
        }
        let rosterMarksUnread = initialRosterSnapshot?.companions.first {
            $0.id == companionID
        }?.unread == true
        let shouldMarkRead = markRead && (
            responseBaseline == nil
                || receivedChanges
                || (rosterMarksUnread && !companionsMarkedRead.contains(companionID))
        )
        if shouldMarkRead,
           (try? await authenticated(
               expectedScope: scope,
               expectedSessionScopeGeneration: capturedSessionScopeGeneration
           ) {
               try await client.updateCompanionMemberState(
                   companionID: companionID,
                   patch: CompanionMemberStatePatch(unread: false)
               )
           }) != nil {
            companionsMarkedRead.insert(companionID)
        }
        let committedSnapshot = snapshot
        if let cache {
            // A bounded top-level tail can still exceed the byte cap when one projected routine
            // group owns many hidden entries. Keep the complete fresh thread in memory even when
            // that optional offline snapshot cannot be written.
            try? await Task.detached(priority: .utility) {
                try cache.saveThread(committedSnapshot, scope: scope, companionID: companionID)
            }.value
        }
        guard threadSyncGenerations[companionID] == generation,
              capturedSessionScopeGeneration == sessionScopeGeneration,
              currentSession.flatMap(Self.cacheScope(for:)) == scope else {
            throw CancellationError()
        }
        liveThreadSnapshots[companionID] = committedSnapshot
        return CompanionSyncMeasurement(
            value: committedSnapshot,
            receivedBytes: receivedBytes,
            networkMilliseconds: networkMilliseconds
        )
    }

    private func bootstrapThreadWindow(
        companionID: String,
        scope: String,
        generation: Int,
        sessionScopeGeneration capturedSessionScopeGeneration: Int,
        markRead: Bool
    ) async throws -> CompanionSyncMeasurement<CompanionThreadSnapshot> {
        let snapshot: CompanionThreadSnapshot
        let receivedBytes: Int
        let networkMilliseconds: Double
        do {
            let response = try await authenticated(
                expectedScope: scope,
                expectedSessionScopeGeneration: capturedSessionScopeGeneration
            ) {
                try await client.companionThreadWindow(companionID: companionID)
            }
            snapshot = response.value.snapshot()
            receivedBytes = response.receivedBytes
            networkMilliseconds = response.networkMilliseconds
        } catch let error as APIError where error.status == 404
            || (error.status == 500 && error.code == "invalid_response") {
            // Rolling deploy: an older API has only the legacy full bootstrap on thread-delta.
            let response = try await authenticated(
                expectedScope: scope,
                expectedSessionScopeGeneration: capturedSessionScopeGeneration
            ) {
                try await client.synchronizeCompanionThread(companionID: companionID, cursor: nil)
            }
            snapshot = response.value.applying(to: nil)
            receivedBytes = response.receivedBytes
            networkMilliseconds = response.networkMilliseconds
        }
        guard threadSyncGenerations[companionID] == generation,
              capturedSessionScopeGeneration == sessionScopeGeneration,
              currentSession.flatMap(Self.cacheScope(for:)) == scope else {
            throw CancellationError()
        }
        if markRead { companionsMarkedRead.insert(companionID) }
        if let cache {
            try? await Task.detached(priority: .utility) {
                try cache.saveThread(snapshot, scope: scope, companionID: companionID)
            }.value
        }
        guard threadSyncGenerations[companionID] == generation,
              capturedSessionScopeGeneration == sessionScopeGeneration,
              currentSession.flatMap(Self.cacheScope(for:)) == scope else {
            throw CancellationError()
        }
        liveThreadSnapshots[companionID] = snapshot
        return CompanionSyncMeasurement(
            value: snapshot,
            receivedBytes: receivedBytes,
            networkMilliseconds: networkMilliseconds
        )
    }

    public func loadOlderThreadWindow(
        companionID: String
    ) async throws -> CompanionSyncMeasurement<CompanionThreadSnapshot>? {
        guard let session = currentSession,
              let scope = Self.cacheScope(for: session) else {
            throw APIError(status: 401, code: "unauthorized", message: "Sign in again to continue.")
        }
        guard let baseline = liveThreadSnapshots[companionID]
                ?? ((try? cache?.thread(scope: scope, companionID: companionID)) ?? nil),
              let before = baseline.olderCursor else { return nil }
        let capturedSessionScopeGeneration = sessionScopeGeneration
        let response = try await authenticated(
            expectedScope: scope,
            expectedSessionScopeGeneration: capturedSessionScopeGeneration
        ) {
            try await client.companionThreadWindow(companionID: companionID, before: before)
        }
        guard capturedSessionScopeGeneration == sessionScopeGeneration,
              currentSession.flatMap(Self.cacheScope(for:)) == scope else {
            throw CancellationError()
        }
        var byID = Dictionary(
            uniqueKeysWithValues: companionExpandedRoutineNotifyEntries(
                baseline.thread.entries
            ).map { ($0.eventID, $0) }
        )
        response.value.entries.forEach { byID[$0.eventID] = $0 }
        let ordered = byID.values.sorted {
            $0.ordinal == $1.ordinal ? $0.eventID < $1.eventID : $0.ordinal < $1.ordinal
        }
        let mergedNotifyReturns = companionMergedRoutineNotifyReturns(
            existing: baseline.notifyReturns ?? [],
            changed: response.value.notifyReturns,
            entries: ordered
        )
        let snapshot = CompanionThreadSnapshot(
            cursor: baseline.cursor,
            thread: response.value.thread.thread(entries: companionCollapsedRoutineNotifyEntries(
                ordered,
                notifyReturns: mergedNotifyReturns
            )),
            isPartial: response.value.olderCursor != nil,
            olderCursor: response.value.olderCursor,
            notifyReturns: mergedNotifyReturns
        )
        liveThreadSnapshots[companionID] = snapshot
        if let cache {
            try? await Task.detached(priority: .utility) {
                try cache.saveThread(snapshot, scope: scope, companionID: companionID)
            }.value
        }
        return CompanionSyncMeasurement(
            value: snapshot,
            receivedBytes: response.receivedBytes,
            networkMilliseconds: response.networkMilliseconds
        )
    }

    private static func transportSafeThreadCursor(_ cursor: String?) -> String? {
        guard let cursor, cursor.utf8.count <= maximumThreadCursorRequestBytes else { return nil }
        return cursor
    }

    private static func shouldRetryThreadSyncWithoutCursor(
        _ error: APIError,
        requestCursor: String?
    ) -> Bool {
        requestCursor != nil && [400, 414, 431].contains(error.status)
    }

    public func decideCompanionDecision(
        companionID: String,
        requestID: String,
        action: CompanionDecisionAction
    ) async throws -> CompanionThread {
        do {
            let thread = try await client.decideCompanionDecision(
                companionID: companionID,
                requestID: requestID,
                action: action
            )
            await persistRollingAuthority()
            return thread
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func retryCompanionTurn(
        companionID: String,
        turnID: String,
        retryID: UUID
    ) async throws -> CompanionOperationSummary {
        do {
            let operation = try await client.retryCompanionTurn(
                companionID: companionID,
                turnID: turnID,
                retryID: retryID
            )
            await persistRollingAuthority()
            return operation
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func cancelCompanionTurn(
        companionID: String,
        turnID: String
    ) async throws -> CompanionThread {
        do {
            let thread = try await client.cancelCompanionTurn(
                companionID: companionID,
                turnID: turnID
            )
            await persistRollingAuthority()
            return thread
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func sendMessage(
        companionID: String,
        content: String,
        clientMessageID: UUID,
        attachments: [CompanionMessageAttachment] = [],
        uploadProgress: (@Sendable (Double) -> Void)? = nil
    ) async throws {
        do {
            try await client.sendMessage(
                companionID: companionID,
                content: content,
                clientMessageID: clientMessageID,
                attachments: attachments,
                uploadProgress: uploadProgress
            )
            await persistRollingAuthority()
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    public func attachmentData(companionID: String, attachmentID: String) async throws -> Data {
        do {
            let data = try await client.attachmentData(
                companionID: companionID,
                attachmentID: attachmentID
            )
            await persistRollingAuthority()
            return data
        } catch let error as APIError where error.status == 401 {
            await clearLocalSession()
            throw error
        }
    }

    private func publish(_ session: Session) {
        let nextPhase = session.needsOnboarding ? Phase.onboarding(session) : .active(session)
        guard phase != nextPhase else { return }
        let previousScope = currentSession.flatMap(Self.cacheScope(for:))
        let nextScope = Self.cacheScope(for: session)
        if previousScope != nextScope {
            sessionScopeGeneration &+= 1
            rosterSyncGeneration &+= 1
            if let nextScope {
                initialRosterSnapshot = (try? cache?.roster(scope: nextScope)) ?? nil
            } else {
                initialRosterSnapshot = nil
            }
            liveThreadSnapshots.removeAll()
            threadSyncGenerations.removeAll()
            companionsMarkedRead.removeAll()
            pendingCompanionInvalidations.removeAll()
        }
        phase = nextPhase
    }

    private func retainCompleteThread(_ thread: CompanionThread, companionID: String) {
        guard thread.companionID == companionID,
              let session = currentSession,
              let scope = Self.cacheScope(for: session),
              let baseline = liveThreadSnapshots[companionID]
                ?? ((try? cache?.thread(scope: scope, companionID: companionID)) ?? nil),
              let cursor = baseline.cursor else { return }
        threadSyncGenerations[companionID] = (threadSyncGenerations[companionID] ?? 0) &+ 1
        liveThreadSnapshots[companionID] = CompanionThreadSnapshot(
            cursor: cursor,
            thread: thread,
            isPartial: false
        )
    }

    private static func cacheScope(for session: Session) -> String? {
        guard let orgID = session.orgID, !orgID.isEmpty, !session.user.id.isEmpty else { return nil }
        return "\(orgID):\(session.user.id)"
    }

    private func authenticated<Value>(
        expectedScope: String? = nil,
        expectedSessionScopeGeneration: Int? = nil,
        _ operation: () async throws -> Value
    ) async throws -> Value {
        let capturedScope = expectedScope ?? currentSession.flatMap(Self.cacheScope(for:))
        let capturedSessionScopeGeneration = expectedSessionScopeGeneration ?? sessionScopeGeneration
        let capturedAuthorityCookie = currentSession?.cookie
        do {
            let value = try await operation()
            await persistRollingAuthority()
            return value
        } catch let error as APIError where error.status == 401 {
            let activeAuthorityCookie = await client.currentAuthority()?.cookie
            if sessionScopeGeneration != capturedSessionScopeGeneration
                || currentSession.flatMap(Self.cacheScope(for:)) != capturedScope
                || activeAuthorityCookie != capturedAuthorityCookie {
                throw CancellationError()
            }
            await clearLocalSession()
            throw error
        }
    }

    private func persist(_ session: Session) throws {
        try storage.save(encoder.encode(session))
        persistedSession = session
    }

    private func persistRollingAuthority() async {
        guard let authority = await client.currentAuthority() else { return }
        if persistedSession != authority {
            try? persist(authority)
        }
        publish(authority)
    }

    private func clearLocalSession() async {
        let scope = currentSession.flatMap { Self.cacheScope(for: $0) }
        sessionScopeGeneration &+= 1
        rosterSyncGeneration &+= 1
        try? storage.remove()
        if let scope { try? cache?.remove(scope: scope) }
        persistedSession = nil
        initialRosterSnapshot = nil
        liveThreadSnapshots.removeAll()
        threadSyncGenerations.removeAll()
        companionsMarkedRead.removeAll()
        pendingCompanionInvalidations.removeAll()
        await client.setAuthority(nil)
        bootstrapError = nil
        phase = .signedOut
    }
}

private extension Duration {
    var companionMilliseconds: Double {
        let parts = components
        return (Double(parts.seconds) * 1_000) + (Double(parts.attoseconds) / 1_000_000_000_000_000)
    }
}
