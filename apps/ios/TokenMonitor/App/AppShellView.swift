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
    private let sampleSettingsPage: String?

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
        #if DEBUG
        let pagePrefix = "--sample-settings-page="
        sampleSettingsPage = ProcessInfo.processInfo.arguments
            .first(where: { $0.hasPrefix(pagePrefix) })
            .map { String($0.dropFirst(pagePrefix.count)) }
        #else
        sampleSettingsPage = nil
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
                    .environment(\.symbolVariants, .none)
            }

            Tab(value: .limits) {
                NavigationStack(path: $limitsPath) {
                    LimitsView()
                }
            } label: {
                Label("Limits", systemImage: "gauge")
                    .environment(\.symbolVariants, .none)
            }

            Tab(value: .insights) {
                NavigationStack(path: $insightsPath) {
                    InsightsView()
                }
            } label: {
                Label("Insights", systemImage: "chart.line.uptrend.xyaxis")
                    .environment(\.symbolVariants, .none)
            }

            Tab(value: .settings) {
                NavigationStack(path: $settingsPath) {
                    #if DEBUG
                    switch sampleSettingsPage {
                    case "hub":
                        HubConnectionView()
                    case "live", "customizer":
                        LiveActivityCustomizerView()
                    case "widgets":
                        WidgetSettingsView()
                    default:
                        SettingsView()
                    }
                    #else
                    SettingsView()
                    #endif
                }
            } label: {
                Label("Settings", systemImage: "gearshape")
                    .environment(\.symbolVariants, .none)
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
            switch newPhase {
            case .active:
                Task {
                    await store.resume()
                }
            case .background:
                // One last fetch + Live Activity update while the system still
                // grants time; remote pushes take over afterwards.
                let taskID = UIApplication.shared.beginBackgroundTask()
                Task {
                    await store.refresh()
                    UIApplication.shared.endBackgroundTask(taskID)
                }
            default:
                break
            }
        }
    }
}
