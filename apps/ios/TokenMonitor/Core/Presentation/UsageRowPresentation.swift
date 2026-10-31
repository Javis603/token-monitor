import Foundation

nonisolated enum UsageRowPresentation {
    static func fraction(_ value: Double?, maximum: Double) -> Double? {
        guard let value, value.isFinite, value >= 0 else { return nil }
        guard maximum.isFinite, maximum > 0, value > 0 else { return 0 }
        // Desktop ranks bars against the largest row, with a 2% floor for nonzero usage.
        return max(0.02, min(1, value / maximum))
    }

    static func maximum(_ values: [Double?]) -> Double {
        values.compactMap { $0 }.filter { $0.isFinite && $0 > 0 }.max() ?? 0
    }

    static func share(_ value: Double, total: Double) -> Double {
        guard value.isFinite, value >= 0, total.isFinite, total > 0 else { return 0 }
        return min(1, value / total)
    }
}
