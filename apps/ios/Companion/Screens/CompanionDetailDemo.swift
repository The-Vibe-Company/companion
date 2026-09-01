import SwiftUI
import CompanionKit

@MainActor
struct CompanionDetailServices {
    let listProviders: () async throws -> CompanionProvidersResponse
    let updateCompanion: (String, UpdateCompanionInput) async throws -> CompanionSummary
    let deleteCompanion: (String, UUID) async throws -> CompanionOperationSummary
    let connectedResources: () async throws -> CompanionConnectedResources
    let listPlugins: () async throws -> [CompanionPluginAccount]
    let listTriggerProviderAccounts: (() async throws -> [CompanionTriggerProviderAccount])?
    let updatePluginSelection: ([String]) async throws -> CompanionSummary
    let loadCompanion: () async throws -> CompanionSummary
    let restart: (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionOperationSummary
    let updateMemberState: ((String, CompanionMemberStatePatch) async throws -> CompanionSummary)?
    let listRoutines: (() async throws -> [CompanionRoutine])?
    let createRoutine: ((CreateCompanionRoutineInput) async throws -> CompanionRoutine)?
    let updateRoutine: ((String, UpdateCompanionRoutineInput) async throws -> CompanionRoutine)?
    let createTrigger: ((CreateCompanionTriggerInput) async throws -> CompanionTrigger)?
    let updateTrigger: ((String, UpdateCompanionTriggerInput) async throws -> CompanionTrigger)?
    let deleteTrigger: ((String) async throws -> Void)?
    let rotateTriggerSecret: ((String) async throws -> CompanionTrigger)?
    let listRoutineRuns: ((String, String?) async throws -> CompanionRoutineRunList)?
    let routineRun: ((String, Int?) async throws -> CompanionRoutineRunDetail)?

    init(
        listProviders: @escaping () async throws -> CompanionProvidersResponse,
        updateCompanion: @escaping (String, UpdateCompanionInput) async throws -> CompanionSummary,
        deleteCompanion: @escaping (String, UUID) async throws -> CompanionOperationSummary,
        connectedResources: @escaping () async throws -> CompanionConnectedResources,
        listPlugins: @escaping () async throws -> [CompanionPluginAccount],
        listTriggerProviderAccounts: (() async throws -> [CompanionTriggerProviderAccount])? = nil,
        updatePluginSelection: @escaping ([String]) async throws -> CompanionSummary,
        loadCompanion: @escaping () async throws -> CompanionSummary,
        restart: @escaping (CompanionRuntimeRestartTarget, UUID) async throws -> CompanionOperationSummary,
        updateMemberState: ((String, CompanionMemberStatePatch) async throws -> CompanionSummary)? = nil,
        listRoutines: (() async throws -> [CompanionRoutine])? = nil,
        createRoutine: ((CreateCompanionRoutineInput) async throws -> CompanionRoutine)? = nil,
        updateRoutine: ((String, UpdateCompanionRoutineInput) async throws -> CompanionRoutine)? = nil,
        createTrigger: ((CreateCompanionTriggerInput) async throws -> CompanionTrigger)? = nil,
        updateTrigger: ((String, UpdateCompanionTriggerInput) async throws -> CompanionTrigger)? = nil,
        deleteTrigger: ((String) async throws -> Void)? = nil,
        rotateTriggerSecret: ((String) async throws -> CompanionTrigger)? = nil,
        listRoutineRuns: ((String, String?) async throws -> CompanionRoutineRunList)? = nil,
        routineRun: ((String, Int?) async throws -> CompanionRoutineRunDetail)? = nil
    ) {
        self.listProviders = listProviders
        self.updateCompanion = updateCompanion
        self.deleteCompanion = deleteCompanion
        self.connectedResources = connectedResources
        self.listPlugins = listPlugins
        self.listTriggerProviderAccounts = listTriggerProviderAccounts
        self.updatePluginSelection = updatePluginSelection
        self.loadCompanion = loadCompanion
        self.restart = restart
        self.updateMemberState = updateMemberState
        self.listRoutines = listRoutines
        self.createRoutine = createRoutine
        self.updateRoutine = updateRoutine
        self.createTrigger = createTrigger
        self.updateTrigger = updateTrigger
        self.deleteTrigger = deleteTrigger
        self.rotateTriggerSecret = rotateTriggerSecret
        self.listRoutineRuns = listRoutineRuns
        self.routineRun = routineRun
    }
}

#if DEBUG
struct CompanionDetailDemoView: View {
    @State private var companion: CompanionSummary
    @State private var showingDetails = false
    @State private var deletionRequested = false

