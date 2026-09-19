import CoreML
import Foundation

/// `--models <dir>` names the directory that holds `mobileclip-s0/`: the fetcher's cache
/// in development, `<Resources>/runtime/models` in a release bundle. A model path is not a
/// secret, so argv is the right place for it. Absent, `embed` answers `unavailable` and
/// `capabilities.embedding` is false.
let modelsDirectory: URL? = modelsArgument(CommandLine.arguments)

func modelsArgument(_ arguments: [String]) -> URL? {
    guard let flag = arguments.firstIndex(of: "--models"), flag + 1 < arguments.count,
        !arguments[flag + 1].isEmpty
    else { return nil }
    return URL(fileURLWithPath: arguments[flag + 1])
}

/// The model directory's layout, in one place. `init?` answers nil when the directory or
/// any file it needs is missing, which is exactly `capabilities.embedding == false`.
struct ModelFiles: Sendable {
    let vocab: URL
    let merges: URL
    let package: URL
    let manifest: URL

    init?(models: URL?) {
        guard let models else { return nil }
        let root = models.appendingPathComponent("mobileclip-s0", isDirectory: true)
        vocab = root.appendingPathComponent("clip-vocab.json")
        merges = root.appendingPathComponent("clip-merges.txt")
        package = root.appendingPathComponent("mobileclip_s0_text.mlpackage", isDirectory: true)
        manifest = root.appendingPathComponent("manifest.json")
        let weights = package.appendingPathComponent(
            "Data/com.apple.CoreML/weights/weight.bin")
        let fileManager = FileManager.default
        for url in [vocab, merges, manifest, package, weights]
        where !fileManager.fileExists(atPath: url.path) {
            return nil
        }
    }
}

/// The compiled model is cached under the weights' own sha256, read from the fetcher's
/// `manifest.json`, so a new revision compiles into a new directory instead of being
/// mistaken for the old one.
func weightsDigestPrefix(_ manifest: URL) -> String? {
    guard let data = try? Data(contentsOf: manifest),
        let files = (try? JSONDecoder().decode(JSONValue.self, from: data))?
            .object?["files"]?.object,
        let digest = files.first(where: { $0.key.hasSuffix("weights/weight.bin") })?.value.string,
        digest.count >= 12
    else { return nil }
    return String(digest.prefix(12))
}

/// The MobileCLIP-S0 text tower: one tokenizer and one `MLModel` for the life of the
/// process, loaded by the launch warm or by the first `embed`, whichever comes first.
actor TextEmbedder {
    static let shared = TextEmbedder(models: modelsDirectory)
    static let dimensions = 512

    /// `MLModel` is documented thread-safe and the tokenizer never mutates after `init`,
    /// so one loaded pair can cross from the loading task to the actor.
    fileprivate final class Loaded: @unchecked Sendable {
        let tokenizer: CLIPTokenizer
        let model: MLModel
        let input: String
        let output: String

        init(tokenizer: CLIPTokenizer, model: MLModel, input: String, output: String) {
            self.tokenizer = tokenizer
            self.model = model
            self.input = input
            self.output = output
        }
    }

    private let files: ModelFiles?
    private var loaded: Loaded?
    private var loading: Task<Loaded, any Error>?

    init(models: URL?) { files = ModelFiles(models: models) }

    func load() async throws { _ = try await ready() }

    /// The launch warm and the first `embed` both land here, and the load suspends on the
    /// compile, so the second caller must wait on the first task instead of starting its
    /// own: an actor's `if loaded != nil` alone compiled the model twice.
    fileprivate func ready() async throws -> Loaded {
        if let loaded { return loaded }
        if let loading { return try await loading.value }
        let task = Task { [files] in try await TextEmbedder.build(files) }
        loading = task
        defer { loading = nil }
        let result = try await task.value
        loaded = result
        return result
    }

    /// Loads the tokenizer and the model, compiling the `.mlpackage` the first time.
    /// Every failure is `unavailable`: Rust turns that into "no embeddings" and the lens
    /// falls back, so a broken model directory must never look like a transient error.
    private static func build(_ files: ModelFiles?) async throws -> Loaded {
        guard let files else {
            throw HelperError(ErrorCode.unavailable, detail: "no model directory")
        }
        let started = Date()
        let tokenizer: CLIPTokenizer
        do {
            tokenizer = try CLIPTokenizer(vocabURL: files.vocab, mergesURL: files.merges)
        } catch {
            throw HelperError(ErrorCode.unavailable, detail: "tokenizer: \(error)")
        }
        let tokenizerMs = msSince(started)

        let compiled = try await compiledModel(files)
        let configuration = MLModelConfiguration()
        configuration.computeUnits = .all
        let model: MLModel
        do {
            model = try MLModel(contentsOf: compiled, configuration: configuration)
        } catch {
            throw HelperError(ErrorCode.unavailable, detail: "load: \(error)")
        }
        let description = model.modelDescription
        let input = description.inputDescriptionsByName["text"] != nil
            ? "text" : (description.inputDescriptionsByName.keys.sorted().first ?? "text")
        let output = description.outputDescriptionsByName["final_emb_1"] != nil
            ? "final_emb_1"
            : (description.outputDescriptionsByName.keys.sorted().first ?? "final_emb_1")
        logToStderr(
            "embed loaded \(msSince(started))ms (tokenizer \(tokenizerMs)ms, "
                + "\(input) -> \(output))")
        return Loaded(tokenizer: tokenizer, model: model, input: input, output: output)
    }

    /// Command Line Tools ship no `coremlcompiler`, so the `.mlpackage` is compiled here
    /// once and kept under Caches for every later launch.
    private static func compiledModel(_ files: ModelFiles) async throws -> URL {
        let fileManager = FileManager.default
        guard let caches = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first
        else { throw HelperError(ErrorCode.unavailable, detail: "no caches directory") }
        guard let key = weightsDigestPrefix(files.manifest) else {
            throw HelperError(
                ErrorCode.unavailable, detail: "manifest.json has no weight.bin sha256")
        }
        let directory = caches.appendingPathComponent(
            "io.frostdev.rimeward/models", isDirectory: true)
        let target = directory.appendingPathComponent(
            "mobileclip_s0_text-\(key).mlmodelc", isDirectory: true)
        if fileManager.fileExists(atPath: target.path) { return target }

        let started = Date()
        do {
            let compiled = try await MLModel.compileModel(at: files.package)
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            do {
                try fileManager.moveItem(at: compiled, to: target)
            } catch {
                // Another launch compiling the same revision got there first.
                guard fileManager.fileExists(atPath: target.path) else { throw error }
            }
        } catch {
            throw HelperError(ErrorCode.unavailable, detail: "compile: \(error)")
        }
        logToStderr("embed compiled \(msSince(started))ms -> \(target.lastPathComponent)")
        return target
    }

    /// One batch-1 prediction per text, unit-normalised, in input order: 2.2 ms each
    /// measured over a batch of 32 in the release build, tokenizing included.
    func embed(_ texts: [String]) async throws -> [[Double]] {
        let loaded = try await ready()
        var vectors: [[Double]] = []
        vectors.reserveCapacity(texts.count)
        for text in texts {
            let ids = loaded.tokenizer.encode_full(text: text)
            let row = try MLMultiArray(shape: [1, NSNumber(value: ids.count)], dataType: .int32)
            for (i, id) in ids.enumerated() { row[i] = NSNumber(value: id) }
            let features = try MLDictionaryFeatureProvider(dictionary: [
                loaded.input: MLFeatureValue(multiArray: row)
            ])
            let prediction = try predict(loaded.model, features)
            guard let vector = prediction.featureValue(for: loaded.output)?.multiArrayValue
            else {
                throw HelperError(
                    ErrorCode.internalFailure, detail: "no \(loaded.output) output")
            }
            vectors.append(unitVector(vector))
        }
        return vectors
    }
}

