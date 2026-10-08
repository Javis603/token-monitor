import Foundation

nonisolated enum UsagePeriodKey: String, CaseIterable, Identifiable, Sendable {
    case today
    case month
    case allTime

    var id: Self { self }

    var shortLabel: String {
        switch self {
        case .today: "Day"
        case .month: "Month"
        case .allTime: "Total"
        }
    }

    var title: String {
        switch self {
        case .today: "Today"
        case .month: "This month"
        case .allTime: "All time"
        }
    }
}
