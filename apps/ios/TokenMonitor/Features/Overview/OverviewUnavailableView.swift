import SwiftUI

struct OverviewUnavailableView: View {
    let phase: ConnectionPhase
    let openSettings: () -> Void

    var body: some View {
        ContentUnavailableView {
            Label(LocalizedStringKey(title), systemImage: symbol)
        } description: {
            Text(LocalizedStringKey(message))
        } actions: {
            Button("Open Settings", action: openSettings)
                .modifier(AppActionStyle())
        }
    }

    private var title: String {
        switch phase {
        case .idle: "Connect Your Hub"
        case .connecting: "Connecting"
        case .live: "No Usage Yet"
        case .failed: "Hub Unavailable"
        }
    }

    private var symbol: String {
        switch phase {
        case .idle: "link.badge.plus"
        case .connecting: "arrow.trianglehead.2.clockwise.rotate.90"
        case .live: "chart.bar"
        case .failed: "exclamationmark.icloud"
        }
    }

    private var message: String {
        switch phase {
        case .idle:
            "Add the Hub URL and shared secret. This app only reads data already collected by your devices."
        case .connecting:
            "Establishing a secure live connection to Token Monitor Hub."
        case .live:
            "The Hub is connected but has not reported usage."
        case let .failed(error):
            error
        }
    }
}
