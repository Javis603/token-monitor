import Foundation

nonisolated struct ProviderBalance: Decodable, Sendable {
    let amount: Double?
    let currency: String?
    let todaySpend: Double?
    let weekSpend: Double?
    let monthSpend: Double?
    let allTimeSpend: Double?
    let expiresAt: String?
    let giftBalance: Double?
    let cashBalance: Double?
    let planUsed: Double?
    let planLimit: Double?
    let planPercent: Double?
    let planStatus: String?

    struct Spend {
        let label: String
        let amount: Double
    }

    var spendEntries: [Spend] {
        [("Today", todaySpend), ("Week", weekSpend), ("Month", monthSpend), ("All time", allTimeSpend)]
            .compactMap { label, value in
                guard let value, value.isFinite, value >= 0 else { return nil }
                return Spend(label: label, amount: value)
            }
    }
}
