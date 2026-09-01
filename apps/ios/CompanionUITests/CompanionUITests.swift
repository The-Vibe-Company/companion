import CoreGraphics
import Foundation
import XCTest

final class CompanionUITests: XCTestCase {
    override func setUpWithError() throws {
        // Put setup code here. This method is called before the invocation of each test method in the class.

        // In UI tests it is usually best to stop immediately when a failure occurs.
        continueAfterFailure = false

        // In UI tests it’s important to set the initial state - such as interface orientation - required for your tests before they run. The setUp method is a good place to do this.
    }

    override func tearDownWithError() throws {
        // Put teardown code here. This method is called after the invocation of each test method in the class.
    }

    @MainActor
    func testLiquidGlassDemoCanSendAMessage() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let composer = app.descendants(matching: .any)["demo.composer"]
        let send = app.buttons["demo.send"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(send.exists)

        app.buttons["Ouvrir les conversations"].tap()
        XCTAssertTrue(app.navigationBars["Conversations"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["demo.roster.inbox-triage"].exists)
        app.buttons["Fermer"].tap()

        composer.tap()
        composer.typeText("Le détail est impeccable.")
        XCTAssertTrue(send.isEnabled)
        send.tap()

        XCTAssertTrue(app.staticTexts["Le détail est impeccable."].waitForExistence(timeout: 3))
    }

    @MainActor
    func testChatPhotoLibraryOpensOnFirstSelectionWithKeyboardVisible() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-detail-demo"]
        app.launchEnvironment["COMPANION_DETAIL_DEMO_ACCESS"] = "owner"
        app.launch()

        let composer = app.descendants(matching: .any)["chat.composer"]
        let attach = app.buttons["chat.attach"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(attach.exists)

        composer.tap()
        composer.typeText("Draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))

        attach.tap()
        let photoLibrary = app.buttons["Photo library"]
        XCTAssertTrue(photoLibrary.waitForExistence(timeout: 2))
        photoLibrary.tap()

        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }

    @MainActor
    func testChatComposerExposesAccessibleVoiceTranscriptionControl() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-detail-demo"]
        app.launchEnvironment["COMPANION_DETAIL_DEMO_ACCESS"] = "owner"
        app.launchEnvironment["COMPANION_DETAIL_DEMO_TRANSCRIPTION_AVAILABLE"] = "true"
        app.launch()

        let microphone = app.buttons["chat.transcription.toggle"]
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        XCTAssertEqual(microphone.label, "Start voice transcription")
        XCTAssertGreaterThanOrEqual(microphone.frame.width, 44)
        XCTAssertGreaterThanOrEqual(microphone.frame.height, 44)
    }

    @MainActor
    func testChatComposerHidesVoiceTranscriptionWithoutDeploymentKey() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-detail-demo"]
        app.launchEnvironment["COMPANION_DETAIL_DEMO_ACCESS"] = "owner"
        app.launch()

        let composer = app.descendants(matching: .any)["chat.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat.transcription.toggle"].exists)
    }

    @MainActor
    func testDecisionDemoAnswersAndApprovesRequests() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "owner"
        app.launch()

        let answerField = decisionAnswerField(in: app)
        let answer = app.buttons["decision.answer.question-1"]
        let deny = app.buttons["decision.deny.question-1"]
        XCTAssertTrue(answerField.waitForExistence(timeout: 5))
        XCTAssertTrue(answer.exists)
        XCTAssertEqual(answer.label, "Answer request")
        XCTAssertTrue(deny.exists)
        XCTAssertFalse(answer.isEnabled)

        answerField.tap()
        answerField.typeText("Ship the stable release")
        XCTAssertTrue(answer.isEnabled)
        answer.doubleTap()
        XCTAssertTrue(app.staticTexts["Submitted 1 request: question-1: answer"].waitForExistence(timeout: 2))

        let routineCard = app.descendants(matching: .any)["decision.card.routine-1"]
        for _ in 0..<4 where !routineCard.exists { app.swipeUp() }
        XCTAssertTrue(routineCard.waitForExistence(timeout: 2))
        let approveRoutine = app.buttons["decision.approve.routine-1"]
        XCTAssertTrue(approveRoutine.waitForExistence(timeout: 2))
        approveRoutine.tap()
        XCTAssertTrue(app.staticTexts["Submitted 2 request: routine-1: allow"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testDecisionDemoKeepsViewerReadOnly() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "viewer"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["decision.card.question-1"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["decision.answer.question-1"].exists)
        XCTAssertFalse(app.buttons["decision.deny.question-1"].exists)
        XCTAssertTrue(app.staticTexts["Waiting for an Owner or Editor"].exists)
    }

    @MainActor
    func testDecisionDemoSupportsAccessibilityDynamicType() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-companion-decision-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "editor"
        app.launch()

        XCTAssertTrue(app.descendants(matching: .any)["decision.card.question-1"].waitForExistence(timeout: 5))
        let answer = app.buttons["decision.answer.question-1"]
        for _ in 0..<3 where !answer.exists { app.swipeUp() }
        XCTAssertTrue(answer.exists)
        XCTAssertTrue(app.staticTexts["Waiting"].exists)
    }

    @MainActor
    func testDecisionDemoRendersEveryDecisionKindAndSettledState() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "editor"
        app.launch()

        for requestID in [
            "question-1", "config-1", "routine-1", "trigger-1", "shell-1", "file-1",
            "question-closed",
        ] {
            let card = app.descendants(matching: .any)["decision.card.\(requestID)"]
            for _ in 0..<6 where !card.exists { app.swipeUp() }
            XCTAssertTrue(card.waitForExistence(timeout: 2), "Missing \(requestID)")
        }
        XCTAssertTrue(app.staticTexts["Timed out, denied"].exists)
        XCTAssertTrue(app.staticTexts["Closed without approval"].exists)
    }

    @MainActor
    func testDecisionDemoOpensPluginsForAConnectionRequest() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "owner"
        app.launch()

        let openPlugins = app.buttons["decision.open-plugins.config-connect-1"]
        for _ in 0..<5 where !openPlugins.exists { app.swipeUp() }
        XCTAssertTrue(openPlugins.waitForExistence(timeout: 2))
        openPlugins.tap()
        XCTAssertTrue(app.staticTexts["Opened Plugins"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testDecisionDemoRecoversAfterAnError() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-decision-demo"]
        app.launchEnvironment["COMPANION_DECISION_DEMO_ACCESS"] = "owner"
        app.launchEnvironment["COMPANION_DECISION_DEMO_FAIL_ONCE"] = "question-1"
        app.launch()

        let answerField = decisionAnswerField(in: app)
        let answer = app.buttons["decision.answer.question-1"]
        XCTAssertTrue(answerField.waitForExistence(timeout: 5))
        answerField.tap()
        answerField.typeText("Retry this answer")
        answer.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["decision.error.question-1"]
                .waitForExistence(timeout: 2)
        )
        XCTAssertTrue(answer.isEnabled)
        answer.tap()
        XCTAssertTrue(app.staticTexts["Submitted 1 request: question-1: answer"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testInterruptedTurnDemoKeepsRecoveryPassiveForOwner() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-interruption-demo"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Turn interrupted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["2 later messages are queued and will continue automatically."].exists)
        XCTAssertTrue(app.staticTexts[
            "This occurrence is terminal and will not be replayed. Later work continues automatically."
        ].exists)
        XCTAssertFalse(app.buttons["chat.interrupted.retry"].exists)
        XCTAssertFalse(app.buttons["chat.interrupted.cancel"].exists)
    }

    @MainActor
    func testQueuedMessagesStayCollapsedAndCanBeRemoved() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-queued-demo"]
        app.launch()

        let queue = app.buttons["chat.queue.toggle"]
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        XCTAssertEqual(queue.label, "3 queued messages")
        XCTAssertTrue(app.descendants(matching: .any)["queue.demo.composer"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["chat.queue.list"].exists)
        XCTAssertFalse(app.staticTexts["Then tighten the empty-state copy."].exists)

        queue.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.queue.list"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Then tighten the empty-state copy."].exists)
        XCTAssertTrue(app.staticTexts["2 images, 1 file"].exists)

        let remove = app.buttons["chat.queue.remove.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]
        XCTAssertTrue(remove.exists)
        XCTAssertTrue(remove.label.contains("Compare these screenshots"))
        XCTAssertNotEqual(
            remove.label,
            app.buttons["chat.queue.remove.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"].label
        )
        remove.tap()
        XCTAssertTrue(app.buttons["Remove from queue"].waitForExistence(timeout: 2))
        app.buttons["Remove from queue"].tap()

        XCTAssertTrue(app.buttons["chat.queue.toggle"].waitForExistence(timeout: 2))
        XCTAssertEqual(app.buttons["chat.queue.toggle"].label, "2 queued messages")
        XCTAssertFalse(app.staticTexts[
            "Compare these screenshots and call out the visual regressions."
        ].exists)

        app.buttons["chat.queue.toggle"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["chat.queue.list"].exists)
    }

    @MainActor
    func testRoutineQueuedMessageUsesCompactChipAndCollapsedRemoval() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-queued-demo"]
        app.launchEnvironment["COMPANION_QUEUED_DEMO_ROUTINE"] = "1"
        app.launch()

        let queue = app.buttons["chat.queue.toggle"]
        let prompt = "ROUTINE_PROMPT_SHOULD_STAY_HIDDEN_UNTIL_EXPANDED"
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        XCTAssertEqual(queue.label, "1 queued message")
        XCTAssertFalse(app.staticTexts[prompt].exists)
        XCTAssertTrue((queue.value as? String)?.contains("Routine: Morning brief") == true)
        XCTAssertGreaterThanOrEqual(queue.frame.height, 44)
        XCTAssertLessThanOrEqual(queue.frame.height, 64)

        let collapsedRemove = app.buttons[
            "chat.queue.remove.dddddddd-dddd-4ddd-8ddd-dddddddddddd"
        ]
        XCTAssertTrue(collapsedRemove.exists)
        XCTAssertGreaterThanOrEqual(collapsedRemove.frame.width, 44)
        XCTAssertGreaterThanOrEqual(collapsedRemove.frame.height, 44)
        XCTAssertFalse(collapsedRemove.label.contains(prompt))
        collapsedRemove.tap()
        XCTAssertTrue(app.buttons["Keep queued"].waitForExistence(timeout: 2))
        app.buttons["Keep queued"].tap()

        queue.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.queue.list"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts[prompt].waitForExistence(timeout: 2))
        let expandedRoutineRemovals = app.buttons.matching(
            NSPredicate(
                format: "identifier == %@",
                "chat.queue.remove.dddddddd-dddd-4ddd-8ddd-dddddddddddd"
            )
        )
        XCTAssertEqual(expandedRoutineRemovals.count, 1)
    }

    @MainActor
    func testRoutineArrivalCollapsesAnExpandedQueueWithoutChangingOrdinarySemantics() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-queued-demo"]
        app.launchEnvironment["COMPANION_QUEUED_DEMO_ROUTINE_TRANSITION"] = "1"
        app.launch()

        let queue = app.buttons["chat.queue.toggle"]
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        queue.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.queue.list"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Then tighten the empty-state copy."].exists)

        app.buttons["queue.demo.load-routine"].tap()
        let collapsedQueue = app.buttons["chat.queue.toggle"]
        XCTAssertTrue(collapsedQueue.waitForExistence(timeout: 2))
        XCTAssertTrue((collapsedQueue.value as? String)?.contains("Routine: Morning brief") == true)
        XCTAssertFalse(app.descendants(matching: .any)["chat.queue.list"].exists)
        XCTAssertFalse(app.staticTexts["ROUTINE_PROMPT_SHOULD_STAY_HIDDEN_UNTIL_EXPANDED"].exists)
    }

    @MainActor
    func testQueuedMessagesSupportAccessibilityDynamicType() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-companion-queued-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launch()

        let queue = app.buttons["chat.queue.toggle"]
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        queue.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.queue.list"].exists)
        XCTAssertTrue(app.buttons[
            "chat.queue.remove.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        ].exists)
    }

    @MainActor
    func testQueuedMessagesRemainReadOnlyForAViewer() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-queued-demo"]
        app.launchEnvironment["COMPANION_QUEUED_DEMO_ACCESS"] = "viewer"
        app.launch()

        let queue = app.buttons["chat.queue.toggle"]
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        queue.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.queue.list"].exists)
        XCTAssertFalse(app.buttons[
            "chat.queue.remove.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        ].exists)
    }

    @MainActor
    func testQueuedMessageRemovalCanRetryAfterFailure() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-queued-demo"]
        app.launchEnvironment["COMPANION_QUEUED_DEMO_FAIL_ONCE"] = "1"
        app.launch()

        app.buttons["chat.queue.toggle"].tap()
        let remove = app.buttons["chat.queue.remove.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        app.buttons["Remove from queue"].tap()

        let queueList = app.descendants(matching: .any)["chat.queue.list"]
        app.buttons["chat.queue.toggle"].tap()
        XCTAssertTrue(queueList.waitForNonExistence(timeout: 2))
        app.buttons["chat.queue.toggle"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.queue.error"].waitForExistence(timeout: 2))
        XCTAssertTrue(remove.isEnabled)
        remove.tap()
        app.buttons["Remove from queue"].tap()
        XCTAssertEqual(app.buttons["chat.queue.toggle"].label, "2 queued messages")
    }

    @MainActor
    func testInterruptedTurnDemoKeepsRecoveryPassiveForEditor() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-interruption-demo"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Turn interrupted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts[
            "This occurrence is terminal and will not be replayed. Later work continues automatically."
        ].exists)
        XCTAssertFalse(app.buttons["chat.interrupted.retry"].exists)
        XCTAssertFalse(app.buttons["chat.interrupted.cancel"].exists)
    }

    @MainActor
    func testInterruptedTurnDemoKeepsViewerReadOnly() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-interruption-demo"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Turn interrupted"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts[
            "This occurrence is terminal and will not be replayed. Later work continues automatically."
        ].exists)
        XCTAssertFalse(app.buttons["chat.interrupted.retry"].exists)
        XCTAssertFalse(app.buttons["chat.interrupted.cancel"].exists)
    }

    @MainActor
    func testCompanionToolRunCardOpensCompleteDetailsAndScreenshotPreview() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let shellDetails = app.buttons["tool-run.open-details.tool:demo-shell-1"]
        XCTAssertTrue(shellDetails.waitForExistence(timeout: 5))
        XCTAssertEqual(shellDetails.label, "Tool operation: run_command, Done")

        let fileDetails = app.buttons["tool-run.open-details.tool:demo-file-1"]
        XCTAssertTrue(fileDetails.exists)
        XCTAssertEqual(fileDetails.label, "Tool operation: file, Failed")

        shellDetails.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        XCTAssertTrue(app.navigationBars["Tool details"].waitForExistence(timeout: 2))
        let toolName = app.staticTexts["tool-run.detail.name"]
        XCTAssertTrue(toolName.exists)
        XCTAssertEqual(toolName.label, "run_command")
        XCTAssertTrue(app.descendants(matching: .any)["tool-run.detail.timestamp"].exists)
        XCTAssertTrue(app.images["tool-run.detail.screenshot"].waitForExistence(timeout: 2))
        let shellPayload = app.staticTexts["tool-run.detail.payload"]
        XCTAssertTrue(shellPayload.exists)
        XCTAssertTrue(shellPayload.label.contains("not interpreted as HTML"))
        try captureScreenshot(named: "chat-tool-operation-preview.png")
        app.buttons["tool-run.detail.done"].tap()
        XCTAssertTrue(app.navigationBars["Tool details"].waitForNonExistence(timeout: 2))

        fileDetails.tap()
        XCTAssertTrue(app.navigationBars["Tool details"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["tool-run.detail.empty"].exists)
        XCTAssertTrue(app.staticTexts["tool-run.detail.empty"].label.contains("No detail payload"))
        app.buttons["tool-run.detail.done"].tap()
        XCTAssertTrue(app.navigationBars["Tool details"].waitForNonExistence(timeout: 2))

        let subagentDetails = app.buttons["tool-run.open-details.tool:demo-subagent-1"]
        for _ in 0..<3 where !subagentDetails.isHittable { app.swipeUp() }
        XCTAssertTrue(subagentDetails.isHittable)
        subagentDetails.tap()

        let detail = app.staticTexts["tool-run.detail.payload"]
        XCTAssertTrue(detail.waitForExistence(timeout: 2))
        XCTAssertTrue(detail.label.contains("Reviewing the transcript model"))
        XCTAssertTrue(detail.label.contains("Finishing the native tool-operation review"))
        XCTAssertTrue(app.descendants(matching: .any)["tool-run.detail.status"].exists)
        try captureScreenshot(named: "chat-tool-operation-details.png")
    }

    @MainActor
    func testCompanionToolRunDetailsSupportAccessibilityDynamicType() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-glass-chat-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launch()

        let shellDetails = app.buttons["tool-run.open-details.tool:demo-shell-1"]
        for _ in 0..<4 where !shellDetails.isHittable { app.swipeDown() }
        XCTAssertTrue(shellDetails.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(shellDetails.frame.height, 44)
        shellDetails.tap()
        XCTAssertTrue(app.navigationBars["Tool details"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["tool-run.detail.payload"].exists)
        XCTAssertTrue(app.buttons["tool-run.detail.done"].isHittable)
    }

    @MainActor
    func testThinkingStatusRevealsCollapsedReasoningDisclosure() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo", "-glass-chat-thinking-demo"]
        app.launch()

        let status = app.buttons["chat.thinking-status"]
        let composer = app.descendants(matching: .any)["demo.composer"]
        XCTAssertTrue(status.waitForExistence(timeout: 5))
        XCTAssertTrue(composer.exists)
        XCTAssertEqual(status.label, "Companion thinking")
        XCTAssertLessThan(status.frame.maxY, composer.frame.minY)
        XCTAssertLessThan(composer.frame.minY - status.frame.maxY, 20)

        let legacyTopBanner = app.descendants(matching: .any).matching(
            NSPredicate(
                format: "label CONTAINS[c] %@ OR label CONTAINS[c] %@",
                "is replying",
                "écrit une réponse"
            )
        ).firstMatch
        XCTAssertFalse(legacyTopBanner.exists)

        let disclosure = app.buttons["thinking.disclosure"]
        for _ in 0..<6 where !disclosure.exists {
            app.swipeUp()
        }
        XCTAssertTrue(disclosure.waitForExistence(timeout: 2))
        XCTAssertEqual(disclosure.value as? String, "Collapsed")
        XCTAssertFalse(app.descendants(matching: .any)["thinking.content"].exists)

        status.tap()
        let content = app.descendants(matching: .any)["thinking.content"]
        XCTAssertTrue(content.waitForExistence(timeout: 2))
        XCTAssertEqual(disclosure.value as? String, "Expanded")
        XCTAssertTrue(app.staticTexts[
            "Salut Stan. J’ai préparé une direction claire inspirée du rythme de Grok, mais pensée pour iOS 26 et son Liquid Glass natif."
        ].exists)

        disclosure.tap()
        XCTAssertEqual(disclosure.value as? String, "Collapsed")
        XCTAssertFalse(content.exists)
    }

    @MainActor
    private func decisionAnswerField(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any).matching(
            NSPredicate(
                format: "identifier == %@ OR label == %@",
                "decision.answer-field.question-1",
                "Answer"
            )
        ).firstMatch
    }

    @MainActor
    func testLiquidGlassDemoRendersCompanionMarkdownSafely() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let reply = app.descendants(matching: .any)["demo.markdown.reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5))

        let heading = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.heading.")
        ).firstMatch
        let list = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.list.")
        ).firstMatch
        let quote = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.quote.")
        ).firstMatch
        let code = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.code-block.")
        ).firstMatch
        let table = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.table.")
        ).firstMatch

        XCTAssertTrue(heading.exists)
        XCTAssertTrue(list.exists)
        XCTAssertTrue(quote.exists)
        XCTAssertTrue(code.exists)
        XCTAssertTrue(table.exists)
        XCTAssertTrue(app.staticTexts["Rapport d’incident"].exists)
        XCTAssertTrue(app.staticTexts["[image: preuve distante]"].exists)
        XCTAssertTrue(app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "<img src=x onerror=alert(1)>")
        ).firstMatch.exists)

        XCTAssertTrue(app.links["Documentation sûre"].exists)
        XCTAssertTrue(app.links["https://github.com/The-Vibe-Company/companion"].exists)
        XCTAssertTrue(app.links["le ticket"].exists)
        XCTAssertFalse(app.links["https://example.com/not-a-link"].exists)
        XCTAssertFalse(app.links["Lien refusé"].exists)
        XCTAssertTrue(app.staticTexts["Lien refusé"].exists)
        XCTAssertFalse(app.images["preuve distante"].exists)
        try captureScreenshot(named: "chat-links-light.png")

        let composer = app.descendants(matching: .any)["demo.composer"]
        let send = app.buttons["demo.send"]
        composer.tap()
        composer.typeText("**Message membre enrichi**")
        send.tap()
        XCTAssertTrue(app.staticTexts["Message membre enrichi"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testMessageLinkLongPressOffersOpenAndCopy() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let link = app.links["https://github.com/The-Vibe-Company/companion"]
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        XCTAssertTrue(link.isHittable)
        link.press(forDuration: 1.2)

        XCTAssertTrue(app.buttons["Open"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["Copy"].exists)
    }

    @MainActor
    func testMessageLinksRemainVisibleInBlackAppearance() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo", "-markdown-table-dark-demo"]
        app.launch()

        let bareLink = app.links["https://github.com/The-Vibe-Company/companion"]
        let markdownLink = app.links["le ticket"]
        XCTAssertTrue(bareLink.waitForExistence(timeout: 5))
        XCTAssertTrue(markdownLink.exists)
        XCTAssertTrue(bareLink.isHittable)
        try captureScreenshot(named: "chat-links-black.png")
    }

    @MainActor
    func testMessageLongPressOffersCopyShareAndSelectableText() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let reply = app.descendants(matching: .any)["demo.markdown.reply"]
        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        reply.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.2)

        XCTAssertTrue(app.buttons["Copy"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["Share"].exists)
        XCTAssertTrue(app.buttons["Select Text"].exists)
        // Activating an iOS 26 context-menu command leaves XCUI waiting indefinitely for app
        // idleness. The deterministic source-shape test covers each command's handler payload.
    }

    @MainActor
    func testMarkdownCodeBlockCopyShowsSuccessStateAndNativeHitTarget() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo"]
        app.launch()

        let copy = app.buttons.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.code-copy.")
        ).firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(copy.frame.height, 44)
        XCTAssertGreaterThanOrEqual(copy.frame.width, 44)

        copy.tap()
        XCTAssertTrue(app.buttons["Code copied"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testQueuedOwnMessageContextDeleteUsesExistingRemoval() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-queued-demo"]
        app.launch()

        let queue = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "3 queued")
        ).firstMatch
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        queue.tap()
        let item = app.staticTexts[
            "Compare these screenshots and call out the visual regressions."
        ]
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        item.press(forDuration: 1.2)
        XCTAssertTrue(app.buttons["Delete"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testQueuedTeammateContextDeleteIsUnavailableToEditor() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-queued-demo"]
        app.launchEnvironment["COMPANION_QUEUED_DEMO_ACCESS"] = "editor"
        app.launch()

        let queue = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "3 queued")
        ).firstMatch
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        queue.tap()
        let item = app.staticTexts[
            "Compare these screenshots and call out the visual regressions."
        ]
        XCTAssertTrue(item.waitForExistence(timeout: 5))
        let visibleRemoval = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Delete queued message:")
        ).firstMatch
        XCTAssertTrue(visibleRemoval.waitForExistence(timeout: 2))
        item.press(forDuration: 1.2)
        XCTAssertFalse(app.buttons["Delete"].waitForExistence(timeout: 1))
    }

    @MainActor
    func testTranscriptWindowDemoStartsWithOnlyTheNewestFiftyMessages() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Long-thread message 120"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Long-thread message 1"].exists)
        for _ in 0..<5 where !app.buttons["chat.load-earlier"].exists {
            app.swipeDown()
        }
        XCTAssertTrue(app.buttons["chat.load-earlier"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testTranscriptTapDismissesKeyboardWithoutBlockingMessageControls() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launchEnvironment["COMPANION_TRANSCRIPT_DEMO_SHORT"] = "1"
        app.launch()

        let latestMessage = app.descendants(matching: .any)["chat.entry.long-10"]
        XCTAssertTrue(latestMessage.waitForExistence(timeout: 12))

        // SwiftUI does not consistently surface the multiline field's identifier to
        // XCTest, so locate the fixture's sole text field by its element role.
        let composer = app.textFields.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5))

        composer.tap()
        composer.typeText("Draft")
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 2))

        // Tap the transcript surface directly so this test does not depend on XCTest
        // resolving a lazily rendered Markdown descendant while the keyboard is animating.
        let transcript = app.scrollViews.matching(
            NSPredicate(format: "identifier == %@", "chat.transcript")
        ).firstMatch
        XCTAssertTrue(transcript.isHittable)
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        let keyboardDismissed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == false"),
            object: keyboard
        )
        wait(for: [keyboardDismissed], timeout: 5)

        let toolCard = app.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "run_layout_checks")
        ).firstMatch
        for _ in 0..<3 where !toolCard.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(toolCard.isHittable)
        toolCard.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["tool-run.detail"].waitForExistence(timeout: 3)
        )
    }

    @MainActor
    func testTranscriptQuestionKeepsCardFocusedAndSubmitsAnswer() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launchEnvironment["COMPANION_TRANSCRIPT_DEMO_SHORT"] = "1"
        app.launchEnvironment["COMPANION_TRANSCRIPT_DEMO_QUESTION"] = "1"
        app.launch()

        let composer = app.descendants(matching: .any)["chat.composer"]
        let answerField = decisionAnswerField(in: app)
        let answerButton = app.buttons["decision.answer.question-1"]
        XCTAssertTrue(composer.waitForExistence(timeout: 12))
        XCTAssertTrue(answerField.waitForExistence(timeout: 5))

        composer.tap()
        composer.typeText("Keep this draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))

        XCTAssertTrue(answerField.isHittable)
        answerField.tap()
        answerField.typeText("Ship the stable release")
        XCTAssertEqual(composer.value as? String, "Keep this draft")
        XCTAssertTrue(answerButton.isHittable)
        answerButton.tap()

        XCTAssertTrue(app.staticTexts["Ship the stable release"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts["Answered"].exists)
    }

    @MainActor
    func testTranscriptWindowDemoLoadsEarlierMessages() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launch()

        let loadEarlier = app.buttons["chat.load-earlier"]
        for _ in 0..<12 where !loadEarlier.isHittable {
            app.swipeDown()
        }
        XCTAssertTrue(loadEarlier.waitForExistence(timeout: 5))
        XCTAssertTrue(loadEarlier.isHittable)
        let preservedAnchor = app.descendants(matching: .any)["chat.entry.long-71"]
        XCTAssertTrue(preservedAnchor.exists)
        loadEarlier.tap()

        let anchorVisible = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: preservedAnchor
        )
        wait(for: [anchorVisible], timeout: 3)
        XCTAssertTrue(preservedAnchor.isHittable)
        let earlier = app.descendants(matching: .any)["chat.entry.long-21"]
        for _ in 0..<12 where !earlier.exists {
            app.swipeDown()
        }
        XCTAssertTrue(earlier.waitForExistence(timeout: 3))
    }

    @MainActor
    func testTranscriptWindowDemoReturnsToLatestAfterScrollingAway() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launch()

        let latest = app.staticTexts["Long-thread message 120"]
        XCTAssertTrue(
            latest.waitForExistence(timeout: 5),
            "Scroll diagnostics: \(app.descendants(matching: .any)["chat.transcript"].value)"
        )
        app.swipeDown()

        let scrollToBottom = app.buttons["chat.scroll-to-bottom"]
        XCTAssertTrue(scrollToBottom.waitForExistence(timeout: 3))
        scrollToBottom.tap()

        let latestVisible = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: latest
        )
        wait(for: [latestVisible], timeout: 3)
        XCTAssertTrue(latest.isHittable)
    }

    @MainActor
    func testTranscriptWindowDemoStaysAtLatestAcrossPollInterval() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launch()

        let latest = app.staticTexts["Long-thread message 120"]
        XCTAssertTrue(latest.waitForExistence(timeout: 5))
        XCTAssertTrue(latest.isHittable)

        // The fixture's four-second poll is real, but returns the same visible tail. Waiting past
        // it catches the old layout/poll feedback loop without exposing diagnostics in the app.
        // Sampling the whole interval also catches a down/up oscillation that happens to end at
        // the same coordinate where it began.
        var sampledBottoms = [latest.frame.maxY]
        for sample in 1...9 {
            let sampleInterval = expectation(description: "poll stability sample \(sample)")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                sampleInterval.fulfill()
            }
            wait(for: [sampleInterval], timeout: 1)
            sampledBottoms.append(latest.frame.maxY)
        }

        XCTAssertTrue(latest.isHittable)
        XCTAssertFalse(app.buttons["chat.scroll-to-bottom"].exists)
        let movement = (sampledBottoms.max() ?? 0) - (sampledBottoms.min() ?? 0)
        XCTAssertLessThan(movement, 12)
    }

    @MainActor
    func testTranscriptWindowDemoRestoresReadingPositionAfterCompanionSwitch() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launch()

        let savedAnchor = app.descendants(matching: .any)["chat.entry.long-101"]
        for _ in 0..<12 where !savedAnchor.isHittable {
            app.swipeDown()
        }
        XCTAssertTrue(
            savedAnchor.waitForExistence(timeout: 3),
            "Scroll diagnostics: \(app.descendants(matching: .any)["chat.transcript"].value)"
        )
        XCTAssertTrue(savedAnchor.isHittable)
        XCTAssertTrue(app.buttons["chat.scroll-to-bottom"].exists)

        let switchCompanion = app.buttons["chat.demo.switch-companion"]
        XCTAssertTrue(switchCompanion.waitForExistence(timeout: 2))
        switchCompanion.tap()
        XCTAssertTrue(app.buttons["Switch to Luna"].waitForExistence(timeout: 3))
        switchCompanion.tap()
        XCTAssertTrue(app.buttons["Switch to Orbit"].waitForExistence(timeout: 3))

        let restoredAnchor = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: savedAnchor
        )
        wait(for: [restoredAnchor], timeout: 3)
        XCTAssertTrue(savedAnchor.isHittable)
        XCTAssertFalse(app.descendants(matching: .any)["chat.entry.long-120"].isHittable)
    }

    @MainActor
    func testTranscriptWindowDemoShowsStagedUnseenReplyAndScrollsToIt() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launchEnvironment["COMPANION_TRANSCRIPT_DEMO_SHORT"] = "1"
        app.launchEnvironment["COMPANION_TRANSCRIPT_DEMO_STAGED_POLL"] = "1"
        app.launch()

        let latest = app.staticTexts.matching(
            NSPredicate(format: "label BEGINSWITH %@", "Long-thread message 10")
        ).firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 12))
        app.swipeDown()

        let unseen = app.buttons["chat.scroll-to-bottom"]
        XCTAssertTrue(unseen.waitForExistence(timeout: 4))
        let plainButtonWidth = unseen.frame.width
        let stageReply = app.buttons["demo.stage-reply"]
        XCTAssertTrue(stageReply.waitForExistence(timeout: 3))
        stageReply.tap()
        let stagedPollDelivered = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label == %@", "Reply delivered"),
            object: stageReply
        )
        wait(for: [stagedPollDelivered], timeout: 15)
        let unseenPill = XCTNSPredicateExpectation(
            predicate: NSPredicate { object, _ in
                guard let element = object as? XCUIElement, element.exists else { return false }
                return element.frame.width > plainButtonWidth + 40
            },
            object: unseen
        )
        wait(for: [unseenPill], timeout: 3)
        XCTAssertGreaterThan(unseen.frame.width, plainButtonWidth + 40)
        unseen.tap()

        let stagedReply = app.staticTexts["Staged poll content has arrived."]
        XCTAssertTrue(stagedReply.waitForExistence(timeout: 3))
        let stagedReplyVisible = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: stagedReply
        )
        wait(for: [stagedReplyVisible], timeout: 3)
        XCTAssertTrue(stagedReply.isHittable)
    }

    @MainActor
    func testTranscriptWindowDemoKeepsLatestEntriesOrderedAndSeparated() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-transcript-window-demo"]
        app.launch()

        let latest = app.descendants(matching: .any)["chat.entry.long-120"]
        if !latest.waitForExistence(timeout: 3) {
            let scrollToBottom = app.buttons["chat.scroll-to-bottom"]
            XCTAssertTrue(
                scrollToBottom.waitForExistence(timeout: 3),
                "Scroll diagnostics: \(app.descendants(matching: .any)["chat.transcript"].value)"
            )
            scrollToBottom.tap()
        }

        let entries = [
            app.buttons.matching(
                NSPredicate(format: "label CONTAINS %@", "run_layout_checks")
            ).firstMatch,
            app.descendants(matching: .any)["chat.entry.long-119"],
            latest,
        ]
        XCTAssertTrue(entries.last?.waitForExistence(timeout: 5) == true)

        for (earlier, later) in zip(entries, entries.dropFirst()) {
            XCTAssertTrue(earlier.exists, "Missing \(earlier.identifier)")
            XCTAssertTrue(later.exists, "Missing \(later.identifier)")
            XCTAssertTrue(earlier.isHittable, "\(earlier.identifier) must share the latest viewport")
            XCTAssertTrue(later.isHittable, "\(later.identifier) must share the latest viewport")
            XCTAssertLessThanOrEqual(
                earlier.frame.maxY,
                later.frame.minY,
                "Transcript entries overlap or render out of ordinal order"
            )
        }

        let table = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.table.")
        ).firstMatch
        XCTAssertTrue(table.exists)
    }

    @MainActor
    func testTranscriptWindowDemoBottomControlsNeverCoverChatContent() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-companion-transcript-window-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launchEnvironment["COMPANION_TRANSCRIPT_DEMO_SHORT"] = "1"
        app.launch()

        let queue = app.buttons.matching(
            NSPredicate(format: "label BEGINSWITH %@", "2 queued")
        ).firstMatch
        let composer = app.buttons.matching(
            NSPredicate(format: "identifier == %@", "chat.composer-controls")
        ).firstMatch
        let thinking = app.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Luna thinking")
        ).firstMatch
        XCTAssertTrue(queue.waitForExistence(timeout: 5))
        XCTAssertTrue(composer.exists)
        XCTAssertLessThanOrEqual(queue.frame.maxY, composer.frame.minY)

        app.swipeDown()
        let transcript = app.scrollViews.matching(
            NSPredicate(format: "identifier == %@", "chat.transcript")
        ).firstMatch
        let scrollToBottom = app.buttons["chat.scroll-to-bottom"]
        XCTAssertTrue(
            scrollToBottom.waitForExistence(timeout: 3),
            "Scroll diagnostics: \(transcript.value)"
        )
        XCTAssertTrue(transcript.exists)
        XCTAssertTrue(
            transcript.frame.intersects(scrollToBottom.frame),
            "Scroll-to-bottom must float inside the transcript instead of reserving a layout row"
        )
        XCTAssertLessThanOrEqual(scrollToBottom.frame.maxY, transcript.frame.maxY)
        XCTAssertLessThanOrEqual(scrollToBottom.frame.maxY, queue.frame.minY)

        XCTAssertTrue(thinking.waitForExistence(timeout: 3))
        XCTAssertFalse(thinking.frame.intersects(queue.frame))
        XCTAssertFalse(thinking.frame.intersects(composer.frame))

        queue.tap()
        let queueList = app.descendants(matching: .any)["chat.queue.list"]
        XCTAssertTrue(queueList.waitForExistence(timeout: 2))
        XCTAssertLessThanOrEqual(queueList.frame.maxY, composer.frame.minY)
        XCTAssertFalse(scrollToBottom.frame.intersects(queueList.frame))
        try captureScreenshot(named: "chat-layout-regression-short.png")
    }

    @MainActor
    func testCompanionMarkdownSupportsAccessibilityTextInLandscape() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-glass-chat-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launch()
        defer {
            XCUIDevice.shared.orientation = .portrait
            app.terminate()
        }

        XCUIDevice.shared.orientation = .landscapeLeft

        let reply = app.descendants(matching: .any)["demo.markdown.reply"]
        let code = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.code-block.")
        ).firstMatch
        let table = app.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.table.")
        ).firstMatch

        XCTAssertTrue(reply.waitForExistence(timeout: 5))
        XCTAssertTrue(code.exists)
        XCTAssertTrue(table.exists)
        try captureScreenshot(named: "chat-markdown-accessibility-landscape.png")
    }

    @MainActor
    func testMarkdownTableDemoCoversNativeTableLayouts() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-markdown-table-demo"]
        app.launch()

        XCTAssertTrue(app.navigationBars["Markdown tables"].waitForExistence(timeout: 5))

        for fixture in ["simple", "wide", "long-content", "alignment", "single-row"] {
            let table = app.descendants(matching: .any)["markdown-table-demo.\(fixture)"]
            XCTAssertTrue(table.exists, "Missing deterministic \(fixture) table fixture")
        }

        let simpleTable = app.descendants(matching: .any)["markdown-table-demo.simple"]
        XCTAssertTrue(simpleTable.staticTexts["Simple two-column table"].exists)
        let healthyCell = simpleTable.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Status, Healthy")
        ).firstMatch
        XCTAssertTrue(healthyCell.exists)
        let simpleValueCell = simpleTable.descendants(matching: .any)[
            "markdown.table.cell.1.1"
        ]
        XCTAssertTrue(simpleValueCell.exists)
        let simpleCellHeight = simpleValueCell.frame.height

        let wideTable = app.descendants(matching: .any)["markdown-table-demo.wide"]
        let nativeWideTable = wideTable.descendants(matching: .any).matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "markdown.table.")
        ).firstMatch
        XCTAssertTrue(nativeWideTable.exists)
        XCTAssertLessThanOrEqual(nativeWideTable.frame.maxX, app.frame.maxX + 1)
        XCTAssertGreaterThanOrEqual(nativeWideTable.frame.minX, app.frame.minX - 1)
        let trailingCell = wideTable.descendants(matching: .any)["markdown.table.cell.1.5"]
        XCTAssertTrue(trailingCell.exists)
        let trailingCellInitialX = trailingCell.frame.minX
        nativeWideTable.swipeLeft()
        XCTAssertLessThan(trailingCell.frame.minX, trailingCellInitialX)

        let longTable = app.otherElements.matching(
            NSPredicate(format: "identifier == %@", "markdown-table-demo.long-content")
        ).firstMatch
        for _ in 0..<4 where !longTable.isHittable { app.swipeUp() }
        let longDetailCell = longTable.descendants(matching: .any)["markdown.table.cell.1.1"]
        XCTAssertTrue(longDetailCell.exists)
        XCTAssertGreaterThan(longDetailCell.frame.height, simpleCellHeight)

        let alignmentTable = app.descendants(matching: .any)["markdown-table-demo.alignment"]
        for _ in 0..<4 where !alignmentTable.isHittable { app.swipeUp() }
        let centerCell = alignmentTable.descendants(matching: .any)[
            "markdown.table.cell.1.1"
        ]
        let rightCell = alignmentTable.descendants(matching: .any)[
            "markdown.table.cell.1.2"
        ]
        XCTAssertEqual(centerCell.value as? String, "Center aligned")
        XCTAssertEqual(rightCell.value as? String, "Right aligned")
        XCTAssertTrue(alignmentTable.links["Beta"].exists)
        try captureScreenshot(named: "markdown-tables.png")
    }

    @MainActor
    func testMarkdownTableDemoSupportsAccessibilityTextInLandscape() throws {
        let app = XCUIApplication()
        app.launchArguments = [
            "-markdown-table-demo",
            "-UIPreferredContentSizeCategoryName",
            "UICTContentSizeCategoryAccessibilityExtraExtraExtraLarge",
        ]
        app.launch()
        defer {
            XCUIDevice.shared.orientation = .portrait
            app.terminate()
        }

        XCUIDevice.shared.orientation = .landscapeLeft

        let wideTable = app.descendants(matching: .any)["markdown-table-demo.wide"]
        XCTAssertTrue(wideTable.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(wideTable.frame.maxX, app.frame.maxX + 1)
        XCTAssertGreaterThanOrEqual(wideTable.frame.minX, app.frame.minX - 1)
        try captureScreenshot(named: "markdown-tables-accessibility-landscape.png")
    }

    @MainActor
    func testMarkdownTableDemoKeepsRowsAndColumnsSeparated() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-markdown-table-demo"]
        app.launch()

        let simpleTable = app.descendants(matching: .any)["markdown-table-demo.simple"]
        XCTAssertTrue(simpleTable.waitForExistence(timeout: 5))
        let headerLeft = simpleTable.descendants(matching: .any)["markdown.table.cell.0.0"]
        let headerRight = simpleTable.descendants(matching: .any)["markdown.table.cell.0.1"]
        let firstLeft = simpleTable.descendants(matching: .any)["markdown.table.cell.1.0"]
        let firstRight = simpleTable.descendants(matching: .any)["markdown.table.cell.1.1"]
        XCTAssertFalse(headerLeft.frame.intersects(headerRight.frame))
        XCTAssertFalse(firstLeft.frame.intersects(firstRight.frame))
        XCTAssertLessThanOrEqual(headerLeft.frame.maxY, firstLeft.frame.minY)
        XCTAssertEqual(headerLeft.frame.minX, firstLeft.frame.minX, accuracy: 1)
        XCTAssertEqual(headerRight.frame.maxX, firstRight.frame.maxX, accuracy: 1)

        let longTable = app.otherElements.matching(
            NSPredicate(format: "identifier == %@", "markdown-table-demo.long-content")
        ).firstMatch
        for _ in 0..<5 where !app.frame.intersects(longTable.frame) { app.swipeUp() }
        XCTAssertTrue(app.frame.intersects(longTable.frame))
        XCTAssertGreaterThanOrEqual(longTable.frame.minX, app.frame.minX - 1)
        XCTAssertLessThanOrEqual(longTable.frame.maxX, app.frame.maxX + 1)
        let longRows = (0...3).map {
            longTable.descendants(matching: .any)["markdown.table.cell.\($0).0"]
        }
        for (earlier, later) in zip(longRows, longRows.dropFirst()) {
            XCTAssertTrue(earlier.exists)
            XCTAssertTrue(later.exists)
            XCTAssertLessThanOrEqual(earlier.frame.maxY, later.frame.minY)
            XCTAssertEqual(earlier.frame.minX, later.frame.minX, accuracy: 1)
        }
        try captureScreenshot(named: "markdown-tables-aligned.png")
    }

    @MainActor
    func testMarkdownTableDemoSupportsDarkAppearance() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-markdown-table-demo", "-markdown-table-dark-demo"]
        app.launch()

        let simpleTable = app.descendants(matching: .any)["markdown-table-demo.simple"]
        XCTAssertTrue(simpleTable.waitForExistence(timeout: 5))
        let healthyCell = simpleTable.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Status, Healthy")
        ).firstMatch
        XCTAssertTrue(healthyCell.exists)
        let gallery = app.descendants(matching: .any)["markdown-table-demo.gallery"]
        XCTAssertEqual(gallery.value as? String, "Dark appearance")
        try captureScreenshot(named: "markdown-tables-dark.png")
    }

    @MainActor
    func testCompanionMarkdownCacheInvalidatesChangedEventContent() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-chat-demo", "-markdown-cache-ui-test"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Rapport d’incident"].waitForExistence(timeout: 5))

        app.buttons["Options de la conversation"].tap()
        let refresh = app.buttons["demo.markdown.refresh-cache"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 2))
        refresh.tap()

        XCTAssertTrue(app.staticTexts["Rapport actualisé"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Rapport d’incident"].exists)
        XCTAssertTrue(app.staticTexts["Le même événement affiche maintenant un contenu renouvelé."].exists)
    }

    @MainActor
    func testManagementDemoCoversCreationProvidersAndPlugins() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-glass-management-demo"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Create a Companion"].waitForExistence(timeout: 5))
        let create = app.buttons["demo.management.create"]
        XCTAssertTrue(create.exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin-account.linear"].exists)
        create.tap()
        XCTAssertTrue(app.staticTexts["Nova is ready for her first message."].waitForExistence(timeout: 2))

        app.swipeDown()
        app.swipeDown()
        app.buttons["Providers"].tap()
        XCTAssertTrue(app.staticTexts["Model providers"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.kimi-coding"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.moonshotai"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.zai"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.openai"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.provider.google"].exists)
        let connectProvider = app.buttons["demo.management.connect-provider"]
        XCTAssertTrue(connectProvider.exists)
        if !connectProvider.isHittable {
            app.swipeUp()
            app.swipeUp()
        }
        connectProvider.tap()
        XCTAssertTrue(app.staticTexts["Codex"].waitForExistence(timeout: 2))

        app.swipeDown()
        app.swipeDown()
        app.buttons["Plugins"].tap()
        XCTAssertTrue(app.staticTexts["Plugins"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin.linear"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin.github"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin.notion"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["demo.management.plugin.conductor"].exists)
        let gmail = app.descendants(matching: .any)["demo.management.plugin.gmail"]
        XCTAssertTrue(gmail.waitForExistence(timeout: 2))
        XCTAssertTrue(gmail.label.contains("Search and read email"))
        XCTAssertTrue(gmail.label.contains("never sends mail"))
        let addLinearAccount = app.buttons["demo.management.add-linear-account"]
        XCTAssertTrue(addLinearAccount.exists)
        if !addLinearAccount.isHittable {
            app.swipeUp()
            app.swipeUp()
        }
        addLinearAccount.tap()
        XCTAssertTrue(app.staticTexts["Linear · client"].waitForExistence(timeout: 2))
        let addPlugin = app.buttons["demo.management.add-plugin"]
        XCTAssertTrue(addPlugin.exists)
        if !addPlugin.isHittable { app.swipeUp() }
        addPlugin.tap()
        XCTAssertTrue(app.staticTexts["Knowledge MCP"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testOwnerCanOpenDetailsAndConfirmDurableDeletion() throws {
        let app = launchCompanionDetails(access: "owner")

        let delete = app.buttons["companion.details.delete"]
        for _ in 0..<4 where !delete.isHittable { app.swipeUp() }
        XCTAssertTrue(delete.waitForExistence(timeout: 5))
        delete.tap()
        let confirmation = app.sheets.buttons["Delete Companion"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 2))
        confirmation.tap()

        XCTAssertTrue(app.staticTexts["Deletion requested"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts[
            "The Companion will remain visible until its Box is permanently deleted."
        ].exists)
    }

    @MainActor
    func testEditorDetailsKeepOwnerOnlyMCPAndRuntimeRules() throws {
        let app = launchCompanionDetails(access: "editor")

        let provider = app.buttons["companion.details.provider"]
        XCTAssertTrue(provider.waitForExistence(timeout: 5))
        XCTAssertTrue(provider.isEnabled)
        XCTAssertEqual(provider.label, "Provider, Claude")
        let model = app.buttons["companion.details.model"]
        XCTAssertTrue(model.exists)
        XCTAssertTrue(model.isEnabled)
        XCTAssertEqual(model.label, "Model, Sonnet")
        XCTAssertFalse(app.buttons["companion.details.provider.save"].exists)
        XCTAssertTrue(app.buttons["companion.details.providers.manage"].exists)
        XCTAssertFalse(app.buttons["companion.details.delete"].exists)

        let ownerOnly = app.descendants(matching: .any)["companion.details.plugins.owner-only"]
        XCTAssertTrue(ownerOnly.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["companion.details.plugins.add"].exists)
        XCTAssertTrue(app.buttons["companion.details.restart.companion"].waitForExistence(timeout: 2))
    }

    @MainActor
    func testViewerDetailsAreReadOnly() throws {
        let app = launchCompanionDetails(access: "viewer")

        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["companion.details.character"].exists)
        let provider = app.buttons["companion.details.provider"]
        XCTAssertTrue(provider.exists)
        XCTAssertFalse(provider.isEnabled)
        let model = app.buttons["companion.details.model"]
        XCTAssertTrue(model.exists)
        XCTAssertFalse(model.isEnabled)
        XCTAssertFalse(app.buttons["companion.details.providers.manage"].exists)
        XCTAssertFalse(app.buttons["companion.details.delete"].exists)
        XCTAssertFalse(app.buttons["companion.details.plugins.add"].exists)
        XCTAssertFalse(app.buttons["companion.details.restart.companion"].exists)
        let readOnly = app.descendants(matching: .any)["companion.details.runtime.read-only"]
        for _ in 0..<4 where !readOnly.exists { app.swipeUp() }
        XCTAssertTrue(readOnly.waitForExistence(timeout: 2))
    }

    @MainActor
    func testRosterTapOpensChatAndHeaderPillOpensDetails() throws {
        let app = launchCompanionRoster(access: "owner")
        let row = app.descendants(matching: .any)[
            "companion.row.c96ab360-00f3-4497-a51a-51442db8add1"
        ]

        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.transcript"].waitForExistence(timeout: 5))
        let details = app.buttons["chat.details"]
        XCTAssertTrue(details.exists)
        XCTAssertTrue(details.label.contains("Replying"))

        details.tap()
        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["companion.details.open-chat"].exists)
    }

    @MainActor
    func testDetailsShowsNativeResourceCardsAndOneRoutineSection() throws {
        let app = launchCompanionDetails(access: "viewer")

        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 5))
        let skill = app.descendants(matching: .any)[
            "companion.details.skill.11111111-1111-4111-8111-111111111111"
        ]
        XCTAssertTrue(skill.waitForExistence(timeout: 5))
        XCTAssertTrue(skill.label.contains("Incident Summary"))
        XCTAssertTrue(skill.label.contains("Enabled"))
        XCTAssertTrue(app.descendants(matching: .any)["companion.details.skills.hidden"].exists)

        let routine = app.descendants(matching: .any)[
            "companion.details.routine.33333333-3333-4333-8333-333333333333"
        ]
        XCTAssertTrue(routine.waitForExistence(timeout: 2))
        XCTAssertTrue(routine.label.contains("Weekday brief"))
        XCTAssertTrue(routine.label.contains("Summarize the weekday release status."))
        XCTAssertEqual(routine.count, 1)

        let trigger = app.descendants(matching: .any)[
            "companion.details.trigger.44444444-4444-4444-8444-444444444444"
        ]
        if !trigger.exists { app.swipeUp() }
        XCTAssertTrue(trigger.waitForExistence(timeout: 2))
        XCTAssertTrue(trigger.label.contains("GitHub"))
        XCTAssertTrue(trigger.label.contains("Webhook registered"))
        XCTAssertTrue(trigger.label.contains("Ask the Companion"))
        XCTAssertTrue(trigger.label.contains("Active"))
        XCTAssertTrue(app.buttons[
            "companion.details.trigger-history.44444444-4444-4444-8444-444444444444"
        ].exists)
        XCTAssertFalse(app.navigationBars["Connected resources"].exists)
    }

    @MainActor
    func testTriggerCreationReusesProviderAccountAndNeverAsksForWebhookSetup() throws {
        let app = launchCompanionDetails(access: "owner")
        let addTrigger = scrollToButton("companion.details.triggers.add", in: app)
        addTrigger.tap()

        XCTAssertTrue(app.navigationBars["New trigger"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.descendants(matching: .any)["companion.trigger-editor.mode"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["companion.trigger-editor.account-reused"].exists)
        XCTAssertFalse(app.textFields.matching(NSPredicate(format: "placeholderValue CONTAINS[c] 'url'")).firstMatch.exists)
        XCTAssertFalse(app.secureTextFields.firstMatch.exists)
    }

    @MainActor
    func testOwnerCreatesResourcesInTheDeviceTimezoneByDefault() throws {
        let app = launchCompanionDetails(access: "owner")

        let addRoutine = scrollToButton("companion.details.add-routine", in: app)
        XCTAssertTrue(app.buttons["companion.details.triggers.add"].exists)
        addRoutine.tap()

        XCTAssertTrue(app.navigationBars["New routine"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts[expectedDeviceTimezone].exists)
        XCTAssertTrue(app.staticTexts[
            "Cron is evaluated as local wall-clock time in this timezone. Change your member timezone from Account › Member settings."
        ].exists)
    }

    @MainActor
    func testDetailsEmptyStatesUseTheSamePage() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-detail-demo"]
        app.launchEnvironment["COMPANION_DETAIL_DEMO_EMPTY"] = "triggers"
        app.launchEnvironment["COMPANION_DETAIL_DEMO_ACCESS"] = "viewer"
        app.launch()

        let settings = app.buttons["chat.details"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 2))
        let empty = app.descendants(matching: .any)["companion.details.triggers.empty"]
        for _ in 0..<5 where !empty.exists { app.swipeUp() }
        XCTAssertTrue(empty.waitForExistence(timeout: 2))
        XCTAssertTrue(empty.label.contains("No triggers connected"))
        XCTAssertTrue(empty.label.contains("Webhook prompts will appear here"))
    }

    @MainActor
    func testRosterContextMenuOpensSettings() throws {
        let app = launchCompanionRoster(access: "editor")
        let row = app.descendants(matching: .any)[
            "companion.row.c96ab360-00f3-4497-a51a-51442db8add1"
        ]
        openRosterContextMenu(for: row, in: app)

        let settings = app.buttons["Settings"]
        XCTAssertTrue(settings.exists)
        settings.tap()
        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 5))
    }

    @MainActor
    func testOwnerCanAttachDetachPluginsAndConfirmCompanionRestart() throws {
        let app = launchCompanionDetails(access: "owner")

        let linear = app.descendants(matching: .any)[
            "companion.details.plugin.55555555-5555-4555-8555-555555555555"
        ]
        XCTAssertTrue(linear.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["work"].exists)
        XCTAssertTrue(app.staticTexts["Linear"].exists)
        XCTAssertTrue(app.descendants(matching: .any)[
            "companion.details.plugin-account.55555555-5555-4555-8555-555555555555"
        ].exists)

        let detach = app.buttons[
            "companion.details.plugin.detach.55555555-5555-4555-8555-555555555555"
        ]
        XCTAssertTrue(detach.exists)
        detach.tap()
        XCTAssertTrue(app.staticTexts["Linear · work detached."].waitForExistence(timeout: 2))

        let add = app.buttons["companion.details.plugins.add"]
        XCTAssertTrue(add.exists)
        add.tap()
        let github = app.sheets.buttons["GitHub · personal"]
        XCTAssertTrue(github.waitForExistence(timeout: 2))
        github.tap()
        XCTAssertTrue(app.staticTexts["GitHub · personal attached."].waitForExistence(timeout: 2))

        let restart = scrollToButton("companion.details.restart.companion", in: app)
        restart.tap()
        let confirm = app.sheets.buttons["Restart Companion"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 2))
        confirm.tap()
        XCTAssertTrue(app.staticTexts[
            "Companion restart accepted. It will run after earlier runtime work."
        ].waitForExistence(timeout: 2))
    }

    @MainActor
    func testOwnerConfirmsFullServerRestartWithInterruptionCopy() throws {
        let app = launchCompanionDetails(access: "owner")

        let restart = scrollToButton("companion.details.restart.server", in: app)
        restart.tap()
        XCTAssertTrue(app.staticTexts[
            "This queues a full server restart. Active work is interrupted, but the Companion and its saved files remain."
        ].waitForExistence(timeout: 2))
        let confirm = app.sheets.buttons["Restart server"]
        XCTAssertTrue(confirm.exists)
    }

    @MainActor
    func testViewerDetailsAreReadOnlyInDarkMode() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-detail-demo", "-AppleInterfaceStyle", "Dark"]
        app.launchEnvironment["COMPANION_DETAIL_DEMO_ACCESS"] = "viewer"
        app.launchEnvironment["COMPANION_API_URL"] = "http://127.0.0.1:9"
        app.launch()

        let settings = app.buttons["chat.details"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 2))

        XCTAssertFalse(app.buttons["companion.details.plugins.add"].exists)
        XCTAssertFalse(app.buttons["companion.details.restart.companion"].exists)
        XCTAssertFalse(app.buttons["companion.details.restart.server"].exists)
        XCTAssertTrue(app.descendants(matching: .any)[
            "companion.details.runtime.read-only"
        ].waitForExistence(timeout: 5))
    }

    @MainActor
    func testMemberSettingsUsesADeviceDefaultAndSearchableTimezonePicker() throws {
        let app = launchCompanionRoster(access: "owner")
        app.buttons["account.menu"].tap()
        let settings = app.buttons["Member settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 2))
        settings.tap()

        XCTAssertTrue(app.navigationBars["Member settings"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts[expectedDeviceTimezone].exists)
        app.buttons["member-settings.timezone"].tap()
        XCTAssertTrue(app.navigationBars["Choose timezone"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.searchFields["Search timezones"].exists)
    }

    @MainActor
    func testNotificationDemoOpensTheTargetConversationAfterRosterRestore() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-roster-demo", "-companion-notification-demo"]
        app.launchEnvironment["COMPANION_API_URL"] = "http://127.0.0.1:9"
        app.launch()

        XCTAssertTrue(app.staticTexts["Conversation unavailable"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Companions"].exists)
    }

    @MainActor
    func testRosterRendersThreeCompanionsAsListRowsWithPreviews() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-roster-demo"]
        app.launchEnvironment["COMPANION_ROSTER_DEMO_THREE"] = "1"
        app.launchEnvironment["COMPANION_API_URL"] = "http://127.0.0.1:9"
        app.launch()

        for (id, name, status) in [
            ("c96ab360-00f3-4497-a51a-51442db8add1", "Luna", "Live"),
            ("d96ab360-00f3-4497-a51a-51442db8add2", "Nova", "Replying"),
            ("e96ab360-00f3-4497-a51a-51442db8add3", "Orbit", "Error"),
        ] {
            let row = app.descendants(matching: .any)["companion.row.\(id)"]
            XCTAssertTrue(row.waitForExistence(timeout: 5), "Missing list row for \(name)")
            XCTAssertTrue(row.label.contains(name))
            XCTAssertTrue(row.label.contains(status))
            XCTAssertTrue(row.label.contains("Release notes are ready."))
        }
    }

    @MainActor
    func testChatSupportsCustomBackAndLeadingEdgeSwipeWithKeyboardOpen() throws {
        let app = launchCompanionRoster(access: "owner")
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]

        openChatFromRoster(row, in: app)
        XCTAssertTrue(app.descendants(matching: .any)["chat.transcript"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Luna thinking"].waitForExistence(timeout: 2))
        let customBack = app.buttons["chat.back"]
        XCTAssertTrue(customBack.exists)
        XCTAssertEqual(customBack.label, "Back")
        swipeFromNativeLeadingEdge(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 3))

        openChatFromRoster(row, in: app)
        let composer = app.descendants(matching: .any)["chat.composer"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        composer.tap()
        composer.typeText("Preserve this draft")
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 2))

        swipeFromLeadingEdge(in: app)

        XCTAssertTrue(customBack.waitForNonExistence(timeout: 3))
        let rosterTransitionSettled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: row
        )
        wait(for: [rosterTransitionSettled], timeout: 3)
        XCTAssertTrue(row.isHittable)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
    }

    @MainActor
    func testChatLeadingEdgeSwipeWorksAfterMidScrollAcrossRepeatedPops() throws {
        let app = launchCompanionRoster(access: "owner", longThread: true)
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]

        for _ in 0..<2 {
            openChatFromRoster(row, in: app)

            let transcript = app.scrollViews.matching(
                NSPredicate(format: "identifier == %@", "chat.transcript")
            ).firstMatch
            XCTAssertTrue(transcript.waitForExistence(timeout: 5))

            // Begin from the middle of the conversation before exercising the leading edge.
            transcript.swipeUp()
            transcript.swipeUp()
            XCTAssertTrue(app.buttons["chat.scroll-to-bottom"].waitForExistence(timeout: 2))

            let chatBack = app.buttons["chat.back"]
            XCTAssertTrue(chatBack.waitForExistence(timeout: 2))
            swipeFromLeadingEdge(in: app)

            XCTAssertTrue(chatBack.waitForNonExistence(timeout: 3))
            let rosterTransitionSettled = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "isHittable == true"),
                object: row
            )
            wait(for: [rosterTransitionSettled], timeout: 3)
            XCTAssertTrue(row.isHittable)
        }
    }

    @MainActor
    func testComputerSupportsLeadingEdgeSwipeAcrossConsecutivePops() throws {
        let app = launchCompanionRoster(access: "owner")
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]
        openChatFromRoster(row, in: app)

        let computer = app.buttons["Open Luna's computer"]
        XCTAssertTrue(computer.waitForExistence(timeout: 5))
        computer.tap()
        XCTAssertTrue(app.descendants(matching: .any)["computer.view"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Preparing computer…"].waitForExistence(timeout: 2))
        let computerBack = app.buttons["computer.back"]
        XCTAssertEqual(computerBack.label, "Back")

        swipeFromLeadingEdge(in: app)
        XCTAssertTrue(app.descendants(matching: .any)["chat.transcript"].waitForExistence(timeout: 3))
        XCTAssertTrue(computerBack.waitForNonExistence(timeout: 3))
        let chatBack = app.buttons["chat.back"]
        let chatTransitionSettled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: chatBack
        )
        wait(for: [chatTransitionSettled], timeout: 3)
        XCTAssertTrue(chatBack.isHittable)
        swipeFromLeadingEdge(in: app)

        let rosterTransitionSettled = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "isHittable == true"),
            object: row
        )
        wait(for: [rosterTransitionSettled], timeout: 3)
        XCTAssertTrue(row.isHittable)
    }

    @MainActor
    func testMemberSettingsCustomHeadersSupportButtonAndLeadingEdgeBack() throws {
        let app = launchCompanionRoster(access: "owner")

        app.buttons["account.menu"].tap()
        let memberSettings = app.buttons["Member settings"]
        XCTAssertTrue(memberSettings.waitForExistence(timeout: 2))
        memberSettings.tap()

        let profile = app.descendants(matching: .any)["settings.profile"]
        XCTAssertTrue(profile.waitForExistence(timeout: 2))
        profile.tap()

        let customBack = app.buttons["navigation.custom-back"]
        XCTAssertTrue(customBack.waitForExistence(timeout: 2))
        XCTAssertEqual(customBack.label, "Back")
        customBack.tap()
        XCTAssertTrue(profile.waitForExistence(timeout: 2))

        let plugins = app.descendants(matching: .any)["settings.plugins"]
        plugins.tap()
        XCTAssertTrue(app.staticTexts["Plugins"].waitForExistence(timeout: 2))
        swipeFromLeadingEdge(in: app)
        XCTAssertTrue(profile.waitForExistence(timeout: 3))
    }

    @MainActor
    func testBotDetailRoutineAndRunCustomHeadersSupportConsecutiveEdgePops() throws {
        let app = launchCompanionDetails(access: "owner")
        let routineID = "33333333-3333-4333-8333-333333333333"
        let runID = "88888888-8888-4888-8888-888888888888"
        let routine = scrollToButton("companion.details.routine.\(routineID)", in: app)

        routine.tap()
        XCTAssertTrue(app.staticTexts["Weekday brief"].waitForExistence(timeout: 2))
        let customBack = app.buttons["navigation.custom-back"]
        XCTAssertTrue(customBack.waitForExistence(timeout: 2))
        customBack.tap()
        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 3))

        scrollToButton("companion.details.routine.\(routineID)", in: app).tap()
        let run = scrollToButton("companion.details.routine-run.\(runID)", in: app)
        run.tap()
        XCTAssertTrue(app.staticTexts["Routine run"].waitForExistence(timeout: 2))

        swipeFromLeadingEdge(in: app)
        XCTAssertTrue(run.waitForExistence(timeout: 3))
        swipeFromLeadingEdge(in: app)
        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 3))
    }

    @MainActor
    func testWideBackZoneDoesNotStealAHorizontalCharacterDrag() throws {
        let app = launchCompanionDetails(access: "owner")
        let colors = app.scrollViews["companion.details.character.colors"]
        XCTAssertTrue(colors.waitForExistence(timeout: 5))

        colors.swipeLeft()
        let start = colors.coordinate(withNormalizedOffset: CGVector(dx: 0.08, dy: 0.5))
        let end = colors.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)

        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.buttons["companion.details.open-chat"].exists)
    }

    @MainActor
    func testOwnerRosterRetriesAnAmbiguousDeleteWithTheRetainedRequest() throws {
        let app = launchCompanionRoster(access: "owner")
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]

        openRosterContextMenu(for: row, in: app)
        let delete = app.buttons["Delete Companion"]
        XCTAssertTrue(delete.exists)
        delete.tap()
        confirmRosterDeletion(in: app)

        let ambiguousMessage = "Deletion could not be confirmed. Luna was restored. Retrying reuses the same request."
        let ambiguousNotice = app.descendants(matching: .any)["Error. \(ambiguousMessage)"]
        XCTAssertTrue(ambiguousNotice.waitForExistence(timeout: 5))

        openRosterContextMenu(for: row, in: app)
        let retry = app.buttons["Retry Delete"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        retry.tap()
        confirmRosterDeletion(in: app)

        XCTAssertTrue(row.waitForNonExistence(timeout: 5))
    }

    @MainActor
    func testEditorRosterOffersSettingsWithoutDelete() throws {
        assertRosterContextMenu(access: "editor", canDelete: false)
    }

    @MainActor
    func testViewerRosterOffersSettingsWithoutDelete() throws {
        assertRosterContextMenu(access: "viewer", canDelete: false)
    }

    @MainActor
    private func scrollToButton(_ identifier: String, in app: XCUIApplication) -> XCUIElement {
        let button = app.buttons[identifier]
        for _ in 0..<8 where !button.isHittable { app.swipeUp() }
        XCTAssertTrue(button.waitForExistence(timeout: 2))
        XCTAssertTrue(button.isHittable)
        return button
    }

    @MainActor
    private func launchCompanionDetails(access: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-detail-demo"]
        app.launchEnvironment["COMPANION_DETAIL_DEMO_ACCESS"] = access
        app.launchEnvironment["COMPANION_API_URL"] = "http://127.0.0.1:9"
        app.launch()

        let details = app.buttons["chat.details"]
        XCTAssertTrue(details.waitForExistence(timeout: 5))
        details.tap()
        XCTAssertTrue(app.staticTexts["Bot details"].waitForExistence(timeout: 2))
        return app
    }

    private var expectedDeviceTimezone: String {
        let identifier = TimeZone.current.identifier
        return identifier == "UTC" || TimeZone.knownTimeZoneIdentifiers.contains(identifier)
            ? identifier
            : "UTC"
    }

    @MainActor
    private func launchCompanionRoster(
        access: String,
        longThread: Bool = false
    ) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-roster-demo"]
        app.launchEnvironment["COMPANION_ROSTER_DEMO_ACCESS"] = access
        app.launchEnvironment["COMPANION_API_URL"] = "http://127.0.0.1:9"
        if longThread {
            app.launchEnvironment["COMPANION_ROSTER_DEMO_LONG_THREAD"] = "1"
        }
        app.launch()

        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        return app
    }

    @MainActor
    private func assertRosterContextMenu(access: String, canDelete: Bool) {
        let app = launchCompanionRoster(access: access)
        let row = app.descendants(matching: .any)["companion.row.c96ab360-00f3-4497-a51a-51442db8add1"]
        openRosterContextMenu(for: row, in: app)

        XCTAssertTrue(app.buttons["Settings"].exists)
        XCTAssertEqual(app.buttons["Delete Companion"].exists, canDelete)
    }

    @MainActor
    private func openRosterContextMenu(for row: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        for _ in 0..<3 {
            if row.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(row.isHittable)
        row.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).press(forDuration: 1.5)
        XCTAssertTrue(app.buttons["Move to"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func confirmRosterDeletion(in app: XCUIApplication) {
        let confirmation = app.sheets.buttons["Delete Companion"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.tap()
    }

    @MainActor
    private func openChatFromRoster(_ row: XCUIElement, in app: XCUIApplication) {
        row.tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat.transcript"].waitForExistence(timeout: 5))
    }

    @MainActor
    private func swipeFromLeadingEdge(in app: XCUIApplication) {
        // About 39pt on the standard test phone: outside UIKit's narrow native band but inside
        // Companion's 52pt supplemental capture zone.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.10, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    @MainActor
    private func swipeFromNativeLeadingEdge(in app: XCUIApplication) {
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.82, dy: 0.5))
        start.press(forDuration: 0.05, thenDragTo: end)
    }

    @MainActor
    func testCompanionIconCatalogExposesEveryVariantAndState() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-icon-demo"]
        app.launch()

        XCTAssertTrue(app.navigationBars["Companion icon catalog"].waitForExistence(timeout: 5))
        try captureScreenshot(named: "catalog-top.png")

        assertIconOptions(in: app, prefix: "demo.icon.shape", count: 8)
        assertIconOptions(in: app, prefix: "demo.icon.mouth", count: 5)
        assertIconOptions(in: app, prefix: "demo.icon.accessory", count: 7)
        assertIconOptions(in: app, prefix: "demo.icon.color", count: 11)

        let colorChoice = app.descendants(matching: .any)["demo.icon.color.10"]
        XCTAssertTrue(colorChoice.exists)
        colorChoice.tap()
        XCTAssertEqual(colorChoice.value as? String, "Selected")

        for (identifier, label) in [("idle", "Idle"), ("thinking", "Thinking"), ("still", "Still")] {
            let element = app.descendants(matching: .any)["demo.icon.state.\(identifier)"]
            for _ in 0..<4 where !element.exists { app.swipeUp() }
            XCTAssertTrue(element.exists)
            XCTAssertTrue(element.label.contains(label))
            XCTAssertTrue(element.label.contains("Companion"), "\(label) should have a Companion VoiceOver label")
        }
        for size in [30, 52, 86] {
            let element = app.descendants(matching: .any)["demo.icon.size.\(size)"]
            for _ in 0..<4 where !element.exists { app.swipeUp() }
            XCTAssertTrue(element.exists)
            XCTAssertTrue(element.label.contains("Companion"), "Size \(size) should have a Companion VoiceOver label")
        }

        try captureScreenshot(named: "catalog-bottom.png")

        app.terminate()

        let reducedMotionApp = XCUIApplication()
        reducedMotionApp.launchArguments = ["-companion-icon-demo", "-companion-reduce-motion"]
        reducedMotionApp.launch()

        XCTAssertTrue(reducedMotionApp.navigationBars["Companion icon catalog"].waitForExistence(timeout: 5))
        let reduceMotionIndicator = reducedMotionApp.descendants(matching: .any)["demo.icon.reduce-motion"]
        XCTAssertTrue(reduceMotionIndicator.waitForExistence(timeout: 2))
        XCTAssertEqual(reduceMotionIndicator.label, "Reduce Motion")
        XCTAssertEqual(reduceMotionIndicator.value as? String, "On")
        try captureScreenshot(named: "catalog-reduce-motion.png")
    }

    @MainActor
    func testCreateCompanionUsesTheSharedVisualIconSelector() throws {
        let app = XCUIApplication()
        app.launchArguments = ["-companion-create-demo"]
        app.launch()

        XCTAssertTrue(app.navigationBars["New Companion"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["companion.create.icon.shape.grid"].waitForExistence(timeout: 2))

        let initialShape = app.descendants(matching: .any)["companion.create.icon.shape.6"]
        XCTAssertTrue(initialShape.exists)
        XCTAssertEqual(initialShape.value as? String, "Selected")

        let nextShape = app.descendants(matching: .any)["companion.create.icon.shape.0"]
        nextShape.tap()
        XCTAssertEqual(nextShape.value as? String, "Selected")
        assertIconOptions(in: app, prefix: "companion.create.icon.shape", count: 8)
        assertIconOptions(in: app, prefix: "companion.create.icon.mouth", count: 5)
        assertIconOptions(in: app, prefix: "companion.create.icon.accessory", count: 7)
        assertIconOptions(in: app, prefix: "companion.create.icon.color", count: 11)
    }

    @MainActor
    func testCompanionAvatarScreenshotsAcrossDemos() throws {
        let chat = XCUIApplication()
        chat.launchArguments = ["-glass-chat-demo", "-companion-avatar-ui-evidence"]
        chat.launch()

        let composer = chat.descendants(matching: .any)["demo.composer"]
        let send = chat.buttons["demo.send"]
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertTrue(send.exists)
        composer.tap()
        composer.typeText("Prépare une réponse.")
        send.tap()

        let replying = chat.descendants(matching: .any)["chat.thinking-status"]
        XCTAssertTrue(replying.waitForExistence(timeout: 2))
        XCTAssertTrue(replying.label.contains("Companion"))
        try captureScreenshot(named: "chat-thinking.png")

        let rosterButton = chat.buttons["Ouvrir les conversations"]
        XCTAssertTrue(rosterButton.waitForExistence(timeout: 2))
        rosterButton.tap()
        XCTAssertTrue(chat.navigationBars["Conversations"].waitForExistence(timeout: 2))
        let rosterEntry = chat.buttons["Companion, En ligne, Direction iOS 26 validée"]
        XCTAssertTrue(rosterEntry.waitForExistence(timeout: 2))
        XCTAssertTrue(rosterEntry.label.contains("Companion"))
        try captureScreenshot(named: "roster-idle.png")

        chat.terminate()

        let creation = XCUIApplication()
        creation.launchArguments = ["-glass-management-demo"]
        creation.launch()

        XCTAssertTrue(creation.staticTexts["Create a Companion"].waitForExistence(timeout: 5))
        let creationAvatar = creation.descendants(matching: .any).matching(
            NSPredicate(format: "label == %@", "Nova, Companion")
        ).firstMatch
        XCTAssertTrue(creationAvatar.waitForExistence(timeout: 2))
        XCTAssertTrue(creationAvatar.label.contains("Nova"))
        XCTAssertTrue(creationAvatar.label.contains("Companion"))
        try captureScreenshot(named: "creation-thinking.png")
    }

    @MainActor
    private func assertIconOptions(
        in app: XCUIApplication,
        prefix: String,
        count: Int
    ) {
        for index in 0..<count {
            let element = app.descendants(matching: .any)["\(prefix).\(index)"]
            for _ in 0..<5 where !element.exists { app.swipeUp() }
            XCTAssertTrue(element.exists, "Missing icon option \(prefix).\(index)")
            XCTAssertTrue(
                element.label.contains("Companion"),
                "Icon option \(prefix).\(index) should have a Companion VoiceOver label"
            )
            XCTAssertTrue(["Selected", "Not selected"].contains(element.value as? String ?? ""))
        }
    }

    @MainActor
    private func captureScreenshot(named filename: String) throws {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = filename
        attachment.lifetime = .keepAlways
        add(attachment)

        guard let directoryPath = ProcessInfo.processInfo.environment["COMPANION_SCREENSHOT_DIR"],
              !directoryPath.isEmpty else { return }

        let directoryURL = URL(fileURLWithPath: directoryPath, isDirectory: true)
        try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
        try screenshot.pngRepresentation.write(
            to: directoryURL.appendingPathComponent(filename),
            options: .atomic
        )
    }
}
