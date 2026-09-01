import CompanionKit
import SwiftUI

struct CompanionInterruptedTurnNotice: View {
    let turn: CompanionTurn
    let queuedCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title3)
                    .foregroundStyle(Color.companionDanger)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 5) {
                    Text("Turn interrupted")
                        .font(.headline)
                        .foregroundStyle(Color.companionInk)
                    Text(turn.error?.message ?? "The runtime could not confirm how this turn ended.")
                        .font(.subheadline)
                        .foregroundStyle(Color.companionInk.opacity(0.82))
                        .fixedSize(horizontal: false, vertical: true)
                    Text("Earlier external actions may already have succeeded.")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                }
            }

            Text("This occurrence is terminal and will not be replayed. Later work continues automatically.")
                .font(.footnote.weight(.medium))
                .foregroundStyle(Color.companionMuted)

            if queuedCount > 0 {
                Text(queueMessage)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .companionMaterial(radius: 12)
    }

    private var queueMessage: String {
        let noun = queuedCount == 1 ? "message is" : "messages are"
        return "\(queuedCount) later \(noun) queued and will continue automatically."
    }
}
