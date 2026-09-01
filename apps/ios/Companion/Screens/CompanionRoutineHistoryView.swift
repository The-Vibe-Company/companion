import CompanionKit
import SwiftUI

/// A value route shared by resource history links and routine-origin chat markers.
struct CompanionRoutineHistoryTarget: Identifiable, Equatable, Sendable {
    let routineID: String?
    let runID: String?
    let name: String

    var id: String {
        "\(routineID ?? "deleted"):\(runID ?? "history")"
    }
}

/// Optional fixture hooks keep the Debug resources showcase server-free. Production callers leave
/// these nil and the view reads through SessionStore, preserving one transport/auth boundary.
@MainActor
struct CompanionRoutineHistoryServices {
    let listRuns: ((String, Int, String?) async throws -> CompanionRoutineRunList)?
    let readRun: ((String, Int, Int?) async throws -> CompanionRoutineRunDetail)?

    init(
        listRuns: ((String, Int, String?) async throws -> CompanionRoutineRunList)? = nil,
        readRun: ((String, Int, Int?) async throws -> CompanionRoutineRunDetail)? = nil
    ) {
        self.listRuns = listRuns
        self.readRun = readRun
    }
}

struct CompanionRoutineHistoryView: View {
    @Environment(SessionStore.self) private var sessionStore

    let companionID: String
    let target: CompanionRoutineHistoryTarget
    let services: CompanionRoutineHistoryServices?

    @State private var runs: [CompanionRoutineRunSummary] = []
    @State private var nextRunsCursor: String?
    @State private var runsLoading = true
    @State private var runsError: String?
    @State private var runsGeneration = 0

    init(
        companionID: String,
        target: CompanionRoutineHistoryTarget,
        services: CompanionRoutineHistoryServices? = nil
    ) {
        self.companionID = companionID
        self.target = target
        self.services = services
        _runsLoading = State(initialValue: target.runID == nil && target.routineID != nil)
    }

    var body: some View {
        CompanionBackdrop {
            if let runID = target.runID {
                CompanionRoutineRunDetailView(
                    companionID: companionID,
                    runID: runID,
                    routineName: target.name,
                    services: services
                )
            } else {
                runList
            }
        }
        .navigationTitle(target.runID == nil ? "Run history" : "Routine run")
        .navigationBarTitleDisplayMode(.inline)
        .tint(CompanionVisualTheme(icon: nil).accent)
        .task(id: listTaskID) {
            guard target.runID == nil, target.routineID != nil else { return }
            await loadRuns()
        }
        .accessibilityIdentifier("companion.routine-history")
    }

    @ViewBuilder
    private var runList: some View {
        if target.routineID == nil {
            ContentUnavailableView(
                "Routine unavailable",
                systemImage: "clock.badge.xmark",
                description: Text("This routine was deleted, so its run history is no longer available.")
            )
            .padding(24)
        } else if runsLoading && runs.isEmpty {
            historyLoadingState(label: "Loading routine history…")
        } else if let runsError, runs.isEmpty {
            historyErrorState(message: runsError, retry: { await loadRuns() })
        } else if runs.isEmpty {
            ContentUnavailableView(
                "No runs yet",
                systemImage: "clock",
                description: Text("This routine has not produced a run yet.")
            )
            .padding(24)
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    historyHeader
                    if let runsError {
                        CompanionErrorNotice(message: runsError)
                    }
                    ForEach(runs) { run in
                        NavigationLink {
                            CompanionRoutineRunDetailView(
                                companionID: companionID,
                                runID: run.runID,
                                routineName: run.routine.name,
                                services: services
                            )
                        } label: {
                            routineRunRow(run)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("companion.routine-history.run.\(run.runID)")
                    }

                    if nextRunsCursor != nil {
                        Button {
                            Task { await loadRuns(cursor: nextRunsCursor) }
                        } label: {
                            HStack(spacing: 8) {
                                if runsLoading { ProgressView().controlSize(.small) }
                                Text(runsLoading ? "Loading…" : "Load more runs")
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.glass)
                        .disabled(runsLoading)
                        .accessibilityLabel(runsLoading ? "Loading more routine runs" : "Load more routine runs")
                        .accessibilityIdentifier("companion.routine-history.load-more")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 30)
            }
            .refreshable { await loadRuns() }
            .scrollIndicators(.hidden)
        }
    }

    private var historyHeader: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(target.name)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.companionInk)
            Text("Newest runs first. Times use \(displayTimezone).")
                .font(.footnote)
                .foregroundStyle(Color.companionMuted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("companion.routine-history.header")
    }

