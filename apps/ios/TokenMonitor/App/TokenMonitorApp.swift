import SwiftUI
import WidgetKit

@main
struct TokenMonitorApp: App {
    @State private var store: TokenMonitorStore
    @State private var settings: ConnectionSettings
    @State private var preferences: AppPreferences
    @State private var liveActivityController: LiveActivityController

    private let snapshotStore: SharedSnapshotStore
    private let systemSurfaces: SystemSurfaceCoordinator
    private let usesSampleData: Bool

    init() {
        #if DEBUG
        let usesSampleData = ProcessInfo.processInfo.arguments.contains("--sample-data")
        #else
        let usesSampleData = false
        #endif
        let snapshotStore = SharedSnapshotStore()
        let liveActivityController = LiveActivityController()
        let systemSurfaces = SystemSurfaceCoordinator(
            snapshotStore: snapshotStore,
            liveActivityController: liveActivityController
        )
        self.snapshotStore = snapshotStore
        self.systemSurfaces = systemSurfaces
        self.usesSampleData = usesSampleData
        _store = State(
            initialValue: usesSampleData
                ? TokenMonitorStore.preview
                : TokenMonitorStore(systemSurfaces: systemSurfaces)
        )
        _settings = State(initialValue: ConnectionSettings())
        _preferences = State(
            initialValue: AppPreferences(snapshotStore: snapshotStore)
        )
        _liveActivityController = State(initialValue: liveActivityController)
    }

    var body: some Scene {
        WindowGroup {
            AppShellView()
                .environment(store)
                .environment(settings)
                .environment(preferences)
                .environment(liveActivityController)
                .environment(\.locale, preferences.language.locale)
                .preferredColorScheme(preferences.appearance.colorScheme)
                .task {
                    await start()
                }
        }
        .backgroundTask(.appRefresh(SystemSurfaceCoordinator.backgroundTaskIdentifier)) {
            await systemSurfaces.performBackgroundRefresh()
        }
    }

    private func start() async {
        if usesSampleData {
            #if DEBUG
            let snapshot = TokenMonitorSharedPayload.Snapshot.make(
                stats: .sample,
                history: .sample
            )
            var surfacePreferences = preferences.sharedPreferences
            try? snapshotStore.updateSnapshot(snapshot)
            try? snapshotStore.updatePreferences(surfacePreferences)
            WidgetCenter.shared.reloadAllTimelines()

            if ProcessInfo.processInfo.arguments.contains("--sample-live-activity") {
                // Debug layout overrides for screenshots, e.g.
                // --sample-live-leading=ring --sample-live-trailing=reset
                // --sample-live-expanded=gauge --sample-live-lock=rings
                let arguments = ProcessInfo.processInfo.arguments
                func option(_ name: String) -> String? {
                    let prefix = "--sample-live-\(name)="
                    return arguments.first(where: { $0.hasPrefix(prefix) })
                        .map { String($0.dropFirst(prefix.count)) }
                }
                var layout = preferences.liveLayout
                if let value = option("leading").flatMap(LiveActivityLayout.CompactStyle.init) {
                    layout.compactLeading.style = value
                }
                if let value = option("trailing").flatMap(LiveActivityLayout.CompactStyle.init) {
                    layout.compactTrailing.style = value
                }
                if let value = option("minimal").flatMap(LiveActivityLayout.MinimalStyle.init) {
                    layout.minimal = value
                }
                if let value = option("expanded").flatMap(LiveActivityLayout.ExpandedTemplate.init) {
                    layout.expanded = value
                }
                if let value = option("lock").flatMap(LiveActivityLayout.LockScreenTemplate.init) {
                    layout.lockScreen = value
                }
                preferences.liveLayout = layout
                surfacePreferences = preferences.sharedPreferences
                surfacePreferences.liveActivityEnabled = true
                try? snapshotStore.updatePreferences(surfacePreferences)
                await liveActivityController.setEnabled(
                    true,
                    snapshot: snapshot,
                    preferences: surfacePreferences
                )
            }
            #endif
            return
        }
        store.configure(settings.configuration)
        systemSurfaces.scheduleBackgroundRefresh()
        let payload = try? snapshotStore.load()
        await liveActivityController.setEnabled(
            preferences.liveActivityEnabled,
            snapshot: payload?.snapshot,
            preferences: preferences.sharedPreferences
        )
    }
}
