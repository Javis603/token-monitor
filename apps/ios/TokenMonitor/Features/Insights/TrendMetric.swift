import Foundation

enum TrendMetric: String, CaseIterable, Identifiable {
    case tokens
    case cost

    var id: Self { self }

    var label: String {
        switch self {
        case .tokens: "Tokens"
        case .cost: "Cost"
        }
    }
}
