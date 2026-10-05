import Foundation

extension HubStats {
    static var sample: HubStats {
        var today = UsagePeriod(
            totalTokens: 165_164_772,
            costUsd: 136.08,
            cacheReadTokens: 132_400_000,
            cacheWriteTokens: 4_800_000,
            outputTokens: 13_200_000,
            clients: [
                "codex": 104_000_000,
                "claude": 47_000_000,
                "hermes": 9_200_000,
                "opencode": 4_964_772
            ],
            clientCosts: [
                "codex": 82.41,
                "claude": 43.30,
                "hermes": 6.72,
                "opencode": 3.65
            ],
            models: [
                "gpt-5.5": 82_000_000,
                "claude-opus-4-8": 45_000_000,
                "gpt-5.6-sol": 27_000_000,
                "gemini-2.5-pro": 11_164_772
            ],
            modelCosts: [
                "gpt-5.5": 62,
                "claude-opus-4-8": 42,
                "gpt-5.6-sol": 20,
                "gemini-2.5-pro": 12.08
            ]
        )

        let sampleSessions = Data(#"{"design":{"client":"codex","sessionId":"design","title":"Refine usage dashboard","projectLabel":"Token Monitor","totalTokens":128400,"costUsd":0.42,"models":{"gpt-5.5":128400},"turnEnded":false},"widget":{"client":"claude","sessionId":"widget","title":"Improve widget layouts","projectLabel":"Token Monitor","totalTokens":84200,"costUsd":0.31,"models":{"claude-opus-4-8":84200},"turnEnded":true}}"#.utf8)
        today.sessions = try? JSONDecoder().decode([String: SessionUsage].self, from: sampleSessions)

        var month = UsagePeriod(
            totalTokens: 2_147_220_793,
            costUsd: 1_794.91,
            cacheReadTokens: 1_650_000_000,
            cacheWriteTokens: 73_000_000,
            outputTokens: 186_000_000,
            clients: today.clients,
            clientCosts: today.clientCosts,
            models: today.models,
            modelCosts: today.modelCosts
        )

        month.sessions = today.sessions

        let allTime = UsagePeriod(
            totalTokens: 5_837_996_083,
            costUsd: 5_025.25,
            cacheReadTokens: 4_300_000_000,
            cacheWriteTokens: 181_000_000,
            outputTokens: 496_000_000,
            clients: [
                "codex": 3_621_458_753,
                "claude": 1_794_070_610,
                "micode": 243_737_593,
                "hermes": 96_083_679,
                "antigravity": 64_943_946,
                "opencode": 13_849_814
            ],
            clientCosts: [
                "codex": 3_243.77,
                "claude": 1_422.12,
                "micode": 226.04,
                "hermes": 86.15,
                "antigravity": 32.68,
                "opencode": 8.37
            ],
            models: [
                "gpt-5.5": 2_600_000_000,
                "claude-opus-4-8": 1_800_000_000,
                "gpt-5.6-sol": 1_780_000_000
            ],
            modelCosts: [
                "gpt-5.5": 2_150,
                "claude-opus-4-8": 1_570,
                "gpt-5.6-sol": 1_305.25
            ]
        )

        return HubStats(
            updatedAt: Date.now.formatted(.iso8601),
            periods: [
                UsagePeriodKey.today.rawValue: today,
                UsagePeriodKey.month.rawValue: month,
                UsagePeriodKey.allTime.rawValue: allTime
            ],
            devices: sampleDevices(today: today, month: month, allTime: allTime),
            limits: LimitsSummary(
                updatedAt: Date.now.formatted(.iso8601),
                refreshMs: 300_000,
                providers: sampleLimits
            ),
            historyPreview: .sample,
            historyRevision: "preview",
            staleAfterMs: 600_000,
            projectsIncomplete: false
        )
    }

    private static func sampleDevices(
        today: UsagePeriod,
        month: UsagePeriod,
        allTime: UsagePeriod
    ) -> [DeviceSnapshot] {
        [
            DeviceSnapshot(
                deviceId: "macbook-m5",
                hostname: "macbook-m5",
                platform: "darwin-arm64",
                osName: "macOS",
                osVersion: "26.0",
                agentVersion: "0.38.0",
                updatedAt: Date.now.formatted(.iso8601),
                receivedAt: Date.now.formatted(.iso8601),
                ageMs: 12_000,
                stale: false,
                periods: [
                    UsagePeriodKey.today.rawValue: today,
                    UsagePeriodKey.month.rawValue: month,
                    UsagePeriodKey.allTime.rawValue: allTime
                ]
            ),
            DeviceSnapshot(
                deviceId: "9950x3d",
                hostname: "9950x3d",
                platform: "win32-x64",
                osName: "Windows",
                osVersion: "11 24H2",
                agentVersion: "0.38.0",
                updatedAt: Date.now.formatted(.iso8601),
                receivedAt: Date.now.formatted(.iso8601),
                ageMs: 34_000,
                stale: false,
                periods: [
                    UsagePeriodKey.today.rawValue: UsagePeriod(
                        totalTokens: 16_700,
                        costUsd: 0.02,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        outputTokens: 1_400,
                        clients: ["codex": 16_700],
                        clientCosts: ["codex": 0.02],
                        models: ["gpt-5.5": 16_700],
                        modelCosts: ["gpt-5.5": 0.02]
                    )
                ]
            )
        ]
    }

    /// Mirrors the real Hub shape: alphabetical by provider id then account
    /// label, `planLabel` empty with the plan in `accountLabel`, three Codex
    /// accounts, one signed-out provider, and a Command Code "GOAT" account.
    private static var sampleLimits: [LimitProvider] {
        [
            LimitProvider(
                provider: "claude",
                accountKey: "claude-sample",
                accountLabel: "Max",
                planLabel: "",
                accountName: "Javis",
                accountEmail: "javis@example.com",
                workspaceKind: nil,
                status: "ok",
                source: "web",
                sourceDetail: nil,
                updatedAt: Date.now.formatted(.iso8601),
                windows: [
                    LimitWindow(
                        kind: "session",
                        metric: nil,
                        label: "Session",
                        used: nil,
                        limit: nil,
                        remaining: nil,
                        usedPercent: 1,
                        remainingPercent: 99,
                        resetsAt: Date.now.addingTimeInterval(7_200).formatted(.iso8601),
                        resetDescription: "",
                        detail: "",
                        currency: nil,
                        showMeter: true
                    ),
                    LimitWindow(
                        kind: "weekly",
                        metric: nil,
                        label: "Weekly",
                        used: nil,
                        limit: nil,
                        remaining: nil,
                        usedPercent: 65,
                        remainingPercent: 35,
                        resetsAt: Date.now.addingTimeInterval(248_400).formatted(.iso8601),
                        resetDescription: "",
                        detail: "",
                        currency: nil,
                        showMeter: true
                    )
                ],
                balanceUsd: nil,
                balance: nil,
                sourceDeviceId: "macbook-m5",
                stale: false
            ),
            sampleCodexAccount(key: "codex-sample", email: "javis@icloud.com", name: "Javis", weekly: 88),
            sampleCodexAccount(key: "codex-secondary", email: "sample@example.com", name: "Sample", weekly: 55),
            sampleCodexAccount(key: "codex-third", email: "demo@example.com", name: "Demo", weekly: 51),
            LimitProvider(
                provider: "commandcode",
                accountKey: "commandcode-sample",
                accountLabel: "GOAT",
                planLabel: "",
                accountName: nil,
                accountEmail: nil,
                workspaceKind: "personal",
                status: "ok",
                source: "local",
                sourceDetail: nil,
                updatedAt: Date.now.formatted(.iso8601),
                windows: [
                    LimitWindow(
                        kind: "session",
                        metric: nil,
                        label: "Session",
                        used: nil,
                        limit: nil,
                        remaining: nil,
                        usedPercent: 30,
                        remainingPercent: 70,
                        resetsAt: Date.now.addingTimeInterval(10_800).formatted(.iso8601),
                        resetDescription: "",
                        detail: "",
                        currency: nil,
                        showMeter: true
                    ),
                    LimitWindow(
                        kind: "weekly",
                        metric: nil,
                        label: "Weekly",
                        used: nil,
                        limit: nil,
                        remaining: nil,
                        usedPercent: 42,
                        remainingPercent: 58,
                        resetsAt: Date.now.addingTimeInterval(356_400).formatted(.iso8601),
                        resetDescription: "",
                        detail: "",
                        currency: nil,
                        showMeter: true
                    )
                ],
                balanceUsd: nil,
                balance: nil,
                sourceDeviceId: "macbook-m5",
                stale: false
            ),
            LimitProvider(
                provider: "cursor",
                accountKey: "cursor-sample",
                accountLabel: "",
                planLabel: "",
                accountName: nil,
                accountEmail: nil,
                workspaceKind: nil,
                status: "notConfigured",
                source: nil,
                sourceDetail: nil,
                updatedAt: Date.now.formatted(.iso8601),
                windows: [],
                balanceUsd: nil,
                balance: nil,
                sourceDeviceId: "macbook-m5",
                stale: false
            ),
            LimitProvider(
                provider: "opencode",
                accountKey: "opencode-sample",
                accountLabel: "Go",
                planLabel: "",
                accountName: "OpenCode",
                accountEmail: nil,
                workspaceKind: nil,
                status: "ok",
                source: "local",
                sourceDetail: nil,
                updatedAt: Date.now.formatted(.iso8601),
                windows: [
                    LimitWindow(
                        kind: "session",
                        metric: nil,
                        label: "Session",
                        used: nil,
                        limit: nil,
                        remaining: nil,
                        usedPercent: 0,
                        remainingPercent: 100,
                        resetsAt: Date.now.addingTimeInterval(18_000).formatted(.iso8601),
                        resetDescription: "",
                        detail: "",
                        currency: nil,
                        showMeter: true
                    ),
                    LimitWindow(
                        kind: "monthly",
                        metric: nil,
                        label: "Monthly",
                        used: nil,
                        limit: nil,
                        remaining: nil,
                        usedPercent: 0,
                        remainingPercent: 100,
                        resetsAt: Date.now.addingTimeInterval(1_987_200).formatted(.iso8601),
                        resetDescription: "",
                        detail: "",
                        currency: nil,
                        showMeter: true
                    )
                ],
                balanceUsd: nil,
                balance: nil,
                sourceDeviceId: "macbook-m5",
                stale: false
            )
        ]
    }

    private static func sampleCodexAccount(
        key: String,
        email: String,
        name: String,
        weekly: Double
    ) -> LimitProvider {
        LimitProvider(
            provider: "codex", accountKey: key, accountLabel: "Plus", planLabel: "",
            accountName: name, accountEmail: email, workspaceKind: nil,
            status: "ok", source: "oauth", sourceDetail: nil,
            updatedAt: Date.now.formatted(.iso8601),
            windows: [
                LimitWindow(
                    kind: "session", metric: nil, label: "Session",
                    used: nil, limit: nil, remaining: nil, usedPercent: 2, remainingPercent: 98,
                    resetsAt: Date.now.addingTimeInterval(15_420).formatted(.iso8601),
                    resetDescription: "", detail: "", currency: nil, showMeter: true
                ),
                LimitWindow(
                    kind: "weekly", metric: nil, label: "Weekly",
                    used: nil, limit: nil, remaining: nil, usedPercent: 100 - weekly, remainingPercent: weekly,
                    resetsAt: Date.now.addingTimeInterval(410_400).formatted(.iso8601),
                    resetDescription: "", detail: "", currency: nil, showMeter: true
                )
            ],
            balanceUsd: nil, balance: nil, sourceDeviceId: "macbook-m5", stale: false
        )
    }
}
