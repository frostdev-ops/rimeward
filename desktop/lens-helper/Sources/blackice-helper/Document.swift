import CoreGraphics
import Foundation
import Vision

/// The first Vision request in a process loads its assets: 24 s once inside this helper,
/// 181 ms after. Paid here on a detached task at launch, so `capabilities` answers on
/// time and the first `document` op is not the one waiting.
func warmDocuments() {
    Task.detached(priority: .utility) {
        let started = Date()
        guard
            let context = CGContext(
                data: nil, width: 32, height: 32, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
            let image = context.makeImage()
        else { return }
        _ = try? await RecognizeDocumentsRequest().perform(on: image)
        logToStderr("vision warm \(msSince(started))ms")
    }
}

/// `{epoch, seq, ref, jpeg}` -> `{title?, paragraphs, tables, lists, ms}` from Vision's
/// `RecognizeDocumentsRequest`. Structure only: no model, no interpretation.
func runDocument(_ value: JSONValue?) async throws -> JSONValue {
    let image = try decodeCrop(value?.object)
    let started = Date()
    let observations: [DocumentObservation]
    do {
        observations = try await RecognizeDocumentsRequest().perform(on: image)
    } catch {
        throw HelperError(ErrorCode.internalFailure, detail: "\(error)")
    }
    guard let document = observations.first?.document else {
        return .object([
            "paragraphs": .array([]), "tables": .array([]), "lists": .array([]),
            "ms": .int(msSince(started)),
        ])
    }

    var fields: [String: JSONValue] = [
        "paragraphs": .array(document.paragraphs.map { .string($0.transcript) }),
        "tables": .array(
            document.tables.map { table in
                .array(
                    table.rows.map { row in
                        .array(row.map { .string($0.content.text.transcript) })
                    })
            }),
        "lists": .array(
            document.lists.map { list in
                .array(list.items.map { .string($0.itemString) })
            }),
        "ms": .int(msSince(started)),
    ]
    if let title = document.title?.transcript, !title.isEmpty {
        fields["title"] = .string(title)
    }
    return .object(fields)
}
