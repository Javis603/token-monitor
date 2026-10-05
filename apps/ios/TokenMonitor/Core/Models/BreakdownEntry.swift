import Foundation

nonisolated struct BreakdownEntry: Identifiable, Sendable {
    let id: String
    let value: Double
    let cost: Double
}
