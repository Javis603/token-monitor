import SwiftUI

struct ConnectionBadge: View {
    let phase: ConnectionPhase

    var body: some View {
        Label(LocalizedStringKey(title), systemImage: symbol)
            .font(.caption)
            .bold()
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(color.opacity(0.13), in: .capsule)
            .accessibilityLabel(Text(accessibilityLabel))
    }

    private var title: String {
        switch phase {
        case .idle: "Not Set"
        case .connecting: "Connecting"
        case .live: "Live"
        case .failed: "Offline"
        }
    }

    private var symbol: String {
        switch phase {
        case .idle: "link.badge.plus"
        case .connecting: "arrow.trianglehead.2.clockwise.rotate.90"
        case .live: "dot.radiowaves.left.and.right"
        case .failed: "exclamationmark.triangle.fill"
        }
    }

    private var color: Color {
        switch phase {
        case .idle: .secondary
        case .connecting: .orange
        case .live: .green
        case .failed: .red
        }
    }

    private var accessibilityLabel: LocalizedStringKey {
        switch phase {
        case .idle:
            "Hub is not configured"
        case .connecting:
            "Connecting to Hub"
        case .live:
            "Hub is live"
        case let .failed(message):
            "Hub is offline. \(message)"
        }
    }
}

struct ConnectionStatusNotice: View {
    let phase: ConnectionPhase
    let retry: () -> Void

    var body: some View {
        switch phase {
        case let .failed(message):
            SurfaceCard {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Offline", systemImage: "wifi.slash")
                        .font(.headline)
                    Text("Showing the last received data. Pull to refresh or check your Hub connection.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    Button("Refresh", systemImage: "arrow.clockwise", action: retry)
                        .modifier(AppActionStyle())
                }
            }
        case .connecting:
            HStack(spacing: 10) {
                ProgressView()
                Text("Connecting to Hub")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        case .idle, .live:
            EmptyView()
        }
    }
}
