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
        snapshot: Snapshot? = TokenMonitorWidgetEntry.placeholderSnapshot,
        preferences: TokenMonitorSharedPayload.Preferences = .default,
        providerID: String? = nil
    ) -> TokenMonitorWidgetEntry {
        TokenMonitorWidgetEntry(
            date: .now,
            snapshot: snapshot,
            preferences: preferences,
            content: content,
            period: "today",
            providerID: providerID,
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

    @Test func newSessionMetadataRendersAtPhoneAndAccessibilitySizes() throws {
        let sessions = try JSONDecoder().decode([String: SessionUsage].self, from: Data(#"{"codex:main":{"client":"codex","sessionId":"main","title":"Inspect the latest Hub stream","models":{"gpt-6.1":400},"totalTokens":400,"costUsd":0.01,"reasoningEffort":"xhigh","lastUsedAt":"2026-10-28T00:00:00Z"},"codex:child":{"client":"codex","sessionId":"child","parentSessionId":"main","models":{"gpt-6.1":100},"totalTokens":100,"costUsd":0.01,"reasoningEffort":"low","lastUsedAt":"2026-10-27T23:59:00Z"},"claude:solo":{"client":"claude","sessionId":"solo","models":{"claude-opus":300},"totalTokens":300,"costUsd":0.01,"reasoningEffort":"high","lastUsedAt":"2026-10-27T23:00:00Z"},"senpi:a":{"client":"senpi","sessionId":"a","models":{"gpt-6.1":200},"totalTokens":200,"costUsd":0.01}}"#.utf8))
        let now = try #require(Date.hubTimestamp(from: "2026-10-28T00:20:00Z"))
        let entries = SessionListEntry.rows(sessions, now: now)
        #expect(entries.first?.session?.displayReasoningEffort == "xhigh")
        let suite = "SessionMetadataRender-\(UUID())"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = AppPreferences(defaults: defaults, snapshotStore: .init(fileURL: nil))
        for accessibility in [false, true] {
            for dark in [false, true] {
                let content = VStack(alignment: .leading, spacing: 20) {
                    ForEach(entries) { entry in
                        if entry.isSessionGroup {
                            SessionGroupRow(entry: entry, maximum: 500, now: now)
                        } else if let session = entry.session {
                            SessionRow(session: session, sessionKey: entry.id, maximum: 500, now: now)
                        }
                    }
                }
                .padding(20).frame(width: 350).background(.background)
                .environment(preferences)
                .environment(\.dynamicTypeSize, accessibility ? .accessibility2 : .large)
                .environment(\.colorScheme, dark ? .dark : .light)
                let renderer = ImageRenderer(content: content)
                renderer.scale = 3
                let image = try #require(renderer.uiImage)
                write(image, name: "main-sync-sessions-\(dark ? "dark" : "light")-\(accessibility ? "accessibility" : "phone")")
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
    @Test func alternateLayoutsAndBoundaryQuotasRender() {
        for layout in ["columns", "rows"] {
            var preferences = TokenMonitorSharedPayload.Preferences.default
            preferences.widgetLimitLayout = layout
            preferences.languageCode = "zh-TW"
            let base = TokenMonitorWidgetEntry.placeholderSnapshot
            let limit = TokenMonitorSharedPayload.Limit(
                id: "claude", providerID: "claude", planLabel: "Pro", status: "ok",
                updatedAt: .now,
                windows: [0.0, 100.0].enumerated().map { index, value in
                    .init(id: "\(index)", label: index == 0 ? "Session" : "Weekly",
                          remainingPercent: value, amount: nil, currency: nil,
                          resetAt: Date.now.addingTimeInterval(7200))
                }
            )
            let snapshot = Snapshot(updatedAt: .now, today: base.today, month: base.month,
                                    allTime: base.allTime, limits: [limit], activity: base.activity)
            for (name, family, size) in families.prefix(3) {
                check(entry(content: "limits", snapshot: snapshot, preferences: preferences),
                      content: "limits", name: name, family: family, size: size, state: "boundary-\(layout)")
            }
        }
        var preferences = TokenMonitorSharedPayload.Preferences.default
        preferences.widgetActivityLayout = "summary"
        preferences.languageCode = "zh-TW"
        check(entry(content: "activity", preferences: preferences), content: "activity",
              name: "medium", family: .systemMedium, size: CGSize(width: 364, height: 170), state: "summary")
    }

    @Test func desktopAccountsAndSingleWindowFillEachFamily() {
        let base = TokenMonitorWidgetEntry.placeholderSnapshot
        let now = Date.now
        typealias Limit = TokenMonitorSharedPayload.Limit
        typealias Window = TokenMonitorSharedPayload.LimitWindow
        func window(_ label: String, _ percent: Double, hours: Double) -> Window {
            .init(id: label.lowercased(), label: label, remainingPercent: percent,
                  amount: nil, currency: nil, resetAt: now.addingTimeInterval(hours * 3600))
        }
        let limits: [Limit] = [
            .init(id: "claude-pro", providerID: "claude", planLabel: "Pro", status: "ok",
                  updatedAt: now.addingTimeInterval(-180),
                  windows: [window("Session", 0, hours: 0.4), window("Weekly", 93, hours: 159)]),
            .init(id: "codex-pro", providerID: "codex", planLabel: "Pro", status: "ok",
                  updatedAt: now.addingTimeInterval(-120), windows: [window("Weekly", 28, hours: 131)],
                  maskedAccountLabel: "j***3@example.com"),
            .init(id: "codex-free", providerID: "codex", planLabel: "Free", status: "ok",
                  updatedAt: now.addingTimeInterval(-120), windows: [window("Monthly", 100, hours: 615)],
                  maskedAccountLabel: "l***3@example.com"),
            .init(id: "codex-plus", providerID: "codex", planLabel: "Plus", status: "ok",
                  updatedAt: now.addingTimeInterval(-120),
                  windows: [window("Session", 31, hours: 0.4), window("Weekly", 73, hours: 131)],
                  maskedAccountLabel: "l***8@example.com")
        ]
        func snapshot(_ values: [Limit]) -> Snapshot {
            .init(updatedAt: now, today: base.today, month: base.month, allTime: base.allTime,
                  limits: values, activity: base.activity)
        }
        var preferences = TokenMonitorSharedPayload.Preferences.default
        preferences.languageCode = "zh-TW"
        for (name, family, size) in families.prefix(3) {
            check(entry(content: "limits", snapshot: snapshot(limits), preferences: preferences),
                  content: "limits", name: name, family: family, size: size, state: "desktop")
            check(entry(content: "limits", snapshot: snapshot(limits), preferences: preferences, providerID: "codex"),
                  content: "limits", name: name, family: family, size: size, state: "codex-accounts")
            check(entry(content: "limits", snapshot: snapshot([limits[1]]), preferences: preferences),
                  content: "limits", name: name, family: family, size: size, state: "single-window")
        }
        for width in [158.0, 164, 180] {
            check(entry(content: "limits", snapshot: snapshot([limits[0]]), preferences: preferences),
                  content: "limits", name: "small", family: .systemSmall,
                  size: CGSize(width: width, height: width), state: "compact-\(Int(width))")
        }
    }

}


extension WidgetLayoutRenderTests {
    @Test func staleQuotaRemainsVisibleInUsageAndOverviewTemplates() throws {
        typealias State = TokenMonitorActivityAttributes.ContentState
        let now = Date.now
        let state = State(updatedAt: now, usage: .init(today: .init(tokens: 1000, costUSD: 1), month: .init()),
            quotas: [.init(providerID: "codex", updatedAt: now, stale: false,
                           windows: [.init(label: "Weekly", kind: "weekly", remainingPercent: 40)]),
                     .init(providerID: "cursor", updatedAt: now.addingTimeInterval(-1000), stale: true,
                           windows: [.init(label: "Monthly", kind: "billing", remainingPercent: 5)])], agents: .none)
        var layout = LiveActivityLayout()
        layout.expanded = .usage
        layout.expandedSource = .init(providerID: "cursor")
        layout.lockScreen = .overview
        layout.lockScreenSource = .init(providerID: "cursor")
        let context = ActivityContext(state: state, layout: layout, isStale: false, now: now)
        let images: [(String, AnyView)] = [
            ("activity-expanded-usage-stale", AnyView(ActivityExpandedPreview(context: context))),
            ("activity-lock-overview-stale", AnyView(ActivityLockScreenView(context: context)))
        ]
        for (name, view) in images {
            let renderer = ImageRenderer(content: view.frame(width: 360).environment(\.colorScheme, .dark).background(Color.black))
            renderer.scale = 3
            let image = try #require(renderer.uiImage)
            write(image, name: name)
        }
    }
}
