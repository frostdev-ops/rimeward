import Foundation
import Translation

private let maxTexts = 64
private let maxTextChars = 1000

/// One `TranslationSession(installedSource:target:)` per pair for the process lifetime;
/// building one is the expensive part and `translations(from:)` then batches.
///
/// `TranslationSession` is a non-Sendable class whose `translations(from:)` runs
/// concurrently, so it cannot live in an actor without tripping region isolation. A lock
/// guards the table instead.
/// ponytail: two concurrent calls on the same pair share one session. Callers are
/// latest-wins per consumer, so concurrency per pair is 1. Serialize per pair if that
/// stops holding.
final class TranslationCache: @unchecked Sendable {
    private let lock = NSLock()
    private var sessions: [String: TranslationSession] = [:]

    private func read(_ pair: String) -> TranslationSession? {
        lock.lock()
        defer { lock.unlock() }
        return sessions[pair]
    }

    private func write(_ pair: String, _ session: TranslationSession?) {
        lock.lock()
        defer { lock.unlock() }
        sessions[pair] = session
    }

    func translate(from source: String, to target: String, texts: [String]) async throws -> [String] {
        let pair = "\(source)->\(target)"
        let session: TranslationSession
        if let cached = read(pair) {
            session = cached
        } else {
            let status = await LanguageAvailability().status(
                from: Locale.Language(identifier: source),
                to: Locale.Language(identifier: target))
            guard status == .installed else {
                throw HelperError(ErrorCode.notInstalled, detail: pair)
            }
            session = TranslationSession(
                installedSource: Locale.Language(identifier: source),
                target: Locale.Language(identifier: target))
            write(pair, session)
        }
        do {
            let batch = texts.map { TranslationSession.Request(sourceText: $0) }
            return try await session.translations(from: batch).map(\.targetText)
        } catch {
            // A pack removed after the session was cached comes back as a translation error.
            let mapped = helperError(error)
            guard mapped.code == ErrorCode.notInstalled else { throw mapped }
            write(pair, nil)
            throw HelperError(ErrorCode.notInstalled, detail: pair)
        }
    }
}

let translationCache = TranslationCache()

/// `{epoch, seq, source, target, texts}` -> `{texts}`.
func runTranslate(_ value: JSONValue?) async throws -> JSONValue {
    guard let fields = value?.object,
        let source = fields["source"]?.string, !source.isEmpty,
        let target = fields["target"]?.string, !target.isEmpty,
        let raw = fields["texts"]?.array
    else { throw HelperError(ErrorCode.badRequest, detail: "source, target and texts are required") }
    let texts = raw.compactMap(\.string)
    guard texts.count == raw.count else {
        throw HelperError(ErrorCode.badRequest, detail: "texts must be strings")
    }
    guard texts.count <= maxTexts else {
        throw HelperError(ErrorCode.badRequest, detail: "at most \(maxTexts) texts")
    }
    guard texts.allSatisfy({ $0.count <= maxTextChars }) else {
        throw HelperError(ErrorCode.badRequest, detail: "each text is at most \(maxTextChars) chars")
    }
    guard !texts.isEmpty else { return .object(["texts": .array([])]) }

    let out = try await translationCache.translate(from: source, to: target, texts: texts)
    return .object(["texts": .array(out.map(JSONValue.string))])
}
