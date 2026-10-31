import Foundation

nonisolated extension Date {
    func updateDescription(
        relativeTo referenceDate: Date = .now,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        let seconds = max(0, referenceDate.timeIntervalSince(self))
        let unit: String
        let value: Int
        if seconds < 60 {
            return localizedUpdate(value: 0, unit: "now", locale: locale)
        } else if seconds < 3_600 {
            unit = "m"
            value = max(1, Int(seconds / 60))
        } else if seconds < 86_400 {
            unit = "h"
            value = max(1, Int(seconds / 3_600))
        } else {
            unit = "d"
            value = max(1, Int(seconds / 86_400))
        }
        return localizedUpdate(value: value, unit: unit, locale: locale)
    }

    /// Limits rows read like the desktop app: "Updated …", or "Stale · …" once
    /// the source report is stale.
    func limitFreshnessDescription(
        stale: Bool,
        relativeTo referenceDate: Date = .now,
        locale: Locale = .autoupdatingCurrent
    ) -> String {
        guard stale else {
            return updateDescription(relativeTo: referenceDate, locale: locale)
        }
        return "\(Self.staleWord(for: locale)) · \(ageText(relativeTo: referenceDate, locale: locale))"
    }

    static func staleWord(for locale: Locale) -> String {
        let identifier = locale.identifier.lowercased()
        if identifier.hasPrefix("zh") {
            return identifier.contains("hant")
                || identifier.contains("tw")
                || identifier.contains("hk") ? "已過期" : "已过期"
        }
        if identifier.hasPrefix("ja") { return "期限切れ" }
        if identifier.hasPrefix("ko") { return "오래됨" }
        return "Stale"
    }

    private func ageText(relativeTo referenceDate: Date, locale: Locale) -> String {
        let seconds = max(0, referenceDate.timeIntervalSince(self))
        let identifier = locale.identifier.lowercased()
        if identifier.hasPrefix("zh") {
            let traditional = identifier.contains("hant")
                || identifier.contains("tw")
                || identifier.contains("hk")
            if seconds < 60 { return "剛剛" }
            let (value, unit) = ageValue(seconds: seconds)
            let localizedUnit: String = switch unit {
            case "m": traditional ? "分鐘" : "分钟"
            case "h": traditional ? "小時" : "小时"
            default: "天"
            }
            return "\(value) \(localizedUnit)前"
        }
        if identifier.hasPrefix("ja") {
            if seconds < 60 { return "たった今" }
            let (value, unit) = ageValue(seconds: seconds)
            return "\(value)\(unit == "m" ? "分" : unit == "h" ? "時間" : "日")前"
        }
        if identifier.hasPrefix("ko") {
            if seconds < 60 { return "방금" }
            let (value, unit) = ageValue(seconds: seconds)
            return "\(value)\(unit == "m" ? "분" : unit == "h" ? "시간" : "일") 전"
        }
        if seconds < 60 { return "just now" }
        let (value, unit) = ageValue(seconds: seconds)
        return "\(value)\(unit) ago"
    }

    private func ageValue(seconds: Double) -> (Int, String) {
        if seconds < 3_600 {
            return (max(1, Int(seconds / 60)), "m")
        }
        if seconds < 86_400 {
            return (max(1, Int(seconds / 3_600)), "h")
        }
        return (max(1, Int(seconds / 86_400)), "d")
    }

    private func localizedUpdate(value: Int, unit: String, locale: Locale) -> String {
        let identifier = locale.identifier.lowercased()
        if identifier.hasPrefix("zh") {
            let traditional = identifier.contains("hant")
                || identifier.contains("tw")
                || identifier.contains("hk")
            if unit == "now" {
                return traditional ? "剛剛更新" : "刚刚更新"
            }
            let localizedUnit: String = switch unit {
            case "m": traditional ? "分鐘" : "分钟"
            case "h": traditional ? "小時" : "小时"
            default: "天"
            }
            return traditional
                ? "\(value) \(localizedUnit)前更新"
                : "\(value) \(localizedUnit)前更新"
        }
        if identifier.hasPrefix("ja") {
            if unit == "now" { return "たった今更新" }
            let localizedUnit = unit == "m" ? "分" : unit == "h" ? "時間" : "日"
            return "\(value)\(localizedUnit)前に更新"
        }
        if identifier.hasPrefix("ko") {
            if unit == "now" { return "방금 업데이트됨" }
            let localizedUnit = unit == "m" ? "분" : unit == "h" ? "시간" : "일"
            return "\(value)\(localizedUnit) 전 업데이트"
        }
        if unit == "now" { return "Updated just now" }
        return "Updated \(value)\(unit) ago"
    }
}
