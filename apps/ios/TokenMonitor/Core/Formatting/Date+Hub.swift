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

    nonisolated static func hubDay(from value: String?, timeZone: TimeZone = .gmt) -> Date? {
        componentsDate(from: value, expectedComponents: 3, timeZone: timeZone)
    }

    nonisolated static func hubMonth(from value: String?, timeZone: TimeZone = .gmt) -> Date? {
        componentsDate(from: value, expectedComponents: 2, timeZone: timeZone)
    }

    nonisolated private static func componentsDate(
        from value: String?,
        expectedComponents: Int,
        timeZone: TimeZone
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
        // Wire keys retain their UTC representation by default. Display callers
        // can explicitly construct the same calendar label in their local zone.
        components.timeZone = timeZone
        components.year = parts[0]
        components.month = parts[1]
        components.day = expectedComponents == 3 ? parts[2] : 1
        return components.date
    }
}
