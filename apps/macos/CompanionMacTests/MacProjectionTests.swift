import Foundation
import CompanionKit
import XCTest
@testable import CompanionMac

final class MacProjectionTests: XCTestCase {
    func testFreshThreadAuthorizationOverridesAStaleRosterRole() {
        XCTAssertTrue(CompanionMacSendProjection.evaluate(threadCanSend: true, readOnly: false))
        XCTAssertFalse(CompanionMacSendProjection.evaluate(threadCanSend: false, readOnly: false))
        XCTAssertFalse(CompanionMacSendProjection.evaluate(threadCanSend: true, readOnly: true))
        XCTAssertFalse(CompanionMacSendProjection.evaluate(threadCanSend: nil, readOnly: nil))
    }

    func testExpiredAttachmentHasNoPreviewTarget() {
        XCTAssertTrue(CompanionMacAttachmentProjection.canOpen(.available))
        XCTAssertFalse(CompanionMacAttachmentProjection.canOpen(.expired))
    }

    func testMacRosterUsesSharedOwnerSectionsAndOmitsHiddenRows() throws {
        let companions = try makeCompanions()
        let sections = try JSONDecoder().decode([CompanionSection].self, from: Data(#"""
        [{"id":"section-a","org_id":"org","owner_id":"owner","name":"Work","position":0,"created_at":"2026-08-26T12:00:00Z","updated_at":"2026-08-26T12:00:00Z"}]
        """#.utf8))
        var store = CompanionSectionStore()
        store.reconcile(with: sections)

        let groups = store.groups(companions: companions)
        XCTAssertEqual(groups.map(\.name), ["Unassigned"])
        XCTAssertEqual(groups.flatMap(\.companions).map(\.name), ["Pinned", "Visible"])
        XCTAssertFalse(groups.flatMap(\.companions).contains(where: { $0.name == "Hidden" }))
    }

    func testSharedStatusProjectionMatchesMacDots() throws {
        let companions = try makeCompanions()
        XCTAssertEqual(CompanionStatusIndicatorState(runtime: companions[0].runtime), .live)
        XCTAssertEqual(CompanionStatusIndicatorState(runtime: companions[1].runtime), .inactive)
    }

    func testDesktopEligibilityRequiresOwnerOrEditorAndRunningBox() {
        XCTAssertEqual(
            CompanionMacDesktopEligibility.evaluate(access: .owner, runtimeState: .running),
            .allowed
        )
        XCTAssertEqual(
            CompanionMacDesktopEligibility.evaluate(access: .editor, runtimeState: .running),
            .allowed
        )
        XCTAssertEqual(
            CompanionMacDesktopEligibility.evaluate(access: .viewer, runtimeState: .running),
            .viewerReadOnly
        )
        XCTAssertEqual(
            CompanionMacDesktopEligibility.evaluate(access: .owner, runtimeState: .stopped),
            .boxNotRunning
        )
    }

    func testReplyingStopsWhenTheLoadedThreadClearsItsAdmissionProjection() {
        XCTAssertTrue(CompanionMacReplyingProjection.evaluate(
            threadLoaded: false,
            activeTurnReplying: nil,
            rosterReplying: true
        ))
        XCTAssertFalse(CompanionMacReplyingProjection.evaluate(
            threadLoaded: true,
            activeTurnReplying: nil,
            rosterReplying: true
        ))
        XCTAssertFalse(CompanionMacReplyingProjection.evaluate(
            threadLoaded: true,
            activeTurnReplying: false,
            rosterReplying: true
        ))
        XCTAssertTrue(CompanionMacReplyingProjection.evaluate(
            threadLoaded: true,
            activeTurnReplying: true,
            rosterReplying: false
        ))
    }

    @MainActor
    func testClearingDesktopInvalidatesAnInFlightSignedHandoff() throws {
        let state = CompanionMacDesktopWindowState()
        state.begin(companionID: "companion-a", companionName: "A", access: .owner)
        let staleGeneration = state.requestGeneration
        state.clear()

        let desktop = try JSONDecoder().decode(CompanionDesktop.self, from: Data(#"""
        {"desktop_url":"https://desktop.example.test/session?token=secret","provisioning":false,"automation":"computer","transport":"vnc"}
        """#.utf8))
        state.install(desktop, generation: staleGeneration, companionID: "companion-a")

        XCTAssertNil(state.desktopURL)
        XCTAssertEqual(state.phase, .empty)
        XCTAssertGreaterThan(state.requestGeneration, staleGeneration)
    }

    @MainActor
    func testSwitchingDesktopCompanionsRejectsTheOlderResponse() throws {
        let state = CompanionMacDesktopWindowState()
        state.begin(companionID: "companion-a", companionName: "A", access: .owner)
        let staleGeneration = state.requestGeneration
        state.begin(companionID: "companion-b", companionName: "B", access: .editor)

        let desktop = try JSONDecoder().decode(CompanionDesktop.self, from: Data(#"""
        {"desktop_url":"https://desktop.example.test/session?token=secret","provisioning":false,"automation":"computer","transport":"vnc"}
        """#.utf8))
        state.install(desktop, generation: staleGeneration, companionID: "companion-a")

        XCTAssertEqual(state.companionID, "companion-b")
        XCTAssertNil(state.desktopURL)
        XCTAssertEqual(state.phase, .requesting)
    }

    private func makeCompanions() throws -> [CompanionSummary] {
        let payload = #"""
        [
          {"id":"pinned","name":"Pinned","persona":"Operations","model_id":"model","selected_skill_ids":[],"selected_mcp_account_ids":[],"icon":{"shape":1,"mouth":1,"accessory":1,"color":2},"access":"owner","pinned":true,"hidden":false,"unread":false,"last_message":{"preview":"Ready","role":"assistant","created_at":"2026-08-26T12:00:00Z"},"runtime":{"state":"running","daemon_state":"running","replying":false,"provider_ids":["provider"]}},
          {"id":"visible","name":"Visible","persona":"Review queue","model_id":"model","selected_skill_ids":[],"selected_mcp_account_ids":[],"icon":{"shape":1,"mouth":1,"accessory":1,"color":2},"access":"editor","pinned":false,"hidden":false,"unread":true,"last_message":{"preview":"No new messages","role":"user","created_at":"2026-08-26T12:00:00Z"},"runtime":{"state":"stopped","daemon_state":"stopped","replying":false,"provider_ids":["provider"]}},
          {"id":"hidden","name":"Hidden","persona":"Maintenance","model_id":"model","selected_skill_ids":[],"selected_mcp_account_ids":[],"icon":{"shape":1,"mouth":1,"accessory":1,"color":2},"access":"owner","pinned":false,"hidden":true,"unread":false,"last_message":{"preview":"Deploy complete","role":"assistant","created_at":"2026-08-26T12:00:00Z"},"runtime":{"state":"running","daemon_state":"running","replying":false,"provider_ids":["provider"]}}
        ]
        """#
        return try JSONDecoder().decode([CompanionSummary].self, from: Data(payload.utf8))
    }
}
