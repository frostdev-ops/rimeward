import Foundation
import FoundationModels
import Translation

typealias CapabilitiesProbe = @Sendable (JSONValue?) async throws -> JSONValue

let defaultTranslationPairs: [[String]] = [
    ["en", "es"], ["es", "en"],
    ["en", "fr"], ["fr", "en"],
    ["en", "de"], ["de", "en"],
    ["en", "ja"], ["ja", "en"],
    ["en", "zh-Hans"], ["zh-Hans", "en"],
]

/// Reports what this Mac can actually do. Never creates a `LanguageModelSession`
/// and never generates, so it stays well under a few hundred milliseconds.
func probeCapabilities(_ value: JSONValue?) async throws -> JSONValue {
    let pairs = requestedPairs(value) ?? defaultTranslationPairs
    let model = modelCapabilities()
    let translation = await installedTranslationPairs(pairs)
    // The Core ML text tower the `for` prefilter scores with: present and loadable.
    let embedding = ModelFiles(models: modelsDirectory) != nil
    return .object([
        "model": model,
        "translation": translation,
        "embedding": .bool(embedding),
    ])
}

func requestedPairs(_ value: JSONValue?) -> [[String]]? {
    guard let list = value?.object?["pairs"]?.array else { return nil }
    return list.compactMap { $0.array?.compactMap(\.string) }.filter { $0.count == 2 }
}

private func modelCapabilities() -> JSONValue {
    let model = SystemLanguageModel.default
    let available = model.isAvailable
    var fields: [String: JSONValue] = [
        "available": .bool(available),
        "variant": .string(model.variant.displayName),
        "contextSize": .int(model.contextSize),
        "vision": .bool(model.capabilities.contains(.vision)),
    ]
    if !available { fields["reason"] = .string(String(describing: model.availability)) }
    return .object(fields)
}

private func installedTranslationPairs(_ pairs: [[String]]) async -> JSONValue {
    let availability = LanguageAvailability()
    var installed: [JSONValue] = []
    for pair in pairs {
        let status = await availability.status(
            from: Locale.Language(identifier: pair[0]),
            to: Locale.Language(identifier: pair[1])
        )
        if case .installed = status {
            installed.append(.array([.string(pair[0]), .string(pair[1])]))
        }
    }
    return .array(installed)
}
