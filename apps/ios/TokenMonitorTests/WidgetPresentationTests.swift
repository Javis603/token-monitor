import Foundation
import Testing
@testable import TokenMonitor

struct WidgetPresentationTests {
    private let reference = Date(timeIntervalSince1970: 1_800_000_000)

    private func age(_ seconds: TimeInterval) -> String {
        WidgetPresentation.compactAge(
            since: reference.addingTimeInterval(-seconds),
            now: reference
        )
    }

    @Test func compactAgeBoundaries() {
        #expect(age(0) == "now")
        #expect(age(59) == "now")
        #expect(age(60) == "1m")
        #expect(age(300) == "5m")
        #expect(age(3_599) == "59m")
        #expect(age(3_600) == "1h")
        #expect(age(10_800) == "3h")
        #expect(age(86_399) == "23h")
        #expect(age(86_400) == "1d")
        #expect(age(172_800) == "2d")
    }
}