/// `prediction(from:)` also has an `async` form, which the compiler picks inside an actor
/// and then refuses because it would send the model off the actor. A prediction of a few
/// milliseconds has no reason to hop executors: this wrapper keeps it on the caller's.
private func predict(
    _ model: MLModel, _ features: MLFeatureProvider
) throws -> MLFeatureProvider {
    try model.prediction(from: features)
}

/// The tower's output is not normalised, so a cosine is only a dot product after this.
func unitVector(_ array: MLMultiArray) -> [Double] {
    var values = [Double](repeating: 0, count: array.count)
    for i in 0..<array.count { values[i] = array[i].doubleValue }
    let norm = values.reduce(0) { $0 + $1 * $1 }.squareRoot()
    guard norm > 0 else { return values }
    return values.map { $0 / norm }
}

let maxEmbedTexts = 32
let maxEmbedChars = 1000

/// `{texts: [String]}` -> `{dims, vectors}`.
func runEmbed(_ value: JSONValue?) async throws -> JSONValue {
    try await embedTexts(value, with: TextEmbedder.shared)
}

func embedTexts(_ value: JSONValue?, with embedder: TextEmbedder) async throws -> JSONValue {
    guard let list = value?.object?["texts"]?.array else {
        throw HelperError(ErrorCode.badRequest, detail: "texts is required")
    }
    let texts = list.compactMap(\.string)
    guard texts.count == list.count else {
        throw HelperError(ErrorCode.badRequest, detail: "texts must be strings")
    }
    guard !texts.isEmpty, texts.count <= maxEmbedTexts else {
        throw HelperError(
            ErrorCode.badRequest, detail: "1..\(maxEmbedTexts) texts, got \(texts.count)")
    }
    if let long = texts.first(where: { $0.count > maxEmbedChars }) {
        throw HelperError(
            ErrorCode.badRequest, detail: "\(long.count) chars > \(maxEmbedChars)")
    }
    let started = Date()
    let vectors = try await embedder.embed(texts)
    logToStderr("embed \(texts.count) texts \(msSince(started))ms")
    return .object([
        "dims": .int(vectors.first?.count ?? TextEmbedder.dimensions),
        "vectors": .array(vectors.map { .array($0.map(JSONValue.double)) }),
    ])
}

/// Pays the tokenizer read and the one-off Core ML compile on a detached task at launch,
/// like `warmDocuments()`, so `capabilities` answers on time and the first `embed` is not
/// the call that waits. Nothing to do when the app gave no `--models`.
func warmEmbed() {
    guard modelsDirectory != nil else { return }
    Task.detached(priority: .utility) {
        do {
            try await TextEmbedder.shared.load()
        } catch {
            logToStderr("embed warm failed: \(helperError(error).detail ?? "\(error)")")
        }
    }
}
