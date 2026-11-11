import Foundation

nonisolated struct SubscriptionDocument: Decodable, Sendable {
    let version: Int
    let updatedAt: String
    let subscriptions: [SharedSubscription]

    func monthlyTotalUSD(today: String) -> Double? {
        var total = 0.0
        for record in subscriptions {
            guard let amount = record.monthlyAmountUSD(today: today) else { return nil }
            total += amount
        }
        return total.isFinite ? total : nil
    }
}
