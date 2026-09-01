import Foundation

public struct WorkspaceIdentity: Codable, Equatable, Sendable {
    public let id: String
    public let name: String

    enum CodingKeys: String, CodingKey {
        case id = "org_id"
        case name
    }
}

public struct WhoAmI: Codable, Equatable, Sendable {
    public let userID: String
    public let email: String
    public let name: String?
    public let avatarURL: String?
    public let timezone: String?
    public let org: WorkspaceIdentity?
    public let onboarded: Bool
    public let needsOnboarding: Bool

    enum CodingKeys: String, CodingKey {
        case userID = "userId"
        case email
        case name
        case avatarURL = "avatarUrl"
        case timezone
        case org
        case onboarded
        case needsOnboarding
    }

    public init(
        userID: String,
        email: String,
        name: String?,
        avatarURL: String? = nil,
        org: WorkspaceIdentity?,
        onboarded: Bool,
        needsOnboarding: Bool,
        timezone: String? = nil
    ) {
        self.userID = userID
        self.email = email
        self.name = name
        self.avatarURL = avatarURL
        self.org = org
        self.onboarded = onboarded
        self.needsOnboarding = needsOnboarding
        self.timezone = timezone
    }
}

public struct Session: Codable, Equatable, Sendable {
    public let cookie: String
    public let orgID: String?
    public let needsOnboarding: Bool
    public let user: User

    public struct User: Codable, Equatable, Sendable {
        public let id: String
        public let email: String
        public let name: String?
        public let avatarURL: String?
        public let timezone: String?

        public init(
            id: String,
            email: String,
            name: String?,
            avatarURL: String? = nil,
            timezone: String? = nil
        ) {
            self.id = id
            self.email = email
            self.name = name
            self.avatarURL = avatarURL
            self.timezone = timezone
        }
    }

    public init(cookie: String, orgID: String?, needsOnboarding: Bool, user: User) {
        self.cookie = cookie
        self.orgID = orgID
        self.needsOnboarding = needsOnboarding
        self.user = user
    }

    public init(cookie: String, identity: WhoAmI) {
        self.init(
            cookie: cookie,
            orgID: identity.org?.id,
            needsOnboarding: identity.needsOnboarding || identity.org == nil,
            user: User(
                id: identity.userID,
                email: identity.email,
                name: identity.name,
                avatarURL: identity.avatarURL,
                timezone: identity.timezone
            )
        )
    }
}

/// Self-service profile fields accepted by the shared `PUT /v1/users/me` endpoint.
/// Optional values are omitted rather than encoded as null so partial updates remain safe.
public struct UpdateUserProfileInput: Encodable, Equatable, Sendable {
    public let name: String?
    public let timezone: String?

    public init(name: String? = nil, timezone: String? = nil) {
        self.name = name
        self.timezone = timezone
    }

    enum CodingKeys: String, CodingKey {
        case name
        case timezone
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encodeIfPresent(timezone, forKey: .timezone)
    }
}

public struct UserProfile: Codable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let initials: String
    public let timezone: String?

    public init(id: String, name: String, initials: String, timezone: String?) {
        self.id = id
        self.name = name
        self.initials = initials
        self.timezone = timezone
    }
}

public enum CompanionNotificationEvent: String, Codable, Equatable, Sendable {
    case reply
    case inputRequired = "input_required"
    case failed
    case interrupted
}

public struct CompanionNotificationPayload: Codable, Equatable, Sendable {
    public let version: Int
    public let orgID: String
    public let companionID: String
    public let event: CompanionNotificationEvent

    public init(version: Int, orgID: String, companionID: String, event: CompanionNotificationEvent) {
        self.version = version
        self.orgID = orgID
        self.companionID = companionID
        self.event = event
    }

    enum CodingKeys: String, CodingKey {
        case version
        case orgID = "org_id"
        case companionID = "companion_id"
        case event
    }
}

public struct NotificationDeviceRegistration: Codable, Equatable, Sendable {
    public enum Environment: String, Codable, Equatable, Sendable {
        case sandbox
        case production
    }

    public let platform = "ios"
    public let deviceToken: String
    public let environment: Environment
    public let bundleID: String

    public init(deviceToken: String, environment: Environment, bundleID: String) {
        self.deviceToken = deviceToken
        self.environment = environment
        self.bundleID = bundleID
    }

    enum CodingKeys: String, CodingKey {
        case platform
        case deviceToken = "device_token"
        case environment
        case bundleID = "bundle_id"
    }
}

public enum NotificationInstallationIdentifier {
    public static func current(bundleIdentifier: String) -> UUID {
        let key = "dev.companion.notification-installation.\(bundleIdentifier)"
        if let value = UserDefaults.standard.string(forKey: key), let identifier = UUID(uuidString: value) {
            return identifier
        }
        let identifier = UUID()
        UserDefaults.standard.set(identifier.uuidString.lowercased(), forKey: key)
        return identifier
    }
}

