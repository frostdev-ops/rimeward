import Foundation
import FoundationModels
import Translation
import os

/// A helper-protocol failure: the wire `error` code plus the optional `detail` and
/// `reset_at` siblings. Every op throws this; `helperError` maps framework errors onto it.
struct HelperError: Error, Sendable, Equatable {
    var code: String
    var detail: String?
    var resetAt: Int64?

    init(_ code: String, detail: String? = nil, resetAt: Int64? = nil) {
        self.code = code
        self.detail = detail
        self.resetAt = resetAt
    }
}

func epochMs(_ date: Date) -> Int64 { Int64((date.timeIntervalSince1970 * 1000).rounded()) }

func msSince(_ start: Date) -> Int { Int((Date().timeIntervalSince(start) * 1000).rounded()) }

private func short(_ error: any Error) -> String { String(String(describing: error).prefix(200)) }

/// Maps what the frameworks throw onto the wire codes. `LanguageModelSession.GenerationError`
/// is deprecated on macOS 27 in favour of `LanguageModelError`, so only the new type is
/// matched; the deprecated one would build with warnings and is never thrown here.
func helperError(_ error: any Error) -> HelperError {
    if let mine = error as? HelperError { return mine }
    switch error {
    case let modelError as LanguageModelError:
        switch modelError {
        case .rateLimited(let info):
            let reset = info.resetDate ?? Date().addingTimeInterval(60)
            return HelperError(
                ErrorCode.rateLimited, detail: String(info.debugDescription.prefix(200)),
                resetAt: epochMs(reset))
        case .contextSizeExceeded(let info):
            return HelperError(
                ErrorCode.context, detail: "\(info.tokenCount) tokens > \(info.contextSize)")
        case .guardrailViolation, .refusal:
            return HelperError(ErrorCode.refused, detail: short(modelError))
        case .unsupportedLanguageOrLocale, .unsupportedCapability:
            return HelperError(ErrorCode.unavailable, detail: short(modelError))
        case .timeout:
            return HelperError(ErrorCode.deadline, detail: "model timeout")
        default:
            return HelperError(ErrorCode.internalFailure, detail: short(modelError))
        }
    case is SystemLanguageModel.Error:
        return HelperError(ErrorCode.unavailable, detail: short(error))
    case TranslationError.notInstalled, TranslationError.unsupportedLanguagePairing,
        TranslationError.unsupportedSourceLanguage, TranslationError.unsupportedTargetLanguage:
        return HelperError(ErrorCode.notInstalled, detail: short(error))
    case is CancellationError:
        return HelperError(ErrorCode.deadline, detail: "cancelled")
    default:
        return HelperError(ErrorCode.internalFailure, detail: short(error))
    }
}

/// Shared state of the op-versus-deadline race. Whoever claims `done` resumes the
/// continuation and cancels the other task; the loser is never awaited.
private struct Race: Sendable {
    var done = false
    var op: Task<Void, Never>?
    var timer: Task<Void, Never>?
}

/// Runs `op` in an unstructured task and races it against the wall-clock `deadline`.
/// Resumes exactly once with whichever finishes first. A deadline already in the past
/// returns `deadline` without starting the op at all.
func withDeadline<T: Sendable>(
    _ deadline: Date,
    _ op: @escaping @Sendable () async throws -> T
) async -> Result<T, HelperError> {
    let seconds = deadline.timeIntervalSinceNow
    guard seconds > 0 else { return .failure(HelperError(ErrorCode.deadline, detail: "deadline passed")) }

    let race = OSAllocatedUnfairLock(initialState: Race())
    return await withCheckedContinuation { (continuation: CheckedContinuation<Result<T, HelperError>, Never>) in
        let opTask = Task<Void, Never> {
            let outcome: Result<T, HelperError>
            do { outcome = .success(try await op()) } catch { outcome = .failure(helperError(error)) }
            let claim = race.withLock { state -> (Bool, Task<Void, Never>?) in
                if state.done { return (false, nil) }
                state.done = true
                return (true, state.timer)
            }
            guard claim.0 else { return }
            claim.1?.cancel()
            continuation.resume(returning: outcome)
        }
        let timerTask = Task<Void, Never> {
            try? await Task.sleep(until: .now.advanced(by: .seconds(seconds)), clock: .continuous)
            if Task.isCancelled { return }
            let claim = race.withLock { state -> (Bool, Task<Void, Never>?) in
                if state.done { return (false, nil) }
                state.done = true
                return (true, state.op)
            }
            guard claim.0 else { return }
            claim.1?.cancel()
            continuation.resume(returning: .failure(HelperError(ErrorCode.deadline)))
        }
        // The op can finish before these are stored, which would leave the timer
        // uncancelled; close that window here.
        let stillRacing = race.withLock { state -> Bool in
            state.op = opTask
            state.timer = timerTask
            return !state.done
        }
        if !stillRacing {
            timerTask.cancel()
            opTask.cancel()
        }
    }
}
