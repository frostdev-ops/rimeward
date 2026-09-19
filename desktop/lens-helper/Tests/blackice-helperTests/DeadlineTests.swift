import Foundation
import FoundationModels
import Testing
import Translation

@testable import blackice_helper

/// Lets a test observe a losing task without awaiting it.
final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var raised = false

    func raise() {
        lock.lock()
        raised = true
        lock.unlock()
    }

    var isRaised: Bool {
        lock.lock()
        defer { lock.unlock() }
        return raised
    }
}

/// Polls up to `ms` for the flag without ever awaiting the task that raises it.
func waitForFlag(_ flag: Flag, ms: Int = 1000) async {
    for _ in 0..<(ms / 10) {
        if flag.isRaised { return }
        try? await Task.sleep(for: .milliseconds(10))
    }
}

@Suite struct DeadlineTests {
    @Test func fastOpWinsTheRace() async {
        let result = await withDeadline(Date().addingTimeInterval(2)) { 42 }
        #expect(result == .success(42))
    }

    @Test func aThrownHelperErrorSurvivesTheRace() async {
        let result: Result<Int, HelperError> = await withDeadline(Date().addingTimeInterval(2)) {
            throw HelperError(ErrorCode.noVision, detail: "core3")
        }
        #expect(result == .failure(HelperError(ErrorCode.noVision, detail: "core3")))
    }

    @Test func slowOpLosesAndIsCancelledButNeverAwaited() async {
        let cancelled = Flag()
        let started = Date()
        let result: Result<Int, HelperError> = await withDeadline(
            Date().addingTimeInterval(0.15)
        ) {
            do { try await Task.sleep(for: .seconds(5)) } catch {
                cancelled.raise()
                throw error
            }
            return 7
        }
        let elapsed = Date().timeIntervalSince(started)

        #expect(result == .failure(HelperError(ErrorCode.deadline)))
        // deadline + 50 ms
        #expect(elapsed < 0.2, "took \(Int(elapsed * 1000))ms")
        await waitForFlag(cancelled)
        #expect(cancelled.isRaised)
    }

    /// A continuation resumed twice traps and one never resumed hangs the suite, so
    /// finishing with 200 results is the whole assertion. Deadlines of 1 to 5 ms
    /// against ops of 0 to 2 ms make both sides win often.
    @Test func twoHundredConcurrentRacesEachResumeExactlyOnce() async {
        let results = await withTaskGroup(of: Result<Int, HelperError>.self) { group in
            for i in 0..<200 {
                group.addTask {
                    await withDeadline(Date().addingTimeInterval(Double(i % 5 + 1) / 1000)) {
                        try await Task.sleep(for: .milliseconds(i % 3))
                        return i
                    }
                }
            }
            var wins = 0
            var losses = 0
            for await result in group {
                if case .success = result { wins += 1 } else { losses += 1 }
            }
            return (wins, losses)
        }
        #expect(results.0 + results.1 == 200)
        #expect(results.0 > 0 && results.1 > 0, "wins \(results.0) losses \(results.1)")
    }

    @Test func aDeadlineInThePastNeverStartsTheOp() async {
        let ran = Flag()
        let result: Result<Int, HelperError> = await withDeadline(
            Date().addingTimeInterval(-1)
        ) {
            ran.raise()
            return 1
        }
        #expect(result == .failure(HelperError(ErrorCode.deadline, detail: "deadline passed")))
        try? await Task.sleep(for: .milliseconds(50))
        #expect(!ran.isRaised)
    }

    @Test func mapsFrameworkErrorsOntoWireCodes() {
        #expect(helperError(CancellationError()).code == ErrorCode.deadline)
        #expect(helperError(HelperError(ErrorCode.busy)).code == ErrorCode.busy)
        struct Boom: Error {}
        let internalFailure = helperError(Boom())
        #expect(internalFailure.code == ErrorCode.internalFailure)
        #expect(internalFailure.detail?.isEmpty == false)

        let reset = Date().addingTimeInterval(120)
        let limited = helperError(
            LanguageModelError.rateLimited(
                .init(resetDate: reset, debugDescription: "on battery in the background")))
        #expect(limited.code == ErrorCode.rateLimited)
        #expect(limited.resetAt == epochMs(reset))

        // No resetDate on the error: the helper still hands Rust a time to back off to.
        let before = epochMs(Date().addingTimeInterval(59))
        let blind = helperError(
            LanguageModelError.rateLimited(.init(resetDate: nil, debugDescription: "no date")))
        #expect(blind.code == ErrorCode.rateLimited)
        #expect((blind.resetAt ?? 0) >= before)

        let overflow = helperError(
            LanguageModelError.contextSizeExceeded(
                .init(contextSize: 8192, tokenCount: 9001, debugDescription: "too long")))
        #expect(overflow.code == ErrorCode.context)
        #expect(overflow.detail == "9001 tokens > 8192")

        #expect(
            helperError(LanguageModelError.guardrailViolation(.init(debugDescription: "unsafe")))
                .code == ErrorCode.refused)
        #expect(
            helperError(
                LanguageModelError.refusal(.init(explanation: "no", debugDescription: "no")))
                .code == ErrorCode.refused)
        #expect(
            helperError(
                LanguageModelError.unsupportedLanguageOrLocale(
                    .init(languageCode: .init("kl"), debugDescription: "kl")))
                .code == ErrorCode.unavailable)
        #expect(
            helperError(SystemLanguageModel.Error.assetsUnavailable(.init(debugDescription: "off")))
                .code == ErrorCode.unavailable)
        #expect(helperError(TranslationError.notInstalled).code == ErrorCode.notInstalled)
    }
}
