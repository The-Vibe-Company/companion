import Foundation
import SQLite3

public struct CompanionRosterSnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let cursor: String?
    public let companions: [CompanionSummary]
    public let sections: [CompanionSection]
    public let syncedAt: Date

    public init(
        schemaVersion: Int = Self.currentSchemaVersion,
        cursor: String?,
        companions: [CompanionSummary],
        sections: [CompanionSection],
        syncedAt: Date = .now
    ) {
        self.schemaVersion = schemaVersion
        self.cursor = cursor
        self.companions = companions
        self.sections = sections
        self.syncedAt = syncedAt
    }
}

public struct CompanionThreadSnapshot: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 2

    public let schemaVersion: Int
    public let cursor: String?
    public let thread: CompanionThread
    /// The on-device copy is a bounded tail, not an assertion that older history is complete.
    public let isPartial: Bool
    public let olderCursor: String?
    /// Server evidence used to rebuild collapsed routine-notification disclosures after deltas.
    /// Optional keeps snapshots written by the previous schema readable during app upgrades.
    public let notifyReturns: [CompanionRoutineNotifyReturn]?
    public let syncedAt: Date

    public init(
        schemaVersion: Int = Self.currentSchemaVersion,
        cursor: String?,
        thread: CompanionThread,
        isPartial: Bool = false,
        syncedAt: Date = .now,
        olderCursor: String? = nil,
        notifyReturns: [CompanionRoutineNotifyReturn]? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.cursor = cursor
        self.thread = thread
        self.isPartial = isPartial
        self.syncedAt = syncedAt
        self.olderCursor = olderCursor
        self.notifyReturns = notifyReturns
    }
}

public protocol CompanionSnapshotCache: Sendable {
    func roster(scope: String) throws -> CompanionRosterSnapshot?
    func saveRoster(_ snapshot: CompanionRosterSnapshot, scope: String) throws
    func thread(scope: String, companionID: String) throws -> CompanionThreadSnapshot?
    func saveThread(_ snapshot: CompanionThreadSnapshot, scope: String, companionID: String) throws
    func remove(scope: String) throws
}

extension CompanionThreadSnapshot {
    static let maximumCachedEntryCount = 150

    /// Cached content is presentation-only. A fresh server response is required before any
    /// mutation control can become active again.
    func readOnlyPresentation() -> CompanionThreadSnapshot {
        CompanionThreadSnapshot(
            cursor: cursor,
            thread: thread.copy(
                entries: thread.entries,
                readOnly: true,
                canSend: false
            ),
            isPartial: isPartial,
            syncedAt: syncedAt,
            olderCursor: olderCursor,
            notifyReturns: notifyReturns
        )
    }

    static func bounded(
        cursor: String?,
        thread: CompanionThread,
        isPartial: Bool = false,
        syncedAt: Date = .now,
        olderCursor: String? = nil,
        notifyReturns: [CompanionRoutineNotifyReturn]? = nil
    ) -> Self {
        let sortedEntries = thread.entries.sorted {
            $0.ordinal == $1.ordinal ? $0.eventID < $1.eventID : $0.ordinal < $1.ordinal
        }
        let cachedEntries = Array(sortedEntries.suffix(maximumCachedEntryCount))
        return Self(
            cursor: cursor,
            thread: thread.copy(entries: cachedEntries),
            isPartial: isPartial || cachedEntries.count < sortedEntries.count,
            syncedAt: syncedAt,
            olderCursor: olderCursor,
            notifyReturns: notifyReturns
        )
    }
}

extension CompanionThread {
    func copy(
        entries: [TranscriptEntry],
        readOnly: Bool? = nil,
        canSend: Bool? = nil
    ) -> CompanionThread {
        CompanionThread(
            companionID: companionID,
            viewerID: viewerID,
            readOnly: readOnly ?? self.readOnly,
            canSend: canSend ?? self.canSend,
            transcriptionAvailable: transcriptionAvailable,
            entries: entries,
            activeTurn: activeTurn,
            queuedCount: queuedCount,
            interruptedTurn: interruptedTurn
        )
    }
}

public enum CompanionCacheLocation {
    public static func applicationSupport(
        bundleIdentifier: String = Bundle.main.bundleIdentifier ?? "dev.companion.mobile"
    ) throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = base.appending(path: bundleIdentifier, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var protectedDirectory = directory
        try protectedDirectory.setResourceValues(resourceValues)
        return directory.appending(path: "companion-cache.sqlite3", directoryHint: .notDirectory)
    }
}

public final class SQLiteCompanionSnapshotCache: CompanionSnapshotCache, @unchecked Sendable {
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private static let maximumRosterBytes = 2 * 1_024 * 1_024
    private static let maximumThreadBytes = 8 * 1_024 * 1_024

    private let lock = NSLock()
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder
    private var database: OpaquePointer?

    public init(url: URL) throws {
        encoder = JSONEncoder()
        decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .millisecondsSince1970
        decoder.dateDecodingStrategy = .millisecondsSince1970

        var connection: OpaquePointer?
        let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(url.path, &connection, flags, nil) == SQLITE_OK,
              let connection else {
            if let connection { sqlite3_close(connection) }
            throw CacheError.open
        }
        database = connection
        do {
            try execute("PRAGMA journal_mode=WAL")
            try execute("PRAGMA synchronous=NORMAL")
            try execute("PRAGMA busy_timeout=1000")
            try execute("""
                CREATE TABLE IF NOT EXISTS roster_snapshots (
                    scope TEXT PRIMARY KEY NOT NULL,
                    payload BLOB NOT NULL
                )
                """)
            try execute("""
                CREATE TABLE IF NOT EXISTS thread_snapshots (
                    scope TEXT NOT NULL,
                    companion_id TEXT NOT NULL,
                    payload BLOB NOT NULL,
                    PRIMARY KEY (scope, companion_id)
                )
                """)
        } catch {
            sqlite3_close(connection)
            database = nil
            throw error
        }
    }

