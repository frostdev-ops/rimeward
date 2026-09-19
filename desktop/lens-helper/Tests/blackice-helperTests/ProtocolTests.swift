import Foundation
import Testing

@testable import blackice_helper

private func reparse(_ value: some Encodable) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: Data(try encodeLine(value).utf8))
}

@Suite struct ProtocolCodec {
    @Test func requestRoundTripsWithValue() throws {
        let request = Request(
            id: 3, op: "describe", deadline: 1_758_120_003_000,
            value: .object([
                "epoch": .int(7),
                "ref": .string("f-7-298"),
                "scale": .double(0.5),
                "flags": .array([.bool(true), .null]),
            ])
        )
        #expect(decodeRequest(try encodeLine(request)) == request)
    }

    @Test func requestRoundTripsWithoutValue() throws {
        let request = Request(id: 5, op: "ping", deadline: 0, value: nil)
        let decoded = decodeRequest(try encodeLine(request))
        #expect(decoded == request)
        #expect(decoded?.value == nil)
        #expect(try reparse(request).object?["value"] == nil)
    }

    @Test func replyWithValueOmitsError() throws {
        let reply = Reply.ok(2, .object(["yes": .bool(true), "ms": .int(312)]), outstanding: 1)
        let json = try reparse(reply).object
        #expect(json?["id"] == .int(2))
        #expect(json?["outstanding"] == .int(1))
        #expect(json?["value"]?.object?["ms"] == .int(312))
        #expect(json?["error"] == nil)
        #expect(json?["detail"] == nil)
        #expect(try JSONDecoder().decode(Reply.self, from: Data(try encodeLine(reply).utf8)) == reply)
    }

    @Test func replyWithErrorAndDetail() throws {
        let reply = Reply.fail(4, ErrorCode.notInstalled, detail: "en->es", outstanding: 0)
        let json = try reparse(reply).object
        #expect(json?["error"] == .string("not-installed"))
        #expect(json?["detail"] == .string("en->es"))
        #expect(json?["value"] == nil)
        #expect(try JSONDecoder().decode(Reply.self, from: Data(try encodeLine(reply).utf8)) == reply)
    }

    @Test func stateLineRoundTrips() throws {
        let state = StateLine(model: "rate-limited", resetAt: 1_758_120_060_000, outstanding: 2)
        let json = try reparse(state).object
        #expect(json?["type"] == .string("state"))
        #expect(json?["model"] == .string("rate-limited"))
        #expect(json?["reset_at"] == .int(1_758_120_060_000))
        #expect(json?["outstanding"] == .int(2))
        #expect(try JSONDecoder().decode(StateLine.self, from: Data(try encodeLine(state).utf8)) == state)

        let ok = StateLine(model: "ok", resetAt: nil, outstanding: 0)
        #expect(try reparse(ok).object?["reset_at"] == nil)
    }

    @Test func malformedLinesAreRejectedAndKeepTheirId() {
        #expect(decodeRequest("not json at all") == nil)
        #expect(decodeRequest("{\"id\":9,\"op\":\"ping\"}") == nil)  // no deadline
        #expect(decodeId("{\"id\":9,\"op\":\"ping\"}") == 9)
        #expect(decodeId("{\"op\":\"ping\"}") == 0)
        #expect(decodeId("garbage") == 0)
    }

    @Test func shutdownIsRecognisedAndRequestsAreNot() {
        #expect(decodeControl("{\"type\":\"shutdown\"}")?.type == "shutdown")
        #expect(decodeControl("{\"id\":1,\"op\":\"ping\",\"deadline\":0}") == nil)
    }

    @Test func requestedPairsReadsTheValue() {
        let value = JSONValue.object([
            "pairs": .array([
                .array([.string("en"), .string("es")]),
                .array([.string("fr")]),
            ])
        ])
        #expect(requestedPairs(value) == [["en", "es"]])
        #expect(requestedPairs(nil) == nil)
        #expect(requestedPairs(.object([:])) == nil)
    }
}