    private func routineRunRow(_ run: CompanionRoutineRunSummary) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 5) {
                Text(formattedTimestamp(run.createdAt) ?? run.createdAt)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                Text(outcomeLabel(run))
                    .font(.footnote)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
                if let recovery = recoveryDescription(run.recoveryStatus, turnStatus: run.status) {
                    Label(recovery, systemImage: recoverySymbol(run.recoveryStatus))
                        .font(.caption.weight(.medium))
                        .foregroundStyle(recoveryColor(run.recoveryStatus))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("companion.routine-history.recovery.\(run.runID)")
                }
            }
            Spacer(minLength: 8)
            statusLabel(run.status)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(Color.companionMuted)
                .frame(width: 28, height: 44)
                .accessibilityHidden(true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .companionMaterial(radius: 12)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(runAccessibilityLabel(run))
    }

    private func statusLabel(_ status: CompanionRoutineRunStatus) -> some View {
        Text(statusWord(status))
            .font(.caption.weight(.semibold))
            .foregroundStyle(statusColor(status))
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(statusColor(status).opacity(0.12), in: Capsule())
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Status: \(statusWord(status))")
    }

    private func historyLoadingState(label: String) -> some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text(label)
                .font(.subheadline.weight(.medium))
                .foregroundStyle(Color.companionMuted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(28)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }

    private func historyErrorState(
        message: String,
        retry: @escaping () async -> Void
    ) -> some View {
        ContentUnavailableView {
            Label("Could not load run history", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("Try again", systemImage: "arrow.clockwise") {
                Task { await retry() }
            }
            .buttonStyle(.glassProminent)
            .frame(minHeight: 44)
            .accessibilityIdentifier("companion.routine-history.retry")
        }
        .padding(24)
    }

    private var listTaskID: String {
        "\(companionID):\(target.routineID ?? "none"):\(target.runID ?? "list")"
    }

    private func loadRuns(cursor: String? = nil) async {
        guard let routineID = target.routineID, target.runID == nil else { return }
        runsGeneration &+= 1
        let generation = runsGeneration
        runsLoading = true
        runsError = nil
        do {
            let page: CompanionRoutineRunList
            if let listRuns = services?.listRuns {
                page = try await listRuns(routineID, 50, cursor)
            } else {
                page = try await sessionStore.listCompanionRoutineRuns(
                    companionID: companionID,
                    routineID: routineID,
                    limit: 50,
                    cursor: cursor
                )
            }
            guard !Task.isCancelled, generation == runsGeneration else { return }
            let sorted = page.runs.sorted(by: runOrder)
            runs = cursor == nil ? sorted : mergeRuns(sorted)
            nextRunsCursor = page.nextCursor
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, generation == runsGeneration else { return }
            runsError = companionDisplayMessage(error, fallback: "Routine history could not be loaded.")
        }
        if generation == runsGeneration { runsLoading = false }
    }

    private func mergeRuns(_ incoming: [CompanionRoutineRunSummary]) -> [CompanionRoutineRunSummary] {
        var byID = Dictionary(uniqueKeysWithValues: runs.map { ($0.runID, $0) })
        for run in incoming { byID[run.runID] = run }
        return byID.values.sorted(by: runOrder)
    }

    private func runOrder(_ lhs: CompanionRoutineRunSummary, _ rhs: CompanionRoutineRunSummary) -> Bool {
        if lhs.createdAt != rhs.createdAt { return lhs.createdAt > rhs.createdAt }
        return lhs.runID < rhs.runID
    }

    private var displayTimezone: String {
        sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier
    }

    private func formattedTimestamp(_ value: String) -> String? {
        MemberTimezone.formatInstant(value, in: displayTimezone)
    }

    private func outcomeLabel(_ run: CompanionRoutineRunSummary) -> String {
        if run.outcome == .surfaced {
            switch run.surfaceMode {
            case .relay: return "Relayed to main Companion"
            case .notify: return "Notified in main chat"
            case .unknown: return "Surfaced"
            case nil: return "Surfaced"
            }
        }
        switch run.outcome {
        case .noOutput: return "Completed silently"
        case .error: return statusWord(run.status)
        case .pending: return "Pending"
        case .surfaced, .unknown: return statusWord(run.status)
        }
    }

    private func runAccessibilityLabel(_ run: CompanionRoutineRunSummary) -> String {
        var parts = [
            formattedTimestamp(run.createdAt) ?? run.createdAt,
            "Status \(statusWord(run.status))",
            outcomeLabel(run),
        ]
        if let recovery = recoveryDescription(run.recoveryStatus, turnStatus: run.status) {
            parts.append(recovery)
        }
        if let message = run.error?.message, !message.isEmpty { parts.append(message) }
        return parts.joined(separator: ". ")
    }

    private func statusWord(_ status: CompanionRoutineRunStatus) -> String {
        switch status {
        case .queued: return "Queued"
        case .starting: return "Starting"
        case .dispatching: return "Dispatching"
        case .running: return "Running"
        case .needsInput: return "Needs input"
        case .succeeded: return "Completed"
        case .failed: return "Failed"
        case .interrupted: return "Interrupted"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }

    private func statusColor(_ status: CompanionRoutineRunStatus) -> Color {
        switch status {
        case .succeeded: return .companionSuccess
        case .failed, .cancelled: return .companionDanger
        case .interrupted, .needsInput: return .companionWarning
        default: return .companionMuted
        }
    }

    private func recoveryDescription(
        _ recoveryStatus: CompanionRecoveryStatus?,
        turnStatus: CompanionRoutineRunStatus
    ) -> String? {
        switch recoveryStatus {
        case .pending: return "Cleanup queued; this run will not be replayed"
        case .running: return "Cleaning up this exact run; it will not be replayed"
        case .completed: return "Cleanup complete; later messages continue automatically in order"
        case .unknown: return "Automatic cleanup; this run will not be replayed"
        case nil: return turnStatus == .interrupted
            ? "Automatic cleanup; this run will not be replayed"
            : nil
        }
    }

    private func recoverySymbol(_ status: CompanionRecoveryStatus?) -> String {
        status == .completed ? "checkmark.circle" : "arrow.trianglehead.2.clockwise.rotate.90"
    }

    private func recoveryColor(_ status: CompanionRecoveryStatus?) -> Color {
        status == .completed ? .companionSuccess : .companionWarning
    }
}

private struct CompanionRoutineRunDetailView: View {
    @Environment(SessionStore.self) private var sessionStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let companionID: String
    let runID: String
    let routineName: String
    let services: CompanionRoutineHistoryServices?

    @State private var run: CompanionRoutineRunDetail?
    @State private var loading = true
    @State private var error: String?
    @State private var loadGeneration = 0
    @State private var expandedReasoning: Set<String> = []
    @State private var recoveryRefreshInFlight = false

    var body: some View {
        CompanionBackdrop {
            if loading && run == nil {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Loading routine run…")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.companionMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Loading routine run")
            } else if let error, run == nil {
                ContentUnavailableView {
                    Label("Could not load routine run", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button("Try again", systemImage: "arrow.clockwise") {
                        Task { await load() }
                    }
                    .buttonStyle(.glassProminent)
                    .frame(minHeight: 44)
                    .accessibilityIdentifier("companion.routine-run.retry")
                }
                .padding(24)
            } else if let run {
                detailContent(run)
            }
        }
        .navigationTitle("Routine run")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: runID) { await load() }
        .task(id: recoveryPollingID) { await pollRecovery() }
        .accessibilityIdentifier("companion.routine-run-detail.\(runID)")
    }

    @ViewBuilder
    private func detailContent(_ run: CompanionRoutineRunDetail) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                runSummary(run)
                transcriptSection(run)
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 30)
        }
        .refreshable { await load() }
        .scrollIndicators(.hidden)
    }

    private func runSummary(_ run: CompanionRoutineRunDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "clock")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(Color.companionAccent)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(run.routine.name.isEmpty ? routineName : run.routine.name)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(Color.companionInk)
                    Text("Run \(run.runID)")
                        .font(.caption.monospaced())
                        .foregroundStyle(Color.companionMuted)
                        .textSelection(.enabled)
                }
            }
            statusLabel(run.status)
            if let recovery = recoveryDescription(run.recoveryStatus, turnStatus: run.status) {
                Label(recovery, systemImage: recoverySymbol(run.recoveryStatus))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(recoveryColor(run.recoveryStatus))
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("companion.routine-run.recovery")
            }
            detailValue("Result", outcomeLabel(run))
            detailValue("Created", formattedTimestamp(run.createdAt) ?? run.createdAt)
            if let startedAt = run.startedAt {
                detailValue("Started", formattedTimestamp(startedAt) ?? startedAt)
            }
            if let settledAt = run.settledAt {
                detailValue("Settled", formattedTimestamp(settledAt) ?? settledAt)
            }
            if let error = run.error {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Error")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(Color.companionDanger)
                    Text(error.message)
                        .font(.footnote)
                        .foregroundStyle(Color.companionInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                    Text("Code: \(error.code).")
                        .font(.caption)
                        .foregroundStyle(Color.companionMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .background(Color.companionDanger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Error. \(error.message). Code \(error.code)")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .companionMaterial(radius: 12)
        .accessibilityIdentifier("companion.routine-run.summary")
    }

    private func detailValue(_ label: String, _ value: String) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
                    .frame(width: 72, alignment: .leading)
                Text(value)
                    .font(.footnote)
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
                Text(value)
                    .font(.footnote)
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label): \(value)")
    }

    private func transcriptSection(_ run: CompanionRoutineRunDetail) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Internal transcript")
                .font(.headline)
                .foregroundStyle(Color.companionInk)
                .accessibilityAddTraits(.isHeader)

            if let error {
                CompanionErrorNotice(message: error)
            }
            if run.internalEntries.isEmpty {
                Text("This run finished without recorded private activity.")
                    .font(.footnote)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(sortedEntries(run.internalEntries)) { entry in
                    routineEntry(entry)
                }
            }

            if run.nextEntryCursor != nil {
                Button {
                    Task { await load(entryCursor: run.nextEntryCursor) }
                } label: {
                    HStack(spacing: 8) {
                        if loading || recoveryRefreshInFlight {
                            ProgressView().controlSize(.small)
                        }
                        Text(
                            loading
                                ? "Loading…"
                                : recoveryRefreshInFlight ? "Refreshing…" : "Load more transcript"
                        )
                    }
                    .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.glass)
                .tint(Color.companionAccent)
                .disabled(loading || recoveryRefreshInFlight)
                .accessibilityLabel(
                    loading || recoveryRefreshInFlight
                        ? "Refreshing routine transcript"
                        : "Load more transcript"
                )
                .accessibilityIdentifier("companion.routine-run.load-more")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .companionMaterial(radius: 12)
        .accessibilityIdentifier("companion.routine-run.transcript")
    }

    @ViewBuilder
    private func routineEntry(_ entry: CompanionRoutineRunEntry) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(entryLabel(entry))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.companionInk)
                Spacer(minLength: 4)
                Text(formattedTimestamp(entry.createdAt) ?? entry.createdAt)
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.companionMuted)
            }

            if let tool = entry.tool {
                toolContent(tool, content: entry.content)
            } else if let decision = entry.decision {
                decisionContent(decision, content: entry.content)
            } else if !entry.content.isEmpty {
                Text(entry.content)
                    .font(.body)
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }

            if let reasoning = entry.reasoning,
               !reasoning.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                DisclosureGroup(
                    isExpanded: Binding(
                        get: { expandedReasoning.contains(entry.eventID) },
                        set: { isExpanded in
                            if isExpanded { expandedReasoning.insert(entry.eventID) }
                            else { expandedReasoning.remove(entry.eventID) }
                        }
                    )
                ) {
                    Text(reasoning)
                        .font(.footnote)
                        .foregroundStyle(Color.companionMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(.top, 3)
                } label: {
                    Text("Reasoning")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Color.companionMuted)
                        .frame(minHeight: 44, alignment: .leading)
                }
                .tint(Color.companionMuted)
                .accessibilityLabel("Reasoning")
                .accessibilityValue(expandedReasoning.contains(entry.eventID) ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("companion.routine-run.reasoning.\(entry.eventID)")
                .transaction { transaction in
                    if reduceMotion { transaction.animation = nil }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(CompanionIOSTheme.card, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("companion.routine-run.entry.\(entry.eventID)")
    }

    private func toolContent(_ tool: CompanionToolRun, content: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(tool.title.isEmpty ? tool.name : tool.title, systemImage: "wrench.and.screwdriver")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Text(toolStatusWord(tool.status))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(toolStatusColor(tool.status))
            }
            if !content.isEmpty {
                Text(content)
                    .font(.footnote)
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let detail = tool.detail, !detail.isEmpty {
                DisclosureGroup("Tool details") {
                    Text(detail)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(Color.companionInk)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(.top, 4)
                }
                .frame(minHeight: 44, alignment: .leading)
                .accessibilityLabel("Tool details")
                .accessibilityIdentifier("companion.routine-run.tool-details.\(tool.name)")
            }
        }
    }

    private func decisionContent(_ decision: CompanionDecision, content: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Label(decision.title.isEmpty ? decision.name : decision.title, systemImage: "questionmark.circle")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Text(decisionStatusWord(decision.status))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.companionMuted)
            }
            if !content.isEmpty {
                Text(content)
                    .font(.footnote)
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let detail = decision.detail, !detail.isEmpty {
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Color.companionMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let answer = decision.answer, !answer.isEmpty {
                Text("Answer: \(answer)")
                    .font(.footnote)
                    .foregroundStyle(Color.companionInk)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    private func entryLabel(_ entry: CompanionRoutineRunEntry) -> String {
        switch entry.role {
        case "assistant": return "Routine Pi"
        case "user": return "Routine task"
        case "system": return "System"
        case "tool": return entry.tool?.name ?? "Tool"
        case "decision": return entry.decision?.name ?? "Decision"
        default: return entry.role.capitalized
        }
    }

    private func sortedEntries(_ entries: [CompanionRoutineRunEntry]) -> [CompanionRoutineRunEntry] {
        var seen = Set<String>()
        return entries.filter { seen.insert($0.eventID).inserted }.sorted { lhs, rhs in
            lhs.ordinal == rhs.ordinal ? lhs.eventID < rhs.eventID : lhs.ordinal < rhs.ordinal
        }
    }

    private var recoveryPollingID: String {
        "\(runID):\(run?.recoveryStatus?.rawValue ?? "none")"
    }

    private func pollRecovery() async {
        guard run?.recoveryStatus?.isActive == true else { return }
        while !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(4))
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            await load(preservingLoadedEntries: true, quietly: true)
            guard run?.recoveryStatus?.isActive == true else { return }
        }
    }

    private func load(
        entryCursor: Int? = nil,
        preservingLoadedEntries: Bool = false,
        quietly: Bool = false
    ) async {
        if quietly {
            guard !loading, !recoveryRefreshInFlight else { return }
            recoveryRefreshInFlight = true
        } else {
            guard !recoveryRefreshInFlight else { return }
        }
        defer {
            if quietly { recoveryRefreshInFlight = false }
        }
        loadGeneration &+= 1
        let generation = loadGeneration
        if !quietly { loading = true }
        if !quietly { error = nil }
        do {
            let page: CompanionRoutineRunDetail
            if let readRun = services?.readRun {
                page = try await readRun(runID, 50, entryCursor)
            } else {
                page = try await sessionStore.readCompanionRoutineRun(
                    companionID: companionID,
                    runID: runID,
                    entryLimit: 50,
                    entryCursor: entryCursor
                )
            }
            guard !Task.isCancelled, generation == loadGeneration else { return }
            if entryCursor == nil, preservingLoadedEntries, let current = run,
               current.runID == page.runID {
                run = mergedDetail(
                    metadata: page,
                    entries: current.internalEntries + page.internalEntries,
                    nextEntryCursor: current.nextEntryCursor
                )
            } else if entryCursor == nil || run?.runID != page.runID {
                run = page
            } else if let current = run {
                run = mergedDetail(
                    metadata: page,
                    entries: current.internalEntries + page.internalEntries,
                    nextEntryCursor: page.nextEntryCursor
                )
            }
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            if !quietly {
                self.error = companionDisplayMessage(error, fallback: "This routine run could not be loaded.")
            }
        }
        if generation == loadGeneration, !quietly { loading = false }
    }

    private func mergedDetail(
        metadata: CompanionRoutineRunDetail,
        entries: [CompanionRoutineRunEntry],
        nextEntryCursor: Int?
    ) -> CompanionRoutineRunDetail {
        CompanionRoutineRunDetail(
            runID: metadata.runID,
            companionID: metadata.companionID,
            routine: metadata.routine,
            status: metadata.status,
            outcome: metadata.outcome,
            surfaceMode: metadata.surfaceMode,
            mainEntryEventID: metadata.mainEntryEventID,
            relayTurnID: metadata.relayTurnID,
            createdAt: metadata.createdAt,
            startedAt: metadata.startedAt,
            settledAt: metadata.settledAt,
            error: metadata.error,
            internalEntries: sortedEntries(entries),
            nextEntryCursor: nextEntryCursor,
            recoveryStatus: metadata.recoveryStatus
        )
    }

    private var displayTimezone: String {
        sessionStore.memberTimezone ?? MemberTimezone.deviceIdentifier
    }

    private func formattedTimestamp(_ value: String) -> String? {
        MemberTimezone.formatInstant(value, in: displayTimezone)
    }

    private func outcomeLabel(_ run: CompanionRoutineRunDetail) -> String {
        if run.outcome == .surfaced {
            switch run.surfaceMode {
            case .relay: return "Relayed to main Companion"
            case .notify: return "Notified in main chat"
            case .unknown, nil: return "Surfaced"
            }
        }
        switch run.outcome {
        case .noOutput: return "Completed silently"
        case .error: return statusWord(run.status)
        case .pending: return "Pending"
        case .surfaced, .unknown: return statusWord(run.status)
        }
    }

    private func statusLabel(_ status: CompanionRoutineRunStatus) -> some View {
        Text("Status: \(statusWord(status))")
            .font(.caption.weight(.semibold))
            .foregroundStyle(statusColor(status))
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(statusColor(status).opacity(0.12), in: Capsule())
            .accessibilityLabel("Status: \(statusWord(status))")
    }

    private func statusWord(_ status: CompanionRoutineRunStatus) -> String {
        switch status {
        case .queued: return "Queued"
        case .starting: return "Starting"
        case .dispatching: return "Dispatching"
        case .running: return "Running"
        case .needsInput: return "Needs input"
        case .succeeded: return "Completed"
        case .failed: return "Failed"
        case .interrupted: return "Interrupted"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }

    private func statusColor(_ status: CompanionRoutineRunStatus) -> Color {
        switch status {
        case .succeeded: return .companionSuccess
        case .failed, .cancelled: return .companionDanger
        case .interrupted, .needsInput: return .companionWarning
        default: return .companionMuted
        }
    }

    private func recoveryDescription(
        _ recoveryStatus: CompanionRecoveryStatus?,
        turnStatus: CompanionRoutineRunStatus
    ) -> String? {
        switch recoveryStatus {
        case .pending: "Automatic cleanup for this exact run is queued. The prompt will not be replayed. Later routine messages resume automatically in order when cleanup finishes."
        case .running: "Automatic cleanup for this exact run is running. The prompt will not be replayed. Later routine messages resume automatically in order when cleanup finishes."
        case .completed: "Automatic cleanup for this exact run is complete. The prompt was not replayed. Later routine messages continue automatically in order."
        case .unknown: "Automatic cleanup for this exact run continues in the background. The prompt will not be replayed. Later routine messages resume automatically in order."
        case nil: turnStatus == .interrupted
            ? "Automatic cleanup for this exact run continues in the background. The prompt will not be replayed. Later routine messages resume automatically in order."
            : nil
        }
    }

    private func recoverySymbol(_ status: CompanionRecoveryStatus?) -> String {
        status == .completed ? "checkmark.circle" : "arrow.trianglehead.2.clockwise.rotate.90"
    }

    private func recoveryColor(_ status: CompanionRecoveryStatus?) -> Color {
        status == .completed ? .companionSuccess : .companionWarning
    }

    private func toolStatusWord(_ status: CompanionToolRunStatus) -> String {
        switch status {
        case .running: return "Running"
        case .ok: return "Completed"
        case .error: return "Failed"
        case .timeout: return "Timed out"
        }
    }

    private func toolStatusColor(_ status: CompanionToolRunStatus) -> Color {
        switch status {
        case .ok: return .companionSuccess
        case .error, .timeout: return .companionDanger
        case .running: return .companionMuted
        }
    }

    private func decisionStatusWord(_ status: CompanionDecisionStatus) -> String {
        switch status {
        case .pending: return "Pending"
        case .allowed: return "Allowed"
        case .denied: return "Denied"
        case .answered: return "Answered"
        case .expired: return "Expired"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }
}
