import Foundation
import Testing

@testable import blackice_helper

private func future(_ seconds: Double = 5) -> Int64 {
    epochMs(Date().addingTimeInterval(seconds))
}

private func echo(_ name: String) -> ModelOp {
    { value in .object(["op": .string(name), "in": value ?? .null]) }
}

@Suite struct DispatchTests {
    private let ops = Ops(
        triage: echo("triage"), describe: echo("describe"),
        translate: echo("translate"), document: echo("document"), testOps: true)

    @Test(arguments: ["triage", "describe", "translate", "document"])
    func modelOpsRouteToTheirImplementation(_ op: String) async {
        let reply = await handle(
            Request(id: 11, op: op, deadline: future(), value: .object(["k": .int(1)])),
            outstanding: Outstanding(), ops: ops)
        #expect(reply.error == nil)
        #expect(reply.value?.object?["op"] == .string(op))
        #expect(reply.value?.object?["in"]?.object?["k"] == .int(1))
        #expect(reply.outstanding == 0)
    }

    @Test func aThrownHelperErrorBecomesItsCodeAndDetail() async {
        let reply = await handle(
            Request(id: 12, op: "translate", deadline: future(), value: nil),
            outstanding: Outstanding(),
            ops: Ops(translate: { _ in throw HelperError(ErrorCode.notInstalled, detail: "en->es") })
        )
        #expect(reply.error == ErrorCode.notInstalled)
        #expect(reply.detail == "en->es")
        #expect(reply.value == nil)
    }

    @Test func rateLimitedCarriesResetAtAndEmitsAStateLine() async {
        let lines = Lines()
        let state = ModelState { line in await lines.add(line) }
        let reset = epochMs(Date().addingTimeInterval(60))
        let reply = await handle(
            Request(id: 13, op: "triage", deadline: future(), value: nil),
            outstanding: Outstanding(), state: state,
            ops: Ops(triage: { _ in
                throw HelperError(ErrorCode.rateLimited, detail: "on battery", resetAt: reset)
            })
        )
        #expect(reply.error == ErrorCode.rateLimited)
        #expect(reply.resetAt == reset)
        let emitted = await lines.all
        #expect(emitted.count == 1)
        #expect(emitted.first?.model == ModelState.rateLimited)
        #expect(emitted.first?.resetAt == reset)
    }

    @Test func aWedgedOpRepliesDeadlineAndStaysOutstanding() async {
        let outstanding = Outstanding()
        let finished = Flag()
        let reply = await handle(
            Request(id: 14, op: "sleep", deadline: future(0.15), value: .object(["ms": .int(600)])),
            outstanding: outstanding,
            ops: Ops(
                triage: echo("triage"),
                testOps: true)
        )
        #expect(reply.error == ErrorCode.deadline)
        #expect(reply.outstanding == 1)
        #expect(await outstanding.abandonedIds == [14])

        // The abandoned task still decrements when it finally exits.
        for _ in 0..<100 {
            if await outstanding.count == 0 {
                finished.raise()
                break
            }
            try? await Task.sleep(for: .milliseconds(20))
        }
        #expect(finished.isRaised)
        #expect(await outstanding.abandonedIds == [])
    }

    @Test func sleepIsUnknownWithoutTestOps() async {
        let reply = await handle(
            Request(id: 15, op: "sleep", deadline: future(), value: .object(["ms": .int(1)])),
            outstanding: Outstanding(), ops: Ops())
        #expect(reply.error == ErrorCode.unknownOp)
    }

    @Test func pingAnswersWhileModelWorkIsOutstanding() async {
        let outstanding = Outstanding()
        await outstanding.enter(20, deadline: .distantFuture)
        await outstanding.enter(21, deadline: .distantFuture)
        let reply = await handle(
            Request(id: 16, op: "ping", deadline: 0, value: nil),
            outstanding: outstanding, ops: ops)
        #expect(reply.value == .bool(true))
        #expect(reply.outstanding == 2)
    }

    @Test func aPastDeadlineIsRefusedWithoutRunningTheOp() async {
        let ran = Flag()
        let reply = await handle(
            Request(id: 17, op: "describe", deadline: 1, value: nil),
            outstanding: Outstanding(),
            ops: Ops(describe: { _ in
                ran.raise()
                return .null
            }))
        #expect(reply.error == ErrorCode.deadline)
        #expect(!ran.isRaised)
    }
}
