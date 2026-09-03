import CompanionKit

/// The loaded thread is the authorization projection for chat. Roster ACL data can be stale after
/// a role change, so it must not overrule a fresh `can_send` response.
public enum CompanionMacSendProjection {
    public static func evaluate(threadCanSend: Bool?, readOnly: Bool?) -> Bool {
        threadCanSend == true && readOnly == false
    }
}

public enum CompanionMacAttachmentProjection {
    public static func canOpen(_ availability: CompanionAttachment.Availability) -> Bool {
        availability == .available
    }
}

/// Once the thread has loaded it is the sole authority for replying. A stale roster bit must not
/// keep typing visible after `needs_input` or terminal settlement.
public enum CompanionMacReplyingProjection {
    public static func evaluate(
        threadLoaded: Bool,
        activeTurnReplying: Bool?,
        rosterReplying: Bool
    ) -> Bool {
        threadLoaded ? activeTurnReplying == true : rosterReplying
    }
}

/// The macOS client must not offer a desktop handoff to a Viewer or to a Box that is not already
/// running. Keeping that decision in a pure projection makes it testable without UI hosting or a
/// network session and gives toolbar/menu surfaces one source of truth.
public enum CompanionMacDesktopEligibility: Equatable, Sendable {
    case allowed
    case viewerReadOnly
    case boxNotRunning

    public static func evaluate(
        access: CompanionAccess,
        runtimeState: CompanionRuntimeState
    ) -> Self {
        guard access.canEditCompanionSettings else { return .viewerReadOnly }
        return runtimeState == .running ? .allowed : .boxNotRunning
    }

    public var canOpen: Bool {
        self == .allowed
    }

    public var explanation: String {
        switch self {
        case .allowed:
            return "Open the Box desktop"
        case .viewerReadOnly:
            return "Viewers cannot open the Box desktop"
        case .boxNotRunning:
            return "The Box desktop is available while the Box is running"
        }
    }
}

/// Ephemeral state for the dedicated desktop window. It deliberately has no Codable or
/// persistence surface: desktop URLs are signed, short-lived credentials and must disappear with
/// the window or when a new handoff replaces them.
public enum CompanionMacDesktopPhase: Equatable, Sendable {
    case empty
    case requesting
    case provisioning
    case loaded
    case failed
}
