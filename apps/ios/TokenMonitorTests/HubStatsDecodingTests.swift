import Foundation
import Testing
@testable import TokenMonitor

struct HubStatsDecodingTests {
    @Test
    func decodesCurrentHubShapeAndToleratesMissingOptionalFields() throws {
        let json = """
        {
          "updatedAt": "2026-07-31T01:02:03.000Z",
          "periods": {
            "today": {
              "totalTokens": 123456,
              "costUsd": 1.25,
              "clients": { "codex": 100000, "claude": 23456 },
              "models": { "gpt-5.5": 123456 }
            }
          },
          "devices": [
            {
              "deviceId": "macbook",
              "hostname": "macbook",
              "platform": "darwin-arm64",
              "stale": false,
              "periods": {
                "today": { "totalTokens": 123456 }
              }
            }
          ],
          "limits": {
            "providers": [
              {
                "provider": "codex",
                "status": "ok",
                "windows": [
                  {
                    "kind": "weekly",
                    "remainingPercent": 88,
                    "resetsAt": "2026-08-06T00:00:00.000Z"
                  }
                ]
              }
            ]
          }
        }
        """

        let stats = try JSONDecoder().decode(HubStats.self, from: Data(json.utf8))

        #expect(stats.period(.today).totalTokens == 123_456)
        #expect(stats.period(.today).clientEntries.first?.id == "codex")
        #expect(stats.devices?.first?.displayName == "macbook")
        #expect(stats.sortedLimits.first?.provider == "codex")
        #expect(stats.sortedLimits.first?.lowestRemainingPercent == 88)
    }
}
