import CoreServices
import Darwin
import Foundation
import WidgetKit

private func registerContainingHost() -> Never {
    let executableURL = URL(fileURLWithPath: CommandLine.arguments[0])
        .standardizedFileURL
        .resolvingSymlinksInPath()
    let resourcesURL = executableURL.deletingLastPathComponent()
    let contentsURL = resourcesURL.deletingLastPathComponent()
    let hostAppURL = contentsURL.deletingLastPathComponent()

    guard
        resourcesURL.lastPathComponent == "Resources",
        contentsURL.lastPathComponent == "Contents",
        hostAppURL.pathExtension == "app"
    else {
        exit(EXIT_FAILURE)
    }

    let status = LSRegisterURL(hostAppURL as CFURL, true)
    exit(status == noErr ? EXIT_SUCCESS : EXIT_FAILURE)
}

if Array(CommandLine.arguments.dropFirst()) == ["--mode", "register-host"] {
    registerContainingHost()
}

let kind = CommandLine.arguments.dropFirst().first ?? "com.tokenmonitor.dashboard"

if #available(macOS 14.0, *) {
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
}
