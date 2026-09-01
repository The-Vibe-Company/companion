#if DEBUG
import CompanionKit
import Foundation
import Observation
import SwiftUI

@MainActor
struct CompanionTranscriptWindowDemoView: View {
    @State private var selectedCompanionID = CompanionTranscriptWindowDemoFixtures.companionID
    @State private var readingPositions = CompanionChatReadingPositionStore()
    @State private var stagedFixture = CompanionTranscriptWindowDemoFixtures.makeStagedFixture()

    var body: some View {
        let companionID = selectedCompanionID
        let services = CompanionTranscriptWindowDemoFixtures.services(
            stagedFixture: stagedFixture
        )
        NavigationStack {
            ChatView(
                companion: selectedCompanion,
                readingPosition: readingPositions.position(for: companionID),
                onOpenPlugins: { _, _ in },
                services: services,
                onReadingPositionChange: { position in
                    readingPositions.record(position, for: companionID)
                },
                onDetails: {}
            )
            .id(companionID)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(selectedCompanionID == CompanionTranscriptWindowDemoFixtures.companionID
                        ? "Switch to Orbit"
                        : "Switch to Luna") {
                        selectedCompanionID = selectedCompanionID
                            == CompanionTranscriptWindowDemoFixtures.companionID
                            ? CompanionTranscriptWindowDemoFixtures.secondCompanionID
                            : CompanionTranscriptWindowDemoFixtures.companionID
                    }
                    .accessibilityIdentifier("chat.demo.switch-companion")
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let stagedFixture {
                HStack {
                    Spacer()
                    Button(stagedFixture.deliveredStagedReply ? "Reply delivered" : "Stage reply") {
                        stagedFixture.stageNextPoll()
                    }
                    .buttonStyle(.bordered)
                    .accessibilityIdentifier("demo.stage-reply")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
            }
        }
    }

    private var selectedCompanion: CompanionSummary {
        selectedCompanionID == CompanionTranscriptWindowDemoFixtures.companionID
            ? CompanionTranscriptWindowDemoFixtures.companion
            : CompanionTranscriptWindowDemoFixtures.secondCompanion
    }
}

@MainActor
private enum CompanionTranscriptWindowDemoFixtures {
    static let companionID = "c96ab360-00f3-4497-a51a-51442db8add1"
    static let secondCompanionID = "d97bc471-11f4-45a8-b62b-62553ec9bee2"
    static let usesShortThread = ProcessInfo.processInfo.environment[
        "COMPANION_TRANSCRIPT_DEMO_SHORT"
    ] == "1"
    static let usesStagedPoll = ProcessInfo.processInfo.environment[
        "COMPANION_TRANSCRIPT_DEMO_STAGED_POLL"
    ] == "1"
    static let includesPendingQuestion = ProcessInfo.processInfo.environment[
        "COMPANION_TRANSCRIPT_DEMO_QUESTION"
    ] == "1"

