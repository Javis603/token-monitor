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
                surfacePreferences.liveActivityEnabled = true
                // Debug layout overrides for screenshots, e.g.
                // --sample-live-lock=combined --sample-live-expanded=usage
                // --sample-live-leading=ring --sample-live-trailing=cost
                let arguments = ProcessInfo.processInfo.arguments
                func option(_ name: String) -> String? {
                    let prefix = "--sample-live-\(name)="
                    return arguments.first(where: { $0.hasPrefix(prefix) })
                        .map { String($0.dropFirst(prefix.count)) }
                }
                if let value = option("lock") {
                    surfacePreferences.liveLockScreenStyle = value
                    preferences.liveLockScreenStyle =
                        .init(rawValue: value) ?? preferences.liveLockScreenStyle
                }
                if let value = option("expanded") {
                    surfacePreferences.liveExpandedStyle = value
                    preferences.liveExpandedStyle =
                        .init(rawValue: value) ?? preferences.liveExpandedStyle
                }
                if let value = option("leading") {
                    surfacePreferences.liveCompactLeading = value
                    preferences.liveCompactLeading =
                        .init(rawValue: value) ?? preferences.liveCompactLeading
                }
                if let value = option("trailing") {
                    surfacePreferences.liveCompactTrailing = value
                    preferences.liveCompactTrailing =
                        .init(rawValue: value) ?? preferences.liveCompactTrailing
                }
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
