import Foundation
import FoundationModels

/// New model ops are refused `busy` at this many retained tasks, whatever the
/// semaphore in Rust thinks, so abandoned work cannot be hidden by healthy replies.
let maxOutstanding = 4

/// Counts model tasks that have started and not yet exited, including tasks abandoned
/// after their wrapper already replied `deadline`. A task still running this long past
/// its deadline means the helper is wedged and it exits 75 for Rust to respawn.
actor Outstanding {
    private var running: [Int: Date] = [:]
    private var abandoned: [Int: Date] = [:]
    private var watchdog: Task<Void, Never>?
    private let abandonMs: Double
    private let onAbandoned: @Sendable (Int, Date) -> Void

    init(
        abandonMs: Double = Outstanding.configuredAbandonMs,
        onAbandoned: @escaping @Sendable (Int, Date) -> Void = exitSeventyFive
    ) {
        self.abandonMs = abandonMs
        self.onAbandoned = onAbandoned
    }

    /// Tests shorten the 30 s recovery deadline through the environment.
    static var configuredAbandonMs: Double {
        guard let raw = ProcessInfo.processInfo.environment["RIMEWARD_HELPER_ABANDON_MS"],
            let value = Double(raw), value > 0
        else { return 30_000 }
        return value
    }

    var count: Int { running.count }

    var abandonedIds: [Int] { abandoned.keys.sorted() }

    func enter(_ id: Int, deadline: Date) { running[id] = deadline }

    func exit(_ id: Int) {
        running[id] = nil
        abandoned[id] = nil
    }

    /// Records a task whose wrapper already replied `deadline`.
    /// ponytail: a task that has not reached `enter` yet is not recorded. The window is
    /// the few microseconds between `Task` creation and its first await, against
    /// deadlines of 100 ms and up. Key the registry off the request instead if that
    /// ever stops holding.
    func abandon(_ id: Int) {
        if let deadline = running[id] { abandoned[id] = deadline }
    }

    func startWatchdog() {
        guard watchdog == nil else { return }
        let interval = Duration.milliseconds(Int(min(1000, max(1, abandonMs / 2))))
        watchdog = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: interval)
                guard let self else { return }
                await self.sweep()
            }
        }
    }

    func stopWatchdog() {
        watchdog?.cancel()
        watchdog = nil
    }

    func sweep() {
        let now = Date()
        for (id, deadline) in abandoned
        where now.timeIntervalSince(deadline) * 1000 >= abandonMs && running[id] != nil {
            onAbandoned(id, deadline)
            return
        }
    }
}

let exitSeventyFive: @Sendable (Int, Date) -> Void = { id, deadline in
    let late = Int(Date().timeIntervalSince(deadline) * 1000)
    logToStderr("id=\(id) abandoned task still running \(late)ms past its deadline, exiting 75")
    exit(75)
}

/// The helper's view of the model. Emits a `state` line on every transition only.
actor ModelState {
    static let ok = "ok"
    static let rateLimited = "rate-limited"
    static let unavailable = "unavailable"

    typealias Sink = @Sendable (StateLine) async -> Void

    private var current = ModelState.ok
    private let sink: Sink

    init(sink: @escaping Sink = { _ in }) { self.sink = sink }

    var model: String { current }

    func note(_ model: String, resetAt: Int64? = nil, outstanding: Int) async {
        guard model != current else { return }
        current = model
        await sink(StateLine(model: model, resetAt: resetAt, outstanding: outstanding))
    }
}

/// Every model op runs through here: the `busy` bound, the retained-work accounting and
/// the deadline race, then the state transitions its outcome implies. `state` is nil for
/// an op whose outcome says nothing about the language model (`embed` runs the Core ML
/// text tower): it still counts and races, but never moves the `state` line.
func runModelOp(
    _ request: Request,
    outstanding: Outstanding,
    state: ModelState?,
    _ body: @escaping @Sendable () async throws -> JSONValue
) async -> Reply {
    let id = request.id
    let deadline = Date(timeIntervalSince1970: Double(request.deadline) / 1000)
    let before = await outstanding.count
    guard before < maxOutstanding else {
        return .fail(id, ErrorCode.busy, detail: "\(before) outstanding", outstanding: before)
    }

    let result = await withDeadline(deadline) {
        await outstanding.enter(id, deadline: deadline)
        // `defer` cannot await, so the exit is written out on both paths. It runs
        // before the race is claimed, so the reply's `outstanding` never counts the
        // op that is replying, and it still runs when an abandoned task finishes late.
        let outcome: Result<JSONValue, any Error>
        do { outcome = .success(try await body()) } catch { outcome = .failure(error) }
        await outstanding.exit(id)
        return try outcome.get()
    }

    switch result {
    case .success(let value):
        await state?.note(ModelState.ok, outstanding: await outstanding.count)
        return .ok(id, value, outstanding: await outstanding.count)
    case .failure(let error):
        switch error.code {
        case ErrorCode.deadline:
            await outstanding.abandon(id)
        case ErrorCode.rateLimited:
            await state?.note(
                ModelState.rateLimited, resetAt: error.resetAt,
                outstanding: await outstanding.count)
        case ErrorCode.unavailable:
            await state?.note(ModelState.unavailable, outstanding: await outstanding.count)
        default:
            break
        }
        return .fail(
            id, error.code, detail: error.detail,
            outstanding: await outstanding.count, resetAt: error.resetAt)
    }
}

/// Throws `unavailable` when Apple Intelligence is off or the assets are missing, so the
/// caller emits the state line and Rust falls back.
func requireModel() throws -> SystemLanguageModel {
    let model = SystemLanguageModel.default
    guard model.isAvailable else {
        throw HelperError(
            ErrorCode.unavailable, detail: String(describing: model.availability))
    }
    return model
}

/// One serial writer for stdout, flushed per line. Logging goes to stderr only.
actor StdoutWriter {
    func emit(_ value: some Encodable) {
        guard let line = try? encodeLine(value) else { return }
        write(line)
    }

    func write(_ line: String) {
        let bytes = Array((line + "\n").utf8)
        var sent = 0
        bytes.withUnsafeBufferPointer { buffer in
            guard let base = buffer.baseAddress else { return }
            while sent < buffer.count {
                let n = Darwin.write(1, base + sent, buffer.count - sent)
                if n <= 0 { break }
                sent += n
            }
        }
    }
}

func logToStderr(_ message: String) {
    FileHandle.standardError.write(Data("blackice-helper: \(message)\n".utf8))
}