    static let companion: CompanionSummary = decode(#"""
    {
      "id":"c96ab360-00f3-4497-a51a-51442db8add1",
      "name":"Luna",
      "persona":"Keep long conversations legible",
      "model_id":"claude-sonnet",
      "selected_skill_ids":[],
      "icon":{"shape":1,"mouth":1,"accessory":6,"color":7},
      "access":"owner",
      "hidden":false,
      "unread":false,
      "last_message":{"preview":"The release matrix is now stable.","role":"assistant","created_at":"2026-08-26T12:00:00.000Z"},
      "runtime":{"state":"running","replying":true,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}
    }
    """#)

    static let secondCompanion: CompanionSummary = decode(#"""
    {
      "id":"d97bc471-11f4-45a8-b62b-62553ec9bee2",
      "name":"Orbit",
      "persona":"Keep another long conversation legible",
      "model_id":"claude-sonnet",
      "selected_skill_ids":[],
      "icon":{"shape":2,"mouth":2,"accessory":5,"color":4},
      "access":"owner",
      "hidden":false,
      "unread":false,
      "last_message":{"preview":"The second release matrix is stable.","role":"assistant","created_at":"2026-08-26T12:00:00.000Z"},
      "runtime":{"state":"running","replying":false,"last_error":null,"provider_ids":["anthropic"],"latest_operation":null}
    }
    """#)

    static let thread: CompanionThread = {
        let transcriptCount = usesShortThread ? 10 : 120
        var entries: [[String: Any]] = (1...transcriptCount).map { index in
            let role = index.isMultiple(of: 2) ? "assistant" : "user"
            var entry: [String: Any] = [
                "event_id": "long-\(index)",
                "ordinal": index,
                "role": role,
                "content": "Long-thread message \(index)",
                "author_id": role == "user" ? "owner-1" as Any : NSNull(),
                "author_name": role == "user" ? "Stan" as Any : NSNull(),
                "decision": NSNull(),
                "tool": NSNull(),
                "queued": false,
                "attachments": [Any](),
                "created_at": String(
                    format: index <= transcriptCount / 2
                        ? "2026-08-25T%02d:%02d:00.000Z"
                        : "2026-08-26T%02d:%02d:00.000Z",
                    index / 60,
                    index % 60
                ),
            ]

            switch index {
            case transcriptCount - 4:
                entry["role"] = "user"
                entry["content"] = "Check the final deployment table before we ship."
                entry["author_id"] = "owner-1"
                entry["author_name"] = "Stan"
            case transcriptCount - 3:
                entry["role"] = "assistant"
                entry["content"] = """
                ## Release matrix

                | Surface | State | Owner |
                | :-- | :--: | --: |
                | iOS chat | Ready for review | Mobile |
                | Runtime | Healthy | Platform |
                """
                entry["author_id"] = NSNull()
                entry["author_name"] = NSNull()
            case transcriptCount - 2:
                entry["role"] = "tool"
                entry["content"] = ""
                entry["author_id"] = NSNull()
                entry["author_name"] = NSNull()
                entry["tool"] = [
                    "call_id": "layout-check",
                    "kind": "shell",
                    "name": "run_layout_checks",
                    "title": "Validate native chat layout",
                    "status": "ok",
                    "detail": "Ordering and non-overlap checks completed.",
                    "screenshot": NSNull(),
                ]
            case transcriptCount - 1:
                entry["role"] = "user"
                entry["content"] = "Keep that result attached to the reply below."
                entry["author_id"] = "owner-1"
                entry["author_name"] = "Stan"
            case transcriptCount:
                entry["role"] = "assistant"
                entry["content"] = "Long-thread message \(transcriptCount)"
                entry["author_id"] = NSNull()
                entry["author_name"] = NSNull()
            default:
                break
            }
            return entry
        }

        if includesPendingQuestion {
            entries.append([
                "event_id": "decision:question-1",
                "ordinal": transcriptCount + 1,
                "role": "decision",
                "content": "Which release should I prepare?",
                "author_id": NSNull(),
                "author_name": NSNull(),
                "decision": [
                    "request_id": "question-1",
                    "kind": "question",
                    "name": "ask_user",
                    "title": "Which release should I prepare?",
                    "detail": NSNull(),
                    "status": "pending",
                    "answer": NSNull(),
                    "decided_by_id": NSNull(),
                    "decided_by_name": NSNull(),
                    "decided_at": NSNull(),
                    "expires_at": "2026-08-26T12:10:00.000Z",
                    "proposal": NSNull(),
                ],
                "tool": NSNull(),
                "queued": false,
                "attachments": [Any](),
                "created_at": "2026-08-26T12:00:30.000Z",
            ])
        }

        let queuedOrdinal = transcriptCount + (includesPendingQuestion ? 2 : 1)
        entries.append(contentsOf: [
            queuedEntry(
                ordinal: queuedOrdinal,
                eventID: "queued-one",
                turnID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                content: "Queue the accessibility follow-up."
            ),
            queuedEntry(
                ordinal: queuedOrdinal + 1,
                eventID: "queued-two",
                turnID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                content: "Then verify the compact-width layout."
            ),
        ])
        let payload: [String: Any] = [
            "companion_id": companionID,
            "viewer_id": "owner-1",
            "read_only": false,
            "can_send": true,
            "entries": entries,
            "active_turn": [
                "id": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                "companion_id": companionID,
                "client_message_id": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                "status": "running",
                "queue_sequence": queuedOrdinal + 2,
                "latest_attempt": NSNull(),
                "replying": true,
                "error": NSNull(),
                "state_changed_at": "2026-08-26T12:00:00.000Z",
                "settled_at": NSNull(),
                "created_at": "2026-08-26T12:00:00.000Z",
                "updated_at": "2026-08-26T12:00:00.000Z",
            ],
            "queued_count": 2,
            "interrupted_turn": NSNull(),
        ]
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(CompanionThread.self, from: data)
    }()

    private static func queuedEntry(
        ordinal: Int,
        eventID: String,
        turnID: String,
        content: String
    ) -> [String: Any] {
        [
            "event_id": eventID,
            "ordinal": ordinal,
            "role": "user",
            "content": content,
            "author_id": "owner-1",
            "author_name": "Stan",
            "decision": NSNull(),
            "tool": NSNull(),
            "turn_id": turnID,
            "queued": true,
            "attachments": [Any](),
            "created_at": "2026-08-26T12:01:00.000Z",
        ]
    }

    static func makeStagedFixture() -> DemoStagedThreadFixture? {
        usesStagedPoll || includesPendingQuestion
            ? DemoStagedThreadFixture(initial: thread)
            : nil
    }

    static func services(stagedFixture: DemoStagedThreadFixture?) -> ChatServices {
        let fixtureThread = thread
        let fixtureCompanion = companion
        let secondFixtureCompanion = secondCompanion
        return ChatServices(
            thread: { companionID in
                if companionID == fixtureCompanion.id, let stagedFixture {
                    return stagedFixture.nextThread()
                }
                return fixtureThread
            },
            listCompanions: { [fixtureCompanion, secondFixtureCompanion] },
            decide: { _, requestID, action in
                guard requestID == "question-1" else { return fixtureThread }
                if let stagedFixture {
                    return stagedFixture.settleQuestion(action: action)
                }
                return settledQuestionThread(from: fixtureThread, action: action)
            },
            retryTurn: { _, _, _ in throw CompanionTranscriptWindowDemoError.unavailable },
            cancelTurn: { _, _ in fixtureThread },
            listSkills: { [] },
            listPlugins: { [] },
            listProviders: { throw CompanionTranscriptWindowDemoError.unavailable }
        )
    }

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        try! JSONDecoder().decode(Value.self, from: Data(json.utf8))
    }

    fileprivate static func settledQuestionThread(
        from thread: CompanionThread,
        action: CompanionDecisionAction
    ) -> CompanionThread {
        guard case .answer(let answer) = action else { return thread }
        let encoded = try! JSONEncoder().encode(thread)
        var payload = try! JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        var entries = payload["entries"] as! [[String: Any]]
        guard let index = entries.firstIndex(where: { entry in
            (entry["decision"] as? [String: Any])?["request_id"] as? String == "question-1"
        }) else { return thread }
        var decision = entries[index]["decision"] as! [String: Any]
        decision["status"] = "answered"
        decision["answer"] = answer
        decision["decided_by_id"] = "owner-1"
        decision["decided_by_name"] = "Stan"
        decision["decided_at"] = "2026-08-26T12:00:45.000Z"
        entries[index]["decision"] = decision
        payload["entries"] = entries
        let data = try! JSONSerialization.data(withJSONObject: payload)
        return try! JSONDecoder().decode(CompanionThread.self, from: data)
    }
}

@MainActor
@Observable
private final class DemoStagedThreadFixture {
    private var current: CompanionThread
    private var stagesNextPoll = false
    private(set) var deliveredStagedReply = false

    init(initial: CompanionThread) {
        current = initial
    }

    func stageNextPoll() {
        stagesNextPoll = true
    }

    func nextThread() -> CompanionThread {
        guard stagesNextPoll else { return current }
        stagesNextPoll = false
        deliveredStagedReply = true

        let encoded = try! JSONEncoder().encode(current)
        var payload = try! JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        var entries = payload["entries"] as! [[String: Any]]
        let nextOrdinal = entries.compactMap { $0["ordinal"] as? Int }.max().map { $0 + 1 } ?? 1
        entries.append([
            "event_id": "staged-reply",
            "ordinal": nextOrdinal,
            "role": "assistant",
            "content": "Staged poll content has arrived.",
            "author_id": NSNull(),
            "author_name": NSNull(),
            "decision": NSNull(),
            "tool": NSNull(),
            "queued": false,
            "attachments": [Any](),
            "created_at": "2026-08-26T12:02:00.000Z",
        ])
        payload["entries"] = entries
        let data = try! JSONSerialization.data(withJSONObject: payload)
        current = try! JSONDecoder().decode(CompanionThread.self, from: data)
        return current
    }

    func settleQuestion(action: CompanionDecisionAction) -> CompanionThread {
        current = CompanionTranscriptWindowDemoFixtures.settledQuestionThread(
            from: current,
            action: action
        )
        return current
    }
}

private enum CompanionTranscriptWindowDemoError: Error {
    case unavailable
}
#endif