public enum CompanionRuntimeState: String, Codable, Hashable, Sendable {
    case notCreated = "not_created"
    case provisioning
    case running
    case stopping
    case stopped
    case error
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionDaemonState: String, Codable, Hashable, Sendable {
    case unknown
    case starting
    case running
    case stopped
    case error

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionRuntimeRestartTarget: String, Codable, Equatable, Hashable, Sendable {
    case pi
    case box
}

/// The transport used by a freshly minted Box desktop stream.
public enum CompanionDesktopTransport: String, Codable, Equatable, Hashable, Sendable {
    case vnc
    case webrtc
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

/// One short-lived, authorized handoff to the Companion's existing Box desktop.
///
/// The URL is secret-bearing and must stay in memory only. Each request mints a new stream; clients
/// must never persist or log it, and opening desktop access never wakes a stopped Box.
public struct CompanionDesktop: Codable, Equatable, Sendable {
    public let desktopURL: URL?
    public let provisioning: Bool
    public let automation: String
    public let transport: CompanionDesktopTransport?

    enum CodingKeys: String, CodingKey {
        case desktopURL = "desktop_url"
        case provisioning
        case automation
        case transport
    }
}

public enum CompanionAccess: String, Codable, Hashable, Sendable {
    case owner
    case editor
    case viewer

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .viewer
    }

    public var canEditCompanionSettings: Bool {
        self == .owner || self == .editor
    }

    public var canDeleteCompanion: Bool {
        self == .owner
    }
}

public enum CompanionOperationKind: String, Codable, Hashable, Sendable {
    case delete
    case stop
    case restartPi = "restart_pi"
    case restartBox = "restart_box"
    case start
    case applySettings = "apply_settings"
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionOperationStatus: String, Codable, Hashable, Sendable {
    case pending
    case running
    case succeeded
    case failed
    case interrupted
    case cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct CompanionRuntimeSafeError: Codable, Hashable, Sendable {
    public let code: String
    public let message: String
    public let action: String
}

public struct CompanionOperationSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let sourceTurnID: String?
    public let kind: CompanionOperationKind
    public let status: CompanionOperationStatus
    public let error: CompanionRuntimeSafeError?

    enum CodingKeys: String, CodingKey {
        case id
        case sourceTurnID = "source_turn_id"
        case kind
        case status
        case error
    }

    public var isActive: Bool {
        status == .pending || status == .running
    }
}

public struct CompanionSummary: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let persona: String?
    public let modelID: String?
    public let selectedSkillIDs: [String]
    public let selectedMCPAccountIDs: [String]
    public let icon: Icon?
    public let sectionID: String?
    public let access: CompanionAccess
    public let pinned: Bool
    public let hidden: Bool
    public let muted: Bool
    public let unread: Bool
    public let lastMessage: LastMessage?
    public let runtime: Runtime

    public struct LastMessage: Codable, Hashable, Sendable {
        public let preview: String
        public let role: String
        public let createdAt: String

        enum CodingKeys: String, CodingKey {
            case preview
            case role
            case createdAt = "created_at"
        }
    }

    public struct Icon: Codable, Hashable, Sendable {
        public let shape: Int
        public let mouth: Int
        public let accessory: Int
        public let color: Int

        public init(shape: Int, mouth: Int, accessory: Int, color: Int) {
            self.shape = shape
            self.mouth = mouth
            self.accessory = accessory
            self.color = color
        }
    }

    public struct Runtime: Codable, Hashable, Sendable {
        public let state: CompanionRuntimeState
        public let daemonState: CompanionDaemonState
        public let replying: Bool
        public let lastError: String?
        public let providerIDs: [String]
        public let latestOperation: CompanionOperationSummary?

        enum CodingKeys: String, CodingKey {
            case state
            case daemonState = "daemon_state"
            case replying
            case lastError = "last_error"
            case providerIDs = "provider_ids"
            case latestOperation = "latest_operation"
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            state = try container.decode(CompanionRuntimeState.self, forKey: .state)
            daemonState = try container.decodeIfPresent(CompanionDaemonState.self, forKey: .daemonState) ?? .unknown
            replying = try container.decodeIfPresent(Bool.self, forKey: .replying) ?? false
            lastError = try container.decodeIfPresent(String.self, forKey: .lastError)
            providerIDs = try container.decodeIfPresent([String].self, forKey: .providerIDs) ?? []
            latestOperation = try container.decodeIfPresent(
                CompanionOperationSummary.self,
                forKey: .latestOperation
            )
        }

    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case persona
        case modelID = "model_id"
        case selectedSkillIDs = "selected_skill_ids"
        case selectedMCPAccountIDs = "selected_mcp_account_ids"
        case icon
        case sectionID = "section_id"
        case access
        case pinned
        case hidden
        case muted
        case unread
        case lastMessage = "last_message"
        case runtime
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        persona = try container.decodeIfPresent(String.self, forKey: .persona)
        modelID = try container.decodeIfPresent(String.self, forKey: .modelID)
        selectedSkillIDs = try container.decodeIfPresent([String].self, forKey: .selectedSkillIDs) ?? []
        selectedMCPAccountIDs = try container.decodeIfPresent([String].self, forKey: .selectedMCPAccountIDs) ?? []
        icon = try container.decodeIfPresent(Icon.self, forKey: .icon)
        sectionID = try container.decodeIfPresent(String.self, forKey: .sectionID)
        access = try container.decodeIfPresent(CompanionAccess.self, forKey: .access) ?? .viewer
        pinned = try container.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        hidden = try container.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
        muted = try container.decodeIfPresent(Bool.self, forKey: .muted) ?? false
        unread = try container.decodeIfPresent(Bool.self, forKey: .unread) ?? false
        lastMessage = try container.decodeIfPresent(LastMessage.self, forKey: .lastMessage)
        runtime = try container.decode(Runtime.self, forKey: .runtime)
    }

    public var deletionOperation: CompanionOperationSummary? {
        guard runtime.latestOperation?.kind == .delete else { return nil }
        return runtime.latestOperation
    }

    public func preservingListProjection(from previous: CompanionSummary) -> CompanionSummary {
        CompanionSummary(
            id: id,
            name: name,
            persona: persona,
            modelID: modelID,
            selectedSkillIDs: selectedSkillIDs,
            selectedMCPAccountIDs: selectedMCPAccountIDs,
            icon: icon,
            sectionID: sectionID,
            access: access,
            pinned: pinned,
            hidden: hidden,
            muted: muted,
            unread: unread,
            lastMessage: lastMessage ?? previous.lastMessage,
            runtime: runtime
        )
    }

    public func reconcilingParentProjection(from previous: CompanionSummary) -> CompanionSummary {
        let incomingOperationID = runtime.latestOperation?.id
        let previousOperation = previous.runtime.latestOperation
        let parentRuntimeIsStale = previousOperation?.isActive == true
            && incomingOperationID != previousOperation?.id
        return CompanionSummary(
            id: id,
            name: name,
            persona: persona,
            modelID: modelID,
            selectedSkillIDs: selectedSkillIDs,
            selectedMCPAccountIDs: selectedMCPAccountIDs,
            icon: icon,
            sectionID: sectionID,
            access: access,
            pinned: pinned,
            hidden: hidden,
            muted: muted,
            unread: unread,
            lastMessage: lastMessage,
            runtime: parentRuntimeIsStale ? previous.runtime : runtime
        )
    }

    private init(
        id: String,
        name: String,
        persona: String?,
        modelID: String?,
        selectedSkillIDs: [String],
        selectedMCPAccountIDs: [String],
        icon: Icon?,
        sectionID: String?,
        access: CompanionAccess,
        pinned: Bool,
        hidden: Bool,
        muted: Bool,
        unread: Bool,
        lastMessage: LastMessage?,
        runtime: Runtime
    ) {
        self.id = id
        self.name = name
        self.persona = persona
        self.modelID = modelID
        self.selectedSkillIDs = selectedSkillIDs
        self.selectedMCPAccountIDs = selectedMCPAccountIDs
        self.icon = icon
        self.sectionID = sectionID
        self.access = access
        self.pinned = pinned
        self.hidden = hidden
        self.muted = muted
        self.unread = unread
        self.lastMessage = lastMessage
        self.runtime = runtime
    }
}

public struct CompanionSection: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let orgID: String
    public let ownerID: String
    public let name: String
    public let position: Int
    public let createdAt: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case orgID = "org_id"
        case ownerID = "owner_id"
        case name
        case position
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct CompanionSectionNameInput: Codable, Equatable, Sendable {
    public let name: String

    public init(name: String) { self.name = name }
}

public struct CompanionSectionAssignmentInput: Codable, Equatable, Sendable {
    public let sectionID: String?

    public init(sectionID: String?) { self.sectionID = sectionID }

    enum CodingKeys: String, CodingKey {
        case sectionID = "section_id"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sectionID = try container.decodeIfPresent(String.self, forKey: .sectionID)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        // An explicit JSON null is the API's unassign operation. Synthesized Codable would
        // omit this optional key when sectionID is nil, which is a different request shape.
        try container.encode(sectionID, forKey: .sectionID)
    }
}

public struct CompanionSectionReorderInput: Codable, Equatable, Sendable {
    public let sectionIDs: [String]

    public init(sectionIDs: [String]) { self.sectionIDs = sectionIDs }

    enum CodingKeys: String, CodingKey {
        case sectionIDs = "section_ids"
    }
}

public struct CompanionMemberStatePatch: Codable, Equatable, Sendable {
    public let pinned: Bool?
    public let hidden: Bool?
    public let muted: Bool?
    public let unread: Bool?

    public init(
        pinned: Bool? = nil,
        hidden: Bool? = nil,
        muted: Bool? = nil,
        unread: Bool? = nil
    ) {
        self.pinned = pinned
        self.hidden = hidden
        self.muted = muted
        self.unread = unread
    }
}

public enum CompanionConnectedResourceStatus: String, Equatable, Sendable {
    case active
    case disabled
    case error

    public var label: String {
        switch self {
        case .active: "Active"
        case .disabled: "Disabled"
        case .error: "Error"
        }
    }
}

public struct CompanionSkillSummary: Codable, Identifiable, Equatable, Sendable {
    public struct Display: Codable, Equatable, Sendable {
        public let name: String?
    }

    public let id: String
    public let slug: String
    public let description: String
    public let display: Display?

    public var displayName: String {
        guard let name = display?.name?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty else {
            return slug
        }
        return name
    }
}

public struct CompanionRoutine: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let companionID: String?
    public let name: String
    /// The prompt is present on the API projection and is optional here for compatibility with
    /// older cached projections that only carried the resource summary.
    public let prompt: String?
    public let cron: String
    public let timezone: String
    public let enabled: Bool
    public let nextFireAt: String?
    public let lastFiredAt: String?
    public let lastErrorCode: String?
    public let lastErrorMessage: String?

    enum CodingKeys: String, CodingKey {
        case id
        case companionID = "companion_id"
        case name
        case prompt
        case cron
        case timezone
        case enabled
        case nextFireAt = "next_fire_at"
        case lastFiredAt = "last_fired_at"
        case lastErrorCode = "last_error_code"
        case lastErrorMessage = "last_error_message"
    }

    public init(
        id: String,
        name: String,
        cron: String,
        timezone: String,
        enabled: Bool,
        nextFireAt: String?,
        lastErrorMessage: String?,
        companionID: String? = nil,
        prompt: String? = nil,
        lastFiredAt: String? = nil,
        lastErrorCode: String? = nil
    ) {
        self.id = id
        self.companionID = companionID
        self.name = name
        self.prompt = prompt
        self.cron = cron
        self.timezone = timezone
        self.enabled = enabled
        self.nextFireAt = nextFireAt
        self.lastFiredAt = lastFiredAt
        self.lastErrorCode = lastErrorCode
        self.lastErrorMessage = lastErrorMessage
    }

    public var status: CompanionConnectedResourceStatus {
        if !enabled { return .disabled }
        return lastErrorMessage == nil ? .active : .error
    }

    /// A concise, truthful label for common five-field schedules. The literal cron remains visible
    /// beside this label, so an unfamiliar expression is never guessed at or hidden.
    public var scheduleDescription: String {
        let fields = cron.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard fields.count == 5 else { return "Custom schedule" }
        let minute = fields[0]
        let hour = fields[1]
        let dayOfMonth = fields[2]
        let month = fields[3]
        let dayOfWeek = fields[4]

        guard dayOfMonth == "*", month == "*" else { return "Custom schedule" }
        if hour == "*", dayOfWeek == "*" {
            if minute == "0" { return "Every hour" }
            if minute.hasPrefix("*/"), let interval = Int(minute.dropFirst(2)), interval > 0 {
                return "Every \(interval) minutes"
            }
        }

        guard let hourValue = Int(hour), (0...23).contains(hourValue),
              let minuteValue = Int(minute), (0...59).contains(minuteValue) else {
            return "Custom schedule"
        }
        let time = String(format: "%02d:%02d", hourValue, minuteValue)
        switch dayOfWeek {
        case "*": return "Every day at \(time)"
        case "1-5": return "Weekdays at \(time)"
        case "0,6", "6,0": return "Weekends at \(time)"
        default:
            let names = ["0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday",
                         "4": "Thursday", "5": "Friday", "6": "Saturday", "7": "Sunday"]
            if let name = names[dayOfWeek] { return "Every \(name) at \(time)" }
            return "Custom schedule"
        }
    }
}

/// The durable lifecycle of one scheduled routine fire. This intentionally follows the shared
/// turn status vocabulary so history can describe a run without knowing anything about Box/Pi.
public enum CompanionRoutineRunStatus: String, Codable, Equatable, Hashable, Sendable {
    case queued
    case starting
    case dispatching
    case running
    case needsInput = "needs_input"
    case succeeded
    case failed
    case interrupted
    case cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

/// The private routine execution result. A silent completion is distinct from surfaced output.
public enum CompanionRoutineRunOutcome: String, Codable, Equatable, Hashable, Sendable {
    case pending
    case noOutput = "no_output"
    case surfaced
    case error
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionRoutineSurfaceMode: String, Codable, Equatable, Hashable, Sendable {
    case relay
    case notify
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

/// Immutable routine identity carried by history and transcript markers.
public struct CompanionRoutineIdentitySnapshot: Codable, Equatable, Hashable, Sendable {
    public let id: String?
    public let name: String

    public init(id: String?, name: String) {
        self.id = id
        self.name = name
    }
}

/// One bounded internal event from a routine's private transcript.
public struct CompanionRoutineRunEntry: Codable, Identifiable, Equatable, Sendable {
    public let eventID: String
    public let ordinal: Int
    public let role: String
    public let content: String
    public let reasoning: String?
    public let tool: CompanionToolRun?
    public let decision: CompanionDecision?
    public let createdAt: String

    public var id: String { eventID }

    enum CodingKeys: String, CodingKey {
        case eventID = "event_id"
        case ordinal
        case role
        case content
        case reasoning
        case tool
        case decision
        case createdAt = "created_at"
    }

    public init(
        eventID: String,
        ordinal: Int,
        role: String,
        content: String,
        reasoning: String? = nil,
        tool: CompanionToolRun? = nil,
        decision: CompanionDecision? = nil,
        createdAt: String
    ) {
        self.eventID = eventID
        self.ordinal = ordinal
        self.role = role
        self.content = content
        self.reasoning = reasoning
        self.tool = tool
        self.decision = decision
        self.createdAt = createdAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventID = try container.decode(String.self, forKey: .eventID)
        ordinal = try container.decode(Int.self, forKey: .ordinal)
        role = try container.decode(String.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        reasoning = try container.decodeIfPresent(String.self, forKey: .reasoning)
        tool = try container.decodeIfPresent(CompanionToolRun.self, forKey: .tool)
        decision = try container.decodeIfPresent(CompanionDecision.self, forKey: .decision)
        createdAt = try container.decode(String.self, forKey: .createdAt)
    }
}

public struct CompanionRoutineRunSummary: Codable, Identifiable, Equatable, Sendable {
    public let runID: String
    public let companionID: String
    public let routine: CompanionRoutineIdentitySnapshot
    public let status: CompanionRoutineRunStatus
    public let outcome: CompanionRoutineRunOutcome
    public let surfaceMode: CompanionRoutineSurfaceMode?
    public let mainEntryEventID: String?
    public let relayTurnID: String?
    public let createdAt: String
    public let startedAt: String?
    public let settledAt: String?
    public let error: CompanionRuntimeSafeError?

    public var id: String { runID }

    public init(
        runID: String,
        companionID: String,
        routine: CompanionRoutineIdentitySnapshot,
        status: CompanionRoutineRunStatus,
        outcome: CompanionRoutineRunOutcome,
        surfaceMode: CompanionRoutineSurfaceMode?,
        mainEntryEventID: String?,
        relayTurnID: String?,
        createdAt: String,
        startedAt: String?,
        settledAt: String?,
        error: CompanionRuntimeSafeError?
    ) {
        self.runID = runID
        self.companionID = companionID
        self.routine = routine
        self.status = status
        self.outcome = outcome
        self.surfaceMode = surfaceMode
        self.mainEntryEventID = mainEntryEventID
        self.relayTurnID = relayTurnID
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.settledAt = settledAt
        self.error = error
    }

    enum CodingKeys: String, CodingKey {
        case runID = "run_id"
        case companionID = "companion_id"
        case routine
        case status
        case outcome
        case surfaceMode = "surface_mode"
        case mainEntryEventID = "main_entry_event_id"
        case relayTurnID = "relay_turn_id"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case settledAt = "settled_at"
        case error
    }
}

public struct CompanionRoutineRunDetail: Codable, Equatable, Sendable {
    public let runID: String
    public let companionID: String
    public let routine: CompanionRoutineIdentitySnapshot
    public let status: CompanionRoutineRunStatus
    public let outcome: CompanionRoutineRunOutcome
    public let surfaceMode: CompanionRoutineSurfaceMode?
    public let mainEntryEventID: String?
    public let relayTurnID: String?
    public let createdAt: String
    public let startedAt: String?
    public let settledAt: String?
    public let error: CompanionRuntimeSafeError?
    public let internalEntries: [CompanionRoutineRunEntry]
    public let nextEntryCursor: Int?

    public init(
        runID: String,
        companionID: String,
        routine: CompanionRoutineIdentitySnapshot,
        status: CompanionRoutineRunStatus,
        outcome: CompanionRoutineRunOutcome,
        surfaceMode: CompanionRoutineSurfaceMode?,
        mainEntryEventID: String?,
        relayTurnID: String?,
        createdAt: String,
        startedAt: String?,
        settledAt: String?,
        error: CompanionRuntimeSafeError?,
        internalEntries: [CompanionRoutineRunEntry],
        nextEntryCursor: Int?
    ) {
        self.runID = runID
        self.companionID = companionID
        self.routine = routine
        self.status = status
        self.outcome = outcome
        self.surfaceMode = surfaceMode
        self.mainEntryEventID = mainEntryEventID
        self.relayTurnID = relayTurnID
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.settledAt = settledAt
        self.error = error
        self.internalEntries = internalEntries
        self.nextEntryCursor = nextEntryCursor
    }

    enum CodingKeys: String, CodingKey {
        case runID = "run_id"
        case companionID = "companion_id"
        case routine
        case status
        case outcome
        case surfaceMode = "surface_mode"
        case mainEntryEventID = "main_entry_event_id"
        case relayTurnID = "relay_turn_id"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case settledAt = "settled_at"
        case error
        case internalEntries = "internal_entries"
        case nextEntryCursor = "next_entry_cursor"
    }
}

public struct CompanionRoutineRunList: Codable, Equatable, Sendable {
    public let runs: [CompanionRoutineRunSummary]
    public let nextCursor: String?

    public init(runs: [CompanionRoutineRunSummary], nextCursor: String?) {
        self.runs = runs
        self.nextCursor = nextCursor
    }

    enum CodingKeys: String, CodingKey {
        case runs
        case nextCursor = "next_cursor"
    }
}

/// A routine-origin user entry may predate durable run ids. Keep both nullable for old rows and
/// retain the routine snapshot so the prompt itself can stay hidden from the chat surface.
public struct CompanionTranscriptRoutineOrigin: Codable, Equatable, Sendable {
    public let id: String?
    public let name: String
    public let runID: String?

    public init(id: String?, name: String, runID: String? = nil) {
        self.id = id
        self.name = name
        self.runID = runID
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case runID = "run_id"
    }
}

public enum CompanionTriggerProvider: String, Codable, CaseIterable, Equatable, Hashable, Sendable {
    case webhook
    case linear
    case github
    case sentry
    case custom
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionTriggerMode: String, Codable, CaseIterable, Equatable, Hashable, Sendable {
    case notify
    case relay
}

public struct CompanionTriggerTarget: Codable, Equatable, Sendable {
    public let repo: String?
    public let organization: String?
    public let project: String?
    public let events: [String]?

    public init(
        repo: String? = nil,
        organization: String? = nil,
        project: String? = nil,
        events: [String]? = nil
    ) {
        self.repo = repo
        self.organization = organization
        self.project = project
        self.events = events
    }
}

public struct CompanionTrigger: Codable, Identifiable, Equatable, Sendable {
    public enum RegistrationStatus: String, Codable, Equatable, Sendable {
        case manual
        case unregistered
        case registered
        case failed
        case unknown

        public init(from decoder: Decoder) throws {
            let value = try decoder.singleValueContainer().decode(String.self)
            self = Self(rawValue: value) ?? .unknown
        }
    }

    public let id: String
    public let companionID: String?
    public let name: String
    public let prompt: String
    public let mode: CompanionTriggerMode
    public let provider: String
    public let providerAccountID: String?
    public let target: CompanionTriggerTarget?
    public let registrationStatus: RegistrationStatus
    public let enabled: Bool
    public let webhookURL: String?
    public let remoteHookAccountID: String?
    public let remoteHookID: String?
    public let lastRegistrationError: String?
    public let lastFiredAt: String?
    public let lastErrorCode: String?
    public let lastErrorMessage: String?

    enum CodingKeys: String, CodingKey {
        case id
        case companionID = "companion_id"
        case name
        case prompt
        case mode
        case provider
        case providerAccountID = "provider_account_id"
        case target
        case registrationStatus = "registration_status"
        case enabled
        case webhookURL = "webhook_url"
        case remoteHookAccountID = "remote_hook_account_id"
        case remoteHookID = "remote_hook_id"
        case lastRegistrationError = "last_registration_error"
        case lastFiredAt = "last_fired_at"
        case lastErrorCode = "last_error_code"
        case lastErrorMessage = "last_error_message"
    }

    public init(
        id: String,
        name: String,
        prompt: String = "",
        mode: CompanionTriggerMode = .relay,
        provider: String,
        registrationStatus: RegistrationStatus,
        enabled: Bool,
        lastErrorMessage: String?,
        companionID: String? = nil,
        target: CompanionTriggerTarget? = nil,
        providerAccountID: String? = nil,
        webhookURL: String? = nil,
        remoteHookAccountID: String? = nil,
        remoteHookID: String? = nil,
        lastRegistrationError: String? = nil,
        lastFiredAt: String? = nil,
        lastErrorCode: String? = nil
    ) {
        self.id = id
        self.companionID = companionID
        self.name = name
        self.prompt = prompt
        self.mode = mode
        self.provider = provider
        self.providerAccountID = providerAccountID
        self.target = target
        self.registrationStatus = registrationStatus
        self.enabled = enabled
        self.webhookURL = webhookURL
        self.remoteHookAccountID = remoteHookAccountID
        self.remoteHookID = remoteHookID
        self.lastRegistrationError = lastRegistrationError
        self.lastFiredAt = lastFiredAt
        self.lastErrorCode = lastErrorCode
        self.lastErrorMessage = lastErrorMessage
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        companionID = try container.decodeIfPresent(String.self, forKey: .companionID)
        name = try container.decode(String.self, forKey: .name)
        prompt = try container.decode(String.self, forKey: .prompt)
        mode = try container.decodeIfPresent(CompanionTriggerMode.self, forKey: .mode) ?? .relay
        provider = try container.decode(String.self, forKey: .provider)
        providerAccountID = try container.decodeIfPresent(String.self, forKey: .providerAccountID)
        target = try container.decodeIfPresent(CompanionTriggerTarget.self, forKey: .target)
        registrationStatus = try container.decodeIfPresent(RegistrationStatus.self, forKey: .registrationStatus) ?? .manual
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        webhookURL = try container.decodeIfPresent(String.self, forKey: .webhookURL)
        remoteHookAccountID = try container.decodeIfPresent(String.self, forKey: .remoteHookAccountID)
        remoteHookID = try container.decodeIfPresent(String.self, forKey: .remoteHookID)
        lastRegistrationError = try container.decodeIfPresent(String.self, forKey: .lastRegistrationError)
        lastFiredAt = try container.decodeIfPresent(String.self, forKey: .lastFiredAt)
        lastErrorCode = try container.decodeIfPresent(String.self, forKey: .lastErrorCode)
        lastErrorMessage = try container.decodeIfPresent(String.self, forKey: .lastErrorMessage)
    }

    public var status: CompanionConnectedResourceStatus {
        if !enabled { return .disabled }
        return registrationStatus == .failed || registrationStatus == .unregistered
            || lastRegistrationError != nil || lastErrorMessage != nil
            ? .error
            : .active
    }

    public var providerName: String {
        switch provider {
        case "webhook": "Webhook"
        case "github": "GitHub"
        case "linear": "Linear"
        case "sentry": "Sentry"
        case "custom": "Custom"
        default: provider
        }
    }

    public var registrationDescription: String {
        switch registrationStatus {
        case .manual: "Platform endpoint ready"
        case .unregistered: "Webhook unregistered"
        case .registered: "Webhook registered"
        case .failed: "Registration failed"
        case .unknown: "Registration unknown"
        }
    }
}

public enum CompanionTriggerProviderAccountProvider: String, Codable, CaseIterable, Hashable, Sendable {
    case github
    case linear
    case sentry
}

public enum CompanionTriggerProviderAccountStatus: String, Codable, Hashable, Sendable {
    case connected
    case disconnected
}

public enum CompanionTriggerProviderCredentialSource: String, Codable, Hashable, Sendable {
    case mcpOAuth = "mcp_oauth"
    case apiKey = "api_key"
}

/// Write-only-safe member authority shared by every Companion without an attachment step.
public struct CompanionTriggerProviderAccount: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let provider: CompanionTriggerProviderAccountProvider
    public let label: String
    public let credentialSource: CompanionTriggerProviderCredentialSource
    public let mcpAccountID: String?
    public let status: CompanionTriggerProviderAccountStatus
    public let dependentTriggerCount: Int
    public let createdAt: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case provider
        case label
        case credentialSource = "credential_source"
        case mcpAccountID = "mcp_account_id"
        case status
        case dependentTriggerCount = "dependent_trigger_count"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct CreateCompanionTriggerProviderAccountInput: Encodable, Equatable, Sendable {
    public let provider: CompanionTriggerProviderAccountProvider
    public let label: String
    public let credential: String

    public init(
        provider: CompanionTriggerProviderAccountProvider,
        label: String,
        credential: String
    ) {
        self.provider = provider
        self.label = label
        self.credential = credential
    }
}

public typealias CompanionTriggerRunStatus = CompanionRoutineRunStatus
public typealias CompanionTriggerRunOutcome = CompanionRoutineRunOutcome
public typealias CompanionTriggerSurfaceMode = CompanionRoutineSurfaceMode
public typealias CompanionTriggerRunEntry = CompanionRoutineRunEntry

public struct CompanionTriggerIdentitySnapshot: Codable, Equatable, Hashable, Sendable {
    public let id: String?
    public let name: String

    public init(id: String?, name: String) {
        self.id = id
        self.name = name
    }
}

public struct CompanionTriggerRunSummary: Codable, Identifiable, Equatable, Sendable {
    public let runID: String
    public let companionID: String
    public let trigger: CompanionTriggerIdentitySnapshot
    public let status: CompanionTriggerRunStatus
    public let mode: CompanionTriggerMode
    public let outcome: CompanionTriggerRunOutcome
    public let surfaceMode: CompanionTriggerSurfaceMode?
    public let mainEntryEventID: String?
    public let relayTurnID: String?
    public let createdAt: String
    public let startedAt: String?
    public let settledAt: String?
    public let error: CompanionRuntimeSafeError?

    public var id: String { runID }

    enum CodingKeys: String, CodingKey {
        case runID = "run_id"
        case companionID = "companion_id"
        case trigger
        case status
        case mode
        case outcome
        case surfaceMode = "surface_mode"
        case mainEntryEventID = "main_entry_event_id"
        case relayTurnID = "relay_turn_id"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case settledAt = "settled_at"
        case error
    }
}

public struct CompanionTriggerRunDetail: Codable, Equatable, Sendable {
    public let runID: String
    public let companionID: String
    public let trigger: CompanionTriggerIdentitySnapshot
    public let status: CompanionTriggerRunStatus
    public let mode: CompanionTriggerMode
    public let outcome: CompanionTriggerRunOutcome
    public let surfaceMode: CompanionTriggerSurfaceMode?
    public let mainEntryEventID: String?
    public let relayTurnID: String?
    public let createdAt: String
    public let startedAt: String?
    public let settledAt: String?
    public let error: CompanionRuntimeSafeError?
    public let internalEntries: [CompanionTriggerRunEntry]
    public let nextEntryCursor: Int?

    public init(
        runID: String,
        companionID: String,
        trigger: CompanionTriggerIdentitySnapshot,
        status: CompanionTriggerRunStatus,
        mode: CompanionTriggerMode,
        outcome: CompanionTriggerRunOutcome,
        surfaceMode: CompanionTriggerSurfaceMode?,
        mainEntryEventID: String?,
        relayTurnID: String?,
        createdAt: String,
        startedAt: String?,
        settledAt: String?,
        error: CompanionRuntimeSafeError?,
        internalEntries: [CompanionTriggerRunEntry],
        nextEntryCursor: Int?
    ) {
        self.runID = runID
        self.companionID = companionID
        self.trigger = trigger
        self.status = status
        self.mode = mode
        self.outcome = outcome
        self.surfaceMode = surfaceMode
        self.mainEntryEventID = mainEntryEventID
        self.relayTurnID = relayTurnID
        self.createdAt = createdAt
        self.startedAt = startedAt
        self.settledAt = settledAt
        self.error = error
        self.internalEntries = internalEntries
        self.nextEntryCursor = nextEntryCursor
    }

    enum CodingKeys: String, CodingKey {
        case runID = "run_id"
        case companionID = "companion_id"
        case trigger
        case status
        case mode
        case outcome
        case surfaceMode = "surface_mode"
        case mainEntryEventID = "main_entry_event_id"
        case relayTurnID = "relay_turn_id"
        case createdAt = "created_at"
        case startedAt = "started_at"
        case settledAt = "settled_at"
        case error
        case internalEntries = "internal_entries"
        case nextEntryCursor = "next_entry_cursor"
    }
}

public struct CompanionTriggerRunList: Codable, Equatable, Sendable {
    public let runs: [CompanionTriggerRunSummary]
    public let nextCursor: String?

    enum CodingKeys: String, CodingKey {
        case runs
        case nextCursor = "next_cursor"
    }
}

public struct CompanionConnectedResources: Equatable, Sendable {
    public let skills: [CompanionSkillSummary]
    public let hiddenSkillCount: Int
    public let routines: [CompanionRoutine]
    public let triggers: [CompanionTrigger]

    public init(
        skills: [CompanionSkillSummary],
        hiddenSkillCount: Int,
        routines: [CompanionRoutine],
        triggers: [CompanionTrigger]
    ) {
        self.skills = skills
        self.hiddenSkillCount = hiddenSkillCount
        self.routines = routines
        self.triggers = triggers
    }
}

/// Payloads for the shared Companion routine routes. A fresh id is generated client-side so a
/// request can be retried without creating a second durable routine.
public struct CreateCompanionRoutineInput: Encodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let prompt: String
    public let cron: String
    public let timezone: String
    public let enabled: Bool

    public init(
        id: String = UUID().uuidString.lowercased(),
        name: String,
        prompt: String,
        cron: String,
        timezone: String,
        enabled: Bool = true
    ) {
        self.id = id
        self.name = name
        self.prompt = prompt
        self.cron = cron
        self.timezone = timezone
        self.enabled = enabled
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case prompt
        case cron
        case timezone
        case enabled
    }
}

public struct UpdateCompanionRoutineInput: Encodable, Equatable, Sendable {
    public let name: String?
    public let prompt: String?
    public let cron: String?
    public let timezone: String?
    public let enabled: Bool?

    public init(
        name: String? = nil,
        prompt: String? = nil,
        cron: String? = nil,
        timezone: String? = nil,
        enabled: Bool? = nil
    ) {
        self.name = name
        self.prompt = prompt
        self.cron = cron
        self.timezone = timezone
        self.enabled = enabled
    }

    enum CodingKeys: String, CodingKey {
        case name
        case prompt
        case cron
        case timezone
        case enabled
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encodeIfPresent(prompt, forKey: .prompt)
        try container.encodeIfPresent(cron, forKey: .cron)
        try container.encodeIfPresent(timezone, forKey: .timezone)
        try container.encodeIfPresent(enabled, forKey: .enabled)
    }
}

/// Payloads for the shared Companion trigger routes. Trigger secrets and webhook URLs are always
/// generated by the control plane and never accepted from this client.
public struct CreateCompanionTriggerInput: Encodable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let prompt: String
    public let mode: CompanionTriggerMode
    public let provider: CompanionTriggerProvider
    public let providerAccountID: String?
    public let target: CompanionTriggerTarget?
    public let enabled: Bool

    public init(
        id: String = UUID().uuidString.lowercased(),
        name: String,
        prompt: String,
        mode: CompanionTriggerMode = .relay,
        provider: CompanionTriggerProvider,
        providerAccountID: String? = nil,
        target: CompanionTriggerTarget? = nil,
        enabled: Bool = true
    ) {
        self.id = id
        self.name = name
        self.prompt = prompt
        self.mode = mode
        self.provider = provider
        self.providerAccountID = providerAccountID
        self.target = target
        self.enabled = enabled
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case prompt
        case mode
        case provider
        case providerAccountID = "provider_account_id"
        case target
        case enabled
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(name, forKey: .name)
        try container.encode(prompt, forKey: .prompt)
        try container.encode(mode, forKey: .mode)
        try container.encode(provider.rawValue, forKey: .provider)
        try container.encodeIfPresent(providerAccountID, forKey: .providerAccountID)
        try container.encodeIfPresent(target, forKey: .target)
        try container.encode(enabled, forKey: .enabled)
    }
}

public struct UpdateCompanionTriggerInput: Encodable, Equatable, Sendable {
    public let name: String?
    public let prompt: String?
    public let mode: CompanionTriggerMode?
    public let provider: CompanionTriggerProvider?
    public let providerAccountID: String?
    public let target: CompanionTriggerTarget?
    public let enabled: Bool?

    public init(
        name: String? = nil,
        prompt: String? = nil,
        mode: CompanionTriggerMode? = nil,
        provider: CompanionTriggerProvider? = nil,
        providerAccountID: String? = nil,
        target: CompanionTriggerTarget? = nil,
        enabled: Bool? = nil
    ) {
        self.name = name
        self.prompt = prompt
        self.mode = mode
        self.provider = provider
        self.providerAccountID = providerAccountID
        self.target = target
        self.enabled = enabled
    }

    enum CodingKeys: String, CodingKey {
        case name
        case prompt
        case mode
        case provider
        case providerAccountID = "provider_account_id"
        case target
        case enabled
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(name, forKey: .name)
        try container.encodeIfPresent(prompt, forKey: .prompt)
        try container.encodeIfPresent(mode, forKey: .mode)
        try container.encodeIfPresent(providerAccountID, forKey: .providerAccountID)
        if let provider {
            try container.encode(provider.rawValue, forKey: .provider)
            // A provider change from GitHub to a provider without targets must explicitly clear
            // the old target. A nil provider means this is a narrow patch (for example, a toggle),
            // so leave target omitted in that case.
            try container.encode(target, forKey: .target)
        } else {
            try container.encodeIfPresent(target, forKey: .target)
        }
        try container.encodeIfPresent(enabled, forKey: .enabled)
    }
}

public enum CompanionProviderAuthMethod: String, Codable, Hashable, Sendable {
    case apiKey = "api_key"
    case subscription
}

public struct CompanionProviderDefinition: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let name: String
    public let authMethods: [CompanionProviderAuthMethod]
    public let description: String
    public let models: [Model]

    public struct Model: Codable, Identifiable, Hashable, Sendable {
        public let id: String
        public let name: String
        public let isDefault: Bool?
        public let input: [String]?

        enum CodingKeys: String, CodingKey {
            case id
            case name
            case isDefault = "default"
            case input
        }
    }

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case authMethods = "auth_methods"
        case description
        case models
    }

