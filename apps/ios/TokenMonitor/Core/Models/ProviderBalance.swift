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
}
