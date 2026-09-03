import Foundation

public struct CompanionSyncMeasurement<Value: Sendable>: Sendable {
    public let value: Value
    public let receivedBytes: Int
    public let networkMilliseconds: Double

    public init(value: Value, receivedBytes: Int, networkMilliseconds: Double) {
        self.value = value
        self.receivedBytes = receivedBytes
        self.networkMilliseconds = networkMilliseconds
    }
}

public struct CompanionRosterDelta: Codable, Equatable, Sendable {
    public let cursor: String
    public let changedCompanions: [CompanionSummary]
    public let deletedCompanionIDs: [String]
    public let companionIDs: [String]
    public let changedSections: [CompanionSection]
    public let deletedSectionIDs: [String]
    public let sectionIDs: [String]

    enum CodingKeys: String, CodingKey {
        case cursor
        case changedCompanions = "changed_companions"
        case deletedCompanionIDs = "deleted_companion_ids"
        case companionIDs = "companion_ids"
        case changedSections = "changed_sections"
        case deletedSectionIDs = "deleted_section_ids"
        case sectionIDs = "section_ids"
    }

    public func applying(to snapshot: CompanionRosterSnapshot?) throws -> CompanionRosterSnapshot {
        var companions = Dictionary(uniqueKeysWithValues: (snapshot?.companions ?? []).map { ($0.id, $0) })
        deletedCompanionIDs.forEach { companions[$0] = nil }
        changedCompanions.forEach { companions[$0.id] = $0 }
        guard companionIDs.count == companions.count,
              Set(companionIDs).count == companionIDs.count,
              companionIDs.allSatisfy({ companions[$0] != nil }) else {
            throw CompanionSyncMergeError.incompleteRoster
        }

        var sections = Dictionary(uniqueKeysWithValues: (snapshot?.sections ?? []).map { ($0.id, $0) })
        deletedSectionIDs.forEach { sections[$0] = nil }
        changedSections.forEach { sections[$0.id] = $0 }
        guard sectionIDs.count == sections.count,
              Set(sectionIDs).count == sectionIDs.count,
              sectionIDs.allSatisfy({ sections[$0] != nil }) else {
            throw CompanionSyncMergeError.incompleteRoster
        }

        return CompanionRosterSnapshot(
            cursor: cursor,
            companions: companionIDs.compactMap { companions[$0] },
            sections: sectionIDs.compactMap { sections[$0] }
        )
    }
}

public struct CompanionThreadMetadata: Codable, Equatable, Sendable {
    public let companionID: String
    public let viewerID: String
    public let readOnly: Bool
    public let canSend: Bool
    public let transcriptionAvailable: Bool?
    public let activeTurn: CompanionTurn?
    public let queuedCount: Int
    public let queuedTurn: CompanionTurn?
    public let preparation: CompanionPreparation?
    public let backgroundBusy: Bool?
    public let interruptedTurn: CompanionTurn?

    enum CodingKeys: String, CodingKey {
        case companionID = "companion_id"
        case viewerID = "viewer_id"
        case readOnly = "read_only"
        case canSend = "can_send"
        case transcriptionAvailable = "transcription_available"
        case activeTurn = "active_turn"
        case queuedCount = "queued_count"
        case queuedTurn = "queued_turn"
        case preparation
        case backgroundBusy = "background_busy"
        case interruptedTurn = "interrupted_turn"
    }

    func thread(entries: [TranscriptEntry]) -> CompanionThread {
        CompanionThread(
            companionID: companionID,
            viewerID: viewerID,
            readOnly: readOnly,
            canSend: canSend,
            transcriptionAvailable: transcriptionAvailable,
            entries: entries,
            activeTurn: activeTurn,
            queuedCount: queuedCount,
            queuedTurn: queuedTurn,
            preparation: preparation,
            backgroundBusy: backgroundBusy,
            interruptedTurn: interruptedTurn
        )
    }
}

