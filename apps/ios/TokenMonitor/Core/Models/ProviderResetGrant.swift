import Foundation

nonisolated struct ProviderResetGrant: Decodable, Sendable {
    var id: String? = nil
    var label: String? = nil
    var resetsLeft: Int? = nil
    var resetsTotal: Int? = nil
    var startsAt: String? = nil
    var endsAt: String? = nil
    var clears: [String]? = nil
    var usableNow: Bool? = nil
    var useRequiresLimit: Bool? = nil
    var paused: Bool? = nil

    var clearedWindowLabels: [String] {
        (clears ?? []).filter {
            $0 != "seven_day_overage_included" || !(clears ?? []).contains("seven_day")
        }.map { key in
            switch key {
            case "five_hour": "Session"
            case "seven_day": "Weekly"
            case "seven_day_overage_included": "Fable weekly"
            default: key.replacingOccurrences(of: "seven_day_", with: "")
                .replacingOccurrences(of: "_", with: " ").capitalized + (key.hasPrefix("seven_day_") ? " weekly" : "")
            }
        }
    }
}