    private let access: CompanionAccess
    private let transcriptionAvailable: Bool

    init() {
        let rawAccess = ProcessInfo.processInfo.environment["COMPANION_DETAIL_DEMO_ACCESS"] ?? "owner"
        let access = CompanionAccess(rawValue: rawAccess) ?? .viewer
        self.access = access
        transcriptionAvailable = ProcessInfo.processInfo.environment[
            "COMPANION_DETAIL_DEMO_TRANSCRIPTION_AVAILABLE"
        ] == "true"
        _companion = State(initialValue: CompanionDetailDemoFixtures.companion(access: access))
    }

    var body: some View {
        NavigationStack {
            if deletionRequested {
                ContentUnavailableView(
                    "Deletion requested",
                    systemImage: "trash.circle",
                    description: Text("The Companion will remain visible until its Box is permanently deleted.")
                )
            } else {
                ChatView(
                    companion: companion,
                    services: CompanionDetailDemoFixtures.chatServices(
                        access: access,
                        transcriptionAvailable: transcriptionAvailable
                    )
                ) {
                    showingDetails = true
                }
                .navigationDestination(isPresented: $showingDetails) {
                    CompanionDetailView(
                        companion: companion,
                        onSaved: { companion = $0 },
                        onOpenChat: { showingDetails = false },
                        onDeletionStarted: { _, _ in
                            deletionRequested = true
                            showingDetails = false
                        },
                        onDeletionAccepted: { _, operation in
                            deletionRequested = operation.isActive
                            showingDetails = !operation.isActive
                        },
                        services: CompanionDetailDemoFixtures.services(access: access)
                    )
                }
            }
        }
        .companionNavigationSwipeBackEnabled()
    }
}

@MainActor
private enum CompanionDetailDemoFixtures {
    static func companion(access: CompanionAccess) -> CompanionSummary {
        decode(#"""
        {
          "id":"c96ab360-00f3-4497-a51a-51442db8add1",
          "name":"Luna",
          "persona":"Keep releases calm",
          "model_id":"claude-sonnet",
          "selected_skill_ids":["11111111-1111-4111-8111-111111111111"],
          "selected_mcp_account_ids":["55555555-5555-4555-8555-555555555555"],
          "icon":{"shape":6,"mouth":1,"accessory":6,"color":2},
          "access":"\#(access.rawValue)",
          "hidden":false,
          "unread":false,
          "last_message":{"preview":"Release notes are ready.","role":"assistant","created_at":"2026-08-25T08:00:00.000Z"},
          "runtime":{"state":"running","daemon_state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}
        }
        """#)
    }

    static func services(access: CompanionAccess) -> CompanionDetailServices {
        CompanionDetailServices(
            listProviders: { providers },
            updateCompanion: { _, input in updatedCompanion(input: input, access: access) },
            deleteCompanion: { _, _ in deleteOperation },
            connectedResources: { CompanionResourceDemoFixtures.resources },
            listPlugins: { plugins },
            listTriggerProviderAccounts: { triggerProviderAccounts },
            updatePluginSelection: { selectedIDs in
                companion(access: access, selectedMCPAccountIDs: selectedIDs)
            },
            loadCompanion: { companion(access: access) },
            restart: { target, _ in restartOperation(target) },
            updateMemberState: { _, patch in
                companion(
                    access: access,
                    selectedMCPAccountIDs: ["55555555-5555-4555-8555-555555555555"],
                    muted: patch.muted ?? false
                )
            },
            listRoutines: { [routine] },
            listRoutineRuns: { _, _ in
                CompanionRoutineRunList(runs: [routineRunSummary], nextCursor: nil)
            },
            routineRun: { _, _ in routineRunDetail }
        )
    }

    private static let routine: CompanionRoutine = decode(#"""
    {
      "id":"33333333-3333-4333-8333-333333333333",
      "name":"Weekday brief",
      "prompt":"Summarize the weekday release status.",
      "cron":"0 9 * * 1-5",
      "timezone":"America/New_York",
      "enabled":true,
      "next_fire_at":"2026-08-27T13:00:00.000Z",
      "last_error_message":null
    }
    """#)

    private static let routineRunSummary = CompanionRoutineRunSummary(
        runID: "88888888-8888-4888-8888-888888888888",
        companionID: "c96ab360-00f3-4497-a51a-51442db8add1",
        routine: CompanionRoutineIdentitySnapshot(
            id: "33333333-3333-4333-8333-333333333333",
            name: "Weekday brief"
        ),
        status: .interrupted,
        outcome: .error,
        surfaceMode: nil,
        mainEntryEventID: nil,
        relayTurnID: nil,
        createdAt: "2026-08-27T13:00:00.000Z",
        startedAt: "2026-08-27T13:00:01.000Z",
        settledAt: "2026-08-27T13:00:05.000Z",
        error: nil,
        recoveryStatus: .running
    )

    private static let routineRunDetail = CompanionRoutineRunDetail(
        runID: routineRunSummary.runID,
        companionID: routineRunSummary.companionID,
        routine: routineRunSummary.routine,
        status: routineRunSummary.status,
        outcome: routineRunSummary.outcome,
        surfaceMode: routineRunSummary.surfaceMode,
        mainEntryEventID: routineRunSummary.mainEntryEventID,
        relayTurnID: routineRunSummary.relayTurnID,
        createdAt: routineRunSummary.createdAt,
        startedAt: routineRunSummary.startedAt,
        settledAt: routineRunSummary.settledAt,
        error: routineRunSummary.error,
        internalEntries: [
            CompanionRoutineRunEntry(
                eventID: "routine:assistant:demo",
                ordinal: 0,
                role: "assistant",
                content: "The weekday brief recorded activity before it was interrupted.",
                createdAt: "2026-08-27T13:00:04.000Z"
            ),
        ],
        nextEntryCursor: nil,
        recoveryStatus: .running
    )

    private static let plugins: [CompanionPluginAccount] = [
        decode(#"{"id":"55555555-5555-4555-8555-555555555555","provider":"linear","label":"work","transport":"http","endpoint":"https://mcp.linear.app","connected":true,"created_at":"2026-08-25T08:00:00.000Z","updated_at":"2026-08-25T08:00:00.000Z"}"#),
        decode(#"{"id":"66666666-6666-4666-8666-666666666666","provider":"github","label":"personal","transport":"http","endpoint":"https://api.githubcopilot.com/mcp","connected":true,"created_at":"2026-08-25T08:00:00.000Z","updated_at":"2026-08-25T08:00:00.000Z"}"#),
    ]

    private static let triggerProviderAccounts: [CompanionTriggerProviderAccount] = [
        decode(#"{"id":"55555555-5555-4555-8555-555555555555","provider":"github","label":"personal","credential_source":"mcp_oauth","mcp_account_id":"66666666-6666-4666-8666-666666666666","status":"connected","dependent_trigger_count":1,"created_at":"2026-08-25T08:00:00.000Z","updated_at":"2026-08-25T08:00:00.000Z"}"#),
    ]

    static func chatServices(
        access: CompanionAccess,
        transcriptionAvailable: Bool
    ) -> ChatServices {
        let currentCompanion = companion(access: access)
        let currentThread: CompanionThread = decode(#"""
        {
          "companion_id":"c96ab360-00f3-4497-a51a-51442db8add1",
          "viewer_id":"user-1",
          "read_only":\#(access == .viewer ? "true" : "false"),
          "can_send":\#(access == .viewer ? "false" : "true"),
          "transcription_available":\#(transcriptionAvailable ? "true" : "false"),
          "entries":[],
          "queued_count":0,
          "interrupted_turn":null
        }
        """#)
        return ChatServices(
            thread: { _ in currentThread },
            listCompanions: { [currentCompanion] },
            decide: { _, _, _ in currentThread },
            cancelTurn: { _, _ in currentThread },
            listSkills: { [] },
            listPlugins: { [] },
            listProviders: { providers }
        )
    }

    private static var providers: CompanionProvidersResponse {
        decode(#"""
        {
          "catalog":[{
            "id":"anthropic",
            "name":"Claude",
            "auth_methods":["api_key"],
            "description":"Claude models",
            "models":[{"id":"claude-sonnet","name":"Sonnet","default":true}]
          }],
          "connections":[{
            "provider_id":"anthropic",
            "auth_method":"api_key",
            "connected_by":"user-1",
            "created_at":"2026-08-25T08:00:00.000Z",
            "updated_at":"2026-08-25T08:00:00.000Z"
          }],
          "default_provider_id":"anthropic",
          "can_manage":true
        }
        """#)
    }

    private static var deleteOperation: CompanionOperationSummary {
        decode(#"""
        {
          "id":"14757274-8d64-455c-a394-334665a258f0",
          "kind":"delete",
          "status":"pending",
          "error":null
        }
        """#)
    }

    private static func restartOperation(
        _ target: CompanionRuntimeRestartTarget
    ) -> CompanionOperationSummary {
        decode(#"{"id":"77777777-7777-4777-8777-777777777777","kind":"\#(target == .pi ? "restart_pi" : "restart_box")","status":"pending","error":null}"#)
    }

    private static func companion(
        access: CompanionAccess,
        selectedMCPAccountIDs: [String],
        muted: Bool = false
    ) -> CompanionSummary {
        let object: [String: Any] = [
            "id": "c96ab360-00f3-4497-a51a-51442db8add1",
            "name": "Luna",
            "persona": "Keep releases calm",
            "model_id": "claude-sonnet",
            "selected_skill_ids": ["11111111-1111-4111-8111-111111111111"],
            "selected_mcp_account_ids": selectedMCPAccountIDs,
            "icon": ["shape": 6, "mouth": 1, "accessory": 6, "color": 2],
            "access": access.rawValue,
            "hidden": false,
            "muted": muted,
            "unread": false,
            "last_message": NSNull(),
            "runtime": [
                "state": "running",
                "daemon_state": "running",
                "replying": false,
                "last_error": NSNull(),
                "provider_ids": ["anthropic"],
                "latest_operation": NSNull(),
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(CompanionSummary.self, from: data)
    }

    private static func updatedCompanion(
        input: UpdateCompanionInput,
        access: CompanionAccess
    ) -> CompanionSummary {
        let object: [String: Any] = [
            "id": "c96ab360-00f3-4497-a51a-51442db8add1",
            "name": input.name,
            "persona": input.persona.map { $0 as Any } ?? NSNull(),
            "model_id": input.modelID,
            "selected_skill_ids": ["11111111-1111-4111-8111-111111111111"],
            "selected_mcp_account_ids": ["55555555-5555-4555-8555-555555555555"],
            "icon": [
                "shape": input.icon.shape,
                "mouth": input.icon.mouth,
                "accessory": input.icon.accessory,
                "color": input.icon.color,
            ],
            "access": access.rawValue,
            "hidden": false,
            "unread": false,
            "last_message": NSNull(),
            "runtime": [
                "state": "running",
                "daemon_state": "running",
                "replying": false,
                "last_error": NSNull(),
                "provider_ids": [input.providerID],
                "latest_operation": NSNull(),
            ],
        ]
        let data = try! JSONSerialization.data(withJSONObject: object)
        return try! JSONDecoder().decode(CompanionSummary.self, from: data)
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }
}
#endif
