import Foundation
import Testing

@testable import blackice_helper

/// `~/Library/Caches/rimeward-models`, which `npm run models:fetch` fills and which
/// `npm run helper:test` runs first. The model tests say so and pass when it is missing:
/// hosted CI has no 85 MB of weights.
private let modelsRoot: URL = {
    if let override = ProcessInfo.processInfo.environment["RIMEWARD_MODELS_CACHE"],
        !override.isEmpty
    {
        return URL(fileURLWithPath: override)
    }
    return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("rimeward-models", isDirectory: true)
}()

private func modelFiles(_ what: String) -> ModelFiles? {
    guard let files = ModelFiles(models: modelsRoot) else {
        print("skipping \(what): no model in \(modelsRoot.path); run `npm run models:fetch`")
        return nil
    }
    return files
}

private func future(_ seconds: Double = 5) -> Int64 {
    epochMs(Date().addingTimeInterval(seconds))
}

private func errorCode(_ value: JSONValue?, _ embedder: TextEmbedder) async -> String? {
    do {
        _ = try await embedTexts(value, with: embedder)
        return nil
    } catch let error as HelperError {
        return error.code
    } catch {
        return "\(error)"
    }
}

private func doubles(_ value: JSONValue?) -> [Double] {
    (value?.array ?? []).compactMap {
        if case .double(let d) = $0 { return d }
        if case .int(let i) = $0 { return Double(i) }
        return nil
    }
}

private func dot(_ a: [Double], _ b: [Double]) -> Double {
    zip(a, b).reduce(0) { $0 + $1.0 * $1.1 }
}

/// The reference ids, from open_clip's CLIP BPE tokenizer through `<|endoftext|>`; the
/// rest of every row is zero padding to 77. The last case is 400 characters: the tokens
/// are cut so the end token is still the last one.
private let fixture: [(text: String, ids: [Int])] = [
    ("a build error appeared", [49406, 320, 3289, 12097, 11561, 49407]),
    (
        "error[E0308]: mismatched types",
        [49406, 12097, 314, 324, 271, 274, 271, 279, 21641, 866, 17792, 7543, 49407]
    ),
    ("Passwords do not match", [49406, 43095, 818, 783, 2439, 49407]),
    (
        "Ln 214, Col 9  Spaces: 2  UTF-8  LF  TypeScript",
        [
            49406, 18654, 273, 272, 275, 267, 9371, 280, 9006, 281, 273, 1419, 325, 268,
            279, 22078, 15673, 8374, 49407,
        ]
    ),
    (
        "\u{2716} compilation failed after 4.2s",
        [49406, 1508, 500, 20446, 8314, 953, 275, 269, 273, 338, 49407]
    ),
    (
        "Reminder for \"send the calibration numbers\"",
        [49406, 5565, 556, 257, 3625, 518, 32597, 656, 6121, 257, 49407]
    ),
    ("", [49406, 49407]),
    (
        String(repeating: "x", count: 400),
        [49406] + Array(repeating: 32035, count: 75) + [49407]
    ),
    // Beyond the eight, the ftfy clean open_clip applies first (`CLIPTokenizer.clean`):
    // a decomposed accent, fullwidth punctuation around CJK, an emoji, curly quotes, a
    // ligature with fullwidth ASCII, and halfwidth katakana. Ids from the same reference.
    ("cafe\u{301} au lait", [49406, 15304, 2566, 572, 585, 49407]),
    (
        "\u{9519}\u{8BEF}\u{FF1A}\u{7F16}\u{8BD1}\u{5931}\u{8D25}\u{FF0C}\u{8BF7}\u{68C0}\u{67E5}\u{4EE3}\u{7801}",
        [
            49406, 165, 242, 247, 164, 107, 363, 281, 163, 120, 244, 164, 107, 239, 23170,
            109, 164, 112, 354, 267, 164, 107, 115, 162, 96, 222, 162, 253, 98, 37743, 96,
            163, 254, 479, 49407,
        ]
    ),
    (
        "deploy finished \u{1F680} all green \u{2705}",
        [49406, 26944, 3078, 13542, 615, 1901, 5564, 49407]
    ),
    (
        "\u{201C}Build failed\u{201D} \u{2014} it\u{2019}s done",
        [49406, 257, 3289, 8314, 257, 2005, 585, 568, 1700, 49407]
    ),
    (
        "\u{FB01}le not found in \u{FF28}\u{FF34}\u{FF2D}\u{FF2C}",
        [49406, 4512, 783, 1546, 530, 18231, 49407]
    ),
    (
        "\u{30C6}\u{30B9}\u{30C8} \u{FF83}\u{FF7D}\u{FF84}",
        [49406, 2429, 228, 32421, 486, 2429, 228, 32421, 486, 49407]
    ),
]

