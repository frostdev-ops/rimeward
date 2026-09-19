import Foundation

typealias ModelOp = @Sendable (JSONValue?) async throws -> JSONValue

/// The op implementations, injectable so the dispatcher can be tested without a model.
struct Ops: Sendable {
    var capabilities: CapabilitiesProbe = probeCapabilities
    var triage: ModelOp = runTriage
    var describe: ModelOp = runDescribe
    var translate: ModelOp = runTranslate
    var document: ModelOp = runDocument
    var embed: ModelOp = runEmbed
    /// `--test-ops` adds `sleep`, which simulates a wedged model call.
    var testOps = false
}

/// Sleeps without being cancellable on purpose: a wedged model call keeps burning a slot
/// after its deadline was answered, which is exactly what the accounting must survive.
func runTestSleep(_ value: JSONValue?) async throws -> JSONValue {
    guard let ms = value?.object?["ms"]?.int, ms >= 0 else {
        throw HelperError(ErrorCode.badRequest, detail: "ms is required")
    }
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(ms)) {
            continuation.resume()
        }
    }
    return .bool(true)
}

/// Answers one request. `ping` and `capabilities` answer even while model work is wedged;
/// every other op goes through the busy bound, the retained-work count and the deadline.
func handle(
    _ request: Request,
    outstanding: Outstanding,
    state: ModelState = ModelState(),
    ops: Ops = Ops()
) async -> Reply {
    switch request.op {
    case "ping":
        return .ok(request.id, .bool(true), outstanding: await outstanding.count)
    case "capabilities":
        do {
            let value = try await ops.capabilities(request.value)
            return .ok(request.id, value, outstanding: await outstanding.count)
        } catch {
            let mapped = helperError(error)
            return .fail(
                request.id, mapped.code, detail: mapped.detail ?? "\(error)",
                outstanding: await outstanding.count)
        }
    case "triage":
        return await runModelOp(request, outstanding: outstanding, state: state) {
            try await ops.triage(request.value)
        }
    case "describe":
        return await runModelOp(request, outstanding: outstanding, state: state) {
            try await ops.describe(request.value)
        }
    case "translate":
        return await runModelOp(request, outstanding: outstanding, state: state) {
            try await ops.translate(request.value)
        }
    case "document":
        return await runModelOp(request, outstanding: outstanding, state: state) {
            try await ops.document(request.value)
        }
    case "embed":
        // The text tower is not the language model: a missing model directory must not
        // report the Foundation Model unavailable, and a vector must not report it back.
        return await runModelOp(request, outstanding: outstanding, state: nil) {
            try await ops.embed(request.value)
        }
    case "sleep" where ops.testOps:
        return await runModelOp(request, outstanding: outstanding, state: state) {
            try await runTestSleep(request.value)
        }
    default:
        return .fail(
            request.id, ErrorCode.unknownOp,
            detail: request.op, outstanding: await outstanding.count)
    }
}

/// Reads stdin line by line, dispatches each request as its own task so a slow op
/// never blocks `ping`, and writes replies through one serial writer.
/// `{"type":"shutdown"}` or EOF ends the loop; the task group then drains in-flight work.
func runHelper(ops: Ops = Ops()) async {
    let writer = StdoutWriter()
    let outstanding = Outstanding()
    let state = ModelState { line in await writer.emit(line) }
    await outstanding.startWatchdog()
    warmDocuments()
    warmEmbed()

    await withTaskGroup(of: Void.self) { group in
        do {
            for try await line in FileHandle.standardInput.bytes.lines {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if trimmed.isEmpty { continue }
                if decodeControl(trimmed)?.type == "shutdown" { break }
                guard let request = decodeRequest(trimmed) else {
                    logToStderr("id=\(decodeId(trimmed)) bad-request")
                    await writer.emit(
                        Reply.fail(
                            decodeId(trimmed), ErrorCode.badRequest,
                            outstanding: await outstanding.count
                        )
                    )
                    continue
                }
                group.addTask {
                    let started = Date()
                    let reply = await handle(
                        request, outstanding: outstanding, state: state, ops: ops)
                    logToStderr(
                        "id=\(request.id) op=\(request.op) "
                            + "\(reply.error ?? "ok") \(msSince(started))ms "
                            + "outstanding=\(reply.outstanding)")
                    await writer.emit(reply)
                }
            }
        } catch {
            logToStderr("stdin read failed: \(error)")
        }
        // The group drains in-flight replies, each bounded by its own deadline. Rust
        // gives 5 s before it kills; exit 0 inside that whatever is still running.
        Task {
            try? await Task.sleep(for: .seconds(5))
            exit(0)
        }
    }
    await outstanding.stopWatchdog()
}

await runHelper(ops: Ops(testOps: CommandLine.arguments.contains("--test-ops")))
exit(0)
