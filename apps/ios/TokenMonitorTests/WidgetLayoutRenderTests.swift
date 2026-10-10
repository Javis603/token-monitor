import SwiftUI
import Testing
import WidgetKit
@testable import TokenMonitor

/// Renders every widget content × family in light and dark with
/// `ImageRenderer`; when `WIDGET_SNAPSHOT_DIR` is in the environment (pass it
/// via `TEST_RUNNER_WIDGET_SNAPSHOT_DIR=/tmp/widget-redesign` to xcodebuild)
/// each render is also written as a @3x PNG named
/// `<content>-<family>-<light|dark>[-state].png`.
@MainActor
struct WidgetLayoutRenderTests {
    private typealias Snapshot = TokenMonitorSharedPayload.Snapshot

    private func entry(
        content: String = "overview",
        snapshot: Snapshot? = TokenMonitorWidgetEntry.placeholderSnapshot
    ) -> TokenMonitorWidgetEntry {
        TokenMonitorWidgetEntry(
            date: .now,
            snapshot: snapshot,
            preferences: .default,
            content: content,
            period: "today",
            providerID: nil,
            showsCost: true,
            showsUpdateTime: true,
            ink: .recommended
        )
    }

    private func staleEntry(content: String) -> TokenMonitorWidgetEntry {
        // Age every timestamp past the freshness interval; limits staleness
        // keys off each limit's own updatedAt, usage off the snapshot's.
        let past = Date.now.addingTimeInterval(-3_600)
        let base = TokenMonitorWidgetEntry.placeholderSnapshot
        typealias Limit = TokenMonitorSharedPayload.Limit
        let staleLimits = base.limits.map { limit in
            Limit(
                id: limit.id,
                providerID: limit.providerID,
                planLabel: limit.planLabel,
                status: limit.status,
                updatedAt: past,
                windows: limit.windows
            )
        }
        let snapshot = Snapshot(
            updatedAt: past,
            today: base.today,
            month: base.month,
            allTime: base.allTime,
            limits: staleLimits,
            activity: base.activity
        )
        return entry(content: content, snapshot: snapshot)
    }

    private let families: [(name: String, family: WidgetFamily, size: CGSize)] = [
        ("small", .systemSmall, CGSize(width: 170, height: 170)),
        ("medium", .systemMedium, CGSize(width: 364, height: 170)),
        ("large", .systemLarge, CGSize(width: 364, height: 382)),
        ("rectangular", .accessoryRectangular, CGSize(width: 184, height: 84)),
        ("circular", .accessoryCircular, CGSize(width: 80, height: 80)),
        ("inline", .accessoryInline, CGSize(width: 340, height: 40))
    ]

    private func render(
        entry: TokenMonitorWidgetEntry,
        family: WidgetFamily,
        size: CGSize,
        dark: Bool
    ) -> UIImage? {
        let content = TokenMonitorWidgetView(
            entry: entry,
            surface: .solid,
            family: family
        )
        .padding(16)
        .frame(width: size.width, height: size.height)
        .background(.background)
        .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 3
        renderer.proposedSize = .init(size)
        return renderer.uiImage
    }

    private func snapshotDir() -> String? {
        let environment = ProcessInfo.processInfo.environment
        return environment["WIDGET_SNAPSHOT_DIR"]
            ?? environment["TEST_RUNNER_WIDGET_SNAPSHOT_DIR"]
    }

    private func write(_ image: UIImage, name: String) {
        guard let directory = snapshotDir(), let data = image.pngData() else { return }
        let url = URL(fileURLWithPath: directory)
        try? FileManager.default.createDirectory(
            at: url, withIntermediateDirectories: true
        )
        let file = url.appending(path: "\(name).png")
        do {
            try data.write(to: file)
        } catch {
            // The simulator may not reach the host path; fall back to the
            // container's tmp and say where the files landed.
            let fallback = FileManager.default.temporaryDirectory
                .appending(path: "widget-redesign/\(name).png")
            try? FileManager.default.createDirectory(
                at: fallback.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? data.write(to: fallback)
            print("WidgetLayoutRenderTests: wrote \(fallback.path) instead of \(file.path)")
        }
    }

    private func check(
        _ entry: TokenMonitorWidgetEntry,
        content: String,
        name: String,
        family: WidgetFamily,
        size: CGSize,
        state: String? = nil
    ) {
        for dark in [false, true] {
            let image = render(entry: entry, family: family, size: size, dark: dark)
            #expect(image != nil, "\(content) \(name) \(dark ? "dark" : "light") rendered nil")
            guard let image else { continue }
            var file = "\(content)-\(name)-\(dark ? "dark" : "light")"
            if let state { file += "-\(state)" }
            write(image, name: file)
        }
    }

    @Test func everyContentAndFamilyRenders() {
        for content in ["overview", "limits", "activity"] {
            let entry = entry(content: content)
            for (name, family, size) in families {
                check(entry, content: content, name: name, family: family, size: size)
            }
        }
    }

    @Test func emptySnapshotAndStaleVariantsRender() {
        for content in ["overview", "limits", "activity"] {
            check(
                entry(content: content, snapshot: nil),
                content: content, name: "small", family: .systemSmall,
                size: CGSize(width: 170, height: 170), state: "empty"
            )
            check(
                staleEntry(content: content),
                content: content, name: "small", family: .systemSmall,
                size: CGSize(width: 170, height: 170), state: "stale"
            )
        }
    }
}
