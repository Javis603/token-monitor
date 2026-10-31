import Foundation
import Observation
import WidgetKit

/// Read-only view of the user's placed widgets, shared by the Settings feature
/// section and the Overview hint. `widgetCount` is the number of this app's
/// widget configurations iOS reports — the gallery's Liquid Glass, Transparent
/// and Solid kinds, on the Home Screen and the Lock Screen alike. It stays nil
/// until WidgetKit answers, and after a failed query, so an unknown state
/// never presents as "zero widgets".
@MainActor
@Observable
final class SystemSurfaceStatus {
    /// Configurations iOS reports for this app's widgets; nil while unknown.
    private(set) var widgetCount: Int?

    /// Every widget `kind` the app offers — the Home Screen gallery's three
    /// surface variants share one intent but are separate configurations.
    static let ownedWidgetKinds: Set<String> = [
        TokenMonitorWidgetSurface.liquidGlass.kind,
        TokenMonitorWidgetSurface.transparent.kind,
        TokenMonitorWidgetSurface.solid.kind,
    ]

    private let configurationKinds: () async throws -> [String]

    /// The kind source is injectable so tests can answer without WidgetKit.
    init(configurationKinds: (() async throws -> [String])? = nil) {
        self.configurationKinds = configurationKinds
            ?? SystemSurfaceStatus.systemConfigurationKinds
    }

    /// Re-reads placed configurations — call on appear and whenever the scene
    /// returns to the foreground. A failure clears `widgetCount` back to nil.
    func refresh() async {
        do {
            widgetCount = try await configurationKinds()
                .filter(Self.ownedWidgetKinds.contains)
                .count
        } catch {
            widgetCount = nil
        }
    }

    private static func systemConfigurationKinds() async throws -> [String] {
        let configurations = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<[WidgetInfo], Error>) in
            WidgetCenter.shared.getCurrentConfigurations { result in
                continuation.resume(with: result)
            }
        }
        return configurations.map(\.kind)
    }
}
