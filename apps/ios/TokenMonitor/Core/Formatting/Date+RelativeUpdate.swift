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
