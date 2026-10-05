import SwiftUI

struct ConnectionBadge: View {
    let phase: ConnectionPhase

    var body: some View {
        Label(title, systemImage: symbol)
            .font(.caption)
            .bold()
            .foregroundStyle(color)
            .padding(.horizontal, 10)
            .frame(minHeight: 28)
            .background(color.opacity(0.13), in: .capsule)
            .accessibilityLabel(accessibilityLabel)
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

    private var accessibilityLabel: String {
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