    deinit {
        if let database { sqlite3_close(database) }
    }

    public func roster(scope: String) throws -> CompanionRosterSnapshot? {
        guard let snapshot: CompanionRosterSnapshot = try read(
            "SELECT payload FROM roster_snapshots WHERE scope = ? LIMIT 1",
            bindings: [scope],
            as: CompanionRosterSnapshot.self
        ), snapshot.schemaVersion == CompanionRosterSnapshot.currentSchemaVersion else { return nil }
        return snapshot
    }

    public func saveRoster(_ snapshot: CompanionRosterSnapshot, scope: String) throws {
        let payload = try encoder.encode(snapshot)
        guard payload.count <= Self.maximumRosterBytes else { throw CacheError.tooLarge }
        try write(
            """
            INSERT INTO roster_snapshots(scope, payload) VALUES (?, ?)
            ON CONFLICT(scope) DO UPDATE SET payload = excluded.payload
            """,
            bindings: [scope],
            payload: payload
        )
    }

    public func thread(scope: String, companionID: String) throws -> CompanionThreadSnapshot? {
        guard let snapshot: CompanionThreadSnapshot = try read(
            "SELECT payload FROM thread_snapshots WHERE scope = ? AND companion_id = ? LIMIT 1",
            bindings: [scope, companionID],
            as: CompanionThreadSnapshot.self
        ), snapshot.schemaVersion == CompanionThreadSnapshot.currentSchemaVersion else { return nil }
        return snapshot
    }

    public func saveThread(
        _ snapshot: CompanionThreadSnapshot,
        scope: String,
        companionID: String
    ) throws {
        let persistedSnapshot = CompanionThreadSnapshot.bounded(
            cursor: snapshot.cursor,
            thread: snapshot.thread,
            isPartial: snapshot.isPartial,
            syncedAt: snapshot.syncedAt,
            olderCursor: snapshot.olderCursor,
            notifyReturns: snapshot.notifyReturns
        )
        let payload = try encoder.encode(persistedSnapshot)
        guard payload.count <= Self.maximumThreadBytes else { throw CacheError.tooLarge }
        try write(
            """
            INSERT INTO thread_snapshots(scope, companion_id, payload) VALUES (?, ?, ?)
            ON CONFLICT(scope, companion_id) DO UPDATE SET payload = excluded.payload
            """,
            bindings: [scope, companionID],
            payload: payload
        )
    }

    public func remove(scope: String) throws {
        lock.lock()
        defer { lock.unlock() }
        try executePrepared("BEGIN IMMEDIATE")
        do {
            try executePrepared("DELETE FROM thread_snapshots WHERE scope = ?", bindings: [scope])
            try executePrepared("DELETE FROM roster_snapshots WHERE scope = ?", bindings: [scope])
            try executePrepared("COMMIT")
        } catch {
            try? executePrepared("ROLLBACK")
            throw error
        }
    }

    private func read<Value: Decodable>(
        _ sql: String,
        bindings: [String],
        as type: Value.Type
    ) throws -> Value? {
        let payload: Data?
        lock.lock()
        do {
            guard let database else { throw CacheError.closed }
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
                  let statement else { throw error(for: database) }
            defer { sqlite3_finalize(statement) }
            try bind(bindings, to: statement)
            switch sqlite3_step(statement) {
            case SQLITE_DONE:
                payload = nil
            case SQLITE_ROW:
                guard let bytes = sqlite3_column_blob(statement, 0) else { throw CacheError.corrupt }
                let count = Int(sqlite3_column_bytes(statement, 0))
                payload = Data(bytes: bytes, count: count)
            default:
                throw error(for: database)
            }
            lock.unlock()
        } catch {
            lock.unlock()
            throw error
        }
        return try payload.map { try decoder.decode(type, from: $0) }
    }

    private func write(_ sql: String, bindings: [String], payload: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let database else { throw CacheError.closed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else { throw error(for: database) }
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        let payloadIndex = Int32(bindings.count + 1)
        let result = payload.withUnsafeBytes { buffer in
            sqlite3_bind_blob(statement, payloadIndex, buffer.baseAddress, Int32(buffer.count), Self.transient)
        }
        guard result == SQLITE_OK else { throw error(for: database) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw error(for: database) }
    }

    private func bind(_ bindings: [String], to statement: OpaquePointer) throws {
        for (offset, value) in bindings.enumerated() {
            guard sqlite3_bind_text(
                statement,
                Int32(offset + 1),
                value,
                -1,
                Self.transient
            ) == SQLITE_OK else { throw CacheError.bind }
        }
    }

    private func execute(_ sql: String) throws {
        guard let database else { throw CacheError.closed }
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw error(for: database)
        }
    }

    private func executePrepared(_ sql: String, bindings: [String] = []) throws {
        guard let database else { throw CacheError.closed }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else { throw error(for: database) }
        defer { sqlite3_finalize(statement) }
        try bind(bindings, to: statement)
        guard sqlite3_step(statement) == SQLITE_DONE else { throw error(for: database) }
    }

    private func error(for database: OpaquePointer) -> CacheError {
        CacheError.sqlite(String(cString: sqlite3_errmsg(database)))
    }

    public enum CacheError: Error, Equatable {
        case open
        case closed
        case bind
        case corrupt
        case tooLarge
        case sqlite(String)
    }
}
