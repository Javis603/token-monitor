import SwiftUI

struct AppShellView: View {
    @Environment(TokenMonitorStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase

    @State private var selectedTab: AppTab = .overview
    @State private var overviewPath = NavigationPath()
    @State private var limitsPath = NavigationPath()
    @State private var insightsPath = NavigationPath()
    @State private var settingsPath = NavigationPath()
    private let sampleDetail: String?

    private enum OverviewDestination: Hashable {
        case sessions
    }

    init() {
        #if DEBUG
        let prefix = "--sample-tab="
        let selectedName = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix(prefix) })
            .map { String($0.dropFirst(prefix.count)) }
        let selected: AppTab? = switch selectedName {
        case "limits": .limits
        case "insights": .insights
        case "settings": .settings
        case "overview": .overview
        default: nil
        }
        _selectedTab = State(initialValue: selected ?? .overview)
        let detailPrefix = "--sample-detail="
        sampleDetail = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix(detailPrefix) })
            .map { String($0.dropFirst(detailPrefix.count)) }
        #else
        sampleDetail = nil
        #endif
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            Tab(value: .overview) {
                NavigationStack(path: $overviewPath) {
                    Group {
                    if sampleDetail == "tools" {
                        BreakdownDetailView(kind: .tool)
                    } else if sampleDetail == "models" {
                        BreakdownDetailView(kind: .model)
                    } else if sampleDetail == "sessions" {
                        SessionsView()
                    } else {
                        OverviewView(selectedTab: $selectedTab)
                    }
                    }
                    // Sessions remains an Overview destination, preserving native back navigation.
                    .navigationDestination(for: OverviewDestination.self) { _ in
                        SessionsView()
                    }
                }
            } label: {
                Label("Overview", systemImage: "house")
            }

            Tab(value: .limits) {
                NavigationStack(path: $limitsPath) {
                    LimitsView()
                }
            } label: {
                Label("Limits", systemImage: "gauge")
            }

            Tab(value: .insights) {
                NavigationStack(path: $insightsPath) {
                    InsightsView()
                }
            } label: {
                Label("Insights", systemImage: "chart.line.uptrend.xyaxis")
            }

            Tab(value: .settings) {
                NavigationStack(path: $settingsPath) {
                    SettingsView()
                }
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
        }
        .tint(DesignTokens.accent)
        .tabBarMinimizeBehavior(.never)
        .onOpenURL { url in
            guard let tab = AppTab(url: url) else {
                return
            }
            selectedTab = tab
            switch tab {
            case .overview:
                overviewPath = NavigationPath()
                if AppTab.opensSessions(url) {
                    overviewPath.append(OverviewDestination.sessions)
                }
            case .limits: limitsPath = NavigationPath()
            case .insights: insightsPath = NavigationPath()
            case .settings: settingsPath = NavigationPath()
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            guard newPhase == .active else {
                return
            }
            Task {
                await store.resume()
            }
        }
    }
}
