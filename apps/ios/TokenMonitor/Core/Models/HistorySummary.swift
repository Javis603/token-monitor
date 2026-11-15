import Foundation

nonisolated struct HistorySummary: Decodable, Sendable {
    let totalTokens: Double?
    let totalCost: Double?
    var unpricedTokens: Double? = nil
    let activeDays: Double?
    var activeDaysComplete: Bool? = nil

    var lifetimeActiveDays: Double? {
        activeDaysComplete == true ? activeDays : nil
    }
    let currentStreak: Double?
    let longestStreak: Double?
    let peakDayTokens: Double?
    let favoriteModel: String?
    let messages: Double?
    let activeTimeMs: Double?
}