    public var defaultModelID: String? {
        models.first(where: { $0.isDefault == true })?.id ?? models.first?.id
    }
}

public struct CompanionProviderConnection: Codable, Identifiable, Hashable, Sendable {
    public let providerID: String
    public let authMethod: CompanionProviderAuthMethod
    public let connectedBy: String?
    public let createdAt: String
    public let updatedAt: String

    public var id: String { providerID }

    enum CodingKeys: String, CodingKey {
        case providerID = "provider_id"
        case authMethod = "auth_method"
        case connectedBy = "connected_by"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

public struct CompanionProvidersResponse: Codable, Equatable, Sendable {
    public let catalog: [CompanionProviderDefinition]
    public let connections: [CompanionProviderConnection]
    public let defaultProviderID: String?
    public let canManage: Bool

    enum CodingKeys: String, CodingKey {
        case catalog
        case connections
        case defaultProviderID = "default_provider_id"
        case canManage = "can_manage"
    }

    public init(
        catalog: [CompanionProviderDefinition],
        connections: [CompanionProviderConnection],
        defaultProviderID: String?,
        canManage: Bool
    ) {
        self.catalog = catalog
        self.connections = connections
        self.defaultProviderID = defaultProviderID
        self.canManage = canManage
    }

    public var connectedDefinitions: [CompanionProviderDefinition] {
        let connected = Set(connections.map(\.providerID))
        return catalog.filter { connected.contains($0.id) }
    }
}

public struct CompanionProviderOAuthStart: Codable, Equatable, Sendable {
    public enum Flow: String, Codable, Sendable {
        case authorizationCode = "authorization_code"
        case deviceCode = "device_code"
    }

