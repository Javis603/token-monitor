import Foundation
import WidgetKit

let kind = CommandLine.arguments.dropFirst().first ?? "com.tokenmonitor.dashboard"

if #available(macOS 14.0, *) {
    WidgetCenter.shared.reloadTimelines(ofKind: kind)
}
