// swift-tools-version: 6.4
import Foundation
import PackageDescription

/// Command Line Tools ship swift-testing's macro plugin in a `testing` subdirectory that
/// SwiftPM does not put on the plugin search path, so `#expect` fails to expand. Point the
/// test target at it when it is there; a full Xcode toolchain needs nothing.
func swiftTestingPluginFlags() -> [String] {
    let xcrun = Process()
    xcrun.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    xcrun.arguments = ["--find", "swift-frontend"]
    let pipe = Pipe()
    xcrun.standardOutput = pipe
    xcrun.standardError = FileHandle.nullDevice
    guard (try? xcrun.run()) != nil else { return [] }
    let found = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        .trimmingCharacters(in: .whitespacesAndNewlines)
    xcrun.waitUntilExit()
    guard !found.isEmpty else { return [] }
    // <toolchain>/usr/bin/swift-frontend -> <toolchain>/usr/lib/swift/host/plugins/testing
    let plugins = URL(fileURLWithPath: found)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .appendingPathComponent("lib/swift/host/plugins/testing")
    guard FileManager.default.fileExists(atPath: plugins.path) else { return [] }
    return ["-plugin-path", plugins.path]
}

let package = Package(
    name: "blackice-helper",
    platforms: [.macOS("27.0")],
    products: [
        .executable(name: "blackice-helper", targets: ["blackice-helper"])
    ],
    targets: [
        .executableTarget(
            name: "blackice-helper",
            // Attribution for the ported tokenizer, not a resource to bundle.
            exclude: ["Tokenizer/NOTICE"]
        ),
        .testTarget(
            name: "blackice-helperTests",
            dependencies: ["blackice-helper"],
            swiftSettings: [.unsafeFlags(swiftTestingPluginFlags())]
        ),
    ]
)