/// Restores the durable top-level entry sequence before applying fresh routine-notification
/// evidence. A previously collapsed snapshot keeps its hidden rows in the group metadata, so a
/// later delta can safely regroup the old and new occurrences together.
func companionExpandedRoutineNotifyEntries(_ entries: [TranscriptEntry]) -> [TranscriptEntry] {
    entries.flatMap { entry -> [TranscriptEntry] in
        guard let group = entry.routineNotifyGroup else { return [entry] }
        return group.hiddenEntries.map { $0.withRoutineNotifyGroup(nil) }
            + [entry.withRoutineNotifyGroup(nil)]
    }.sorted {
        $0.ordinal == $1.ordinal ? $0.eventID < $1.eventID : $0.ordinal < $1.ordinal
    }
}

/// Mirrors the web/Core projection: collapse only adjacent, attachment-free marker/update pairs
/// for which the server supplied a terminal routine `notify` return.
func companionCollapsedRoutineNotifyEntries(
    _ entries: [TranscriptEntry],
    notifyReturns: [CompanionRoutineNotifyReturn]
) -> [TranscriptEntry] {
    let ordered = companionExpandedRoutineNotifyEntries(entries)
    let returnedByRun = Dictionary(uniqueKeysWithValues: notifyReturns.map { ($0.runID, $0) })
    typealias Unit = (
        marker: TranscriptEntry,
        update: TranscriptEntry,
        routineID: String,
        routineName: String
    )
    var output: [TranscriptEntry] = []
    var open: [Unit] = []

    func flush() {
        guard let latest = open.last else { return }
        if open.count == 1 {
            output.append(latest.marker)
            output.append(latest.update.withRoutineNotifyGroup(nil))
        } else {
            output.append(latest.marker)
            output.append(latest.update.withRoutineNotifyGroup(
                CompanionTranscriptRoutineNotifyGroup(
                    routineID: latest.routineID,
                    routineName: latest.routineName,
                    totalCount: open.count,
                    hiddenEntries: open.dropLast().flatMap {
                        [$0.marker.withRoutineNotifyGroup(nil), $0.update.withRoutineNotifyGroup(nil)]
                    }
                )
            ))
        }
        open.removeAll(keepingCapacity: true)
    }

    var index = 0
    while index < ordered.count {
        let marker = ordered[index]
        let update = ordered.indices.contains(index + 1) ? ordered[index + 1] : nil
        let returned = marker.routine?.runID.flatMap { returnedByRun[$0] }
        let collapsible = returned != nil
            && update != nil
            && marker.role == "user"
            && marker.routine?.id == returned?.routineID
            && marker.routine?.name == returned?.routineName
            && marker.attachments.isEmpty
            && marker.decision == nil
            && update?.eventID == returned?.mainEntryEventID
            && update?.role == "assistant"
            && update?.attachments.isEmpty == true
            && update?.decision == nil
        guard collapsible, let update, let returned else {
            flush()
            output.append(marker.withRoutineNotifyGroup(nil))
            index += 1
            continue
        }
        if let first = open.first,
           first.routineID != returned.routineID || first.routineName != returned.routineName {
            flush()
        }
        open.append((
            marker: marker.withRoutineNotifyGroup(nil),
            update: update.withRoutineNotifyGroup(nil),
            routineID: returned.routineID,
            routineName: returned.routineName
        ))
        index += 2
    }
    flush()
    return output
}

func companionMergedRoutineNotifyReturns(
    existing: [CompanionRoutineNotifyReturn],
    changed: [CompanionRoutineNotifyReturn],
    entries: [TranscriptEntry]
) -> [CompanionRoutineNotifyReturn] {
    var byRun = Dictionary(uniqueKeysWithValues: existing.map { ($0.runID, $0) })
    changed.forEach { byRun[$0.runID] = $0 }
    let eventIDs = Set(entries.map(\.eventID))
    let runIDs = Set(entries.compactMap { $0.routine?.runID })
    return byRun.values.filter {
        eventIDs.contains($0.mainEntryEventID) || runIDs.contains($0.runID)
    }.sorted { $0.runID < $1.runID }
}

public struct CompanionThreadDelta: Codable, Equatable, Sendable {
    public let cursor: String
    public let resetEntries: Bool
    public let changedEntries: [TranscriptEntry]
    public let deletedEventIDs: [String]
    public let thread: CompanionThreadMetadata
    public let hasMore: Bool?
    public let notifyReturns: [CompanionRoutineNotifyReturn]?

