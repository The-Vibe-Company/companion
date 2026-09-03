import Foundation

/// Shared first-party copy derived only from the durable thread projection.
public enum CompanionRecoveryPresentation {
    public static func waitingMessage(for thread: CompanionThread) -> String? {
        if thread.activeTurn != nil {
            guard thread.queuedCount > 0 else { return nil }
            return "\(thread.queuedCount) later message\(thread.queuedCount == 1 ? " is" : "s are") queued."
        }
        let queueMessage = queuedMessage(count: thread.queuedCount)
        if let external = thread.queuedTurn?.externalBlock {
            return "External service issue: \(external.message) \(queueMessage)"
        }
        if thread.preparation?.takingLongerThanExpected == true {
            return "Ça prend plus de temps que prévu. \(queueMessage)"
        }
        if thread.preparation != nil {
            return "Je me réveille. \(queueMessage)"
        }
        if thread.queuedCount > 0 {
            return queueMessage
        }
        if thread.backgroundBusy == true {
            return "Background work is running. You can keep messaging."
        }
        return nil
    }

    private static func queuedMessage(count: Int) -> String {
        "\(count) message\(count == 1 ? " is" : "s are") saved and queued."
    }
}
