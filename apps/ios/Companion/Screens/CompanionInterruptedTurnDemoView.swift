#if DEBUG
import CompanionKit
import SwiftUI

struct CompanionInterruptedTurnDemoView: View {
    var body: some View {
        NavigationStack {
            CompanionBackdrop {
                ScrollView {
                    CompanionInterruptedTurnNotice(
                        turn: CompanionInterruptedTurnDemoFixtures.turn,
                        queuedCount: 2
                    )
                    .padding(16)
                }
            }
            .navigationTitle("Interrupted turn")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

private enum CompanionInterruptedTurnDemoFixtures {
    static let turn: CompanionTurn = decode(#"""
    {
      "id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "companion_id":"5b7d655e-36bb-4fbe-9acd-e56103759911",
      "client_message_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "status":"interrupted","queue_sequence":20,"latest_attempt":null,"replying":false,
      "error":{"code":"cold_start_deadline_exceeded","message":"The Companion did not start before its deadline.","action":"retry"},
      "state_changed_at":"2026-08-26T05:59:33.505Z","settled_at":"2026-08-26T05:59:33.505Z",
      "created_at":"2026-08-26T05:55:12.466Z","updated_at":"2026-08-26T05:59:33.505Z"
    }
    """#)

    private static func decode<Value: Decodable>(_ json: String) -> Value {
        guard let data = json.data(using: .utf8),
              let value = try? JSONDecoder().decode(Value.self, from: data) else {
            preconditionFailure("Invalid interrupted-turn demo fixture")
        }
        return value
    }
}
#endif
