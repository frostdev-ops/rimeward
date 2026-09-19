import Foundation

/// Error codes the helper may return. Rust maps these onto `desktop` op errors.
enum ErrorCode {
    static let rateLimited = "rate-limited"
    static let deadline = "deadline"
    static let busy = "busy"
    static let unavailable = "unavailable"
    static let noVision = "no-vision"
    static let notInstalled = "not-installed"
    static let context = "context"
    static let refused = "refused"
    static let internalFailure = "internal"
    static let unknownOp = "unknown-op"
    static let badRequest = "bad-request"
}

/// Arbitrary JSON, so `value` can carry whatever an op needs.
enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    var bool: Bool? { if case .bool(let v) = self { return v } else { return nil } }
    var int: Int? { if case .int(let v) = self { return v } else { return nil } }
    var string: String? { if case .string(let v) = self { return v } else { return nil } }
    var array: [JSONValue]? { if case .array(let v) = self { return v } else { return nil } }
    var object: [String: JSONValue]? { if case .object(let v) = self { return v } else { return nil } }
}

extension JSONValue: Codable {
    init(from decoder: any Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .double(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value") }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .int(let v): try c.encode(v)
        case .double(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }
}

struct Request: Codable, Sendable, Equatable {
    var id: Int
    var op: String
    /// Absolute epoch milliseconds. Unused in M0; the deadline race lands in M2.
    var deadline: Int64
    var value: JSONValue?
}

struct Reply: Codable, Sendable, Equatable {
    var id: Int
    var value: JSONValue?
    var error: String?
    var detail: String?
    /// Sibling of `rate-limited`: when the model says it will accept work again.
    var resetAt: Int64?
    var outstanding: Int

    enum CodingKeys: String, CodingKey {
        case id, value, error, detail, outstanding
        case resetAt = "reset_at"
    }

    static func ok(_ id: Int, _ value: JSONValue, outstanding: Int) -> Reply {
        Reply(id: id, value: value, error: nil, detail: nil, resetAt: nil, outstanding: outstanding)
    }

    static func fail(
        _ id: Int, _ code: String, detail: String? = nil, outstanding: Int,
        resetAt: Int64? = nil
    ) -> Reply {
        Reply(
            id: id, value: nil, error: code, detail: detail, resetAt: resetAt,
            outstanding: outstanding)
    }
}

/// Unsolicited line the helper pushes when the model's state changes.
struct StateLine: Codable, Sendable, Equatable {
    var type = "state"
    var model: String
    var resetAt: Int64?
    var outstanding: Int

    enum CodingKeys: String, CodingKey {
        case type, model, outstanding
        case resetAt = "reset_at"
    }
}

/// Non-request lines on stdin, e.g. `{"type":"shutdown"}`.
struct ControlLine: Decodable, Sendable {
    var type: String
}

private struct IdOnly: Decodable { var id: Int? }

func encodeLine(_ value: some Encodable) throws -> String {
    String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
}

func decodeRequest(_ line: String) -> Request? {
    try? JSONDecoder().decode(Request.self, from: Data(line.utf8))
}

func decodeControl(_ line: String) -> ControlLine? {
    try? JSONDecoder().decode(ControlLine.self, from: Data(line.utf8))
}

/// Best-effort id recovery so a malformed request can still be answered by id.
func decodeId(_ line: String) -> Int {
    (try? JSONDecoder().decode(IdOnly.self, from: Data(line.utf8)))?.id ?? 0
}