    public let flow: Flow
    public let providerID: String
    public let authorizationURL: URL?
    public let verificationURL: URL?
    public let userCode: String?
    public let pollIntervalSeconds: Int?
    public let expiresAt: String?

    enum CodingKeys: String, CodingKey {
        case flow
        case providerID = "provider_id"
        case authorizationURL = "authorization_url"
        case verificationURL = "verification_url"
        case userCode = "user_code"
        case pollIntervalSeconds = "poll_interval_seconds"
        case expiresAt = "expires_at"
    }
}

public struct CompanionProviderOAuthPoll: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable {
        case pending
        case connected
    }

    public let status: Status
    public let connection: CompanionProviderConnection?
}

public struct CompanionPluginOAuthStart: Codable, Equatable, Sendable {
    public let authorizationURL: URL

    public init(authorizationURL: URL) {
        self.authorizationURL = authorizationURL
    }

    enum CodingKeys: String, CodingKey {
        case authorizationURL = "authorization_url"
    }
}

public enum CompanionPluginTransport: String, Codable, Hashable, Sendable {
    case http
    case stdio
}

public struct CompanionPluginAccount: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let provider: String
    public let label: String
    public let transport: CompanionPluginTransport
    public let endpoint: String
    public let connected: Bool
    public let createdAt: String
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case provider
        case label
        case transport
        case endpoint
        case connected
        case createdAt = "created_at"
        case updatedAt = "updated_at"
    }
}

/// The minimal Skills Hub projection needed to name a resource in a Companion decision card.
public struct CompanionSkillReference: Codable, Identifiable, Hashable, Sendable {
    public let id: String
    public let slug: String
}

public struct CreateCompanionInput: Encodable, Equatable, Sendable {
    public let name: String
    public let persona: String?
    public let providerID: String
    public let modelID: String
    public let selectedSkillIDs: [String]
    public let selectedMCPAccountIDs: [String]
    public let icon: CompanionSummary.Icon