@Suite struct Dispatcher {
    private let probe: CapabilitiesProbe = { value in
        .object(["echo": value ?? .null])
    }

    @Test func pingReplies() async {
        let reply = await handle(
            Request(id: 1, op: "ping", deadline: 0, value: nil),
            outstanding: Outstanding(), ops: Ops(capabilities: probe)
        )
        #expect(reply == Reply.ok(1, .bool(true), outstanding: 0))
    }

    @Test func unknownOpReplies() async {
        let reply = await handle(
            Request(id: 2, op: "teleport", deadline: 0, value: nil),
            outstanding: Outstanding(), ops: Ops(capabilities: probe)
        )
        #expect(reply.error == ErrorCode.unknownOp)
        #expect(reply.value == nil)
        #expect(reply.id == 2)
    }

    @Test func capabilitiesUsesTheInjectedProbe() async {
        let reply = await handle(
            Request(id: 3, op: "capabilities", deadline: 0, value: .object(["pairs": .array([])])),
            outstanding: Outstanding(), ops: Ops(capabilities: probe)
        )
        #expect(reply.error == nil)
        #expect(reply.value?.object?["echo"]?.object?["pairs"] == .array([]))
    }

    @Test func aThrowingProbeBecomesInternal() async {
        struct Boom: Error {}
        let reply = await handle(
            Request(id: 4, op: "capabilities", deadline: 0, value: nil),
            outstanding: Outstanding(), ops: Ops(capabilities: { _ in throw Boom() })
        )
        #expect(reply.error == ErrorCode.internalFailure)
        #expect(reply.detail?.isEmpty == false)
    }

    @Test func outstandingCountsUpAndDown() async {
        let outstanding = Outstanding()
        await outstanding.enter(101, deadline: .distantFuture)
        await outstanding.enter(102, deadline: .distantFuture)
        let reply = await handle(
            Request(id: 5, op: "ping", deadline: 0, value: nil),
            outstanding: outstanding, ops: Ops(capabilities: probe)
        )
        #expect(reply.outstanding == 2)
        await outstanding.exit(101)
        await outstanding.exit(102)
        await outstanding.exit(103)
        #expect(await outstanding.count == 0)
    }
}

@Suite struct HelperBinary {
    /// `Tests/blackice-helperTests/ProtocolTests.swift` -> the package root -> the debug build.
    private var binary: URL? {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent(".build/debug/blackice-helper")
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    @Test func answersPingAndCapabilitiesThenExitsZero() throws {
        guard let binary else {
            Issue.record("blackice-helper binary not found next to the test bundle; skipping")
            return
        }
        let process = Process()
        process.executableURL = binary
        let input = Pipe()
        let output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        try process.run()
        input.fileHandleForWriting.write(
            Data(
                """
                {"id":1,"op":"ping","deadline":0}
                {"id":2,"op":"capabilities","deadline":0}
                {"id":3,"op":"teleport","deadline":0}
                nonsense
                {"type":"shutdown"}

                """.utf8))
        try input.fileHandleForWriting.close()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        #expect(process.terminationStatus == 0)

        let replies = String(decoding: data, as: UTF8.self)
            .split(separator: "\n")
            .compactMap { try? JSONDecoder().decode(Reply.self, from: Data($0.utf8)) }
        #expect(replies.count == 4)

        let byId = Dictionary(uniqueKeysWithValues: replies.map { ($0.id, $0) })
        #expect(byId[1]?.value == .bool(true))
        #expect(byId[3]?.error == ErrorCode.unknownOp)
        #expect(byId[0]?.error == ErrorCode.badRequest)

        let model = byId[2]?.value?.object?["model"]?.object
        #expect(model?["available"]?.bool != nil)
        #expect(model?["vision"]?.bool != nil)
        #expect(model?["contextSize"]?.int != nil)
        #expect(byId[2]?.value?.object?["translation"]?.array != nil)
        #expect(byId[2]?.value?.object?["embedding"]?.bool != nil)
    }
}
