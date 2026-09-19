import Foundation
import Testing

@testable import blackice_helper

private func future(_ seconds: Double = 5) -> Int64 {
    epochMs(Date().addingTimeInterval(seconds))
}

@Suite struct OutstandingTests {
    @Test func entersAndExitsById() async {
        let outstanding = Outstanding()
        await outstanding.enter(1, deadline: .distantFuture)
        await outstanding.enter(2, deadline: .distantFuture)
        #expect(await outstanding.count == 2)
        await outstanding.exit(1)
        await outstanding.exit(2)
        await outstanding.exit(3)  // unknown id is a no-op
        #expect(await outstanding.count == 0)
    }

    @Test func abandonRecordsOnlyRunningTasksAndExitClearsThem() async {
        let outstanding = Outstanding()
        await outstanding.abandon(9)
        #expect(await outstanding.abandonedIds == [])

        await outstanding.enter(9, deadline: Date())
        await outstanding.abandon(9)
        #expect(await outstanding.abandonedIds == [9])

        await outstanding.exit(9)
        #expect(await outstanding.abandonedIds == [])
        #expect(await outstanding.count == 0)
    }

    @Test func watchdogFiresForATaskStillRunningPastTheThreshold() async {
        let fired = Flag()
        let outstanding = Outstanding(abandonMs: 200) { _, _ in fired.raise() }
        await outstanding.enter(4, deadline: Date())
        await outstanding.abandon(4)
        await outstanding.startWatchdog()
        await waitForFlag(fired, ms: 2000)
        await outstanding.stopWatchdog()
        #expect(fired.isRaised)
    }

    @Test func watchdogLeavesHealthyWorkAlone() async {
        let fired = Flag()
        let outstanding = Outstanding(abandonMs: 100) { _, _ in fired.raise() }
        await outstanding.enter(5, deadline: Date().addingTimeInterval(5))
        await outstanding.startWatchdog()
        try? await Task.sleep(for: .milliseconds(400))
        await outstanding.stopWatchdog()
        #expect(!fired.isRaised)
    }

    @Test func modelOpsAreRefusedBusyAtFourOutstanding() async {
        let outstanding = Outstanding()
        for id in 100..<(100 + maxOutstanding) {
            await outstanding.enter(id, deadline: .distantFuture)
        }
        let ran = Flag()
        let reply = await handle(
            Request(id: 1, op: "triage", deadline: future(), value: .object([:])),
            outstanding: outstanding,
            ops: Ops(triage: { _ in
                ran.raise()
                return .bool(true)
            })
        )
        #expect(reply.error == ErrorCode.busy)
        #expect(reply.outstanding == maxOutstanding)
        #expect(!ran.isRaised)
    }

    @Test func aStateLineIsEmittedOnTransitionsOnly() async {
        let lines = Lines()
        let state = ModelState { line in await lines.add(line) }
        await state.note(ModelState.ok, outstanding: 0)  // already ok
        await state.note(ModelState.rateLimited, resetAt: 1_758_120_060_000, outstanding: 2)
        await state.note(ModelState.rateLimited, resetAt: 1_758_120_060_000, outstanding: 3)
        await state.note(ModelState.ok, outstanding: 1)
        let emitted = await lines.all
        #expect(emitted.count == 2)
        #expect(emitted.first?.model == ModelState.rateLimited)
        #expect(emitted.first?.resetAt == 1_758_120_060_000)
        #expect(emitted.last?.model == ModelState.ok)
    }
}

actor Lines {
    private(set) var all: [StateLine] = []
    func add(_ line: StateLine) { all.append(line) }
}
