import SwiftUI
import CompanionKit

struct CompanionDecisionCatalog: Equatable {
    var skills: [String: String] = [:]
    var plugins: [String: String] = [:]
    var models: [String: String] = [:]

    static let empty = CompanionDecisionCatalog()
}

struct CompanionDecisionCard: View {
    let decision: CompanionDecision
    let companionName: String
    let canAct: Bool
    let catalog: CompanionDecisionCatalog
    let accent: Color
    let accentForeground: Color
    let onDecide: @MainActor (CompanionDecisionAction) async throws -> Void
    let onOpenPlugins: (_ provider: String?, _ controlRequestID: String?) -> Void
    let onAnswerFocusChange: (Bool) -> Void

    @State private var answer = ""
    @State private var busy = false
    @State private var error: String?
    @FocusState private var answerFocused: Bool

    @ViewBuilder
    var body: some View {
        if let outcome = projection.outcome {
            settledBubble(outcome)
        } else {
            pendingCard
        }
    }

    private var pendingCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            header

            requestContent
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(
                    CompanionIOSTheme.innerBubble,
                    in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                )

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(CompanionIOSTheme.danger)
                    .accessibilityLabel("Error. \(error)")
                    .accessibilityIdentifier("decision.error.\(decision.requestID)")
            }

            actions
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(
            CompanionIOSTheme.botBubble,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
    }

    private func settledBubble(_ outcome: CompanionDecisionCardOutcome) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(settledBubbleText(outcome))
                .font(.body)
                .foregroundStyle(CompanionIOSTheme.textPrimary)

            if outcome == .allowed, let provider = controlPluginProvider {
                Button {
                    onOpenPlugins(provider, decision.requestID)
                } label: {
                    Label("Connect \(provider.capitalized)", systemImage: "puzzlepiece.extension")
                        .font(.subheadline.weight(.semibold))
                }
                .buttonStyle(.plain)
                .foregroundStyle(accent)
                .accessibilityIdentifier("decision.open-control-plugin.\(decision.requestID)")
            }

            if let name = decision.decidedByName, !name.isEmpty {
                Text("\(statusLabel) by \(name)")
                    .font(.caption)
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(
            CompanionIOSTheme.botBubble,
            in: RoundedRectangle(cornerRadius: 18, style: .continuous)
        )
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("decision.outcome.\(decision.requestID)")
    }

    private func settledBubbleText(_ outcome: CompanionDecisionCardOutcome) -> String {
        if decision.kind == .trigger, outcome == .allowed {
            return "Approved — Companion handled the provider setup. Check Triggers for its registration status."
        }
        return outcome.bubbleText
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: symbol)
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .accessibilityHidden(true)

            Text(heading)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Spacer(minLength: 4)

            Label(statusLabel, systemImage: statusSymbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(statusColor)
                .labelStyle(.titleAndIcon)
                .fixedSize()
        }
        .accessibilityIdentifier("decision.card.\(decision.requestID)")
    }

    @ViewBuilder
    private var requestContent: some View {
        if decision.proposal != nil, !decision.title.isEmpty {
            Text(decision.title)
                .font(.footnote)
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }

        switch decision.proposal {
        case .config(let proposal):
            configContent(proposal)
        case .routine(let proposal):
            routineContent(proposal)
        case .trigger(let proposal):
            triggerContent(proposal)
        case .control(let proposal):
            controlContent(proposal)
        case nil:
            Text(decision.title)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }

        if let detail = decision.detail, !detail.isEmpty {
            DisclosureGroup("Details") {
                Text(detail)
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)
                    .textSelection(.enabled)
                    .padding(.top, 6)
            }
            .font(.caption.weight(.semibold))
            .tint(CompanionIOSTheme.textSecondary)
        }
    }

    @ViewBuilder
    private var actions: some View {
        if projection.showsActions, decision.kind == .question {
            VStack(alignment: .leading, spacing: 8) {
                Text("Your answer")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CompanionIOSTheme.textPrimary)

                TextField("Type an answer", text: $answer, axis: .vertical)
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .focused($answerFocused)
                    .submitLabel(.send)
                    .disabled(busy)
                    .onChange(of: answer) { _, value in
                        if value.count > 8_000 { answer = String(value.prefix(8_000)) }
                    }
                    .onSubmit {
                        guard !answerValue.isEmpty else { return }
                        perform(.answer(answerValue))
                    }
                    .onChange(of: answerFocused) { _, focused in
                        onAnswerFocusChange(focused)
                    }
                    .accessibilityLabel("Answer")
                    .accessibilityIdentifier("decision.answer-field.\(decision.requestID)")

                HStack(spacing: 8) {
                    decisionButton(
                        projection.primaryActionTitle ?? "Answer",
                        prominent: true,
                        disabled: projection.primaryActionDisabled
                    ) {
                        perform(.answer(answerValue))
                    }
                    decisionButton(projection.secondaryActionTitle ?? "Deny", prominent: false) {
                        perform(.deny)
                    }
                }
            }
        } else if projection.showsActions {
            HStack(spacing: 8) {
                decisionButton(projection.primaryActionTitle ?? "Approve", prominent: true) {
                    perform(.allow)
                }
                decisionButton(projection.secondaryActionTitle ?? "Deny", prominent: false) {
                    perform(.deny)
                }
            }
        } else if let waitingMessage = projection.waitingMessage {
            Text(waitingMessage)
                .font(.caption)
                .foregroundStyle(CompanionIOSTheme.textSecondary)
        }
    }

    @ViewBuilder
    private func decisionButton(
        _ title: String,
        prominent: Bool,
        disabled: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        if prominent {
            Button(action: action) {
                Group {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text(title)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                .background(
                    CompanionIOSTheme.primaryCTA,
                    in: Capsule()
                )
            }
            .buttonStyle(.plain)
            .disabled(busy || disabled)
            .accessibilityLabel("\(title) request")
            .accessibilityIdentifier("decision.\(title.lowercased()).\(decision.requestID)")
        } else {
            Button(action: action) {
                Group {
                    if busy {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text(title)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44)
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .background(CompanionIOSTheme.card, in: Capsule())
            }
            .buttonStyle(.plain)
            .disabled(busy || disabled)
            .accessibilityLabel("\(title) request")
            .accessibilityIdentifier("decision.\(title.lowercased()).\(decision.requestID)")
        }
    }

    @ViewBuilder
    private func configContent(_ proposal: CompanionConfigProposal) -> some View {
        if let connection = proposal.connectPlugin {
            VStack(alignment: .leading, spacing: 8) {
                Text("Connect \(connection.serverName.capitalized)")
                    .font(.footnote.weight(.medium))
                if let reason = connection.reason {
                    Text(reason)
                        .font(.footnote)
                        .foregroundStyle(CompanionIOSTheme.textSecondary)
                }
                Button(action: { onOpenPlugins(nil, nil) }) {
                    Label("Connect", systemImage: "puzzlepiece.extension")
                        .font(.subheadline.weight(.semibold))
                            .foregroundStyle(CompanionIOSTheme.primaryCTAText)
                        .padding(.horizontal, 16)
                        .frame(minHeight: 44)
                        .background(
                            CompanionIOSTheme.primaryCTA,
                            in: Capsule()
                        )
                }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("decision.open-plugins.\(decision.requestID)")
            }
        } else {
            VStack(alignment: .leading, spacing: 5) {
                let rows = configRows(proposal)
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(row.sign)
                            .font(.system(.caption, design: .monospaced))
                            .foregroundStyle(CompanionIOSTheme.textSecondary)
                            .frame(width: 14, alignment: .leading)
                        Text(row.label)
                            .font(.footnote)
                            .foregroundStyle(
                                row.known
                                    ? CompanionIOSTheme.textPrimary
                                    : CompanionIOSTheme.textSecondary
                            )
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if proposal.includesPersona {
                    DisclosureGroup("Instructions") {
                        Text(personaText(proposal))
                            .font(.footnote)
                            .foregroundStyle(CompanionIOSTheme.textPrimary)
                            .textSelection(.enabled)
                            .padding(.top, 6)
                    }
                    .font(.caption.weight(.semibold))
                    .tint(CompanionIOSTheme.textSecondary)
                }
            }
        }
    }

    private func routineContent(_ proposal: CompanionRoutineProposal) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(proposal.name)
                .font(.footnote.weight(.medium))
            Text("\(proposal.cron) · \(proposal.timezone)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
                .textSelection(.enabled)
            promptDisclosure(proposal.prompt)
        }
    }

    private func triggerContent(_ proposal: CompanionTriggerProposal) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(proposal.name)
                .font(.footnote.weight(.medium))
            Text(proposal.provider)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
            Label(
                proposal.mode == .notify ? "Notify me" : "Ask the Companion",
                systemImage: proposal.mode == .notify ? "bell" : "arrow.turn.down.right"
            )
            .font(.caption.weight(.medium))
            .foregroundStyle(CompanionIOSTheme.textSecondary)
            if let repo = proposal.target?.repo {
                Text(repo)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
            }
            if let events = proposal.target?.events, !events.isEmpty {
                Text(events.joined(separator: ", "))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(CompanionIOSTheme.textSecondary)
                    .textSelection(.enabled)
            }
            promptDisclosure(proposal.prompt)
        }
    }

    private func controlContent(_ proposal: CompanionControlProposal) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(proposal.summary)
                .font(.footnote.weight(.semibold))
                .foregroundStyle(CompanionIOSTheme.textPrimary)
            Text("\(proposal.requestKind) · \(proposal.action)")
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(CompanionIOSTheme.textSecondary)
            if !proposal.payload.isEmpty {
                DisclosureGroup("Requested values") {
                    Text(CompanionControlJSONValue.object(proposal.payload).prettyPrintedJSON)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(CompanionIOSTheme.textPrimary)
                        .textSelection(.enabled)
                        .padding(.top, 6)
                }
                .font(.caption.weight(.semibold))
                .tint(CompanionIOSTheme.textSecondary)
            }
        }
    }

    private var controlPluginProvider: String? {
        guard case .control(let proposal) = decision.proposal,
              proposal.requestKind == "plugin_connection",
              case .string(let provider) = proposal.payload["provider"] else { return nil }
        return provider
    }

    private func promptDisclosure(_ prompt: String) -> some View {
        DisclosureGroup("Prompt") {
            Text(prompt)
                .font(.footnote)
                .foregroundStyle(CompanionIOSTheme.textPrimary)
                .textSelection(.enabled)
                .padding(.top, 6)
        }
        .font(.caption.weight(.semibold))
        .tint(CompanionIOSTheme.textSecondary)
    }

    private func personaText(_ proposal: CompanionConfigProposal) -> String {
        guard let persona = proposal.persona, !persona.isEmpty else { return "(empty)" }
        return persona
    }

    private var projection: CompanionDecisionCardProjection {
        CompanionDecisionCardProjection(
            decision: decision,
            canAct: canAct,
            busy: busy,
            answer: answer
        )
    }

    private var answerValue: String {
        answer.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var heading: String {
        switch decision.kind {
        case .question: "Question"
        case .config: "\(companionName) proposes these changes"
        case .routine: "\(companionName) proposes this routine"
        case .trigger: "\(companionName) proposes this trigger"
        case .control: "\(companionName) requests a change"
        case .shell: "Allow run a command"
        case .file: "Allow edit a file"
        case .unknown: "Unsupported request"
        }
    }

    private var symbol: String {
        switch decision.kind {
        case .shell: "terminal"
        case .file: "doc.badge.gearshape"
        case .question: "questionmark.bubble"
        case .config: "gearshape.2"
        case .routine: "calendar.badge.clock"
        case .trigger: "bolt.horizontal.circle"
        case .control: "shippingbox.and.arrow.backward"
        case .unknown: "questionmark.diamond"
        }
    }

    private var statusLabel: String {
        if decision.kind == .control {
            switch decision.controlStatus {
            case .pending: return "Waiting"
            case .applying: return "Applying"
            case .applied: return "Applied"
            case .denied: return "Denied"
            case .expired: return "Timed out"
            case .cancelled: return "Closed"
            case .failed: return "Failed"
            case .unknown: return "Unknown"
            case nil: break
            }
        }
        return switch decision.status {
        case .pending: "Waiting"
        case .allowed: "Allowed"
        case .denied: "Denied"
        case .answered: "Answered"
        case .expired: "Timed out"
        case .cancelled: "Closed"
        case .unknown: "Unknown"
        }
    }

    private var statusSymbol: String {
        if decision.kind == .control, decision.controlStatus == .applying { return "clock" }
        if decision.kind == .control, decision.controlStatus == .failed { return "exclamationmark.triangle" }
        return switch decision.status {
        case .pending: "clock"
        case .allowed, .answered: "checkmark"
        case .denied, .expired: "exclamationmark.triangle"
        case .cancelled: "xmark"
        case .unknown: "questionmark"
        }
    }

    private var statusColor: Color {
        if decision.kind == .control, decision.controlStatus == .applying { return CompanionIOSTheme.textSecondary }
        if decision.kind == .control, decision.controlStatus == .failed { return CompanionIOSTheme.danger }
        return switch decision.status {
        case .pending: CompanionIOSTheme.textSecondary
        case .allowed, .answered: CompanionIOSTheme.toggleGreen
        case .denied, .expired: CompanionIOSTheme.danger
        case .cancelled, .unknown: CompanionIOSTheme.textSecondary
        }
    }

    private func perform(_ action: CompanionDecisionAction) {
        guard projection.isInteractive else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            do {
                try await onDecide(action)
            } catch {
                self.error = companionDisplayMessage(
                    error,
                    fallback: "This request could not be updated."
                )
            }
        }
    }

    private func configRows(_ proposal: CompanionConfigProposal) -> [ConfigRow] {
        var rows: [ConfigRow] = []
        rows += proposal.addSkillIDs.map { resourceRow(sign: "+", id: $0, catalog: catalog.skills) }
        rows += proposal.removeSkillIDs.map { resourceRow(sign: "−", id: $0, catalog: catalog.skills) }
        rows += proposal.attachPluginIDs.map {
            let row = resourceRow(sign: "+", id: $0, catalog: catalog.plugins)
            return ConfigRow(sign: row.sign, label: "plugin \(row.label)", known: row.known)
        }
        rows += proposal.detachPluginIDs.map {
            let row = resourceRow(sign: "−", id: $0, catalog: catalog.plugins)
            return ConfigRow(sign: row.sign, label: "plugin \(row.label)", known: row.known)
        }
        if let modelID = proposal.modelID {
            let row = resourceRow(sign: "→", id: modelID, catalog: catalog.models)
            rows.append(ConfigRow(
                sign: row.sign,
                label: "model \(row.label)",
                known: row.known
            ))
        }
        return rows
    }

    private func resourceRow(
        sign: String,
        id: String,
        catalog: [String: String]
    ) -> ConfigRow {
        guard let label = catalog[id] else {
            return ConfigRow(
                sign: sign,
                label: "a resource owned by another member",
                known: false
            )
        }
        return ConfigRow(sign: sign, label: label, known: true)
    }
}

private struct ConfigRow {
    let sign: String
    let label: String
    let known: Bool
}