    public init(
        name: String,
        persona: String? = nil,
        providerID: String,
        modelID: String,
        selectedSkillIDs: [String] = [],
        selectedMCPAccountIDs: [String] = [],
        icon: CompanionSummary.Icon
    ) {
        self.name = name
        self.persona = persona
        self.providerID = providerID
        self.modelID = modelID
        self.selectedSkillIDs = selectedSkillIDs
        self.selectedMCPAccountIDs = selectedMCPAccountIDs
        self.icon = icon
    }

    enum CodingKeys: String, CodingKey {
        case name
        case persona
        case providerID = "provider_id"
        case modelID = "model_id"
        case selectedSkillIDs = "selected_skill_ids"
        case selectedMCPAccountIDs = "selected_mcp_account_ids"
        case icon
    }
}

public struct UpdateCompanionInput: Encodable, Equatable, Sendable {
    public let name: String
    public let persona: String?
    public let providerID: String
    public let modelID: String
    public let icon: CompanionSummary.Icon

    public init(
        name: String,
        persona: String?,
        providerID: String,
        modelID: String,
        icon: CompanionSummary.Icon
    ) {
        self.name = name
        self.persona = persona
        self.providerID = providerID
        self.modelID = modelID
        self.icon = icon
    }

    enum CodingKeys: String, CodingKey {
        case name
        case persona
        case providerID = "provider_id"
        case modelID = "model_id"
        case icon
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        if let persona {
            try container.encode(persona, forKey: .persona)
        } else {
            try container.encodeNil(forKey: .persona)
        }
        try container.encode(providerID, forKey: .providerID)
        try container.encode(modelID, forKey: .modelID)
        try container.encode(icon, forKey: .icon)
    }
}

/// The narrow Companion settings patch used when attaching or detaching MCP accounts.
public struct UpdateCompanionPluginSelectionInput: Encodable, Equatable, Sendable {
    public let selectedMCPAccountIDs: [String]

