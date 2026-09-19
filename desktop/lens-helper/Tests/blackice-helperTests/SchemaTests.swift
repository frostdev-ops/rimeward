import Foundation
import FoundationModels
import Testing

@testable import blackice_helper

private func encoded(_ spec: JSONValue?) throws -> [String: JSONValue] {
    let schema = try describeSchema(spec)
    let data = try JSONEncoder().encode(schema)
    return try JSONDecoder().decode(JSONValue.self, from: data).object ?? [:]
}

private func code(_ body: () throws -> Void) -> String? {
    do {
        try body()
        return nil
    } catch let error as HelperError {
        return error.code
    } catch {
        return "\(error)"
    }
}

@Suite struct SchemaTests {
    @Test func theDefaultSchemaIsSummaryElementsText() throws {
        let json = try encoded(nil)
        let properties = json["properties"]?.object ?? [:]
        #expect(Set(properties.keys) == ["summary", "elements", "text"])
        #expect(properties["summary"]?.object?["type"] == .string("string"))
        #expect(properties["elements"]?.object?["type"] == .string("array"))
        #expect(properties["elements"]?.object?["items"]?.object?["type"] == .string("string"))
        let required = Set((json["required"]?.array ?? []).compactMap(\.string))
        #expect(required == ["summary", "elements", "text"])
    }

    @Test func buildsPropertiesTypesAndTheRequiredList() throws {
        let json = try encoded(
            .object([
                "type": .string("object"),
                "properties": .object([
                    "title": .object(["type": .string("string"), "description": .string("the title")]),
                    "count": .object(["type": .string("integer")]),
                    "score": .object(["type": .string("number")]),
                    "modal": .object(["type": .string("boolean")]),
                    "buttons": .object([
                        "type": .string("array"),
                        "items": .object(["type": .string("string")]),
                    ]),
                ]),
                "required": .array([.string("title"), .string("buttons")]),
            ]))
        let properties = json["properties"]?.object ?? [:]
        #expect(properties["title"]?.object?["type"] == .string("string"))
        #expect(properties["title"]?.object?["description"] == .string("the title"))
        #expect(properties["count"]?.object?["type"] == .string("integer"))
        #expect(properties["score"]?.object?["type"] == .string("number"))
        #expect(properties["modal"]?.object?["type"] == .string("boolean"))
        #expect(properties["buttons"]?.object?["items"]?.object?["type"] == .string("string"))
        #expect(Set((json["required"]?.array ?? []).compactMap(\.string)) == ["title", "buttons"])
    }

    @Test func malformedSchemasAreBadRequest() {
        #expect(code { _ = try describeSchema(.string("nope")) } == ErrorCode.badRequest)
        #expect(code { _ = try describeSchema(.object(["type": .string("array")])) } == ErrorCode.badRequest)
        #expect(
            code {
                _ = try describeSchema(.object(["type": .string("object"), "properties": .object([:])]))
            } == ErrorCode.badRequest)
        #expect(
            code {
                _ = try describeSchema(
                    .object([
                        "type": .string("object"),
                        "properties": .object(["a": .object(["type": .string("object")])]),
                    ]))
            } == ErrorCode.badRequest)
        #expect(
            code {
                _ = try describeSchema(
                    .object([
                        "type": .string("object"),
                        "properties": .object([
                            "a": .object([
                                "type": .string("array"),
                                "items": .object(["type": .string("number")]),
                            ])
                        ]),
                    ]))
            } == ErrorCode.badRequest)
        #expect(
            code {
                _ = try describeSchema(
                    .object([
                        "type": .string("object"),
                        "properties": .object(["a": .object(["nope": .string("x")])]),
                    ]))
            } == ErrorCode.badRequest)
    }

    @Test func cropsAreDecodedAndOversizeOnesRefused() throws {
        let small = try jpegBase64(makeTestImage(width: 64, height: 48))
        let image = try decodeCrop(["jpeg": .string(small)])
        #expect(image.width == 64)
        #expect(image.height == 48)

        #expect(code { _ = try decodeCrop(nil) } == ErrorCode.badRequest)
        #expect(code { _ = try decodeCrop(["jpeg": .string("!!!not base64!!!")]) } == ErrorCode.badRequest)

        let huge = try jpegBase64(makeTestImage(width: 1200, height: 64))
        var detail: String?
        do { _ = try decodeCrop(["jpeg": .string(huge)]) } catch let error as HelperError {
            detail = error.detail
        }
        #expect(detail == "too-large")
    }

    @Test func theDiffIsCappedAtANewline() {
        let long = (0..<1000).map { "line \($0) of the screen diff" }.joined(separator: "\n")
        let capped = capDiff(long, 100)
        #expect(capped.count <= 100)
        #expect(!capped.hasSuffix("diff") || capped.count < 100)
        #expect(capped.hasPrefix("line 0"))
        #expect(!capped.contains("\n") || capped.last != "\n")
        #expect(capDiff("short", 100) == "short")
    }
}
