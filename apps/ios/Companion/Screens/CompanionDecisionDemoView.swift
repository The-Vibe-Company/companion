#if DEBUG
import SwiftUI
import CompanionKit

struct CompanionDecisionDemoView: View {
    private let canAct: Bool
    private let failOnceRequestID: String?
    private let decisions = CompanionDecisionDemoFixtures.decisions
    @State private var notice: String?
    @State private var submissionCount = 0
    @State private var failedRequestIDs: Set<String> = []

    init() {
        let access = ProcessInfo.processInfo.environment["COMPANION_DECISION_DEMO_ACCESS"] ?? "owner"
        canAct = access == "owner" || access == "editor"
        failOnceRequestID = ProcessInfo.processInfo.environment["COMPANION_DECISION_DEMO_FAIL_ONCE"]
    }

    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    LazyVStack(spacing: 16) {
                        if let notice {
                            CompanionSuccessNotice(message: notice)
                                .accessibilityIdentifier("decision.demo.notice")
                        }

                        ForEach(decisions, id: \.requestID) { decision in
                            CompanionDecisionCard(
                                decision: decision,
                                companionName: "Conductor",
                                canAct: canAct,
                                catalog: CompanionDecisionDemoFixtures.catalog,
                                accent: .companionAccent,
                                accentForeground: .white,
                                onDecide: { action in
                                    try await Task.sleep(for: .milliseconds(120))
                                    if failOnceRequestID == decision.requestID,
                                       failedRequestIDs.insert(decision.requestID).inserted {
                                        throw CompanionDecisionDemoError.simulatedFailure
                                    }
                                    submissionCount += 1
                                    notice = "Submitted \(submissionCount) request: \(decision.requestID): \(action.label)"
                                },
                                onOpenPlugins: { _, _ in notice = "Opened Plugins" },
                                onAnswerFocusChange: { _ in }
                            )
                        }
                    }
                    .padding(16)
                }
            }
            .navigationTitle("Decision requests")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private enum CompanionDecisionDemoError: Error {
    case simulatedFailure
}

private extension CompanionDecisionAction {
    var label: String {
        switch self {
        case .allow: "allow"
        case .deny: "deny"
        case .answer: "answer"
        }
    }
}

private enum CompanionDecisionDemoFixtures {
    static let catalog = CompanionDecisionCatalog(
        skills: ["11111111-1111-4111-8111-111111111111": "release-review"],
        plugins: ["22222222-2222-4222-8222-222222222222": "github · work"],
        models: ["claude-sonnet": "Claude Sonnet"]
    )

    static let decisions = [
        decode(#"{"request_id":"question-1","kind":"question","name":"ask_user","title":"Which release should I prepare?","detail":null,"status":"pending","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T07:00:00.000Z","proposal":null}"#),
        decode(#"{"request_id":"config-1","kind":"config","name":"config","title":"Update the Companion configuration","detail":null,"status":"pending","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T07:00:00.000Z","proposal":{"kind":"config","add_skill_ids":["11111111-1111-4111-8111-111111111111"],"attach_plugin_ids":["22222222-2222-4222-8222-222222222222"],"model_id":"claude-sonnet","persona":"Keep releases calm."}}"#),
        decode(#"{"request_id":"config-connect-1","kind":"config","name":"config","title":"Connect GitHub to continue","detail":null,"status":"pending","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T07:00:00.000Z","proposal":{"kind":"config","connect_plugin":{"server_name":"github","reason":"Watch release events."}}}"#),
        decode(#"{"request_id":"routine-1","kind":"routine","name":"routine","title":"Create progress check","detail":null,"status":"pending","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T07:00:00.000Z","proposal":{"kind":"routine","name":"conductor-progress-check","prompt":"Check the current delivery progress.","cron":"*/30 * * * *","timezone":"Europe/Paris"}}"#),
        decode(#"{"request_id":"trigger-1","kind":"trigger","name":"trigger","title":"Watch GitHub releases","detail":null,"status":"pending","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":null,"expires_at":"2026-08-26T07:00:00.000Z","proposal":{"kind":"trigger","name":"release-watch","prompt":"Review new releases.","provider":"github","target":{"repo":"companion/app","events":["release"]}}}"#),
        decode(#"{"request_id":"shell-1","kind":"shell","name":"shell","title":"pnpm test","detail":"Runs the complete test suite.","status":"allowed","answer":null,"decided_by_id":"owner-1","decided_by_name":"Stan","decided_at":"2026-08-26T06:10:00.000Z","expires_at":"2026-08-26T07:00:00.000Z","proposal":null}"#),
        decode(#"{"request_id":"file-1","kind":"file","name":"edit","title":"Package.swift","detail":null,"status":"expired","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":"2026-08-26T06:10:00.000Z","expires_at":"2026-08-26T06:10:00.000Z","proposal":null}"#),
        decode(#"{"request_id":"question-closed","kind":"question","name":"ask_user","title":"Superseded question","detail":null,"status":"cancelled","answer":null,"decided_by_id":null,"decided_by_name":null,"decided_at":"2026-08-26T06:11:00.000Z","expires_at":"2026-08-26T07:00:00.000Z","proposal":null}"#),
    ]

    private static func decode(_ json: String) -> CompanionDecision {
        guard let data = json.data(using: .utf8),
              let decision = try? JSONDecoder().decode(CompanionDecision.self, from: data) else {
            preconditionFailure("Invalid Companion decision demo fixture")
        }
        return decision
    }
}
#endif