@Suite struct Tokenizer {
    @Test func theIdsMatchTheReferenceTokenizer() throws {
        guard let files = modelFiles("tokenizer fixture") else { return }
        let tokenizer = try CLIPTokenizer(vocabURL: files.vocab, mergesURL: files.merges)
        for item in fixture {
            let ids = tokenizer.encode_full(text: item.text)
            let label = String(item.text.prefix(40))
            #expect(ids.count == 77, "\(label)")
            #expect(Array(ids.prefix(item.ids.count)) == item.ids, "\(label)")
            #expect(ids.dropFirst(item.ids.count).allSatisfy { $0 == 0 }, "\(label)")
        }
    }
}

@Suite struct Embed {
    @Test func embedRoutesToItsImplementation() async {
        let reply = await handle(
            Request(
                id: 31, op: "embed", deadline: future(),
                value: .object(["texts": .array([.string("a build error appeared")])])),
            outstanding: Outstanding(),
            ops: Ops(embed: { value in .object(["op": .string("embed"), "in": value ?? .null]) })
        )
        #expect(reply.error == nil)
        #expect(reply.value?.object?["op"] == .string("embed"))
        #expect(
            reply.value?.object?["in"]?.object?["texts"]?.array
                == [.string("a build error appeared")])
    }

    /// The text tower is not the language model: an `embed` that fails must not report
    /// the Foundation Model unavailable, and one that succeeds must not report it back.
    @Test func embedNeverTouchesTheLanguageModelState() async {
        let lines = Lines()
        let state = ModelState { line in await lines.add(line) }
        let texts = JSONValue.object(["texts": .array([.string("x")])])
        _ = await handle(
            Request(id: 32, op: "embed", deadline: future(), value: texts),
            outstanding: Outstanding(), state: state,
            ops: Ops(embed: { _ in
                throw HelperError(ErrorCode.unavailable, detail: "no model directory")
            }))
        #expect(await lines.all.isEmpty)
        _ = await handle(
            Request(id: 33, op: "triage", deadline: future(), value: nil),
            outstanding: Outstanding(), state: state,
            ops: Ops(triage: { _ in throw HelperError(ErrorCode.unavailable) }))
        _ = await handle(
            Request(id: 34, op: "embed", deadline: future(), value: texts),
            outstanding: Outstanding(), state: state,
            ops: Ops(embed: { _ in .object(["dims": .int(512), "vectors": .array([])]) }))
        #expect(await lines.all.map(\.model) == [ModelState.unavailable])
    }

    @Test func badInputIsRefusedBeforeTheModelIsTouched() async {
        let none = TextEmbedder(models: nil)
        #expect(await errorCode(nil, none) == ErrorCode.badRequest)
        #expect(await errorCode(.object([:]), none) == ErrorCode.badRequest)
        #expect(await errorCode(.object(["texts": .array([])]), none) == ErrorCode.badRequest)
        #expect(
            await errorCode(.object(["texts": .array([.int(1)])]), none) == ErrorCode.badRequest)
        #expect(
            await errorCode(
                .object(["texts": .array(Array(repeating: .string("x"), count: 33))]), none)
                == ErrorCode.badRequest)
        #expect(
            await errorCode(
                .object(["texts": .array([.string(String(repeating: "x", count: 1001))])]), none)
                == ErrorCode.badRequest)
    }

    @Test func noModelDirectoryIsUnavailable() async {
        let none = TextEmbedder(models: nil)
        #expect(
            await errorCode(.object(["texts": .array([.string("hello")])]), none)
                == ErrorCode.unavailable)
        let missing = TextEmbedder(
            models: URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("blackice-no-models-\(UUID().uuidString)"))
        #expect(
            await errorCode(.object(["texts": .array([.string("hello")])]), missing)
                == ErrorCode.unavailable)
    }

    @Test func theRealModelSeparatesRelatedFromUnrelatedText() async throws {
        guard modelFiles("live embed") != nil else { return }
        let embedder = TextEmbedder(models: modelsRoot)
        let started = Date()
        let value = try await embedTexts(
            .object([
                "texts": .array([
                    .string("a build error appeared"),
                    .string("compilation failed: cannot find 'foo' in scope"),
                    .string("Now playing: Track 5"),
                    .string("Payment scheduled for Friday."),
                ])
            ]), with: embedder)
        print("live embed: load and 4 texts in \(msSince(started))ms")

        #expect(value.object?["dims"] == .int(512))
        let vectors = (value.object?["vectors"]?.array ?? []).map { doubles($0) }
        #expect(vectors.count == 4)
        for vector in vectors {
            #expect(vector.count == 512)
            #expect(abs(dot(vector, vector) - 1) < 1e-9)
        }
        let related = dot(vectors[0], vectors[1])
        let unrelated = dot(vectors[2], vectors[3])
        print("live embed: related \(related), unrelated \(unrelated)")
        #expect(related > unrelated)
    }
}
