import Foundation

public let companionMessageAttachmentMaximumCount = 5
public let companionAttachmentMaximumBytes = 10 * 1_024 * 1_024

public enum CompanionAttachmentContentType: String, Codable, CaseIterable, Equatable, Sendable {
    case png = "image/png"
    case jpeg = "image/jpeg"
    case webP = "image/webp"
    case gif = "image/gif"
    case pdf = "application/pdf"
    case csv = "text/csv"
    case text = "text/plain"
    case markdown = "text/markdown"
    case json = "application/json"

    public var isImage: Bool {
        switch self {
        case .png, .jpeg, .webP, .gif: true
        case .pdf, .csv, .text, .markdown, .json: false
        }
    }

    public var preferredFilenameExtension: String {
        switch self {
        case .png: "png"
        case .jpeg: "jpg"
        case .webP: "webp"
        case .gif: "gif"
        case .pdf: "pdf"
        case .csv: "csv"
        case .text: "txt"
        case .markdown: "md"
        case .json: "json"
        }
    }
}

public struct CompanionAttachment: Codable, Identifiable, Equatable, Sendable {
    public enum Kind: String, Codable, Equatable, Sendable {
        case userUpload = "user_upload"
        case piOutput = "pi_output"
    }

    public let id: String
    public let kind: Kind
    public let contentType: CompanionAttachmentContentType
    public let byteSize: Int
    public let filename: String
    public let position: Int
    public let availability: Availability
    public let expiresAt: String?

    public enum Availability: String, Codable, Equatable, Sendable {
        case available
        case expired
    }

    enum CodingKeys: String, CodingKey {
        case id
        case kind
        case contentType = "content_type"
        case byteSize = "byte_size"
        case filename
        case position
        case availability
        case expiresAt = "expires_at"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(Kind.self, forKey: .kind)
        contentType = try container.decode(CompanionAttachmentContentType.self, forKey: .contentType)
        byteSize = try container.decode(Int.self, forKey: .byteSize)
        filename = try container.decode(String.self, forKey: .filename)
        position = try container.decode(Int.self, forKey: .position)
        availability = try container.decodeIfPresent(Availability.self, forKey: .availability)
            ?? .available
        expiresAt = try container.decodeIfPresent(String.self, forKey: .expiresAt)
    }
}

public enum CompanionMessageAttachmentError: Error, LocalizedError, Equatable, Sendable {
    case empty
    case tooMany
    case tooLarge
    case unsupportedType

    public var errorDescription: String? {
        switch self {
        case .empty:
            "This file is empty."
        case .tooMany:
            "You can attach up to five files."
        case .tooLarge:
            "Each file must be 10 MB or smaller."
        case .unsupportedType:
            "Choose a PNG, JPEG, WebP, GIF, PDF, CSV, text, Markdown, or JSON file."
        }
    }
}

/// One file staged for a native send. The API repeats the validation and derives the stored type
/// from these bytes; keeping the same rules here makes refusals immediate without weakening that
/// server boundary.
public struct CompanionMessageAttachment: Identifiable, Equatable, Sendable {
    public let id: UUID
    public let data: Data
    public let filename: String
    public let contentType: CompanionAttachmentContentType

    public var byteSize: Int { data.count }

    public init(
        id: UUID = UUID(),
        data: Data,
        filename: String,
        declaredContentType: String? = nil
    ) throws {
        guard !data.isEmpty else { throw CompanionMessageAttachmentError.empty }
        guard data.count <= companionAttachmentMaximumBytes else {
            throw CompanionMessageAttachmentError.tooLarge
        }
        guard let contentType = Self.resolvedContentType(
            data: data,
            filename: filename,
            declaredContentType: declaredContentType
        ) else {
            throw CompanionMessageAttachmentError.unsupportedType
        }
        self.id = id
        self.data = data
        let suppliedName = filename.isEmpty ? "file" : filename
        self.filename = URL(fileURLWithPath: suppliedName).pathExtension.isEmpty
            ? "\(suppliedName).\(contentType.preferredFilenameExtension)"
            : suppliedName
        self.contentType = contentType
    }

    private static func resolvedContentType(
        data: Data,
        filename: String,
        declaredContentType: String?
    ) -> CompanionAttachmentContentType? {
        let bytes = [UInt8](data.prefix(12))
        if bytes.starts(with: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) { return .png }
        if bytes.starts(with: [0xff, 0xd8, 0xff]) { return .jpeg }
        if bytes.count >= 12,
           Array(bytes[0..<4]) == [0x52, 0x49, 0x46, 0x46],
           Array(bytes[8..<12]) == [0x57, 0x45, 0x42, 0x50] { return .webP }
        if bytes.starts(with: Array("GIF87a".utf8)) || bytes.starts(with: Array("GIF89a".utf8)) {
            return .gif
        }
        if bytes.starts(with: Array("%PDF-".utf8)) { return .pdf }

        guard let declared = declaredType(filename: filename, mimeType: declaredContentType),
              !declared.isImage,
              declared != .pdf,
              isAllowedUTF8Text(data) else { return nil }
        return declared
    }

    private static func declaredType(
        filename: String,
        mimeType: String?
    ) -> CompanionAttachmentContentType? {
        if let mimeType {
            let normalized = mimeType.split(separator: ";", maxSplits: 1).first?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            if let normalized, let type = CompanionAttachmentContentType(rawValue: normalized) {
                return type
            }
        }
        switch URL(fileURLWithPath: filename).pathExtension.lowercased() {
        case "png": return .png
        case "jpg", "jpeg": return .jpeg
        case "webp": return .webP
        case "gif": return .gif
        case "pdf": return .pdf
        case "csv": return .csv
        case "txt": return .text
        case "md", "markdown": return .markdown
        case "json": return .json
        default: return nil
        }
    }

    private static func isAllowedUTF8Text(_ data: Data) -> Bool {
        guard String(data: data, encoding: .utf8) != nil else { return false }
        return !data.contains { byte in
            byte == 0x7f || (byte < 0x20 && byte != 0x09 && byte != 0x0a && byte != 0x0d)
        }
    }
}