    public init(
        cursor: String,
        resetEntries: Bool,
        changedEntries: [TranscriptEntry],
        deletedEventIDs: [String],
        thread: CompanionThreadMetadata,
        hasMore: Bool? = nil,
        notifyReturns: [CompanionRoutineNotifyReturn]? = nil
    ) {
        self.cursor = cursor
        self.resetEntries = resetEntries
        self.changedEntries = changedEntries
        self.deletedEventIDs = deletedEventIDs
        self.thread = thread
        self.hasMore = hasMore
        self.notifyReturns = notifyReturns
    }

    enum CodingKeys: String, CodingKey {
        case cursor
        case resetEntries = "reset_entries"
        case changedEntries = "changed_entries"
        case deletedEventIDs = "deleted_event_ids"
        case thread
        case hasMore = "has_more"
        case notifyReturns = "notify_returns"
    }

    public func applying(to snapshot: CompanionThreadSnapshot?) -> CompanionThreadSnapshot {
        let existingEntries: [TranscriptEntry] = resetEntries
            ? []
            : companionExpandedRoutineNotifyEntries(snapshot?.thread.entries ?? [])
        var entries = Dictionary(
            uniqueKeysWithValues: existingEntries.map { ($0.eventID, $0) }
        )
        deletedEventIDs.forEach { entries[$0] = nil }
        changedEntries.forEach { entries[$0.eventID] = $0 }
        let ordered = entries.values.sorted {
            $0.ordinal == $1.ordinal ? $0.eventID < $1.eventID : $0.ordinal < $1.ordinal
        }
        let mergedNotifyReturns = companionMergedRoutineNotifyReturns(
            existing: resetEntries ? [] : (snapshot?.notifyReturns ?? []),
            changed: notifyReturns ?? [],
            entries: ordered
        )
        return CompanionThreadSnapshot(
            cursor: cursor,
            thread: thread.thread(entries: companionCollapsedRoutineNotifyEntries(
                ordered,
                notifyReturns: mergedNotifyReturns
            )),
            isPartial: resetEntries ? false : (snapshot?.isPartial ?? false),
            olderCursor: snapshot?.olderCursor,
            notifyReturns: mergedNotifyReturns
        )
    }
}

public struct CompanionRoutineNotifyReturn: Codable, Equatable, Sendable {
    public let runID: String
    public let routineID: String
    public let routineName: String
    public let mainEntryEventID: String

    enum CodingKeys: String, CodingKey {
        case runID = "run_id"
        case routineID = "routine_id"
        case routineName = "routine_name"
        case mainEntryEventID = "main_entry_event_id"
    }
}

public struct CompanionThreadWindow: Codable, Equatable, Sendable {
    public let thread: CompanionThreadMetadata
    public let entries: [TranscriptEntry]
    public let olderCursor: String?
    public let syncCursor: String
    public let notifyReturns: [CompanionRoutineNotifyReturn]

    enum CodingKeys: String, CodingKey {
        case thread
        case entries
        case olderCursor = "older_cursor"
        case syncCursor = "sync_cursor"
        case notifyReturns = "notify_returns"
    }

    public func snapshot() -> CompanionThreadSnapshot {
        CompanionThreadSnapshot(
            cursor: syncCursor,
            thread: thread.thread(entries: companionCollapsedRoutineNotifyEntries(
                entries,
                notifyReturns: notifyReturns
            )),
            isPartial: olderCursor != nil,
            olderCursor: olderCursor,
            notifyReturns: notifyReturns
        )
    }
}

public enum CompanionSyncMergeError: Error, Equatable {
    case incompleteRoster
}

public enum CompanionCacheRefreshResult: Equatable, Sendable {
    case newData
    case noData
    case failed
}

func companionMilliseconds(from duration: Duration) -> Double {
    let parts = duration.components
    return (Double(parts.seconds) * 1_000)
        + (Double(parts.attoseconds) / 1_000_000_000_000_000)
}
