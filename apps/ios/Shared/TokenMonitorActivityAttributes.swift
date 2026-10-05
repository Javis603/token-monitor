import ActivityKit
import Foundation

nonisolated struct TokenMonitorActivityAttributes: ActivityAttributes {
    enum Field: String, Codable, CaseIterable, Identifiable, Sendable {
        case primary
        case secondary
        case provider
        case tokens
        case cost
        case limit
        case progress
        case updated
        case none

        var id: String { rawValue }

        var title: String {
            switch self {
            case .primary: "Primary metric"
            case .secondary: "Secondary metric"
            case .provider: "Provider"
            case .tokens: "Tokens"
            case .cost: "Cost"
            case .limit: "AI limit"
            case .progress: "Progress"
            case .updated: "Updated"
            case .none: "Off"
            }
        }

        var systemImage: String {
            switch self {
            case .primary: "chart.bar.fill"
            case .secondary: "rectangle.2.swap"
            case .provider: "building.2"
            case .tokens: "number"
            case .cost: "dollarsign.circle"
            case .limit: "gauge"
            case .progress: "chart.bar"
            case .updated: "clock"
            case .none: "minus"
            }
        }
    }

    struct ContentState: Codable, Hashable {
        let primaryLabel: String
        let primaryValue: String
        let secondaryLabel: String?
        let secondaryValue: String?
        let progress: Double?
        let updatedAt: Date
        let providerID: String?
        let providerName: String?
        let iconProviderID: String?
        let tokensValue: String?
        let costValue: String?
        let limitValue: String?
        let compactTrailingField: String?
        let expandedLeadingField: String?
        let expandedCenterField: String?
        let expandedTrailingField: String?
        let expandedBottomField: String?
        let lockScreenPrimaryField: String?
        let lockScreenSecondaryField: String?
        let lockScreenBottomField: String?
    }

    let title: String
}