    public init(selectedMCPAccountIDs: [String]) {
        self.selectedMCPAccountIDs = selectedMCPAccountIDs
    }

    enum CodingKeys: String, CodingKey {
        case selectedMCPAccountIDs = "selected_mcp_account_ids"
    }
}

public struct SaveCompanionPluginInput: Encodable, Equatable, Sendable {
    public let provider: String
    public let label: String
    public let transport: CompanionPluginTransport
    public let url: String?
    public let command: String?
    public let args: [String]
    public let credentialName: String?
    public let credentialValue: String?

    public init(
        provider: String,
        label: String,
        transport: CompanionPluginTransport,
        url: String? = nil,
        command: String? = nil,
        args: [String] = [],
        credentialName: String? = nil,
        credentialValue: String? = nil
    ) {
        self.provider = provider
        self.label = label
        self.transport = transport
        self.url = url
        self.command = command
        self.args = args
        self.credentialName = credentialName
        self.credentialValue = credentialValue
    }

    enum CodingKeys: String, CodingKey {
        case provider
        case label
        case transport
        case url
        case command
        case args
        case credentialName = "credential_name"
        case credentialValue = "credential_value"
    }
}

public enum CompanionDecisionKind: String, Codable, Equatable, Sendable {
    case shell
    case file
    case question
    case config
    case routine
    case trigger
    case control
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionControlRequestStatus: String, Codable, Equatable, Sendable {
    case pending
    case applying
    case applied
    case denied
    case expired
    case cancelled
    case failed
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public indirect enum CompanionControlJSONValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([CompanionControlJSONValue])
    case object([String: CompanionControlJSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([CompanionControlJSONValue].self) { self = .array(value) }
        else { self = .object(try container.decode([String: CompanionControlJSONValue].self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public var prettyPrintedJSON: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        guard let data = try? encoder.encode(self),
              let value = String(data: data, encoding: .utf8) else { return "{}" }
        return value
    }
}

public struct CompanionControlProposal: Codable, Equatable, Sendable {
    public let requestKind: String
    public let action: String
    public let summary: String
    public let payload: [String: CompanionControlJSONValue]

    enum CodingKeys: String, CodingKey {
        case kind
        case requestKind = "request_kind"
        case action
        case summary
        case payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestKind = try container.decode(String.self, forKey: .requestKind)
        action = try container.decode(String.self, forKey: .action)
        summary = try container.decode(String.self, forKey: .summary)
        payload = try container.decodeIfPresent(
            [String: CompanionControlJSONValue].self,
            forKey: .payload
        ) ?? [:]
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("control", forKey: .kind)
        try container.encode(requestKind, forKey: .requestKind)
        try container.encode(action, forKey: .action)
        try container.encode(summary, forKey: .summary)
        try container.encode(payload, forKey: .payload)
    }
}

public enum CompanionDecisionStatus: String, Codable, Equatable, Sendable {
    case pending
    case allowed
    case denied
    case answered
    case expired
    case cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct CompanionConfigProposal: Codable, Equatable, Sendable {
    public struct PluginConnection: Codable, Equatable, Sendable {
        public let serverName: String
        public let reason: String?

        enum CodingKeys: String, CodingKey {
            case serverName = "server_name"
            case reason
        }
    }

    public let addSkillIDs: [String]
    public let removeSkillIDs: [String]
    public let attachPluginIDs: [String]
    public let detachPluginIDs: [String]
    public let modelID: String?
    public let persona: String?
    public let includesPersona: Bool
    public let connectPlugin: PluginConnection?

    enum CodingKeys: String, CodingKey {
        case kind
        case addSkillIDs = "add_skill_ids"
        case removeSkillIDs = "remove_skill_ids"
        case attachPluginIDs = "attach_plugin_ids"
        case detachPluginIDs = "detach_plugin_ids"
        case modelID = "model_id"
        case persona
        case connectPlugin = "connect_plugin"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        addSkillIDs = try container.decodeIfPresent([String].self, forKey: .addSkillIDs) ?? []
        removeSkillIDs = try container.decodeIfPresent([String].self, forKey: .removeSkillIDs) ?? []
        attachPluginIDs = try container.decodeIfPresent([String].self, forKey: .attachPluginIDs) ?? []
        detachPluginIDs = try container.decodeIfPresent([String].self, forKey: .detachPluginIDs) ?? []
        modelID = try container.decodeIfPresent(String.self, forKey: .modelID)
        includesPersona = container.contains(.persona)
        persona = try container.decodeIfPresent(String.self, forKey: .persona)
        connectPlugin = try container.decodeIfPresent(PluginConnection.self, forKey: .connectPlugin)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("config", forKey: .kind)
        if !addSkillIDs.isEmpty { try container.encode(addSkillIDs, forKey: .addSkillIDs) }
        if !removeSkillIDs.isEmpty { try container.encode(removeSkillIDs, forKey: .removeSkillIDs) }
        if !attachPluginIDs.isEmpty { try container.encode(attachPluginIDs, forKey: .attachPluginIDs) }
        if !detachPluginIDs.isEmpty { try container.encode(detachPluginIDs, forKey: .detachPluginIDs) }
        try container.encodeIfPresent(modelID, forKey: .modelID)
        if includesPersona {
            if let persona {
                try container.encode(persona, forKey: .persona)
            } else {
                try container.encodeNil(forKey: .persona)
            }
        }
        try container.encodeIfPresent(connectPlugin, forKey: .connectPlugin)
    }
}

public struct CompanionRoutineProposal: Codable, Equatable, Sendable {
    public let name: String
    public let prompt: String
    public let cron: String
    public let timezone: String

    enum CodingKeys: String, CodingKey {
        case kind
        case name
        case prompt
        case cron
        case timezone
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        prompt = try container.decode(String.self, forKey: .prompt)
        cron = try container.decode(String.self, forKey: .cron)
        timezone = try container.decode(String.self, forKey: .timezone)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("routine", forKey: .kind)
        try container.encode(name, forKey: .name)
        try container.encode(prompt, forKey: .prompt)
        try container.encode(cron, forKey: .cron)
        try container.encode(timezone, forKey: .timezone)
    }
}

public struct CompanionTriggerProposal: Codable, Equatable, Sendable {
    public struct Target: Codable, Equatable, Sendable {
        public let repo: String?
        public let events: [String]?
    }

    public let name: String
    public let prompt: String
    public let mode: CompanionTriggerMode
    public let provider: String
    public let providerAccountID: String?
    public let target: Target?

    enum CodingKeys: String, CodingKey {
        case kind
        case name
        case prompt
        case mode
        case provider
        case providerAccountID = "provider_account_id"
        case target
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        prompt = try container.decode(String.self, forKey: .prompt)
        mode = try container.decodeIfPresent(CompanionTriggerMode.self, forKey: .mode) ?? .relay
        provider = try container.decode(String.self, forKey: .provider)
        providerAccountID = try container.decodeIfPresent(String.self, forKey: .providerAccountID)
        target = try container.decodeIfPresent(Target.self, forKey: .target)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode("trigger", forKey: .kind)
        try container.encode(name, forKey: .name)
        try container.encode(prompt, forKey: .prompt)
        try container.encode(mode, forKey: .mode)
        try container.encode(provider, forKey: .provider)
        try container.encodeIfPresent(providerAccountID, forKey: .providerAccountID)
        try container.encodeIfPresent(target, forKey: .target)
    }
}

public enum CompanionDecisionProposal: Codable, Equatable, Sendable {
    case config(CompanionConfigProposal)
    case routine(CompanionRoutineProposal)
    case trigger(CompanionTriggerProposal)
    case control(CompanionControlProposal)

    private enum CodingKeys: String, CodingKey {
        case kind
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "config": self = .config(try CompanionConfigProposal(from: decoder))
        case "routine": self = .routine(try CompanionRoutineProposal(from: decoder))
        case "trigger": self = .trigger(try CompanionTriggerProposal(from: decoder))
        case "control": self = .control(try CompanionControlProposal(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(
                forKey: .kind,
                in: container,
                debugDescription: "Unsupported Companion decision proposal"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .config(let proposal): try proposal.encode(to: encoder)
        case .routine(let proposal): try proposal.encode(to: encoder)
        case .trigger(let proposal): try proposal.encode(to: encoder)
        case .control(let proposal): try proposal.encode(to: encoder)
        }
    }
}

public struct CompanionDecision: Codable, Equatable, Sendable {
    public let requestID: String
    public let kind: CompanionDecisionKind
    public let name: String
    public let title: String
    public let detail: String?
    public let status: CompanionDecisionStatus
    public let answer: String?
    public let decidedByID: String?
    public let decidedByName: String?
    public let decidedAt: String?
    public let expiresAt: String
    public let requiredAccess: CompanionAccess
    public let controlStatus: CompanionControlRequestStatus?
    public let proposal: CompanionDecisionProposal?

    enum CodingKeys: String, CodingKey {
        case requestID = "request_id"
        case kind
        case name
        case title
        case detail
        case status
        case answer
        case decidedByID = "decided_by_id"
        case decidedByName = "decided_by_name"
        case decidedAt = "decided_at"
        case expiresAt = "expires_at"
        case requiredAccess = "required_access"
        case controlStatus = "control_status"
        case proposal
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        requestID = try container.decode(String.self, forKey: .requestID)
        kind = try container.decode(CompanionDecisionKind.self, forKey: .kind)
        name = try container.decode(String.self, forKey: .name)
        title = try container.decode(String.self, forKey: .title)
        detail = try container.decodeIfPresent(String.self, forKey: .detail)
        status = try container.decode(CompanionDecisionStatus.self, forKey: .status)
        answer = try container.decodeIfPresent(String.self, forKey: .answer)
        decidedByID = try container.decodeIfPresent(String.self, forKey: .decidedByID)
        decidedByName = try container.decodeIfPresent(String.self, forKey: .decidedByName)
        decidedAt = try container.decodeIfPresent(String.self, forKey: .decidedAt)
        expiresAt = try container.decode(String.self, forKey: .expiresAt)
        requiredAccess = try container.decodeIfPresent(CompanionAccess.self, forKey: .requiredAccess) ?? .editor
        controlStatus = try container.decodeIfPresent(CompanionControlRequestStatus.self, forKey: .controlStatus)
        proposal = kind == .unknown
            ? nil
            : try container.decodeIfPresent(CompanionDecisionProposal.self, forKey: .proposal)
    }
}

public struct CompanionTranscriptDelegation: Codable, Equatable, Sendable {
    public enum Direction: String, Codable, Equatable, Sendable {
        case request
        case response
    }

    public let id: String
    public let direction: Direction
    public let companionID: String?
    public let companionName: String
    public let responseMode: CompanionTriggerMode
    public let status: String

    enum CodingKeys: String, CodingKey {
        case id
        case direction
        case companionID = "companion_id"
        case companionName = "companion_name"
        case responseMode = "response_mode"
        case status
    }
}

public enum CompanionDecisionAction: Encodable, Equatable, Sendable {
    case allow
    case deny
    case answer(String)

    private enum CodingKeys: String, CodingKey {
        case action
        case answer
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .allow:
            try container.encode("allow", forKey: .action)
        case .deny:
            try container.encode("deny", forKey: .action)
        case .answer(let answer):
            try container.encode("answer", forKey: .action)
            try container.encode(answer, forKey: .answer)
        }
    }
}

public enum CompanionToolRunKind: String, Codable, Hashable, Sendable {
    case shell
    case file
    case browse
    case computer
    case subagent
    case tool

    /// The server keeps the catalog open for rolling deploys. A newer runtime may write a kind
    /// this client does not know yet; keep the transcript readable with the generic tool family.
    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .tool
    }
}

public enum CompanionToolRunStatus: String, Codable, Hashable, Sendable {
    case running
    case ok
    case error
    case timeout
}

public struct CompanionToolRun: Codable, Equatable, Hashable, Sendable {
    public let callID: String?
    public let kind: CompanionToolRunKind
    public let name: String
    public let title: String
    public let status: CompanionToolRunStatus
    public let detail: String?
    public let screenshot: String?

    public init(
        callID: String?,
        kind: CompanionToolRunKind,
        name: String,
        title: String,
        status: CompanionToolRunStatus,
        detail: String?,
        screenshot: String?
    ) {
        self.callID = callID
        self.kind = kind
        self.name = name
        self.title = title
        self.status = status
        self.detail = detail
        self.screenshot = screenshot
    }

    enum CodingKeys: String, CodingKey {
        case callID = "call_id"
        case kind
        case name
        case title
        case status
        case detail
        case screenshot
    }
}

public struct TranscriptEntry: Codable, Identifiable, Equatable, Sendable {
    public let eventID: String
    public let ordinal: Int
    public let role: String
    public let content: String
    public let reasoning: String?
    public let authorID: String?
    public let authorName: String?
    public let decision: CompanionDecision?
    public let tool: CompanionToolRun?
    public let routine: CompanionTranscriptRoutineOrigin?
    public let routineNotifyGroup: CompanionTranscriptRoutineNotifyGroup?
    public let delegation: CompanionTranscriptDelegation?
    public let turnID: String?
    public let queued: Bool
    public let attachments: [CompanionAttachment]
    public let createdAt: String

    public var id: String { eventID }

    enum CodingKeys: String, CodingKey {
        case eventID = "event_id"
        case ordinal
        case role
        case content
        case reasoning
        case authorID = "author_id"
        case authorName = "author_name"
        case decision
        case tool
        case routine
        case routineNotifyGroup = "routine_notify_group"
        case delegation
        case turnID = "turn_id"
        case queued
        case attachments
        case createdAt = "created_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventID = try container.decode(String.self, forKey: .eventID)
        ordinal = try container.decode(Int.self, forKey: .ordinal)
        role = try container.decode(String.self, forKey: .role)
        content = try container.decode(String.self, forKey: .content)
        reasoning = try container.decodeIfPresent(String.self, forKey: .reasoning)
        authorID = try container.decodeIfPresent(String.self, forKey: .authorID)
        authorName = try container.decodeIfPresent(String.self, forKey: .authorName)
        decision = try container.decodeIfPresent(CompanionDecision.self, forKey: .decision)
        tool = try container.decodeIfPresent(CompanionToolRun.self, forKey: .tool)
        routine = try container.decodeIfPresent(CompanionTranscriptRoutineOrigin.self, forKey: .routine)
        routineNotifyGroup = try container.decodeIfPresent(
            CompanionTranscriptRoutineNotifyGroup.self,
            forKey: .routineNotifyGroup
        )
        delegation = try container.decodeIfPresent(CompanionTranscriptDelegation.self, forKey: .delegation)
        turnID = try container.decodeIfPresent(String.self, forKey: .turnID)
        queued = try container.decodeIfPresent(Bool.self, forKey: .queued) ?? false
        attachments = try container.decodeIfPresent([CompanionAttachment].self, forKey: .attachments) ?? []
        createdAt = try container.decode(String.self, forKey: .createdAt)
    }

    func withRoutineNotifyGroup(_ group: CompanionTranscriptRoutineNotifyGroup?) -> Self {
        Self(
            eventID: eventID,
            ordinal: ordinal,
            role: role,
            content: content,
            reasoning: reasoning,
            authorID: authorID,
            authorName: authorName,
            decision: decision,
            tool: tool,
            routine: routine,
            routineNotifyGroup: group,
            delegation: delegation,
            turnID: turnID,
            queued: queued,
            attachments: attachments,
            createdAt: createdAt
        )
    }

    init(
        eventID: String,
        ordinal: Int,
        role: String,
        content: String,
        reasoning: String?,
        authorID: String?,
        authorName: String?,
        decision: CompanionDecision?,
        tool: CompanionToolRun?,
        routine: CompanionTranscriptRoutineOrigin?,
        routineNotifyGroup: CompanionTranscriptRoutineNotifyGroup?,
        delegation: CompanionTranscriptDelegation? = nil,
        turnID: String?,
        queued: Bool,
        attachments: [CompanionAttachment],
        createdAt: String
    ) {
        self.eventID = eventID
        self.ordinal = ordinal
        self.role = role
        self.content = content
        self.reasoning = reasoning
        self.authorID = authorID
        self.authorName = authorName
        self.decision = decision
        self.tool = tool
        self.routine = routine
        self.routineNotifyGroup = routineNotifyGroup
        self.delegation = delegation
        self.turnID = turnID
        self.queued = queued
        self.attachments = attachments
        self.createdAt = createdAt
    }
}

/// The server projection for consecutive routine `notify` returns. Earlier marker/update pairs
/// remain available in their exact order, while the latest assistant entry carries this metadata.
/// The server guarantees that hidden entries use the ordinary transcript shape and never nest a
/// second group.
public struct CompanionTranscriptRoutineNotifyGroup: Codable, Equatable, Sendable {
    public let routineID: String?
    public let routineName: String
    public let totalCount: Int
    public let hiddenEntries: [TranscriptEntry]

    public init(
        routineID: String? = nil,
        routineName: String,
        totalCount: Int,
        hiddenEntries: [TranscriptEntry]
    ) {
        self.routineID = routineID
        self.routineName = routineName
        self.totalCount = totalCount
        self.hiddenEntries = hiddenEntries
    }

    enum CodingKeys: String, CodingKey {
        case routineID = "routine_id"
        case routineName = "routine_name"
        case totalCount = "total_count"
        case hiddenEntries = "hidden_entries"
    }
}

/// A transcript row or a server-projected routine disclosure. Disclosure rows get their own
/// stable identity so hidden entries can be rendered safely without changing their durable event
/// IDs or making the client infer groups from ordinary history.
public struct CompanionTranscriptDisplayItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case entry(TranscriptEntry)
        case routineNotifyDisclosure(
            routineName: String,
            totalCount: Int,
            latestAssistantEventID: String
        )
    }

    public let id: String
    public let kind: Kind

    public init(id: String, kind: Kind) {
        self.id = id
        self.kind = kind
    }

    public var transcriptEntry: TranscriptEntry? {
        guard case .entry(let entry) = kind else { return nil }
        return entry
    }
}

/// Projects the API's already-collapsed routine groups into rows for the chat surface.
public enum CompanionTranscriptProjection {
    /// Keeps ordinary entries in order. When a grouped assistant has its latest routine marker
    /// immediately before it, the disclosure (and, when requested, hidden entries) is emitted
    /// before that marker/update pair. A malformed or partial response still gets a disclosure
    /// immediately before its grouped assistant rather than causing unrelated entries to move.
    public static func displayItems(
        from entries: [TranscriptEntry],
        expandedRoutineNotifyEventIDs: Set<String> = []
    ) -> [CompanionTranscriptDisplayItem] {
        var items: [CompanionTranscriptDisplayItem] = []
        items.reserveCapacity(entries.count)

        var index = 0
        while index < entries.count {
            let entry = entries[index]
            if let update = entries[safe: index + 1],
               entry.routine != nil,
               entry.role == "user",
               update.role == "assistant",
               let group = update.routineNotifyGroup {
                appendDisclosure(
                    for: update,
                    group: group,
                    expanded: expandedRoutineNotifyEventIDs.contains(update.eventID),
                    to: &items
                )
                append(entry: entry, to: &items)
                append(entry: update, to: &items)
                index += 2
                continue
            }

            if let group = entry.routineNotifyGroup {
                appendDisclosure(
                    for: entry,
                    group: group,
                    expanded: expandedRoutineNotifyEventIDs.contains(entry.eventID),
                    to: &items
                )
            }
            append(entry: entry, to: &items)
            index += 1
        }
        return items
    }

    private static func appendDisclosure(
        for latestAssistant: TranscriptEntry,
        group: CompanionTranscriptRoutineNotifyGroup,
        expanded: Bool,
        to items: inout [CompanionTranscriptDisplayItem]
    ) {
        items.append(CompanionTranscriptDisplayItem(
            id: "routine-notify.\(latestAssistant.eventID).disclosure",
            kind: .routineNotifyDisclosure(
                routineName: group.routineName,
                totalCount: group.totalCount,
                latestAssistantEventID: latestAssistant.eventID
            )
        ))
        guard expanded else { return }
        for (index, entry) in group.hiddenEntries.enumerated() {
            items.append(CompanionTranscriptDisplayItem(
                id: "routine-notify.\(latestAssistant.eventID).hidden.\(index).\(entry.eventID)",
                kind: .entry(entry)
            ))
        }
    }

    private static func append(
        entry: TranscriptEntry,
        to items: inout [CompanionTranscriptDisplayItem]
    ) {
        items.append(CompanionTranscriptDisplayItem(id: entry.eventID, kind: .entry(entry)))
    }
}

private extension Array {
    subscript(safe index: Index) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

public enum CompanionTurnStatus: String, Codable, Equatable, Sendable {
    case queued
    case starting
    case dispatching
    case running
    case needsInput = "needs_input"
    case succeeded
    case failed
    case interrupted
    case cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionTurnAttemptStatus: String, Codable, Equatable, Sendable {
    case starting
    case dispatching
    case running
    case needsInput = "needs_input"
    case succeeded
    case failed
    case interrupted
    case cancelled
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public enum CompanionTurnDispatchState: String, Codable, Equatable, Sendable {
    case pending
    case writeIntent = "write_intent"
    case accepted
    case rejected
    case ambiguous
    case unknown

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: value) ?? .unknown
    }
}

public struct CompanionTurnAttempt: Codable, Equatable, Sendable {
    public let id: String
    public let turnID: String
    public let attemptNumber: Int
    public let retryID: String?
    public let status: CompanionTurnAttemptStatus
    public let dispatchState: CompanionTurnDispatchState
    public let piInvocationID: String?
    public let dispatchAcceptedAt: String?
    public let error: CompanionRuntimeSafeError?
    public let startedAt: String
    public let settledAt: String?

    enum CodingKeys: String, CodingKey {
        case id
        case turnID = "turn_id"
        case attemptNumber = "attempt_number"
        case retryID = "retry_id"
        case status
        case dispatchState = "dispatch_state"
        case piInvocationID = "pi_invocation_id"
        case dispatchAcceptedAt = "dispatch_accepted_at"
        case error
        case startedAt = "started_at"
        case settledAt = "settled_at"
    }
}

public struct CompanionTurn: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let companionID: String
    public let clientMessageID: String
    public let status: CompanionTurnStatus
    public let queueSequence: Int
    public let latestAttempt: CompanionTurnAttempt?
    public let replying: Bool
    public let error: CompanionRuntimeSafeError?
    public let stateChangedAt: String
    public let settledAt: String?
    public let createdAt: String
    public let updatedAt: String
    public let resolution: String?

    enum CodingKeys: String, CodingKey {
        case id
        case companionID = "companion_id"
        case clientMessageID = "client_message_id"
        case status
        case queueSequence = "queue_sequence"
        case latestAttempt = "latest_attempt"
        case replying
        case error
        case stateChangedAt = "state_changed_at"
        case settledAt = "settled_at"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case resolution
    }
}

public struct CompanionThread: Codable, Equatable, Sendable {
    public let companionID: String
    public let viewerID: String
    public let readOnly: Bool
    public let canSend: Bool
    public let transcriptionAvailable: Bool?
    public let entries: [TranscriptEntry]
    public let activeTurn: CompanionTurn?
    public let queuedCount: Int
    public let interruptedTurn: CompanionTurn?

    enum CodingKeys: String, CodingKey {
        case companionID = "companion_id"
        case viewerID = "viewer_id"
        case readOnly = "read_only"
        case canSend = "can_send"
        case transcriptionAvailable = "transcription_available"
        case entries
        case activeTurn = "active_turn"
        case queuedCount = "queued_count"
        case interruptedTurn = "interrupted_turn"
    }
}
