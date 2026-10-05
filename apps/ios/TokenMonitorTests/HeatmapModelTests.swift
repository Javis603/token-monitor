import Foundation
import Testing
@testable import TokenMonitor

struct HeatmapModelTests {
    @Test
    func usesDesktopHeatmapIntensityThresholds() throws {
        let referenceDate = try #require(
            ISO8601DateFormatter().date(from: "2026-07-31T12:00:00Z")
        )
        let days = [
            HistoryDay(
                date: "2026-07-26",
                tokens: 100,
                cost: 10,
                messages: nil,
                activeTimeMs: nil
            ),
            HistoryDay(
                date: "2026-07-27",
                tokens: 75,
                cost: 7.5,
                messages: nil,
                activeTimeMs: nil
            ),
            HistoryDay(
                date: "2026-07-28",
                tokens: 50,
                cost: 5,
                messages: nil,
                activeTimeMs: nil
            ),
            HistoryDay(
                date: "2026-07-29",
                tokens: 25,
                cost: 2.5,
                messages: nil,
                activeTimeMs: nil
            ),
            HistoryDay(
                date: "2026-07-30",
                tokens: 1,
                cost: 0.1,
                messages: nil,
                activeTimeMs: nil
            )
        ]

        let model = HeatmapModel.make(
            days: days,
            metric: .tokens,
            weekCount: 1,
            referenceDate: referenceDate
        )
        let intensities = Dictionary(
            uniqueKeysWithValues: model.weeks
                .flatMap(\.cells)
                .filter { $0.tokens > 0 }
                .map { ($0.tokens, $0.intensity) }
        )

        #expect(intensities[100] == 4)
        #expect(intensities[75] == 4)
        #expect(intensities[50] == 3)
        #expect(intensities[25] == 2)
        #expect(intensities[1] == 1)
        #expect(model.activeDays == 5)
        #expect(model.peakValue == 100)
    }
}
