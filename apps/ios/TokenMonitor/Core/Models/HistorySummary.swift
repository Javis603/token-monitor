import Foundation

nonisolated struct HistorySummary: Decodable, Sendable {
    let totalTokens: Double?
    let totalCost: Double?
    let activeDays: Double?
    let currentStreak: Double?
    let longestStreak: Double?
    let peakDayTokens: Double?
    let favoriteModel: String?
    let messages: Double?
    let activeTimeMs: Double?
}
