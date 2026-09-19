import CoreGraphics
import CoreText
import Foundation
import FoundationModels
import ImageIO
import Testing
import UniformTypeIdentifiers

@testable import blackice_helper

/// A white canvas with a filled grey rectangle and one word drawn with Core Text, so the
/// live tests never depend on a screenshot fixture.
func makeTestImage(width: Int, height: Int, word: String = "Inbox") -> CGImage {
    let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.setFillColor(CGColor(red: 0.82, green: 0.82, blue: 0.86, alpha: 1))
    context.fill(CGRect(x: 0, y: height - height / 5, width: width, height: height / 5))

    let font = CTFontCreateWithName("Helvetica" as CFString, CGFloat(height) / 10, nil)
    let attributes: [CFString: Any] = [
        kCTFontAttributeName: font,
        kCTForegroundColorAttributeName: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
    ]
    let attributed = CFAttributedStringCreate(
        nil, word as CFString, attributes as CFDictionary)!
    context.textPosition = CGPoint(x: 16, y: CGFloat(height) - CGFloat(height) / 8)
    CTLineDraw(CTLineCreateWithAttributedString(attributed), context)
    return context.makeImage()!
}

func jpegBase64(_ image: CGImage) throws -> String {
    let data = NSMutableData()
    guard
        let destination = CGImageDestinationCreateWithData(
            data, UTType.jpeg.identifier as CFString, 1, nil)
    else { throw HelperError("jpeg-encoder") }
    CGImageDestinationAddImage(
        destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw HelperError("jpeg-encode") }
    return (data as Data).base64EncodedString()
}

private let live = ProcessInfo.processInfo.environment["RIMEWARD_HELPER_LIVE"] == "1"

@Suite(.enabled(if: live)) struct LiveTests {
    @Test func triageSaysYesForAMatchingDiffAndNoOtherwise() async throws {
        let hit = try await runTriage(
            .object([
                "watch": .string("an error dialog appeared"),
                "app": .string("Xcode"),
                "diff": .string("+ Build failed\n+ error: cannot find 'foo' in scope\n+ [OK]"),
            ]))
        print("live triage yes:", try encodeLine(hit))
        #expect(hit.object?["yes"] == .bool(true))

        let miss = try await runTriage(
            .object([
                "watch": .string("an error dialog appeared"),
                "app": .string("Music"),
                "diff": .string("- Now playing: Track 4\n+ Now playing: Track 5"),
            ]))
        print("live triage no:", try encodeLine(miss))
        #expect(miss.object?["yes"] == .bool(false))
    }

    @Test func describeReturnsTheSchemaShapeForAGeneratedImage() async throws {
        let jpeg = try jpegBase64(makeTestImage(width: 256, height: 256))
        let value = try await runDescribe(
            .object([
                "ref": .string("f-0-0"), "jpeg": .string(jpeg),
                "prompt": .string("Describe this crop of the screen."),
            ]))
        print("live describe:", try encodeLine(value))
        let json = value.object?["json"]?.object
        #expect(json?["summary"]?.string?.isEmpty == false)
        #expect(json?["elements"]?.array != nil)
        #expect(json?["text"]?.array != nil)
        #expect((value.object?["ms"]?.int ?? 0) > 0)
    }

    @Test func translateEnglishToSpanish() async throws {
        do {
            let value = try await runTranslate(
                .object([
                    "source": .string("en"), "target": .string("es"),
                    "texts": .array([
                        .string("The build failed."),
                        .string("Payment scheduled for Friday."),
                        .string("Open the settings pane."),
                    ]),
                ]))
            print("live translate:", try encodeLine(value))
            #expect(value.object?["texts"]?.array?.count == 3)
        } catch let error as HelperError where error.code == ErrorCode.notInstalled {
            print("live translate: not-installed \(error.detail ?? "")")
        }
    }

    @Test func documentReadsTheGeneratedImage() async throws {
        let jpeg = try jpegBase64(makeTestImage(width: 512, height: 256, word: "Quarterly report"))
        do {
            let value = try await runDocument(.object(["ref": .string("f-0-0"), "jpeg": .string(jpeg)]))
            print("live document:", try encodeLine(value))
            #expect(value.object?["paragraphs"]?.array != nil)
        } catch let error as HelperError {
            print("live document: \(error.code) \(error.detail ?? "")")
            #expect(error.code == ErrorCode.unavailable)
        }
    }
}
