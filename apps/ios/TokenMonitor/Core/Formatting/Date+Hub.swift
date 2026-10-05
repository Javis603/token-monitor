import Foundation

extension Date {
    nonisolated static func hubTimestamp(from value: String?) -> Date? {
        guard let value, !value.isEmpty else {
            return nil
        }
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) {
            return date
        }
        return try? Date.ISO8601FormatStyle().parse(value)
    }

    nonisolated static func hubDay(from value: String?) -> Date? {
        componentsDate(from: value, expectedComponents: 3)
    }

    nonisolated static func hubMonth(from value: String?) -> Date? {
        componentsDate(from: value, expectedComponents: 2)
    }

    nonisolated private static func componentsDate(
        from value: String?,
        expectedComponents: Int
    ) -> Date? {
        guard let value else {
            return nil
        }
        let parts = value.split(separator: "-").compactMap { Int($0) }
        guard parts.count == expectedComponents else {
            return nil
        }
        var components = DateComponents()
        components.calendar = Calendar(identifier: .gregorian)
        components.timeZone = TimeZone(secondsFromGMT: 0)
        components.year = parts[0]
        components.month = parts[1]
        components.day = expectedComponents == 3 ? parts[2] : 1
        return components.date
    }
}
