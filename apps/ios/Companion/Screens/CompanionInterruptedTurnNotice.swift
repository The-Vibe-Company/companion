import CompanionKit
import SwiftUI

struct CompanionInterruptedTurnNotice: View {
    let turn: CompanionTurn
    let queuedCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: recoverySymbol)
                    .font(.title3)
                    .foregroundStyle(recoveryColor)
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
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Label(recoveryMessage, systemImage: recoveryStatusSymbol)
                .font(.footnote.weight(.medium))
                .foregroundStyle(recoveryColor)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("chat.interrupted.recovery-status")

            if queuedCount > 0 {
                Text(queueMessage)
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Color.companionMuted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .companionMaterial(radius: 12)
        .accessibilityElement(children: .contain)
    }

    private var recoveryMessage: String {
        switch turn.recoveryStatus {
        case .pending:
            "Automatic cleanup for this turn is queued. The prompt will not be replayed. Later messages resume automatically in order when cleanup finishes."
        case .running:
            "Automatic cleanup for this turn is running. The prompt will not be replayed. Later messages resume automatically in order when cleanup finishes."
        case .completed:
            "Automatic cleanup for this turn is complete. The prompt was not replayed. Later messages continue automatically in order."
        case .unknown, nil:
            "Automatic cleanup for this turn continues in the background. The prompt will not be replayed. Later messages resume automatically in order."
        }
    }

    private var recoverySymbol: String {
        turn.recoveryStatus == .completed ? "checkmark.circle.fill" : "exclamationmark.triangle.fill"
    }

    private var recoveryStatusSymbol: String {
        switch turn.recoveryStatus {
        case .completed: "checkmark.circle"
        case .running: "gearshape.2"
        case .pending, .unknown, nil: "clock"
        }
    }

    private var recoveryColor: Color {
        turn.recoveryStatus == .completed ? .companionSuccess : .companionWarning
    }

    private var queueMessage: String {
        let noun = queuedCount == 1 ? "message" : "messages"
        return "\(queuedCount) later \(noun) will continue automatically in order."
    }
}
