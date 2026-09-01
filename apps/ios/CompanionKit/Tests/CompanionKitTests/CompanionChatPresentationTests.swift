import Foundation
import Testing
@testable import CompanionKit

@Test
func bubbleLayoutCapsWidthAndPreservesConversationAlignment() {
    #expect(CompanionChatBubbleLayout.maximumWidth(in: 390) == 312)
    #expect(CompanionChatBubbleLayout.maximumWidth(in: 1_200) == 680)
    #expect(CompanionChatBubbleLayout.maximumWidth(in: -20) == 0)
    #expect(CompanionChatBubbleLayout.alignment(for: .mine) == .trailing)
    #expect(CompanionChatBubbleLayout.alignment(for: .assistant) == .leading)
    #expect(CompanionChatBubbleLayout.alignment(for: .card) == .leading)
}

@Test
func bubbleLayoutKeepsConsecutiveAssistantRepliesDistinctButRelated() {
    #expect(CompanionChatBubbleLayout.spacing(after: nil, before: .assistant) == 0)
    #expect(CompanionChatBubbleLayout.spacing(after: .assistant, before: .assistant) == 8)
    #expect(CompanionChatBubbleLayout.spacing(after: .mine, before: .assistant) == 16)
    #expect(CompanionChatBubbleLayout.spacing(after: .assistant, before: .tool) == 16)
}

@Test
func pendingDecisionProjectionHonorsRoleAndAnswerState() throws {
    let question = try decision(status: "pending", kind: "question")

    let editor = CompanionDecisionCardProjection(
        decision: question,
        canAct: true,
        busy: false,
        answer: "  "
    )
    #expect(editor.isInteractive)
    #expect(editor.showsActions)
    #expect(editor.primaryActionTitle == "Answer")
    #expect(editor.secondaryActionTitle == "Deny")
    #expect(editor.primaryActionDisabled)

    let viewer = CompanionDecisionCardProjection(
        decision: question,
        canAct: false,
        busy: false,
        answer: "Yes"
    )
    #expect(!viewer.isInteractive)
    #expect(!viewer.showsActions)
    #expect(viewer.primaryActionTitle == nil)
    #expect(viewer.waitingMessage == "Waiting for an Owner or Editor")
}

@Test
func settledDecisionProjectionCollapsesAndFailsClosed() throws {
    let expired = CompanionDecisionCardProjection(
        decision: try decision(status: "expired", kind: "config"),
        canAct: true,
        busy: false,
        answer: ""
    )
    #expect(expired.isCollapsed)
    #expect(!expired.showsActions)
    #expect(!expired.isInteractive)
    #expect(expired.primaryActionTitle == nil)
    #expect(expired.outcome == .expired)
    #expect(expired.outcome?.bubbleText == "Timed out, denied")

    let answered = CompanionDecisionCardProjection(
        decision: try decision(status: "answered", kind: "question", answer: "Ship it"),
        canAct: true,
        busy: false,
        answer: "stale local answer"
    )
    #expect(answered.isCollapsed)
    #expect(answered.outcome == .answered("Ship it"))
    #expect(answered.outcome?.bubbleText == "Ship it")

    let busy = CompanionDecisionCardProjection(
        decision: try decision(status: "pending", kind: "file"),
        canAct: true,
        busy: true,
        answer: ""
    )
    #expect(busy.showsActions)
    #expect(!busy.isInteractive)
    #expect(busy.primaryActionTitle == "Approve")
}

@Test
func controlDecisionProjectionKeepsApplyingVisibleAndOwnerOnly() throws {
    let payload = #"""
    {
      "request_id":"11111111-1111-4111-8111-111111111111",
      "kind":"control",
      "name":"grant_peer_access",
      "title":"Allow delegation",
      "detail":null,
      "status":"allowed",
      "answer":null,
      "decided_by_id":"owner-1",
      "decided_by_name":"Stan",
      "decided_at":"2026-08-31T20:01:00Z",
      "expires_at":"2026-09-01T20:00:00Z",
      "required_access":"owner",
      "control_status":"applying",
      "proposal":{"kind":"control","request_kind":"peer_access","action":"grant_peer_access","summary":"Allow delegation","payload":{}}
    }
    """#
    let applying = try JSONDecoder().decode(CompanionDecision.self, from: Data(payload.utf8))
    let projection = CompanionDecisionCardProjection(
        decision: applying,
        canAct: false,
        busy: false,
        answer: ""
    )
    #expect(!projection.isCollapsed)
    #expect(!projection.showsActions)
    #expect(projection.waitingMessage == nil)
    #expect(projection.outcome == nil)
}

private func decision(status: String, kind: String, answer: String? = nil) throws -> CompanionDecision {
    let answerJSON = answer.map { value in
        let data = try! JSONEncoder().encode(value)
        return String(decoding: data, as: UTF8.self)
    } ?? "null"
    let payload = #"""
    {
      "request_id":"request-1",
      "kind":"\#(kind)",
      "name":"request",
      "title":"Review this request",
      "detail":null,
      "status":"\#(status)",
      "answer":\#(answerJSON),
      "decided_by_id":null,
      "decided_by_name":null,
      "decided_at":null,
      "expires_at":"2026-08-27T19:00:00Z",
      "proposal":null
    }
    """#
    return try JSONDecoder().decode(CompanionDecision.self, from: Data(payload.utf8))
}
