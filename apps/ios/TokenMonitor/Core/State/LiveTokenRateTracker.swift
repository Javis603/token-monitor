import Foundation

/// Swift counterpart of renderer/tokenRatePresentation.js. Each device keeps
/// independent model samples; its headline is duration weighted, fleet rates add.
nonisolated struct LiveTokenRateTracker {
    struct ModelReading: Identifiable {
        let id: String
        let tokensPerSecond: Double
        let timedOutput: Double
        let timedDuration: Double
    }
    struct DeviceReading: Identifiable {
        let id: String
        let name: String
        let models: [ModelReading]
    }
    struct Reading {
        let tokensPerSecond: Double
        let isIdle: Bool
        var devices: [DeviceReading] = []
        var deviceCount = 0
    }
    struct Counters: Sendable {
        let tokens: Double
        let output: Double
        let duration: Double
        init?(tokens: Double, output: Double, duration: Double) {
            guard [tokens, output, duration].allSatisfy({ $0.isFinite && $0 >= 0 }) else { return nil }
            self.tokens = tokens; self.output = output; self.duration = duration
        }
        static let zero = Counters(tokens: 0, output: 0, duration: 0)!
        func subtracting(_ other: Self) -> Self? {
            .init(tokens: tokens - other.tokens, output: output - other.output, duration: duration - other.duration)
        }
        func fits(_ other: Self) -> Bool {
            tokens <= other.tokens && output <= other.output && duration <= other.duration
        }
        var speed: Double { duration > 0 ? min(1e12, output / duration * 1_000) : 0 }
    }
    private struct Sample {
        let counters: Counters
        let at: Date
        var independent = false
        func isActive(at now: Date) -> Bool { (0..<8).contains(now.timeIntervalSince(at)) }
    }
    private struct Device {
        var name: String
        var baseline: Counters?
        var modelBaseline: [String: Counters]?
        var models: [String: Sample] = [:]
        var remainder: Sample?

        mutating func observe(_ period: UsagePeriod, resolver: [String: String], at now: Date) -> Bool {
            let current = period.capabilities?.throughput == false ? nil : Counters(
                tokens: period.timedTokens ?? 0, output: period.timedOutputTokens ?? .nan,
                duration: period.timedDurationMs ?? .nan)
            let modelCounters = period.modelThroughput.map { throughput in
                throughput.reduce(into: [String: Counters]()) { result, entry in
                    guard let counters = entry.value.counters else { return }
                    let id = resolver[entry.key] ?? entry.key
                    let prior = result[id] ?? .zero
                    result[id] = Counters(tokens: prior.tokens + counters.tokens,
                        output: prior.output + counters.output, duration: prior.duration + counters.duration)
                }
            }
            let previous = baseline, previousModels = modelBaseline
            baseline = current; modelBaseline = modelCounters
            guard let current else {
                let invalidated = !models.isEmpty || remainder != nil
                models = [:]; remainder = nil
                return invalidated
            }
            guard let previous else { return false }
            guard let delta = current.subtracting(previous) else {
                let invalidated = !models.isEmpty || remainder != nil
                models = [:]; remainder = nil
                return invalidated
            }
            guard delta.duration > 0 else { return false }
            var next: [String: Sample] = [:]
            var tokens = 0.0, output = 0.0, duration = 0.0
            var consistent = modelCounters != nil && previousModels != nil
            if let modelCounters, let previousModels {
                consistent = previousModels.allSatisfy { id, prior in
                    modelCounters[id]?.subtracting(prior) != nil
                }
                if consistent {
                    for (id, value) in modelCounters {
                        guard let change = value.subtracting(previousModels[id] ?? .zero), change.fits(delta) else {
                            consistent = false; break
                        }
                        if change.duration > 0 {
                            tokens += change.tokens; output += change.output; duration += change.duration
                            next[id] = Sample(counters: change, at: now)
                        } else if change.tokens == 0 && change.output == 0 {
                            if let retained = models[id], retained.isActive(at: now) { next[id] = retained }
                        } else { consistent = false; break }
                    }
                }
            }
            let rest = Counters(tokens: delta.tokens - tokens, output: delta.output - output,
                                duration: delta.duration - duration)
            if consistent, let rest, rest.duration > 0 || (rest.tokens == 0 && rest.output == 0) {
                models = next
                if rest.duration > 0 { remainder = Sample(counters: rest, at: now, independent: true) }
                else if remainder?.independent != true || remainder?.isActive(at: now) != true { remainder = nil }
            } else {
                models = [:]; remainder = Sample(counters: delta, at: now)
            }
            return false
        }
        func active(at now: Date) -> [(String?, Sample)] {
            models.filter { $0.value.isActive(at: now) }.map { (Optional($0.key), $0.value) }
                + (remainder.flatMap { $0.isActive(at: now) ? [(nil, $0)] : nil } ?? [])
        }
    }
    private var devices: [String: Device] = [:]
    private var lastDisplay: (reading: Reading, at: Date)?

    mutating func reset() { devices = [:]; lastDisplay = nil }

    mutating func observe(_ stats: HubStats, aliases: ModelAliasSettings = .init(), at now: Date) {
        let entries: [(String, String, UsagePeriod)]
        if let sources = stats.devices, !sources.isEmpty {
            entries = sources.filter { $0.stale != true }.map { ($0.id, $0.displayName, $0.period(.today)) }
        } else { entries = [("aggregate", "", stats.period(.today))] }
        let periods = Array((stats.periods ?? [:]).values)
            + (stats.devices ?? []).flatMap { Array(($0.periods ?? [:]).values) }
        let ids = periods.flatMap { period in
            Array((period.models ?? [:]).keys) + Array((period.modelThroughput ?? [:]).keys)
                + (period.sessions ?? [:]).values.flatMap { Array(($0.models ?? [:]).keys) }
        }
        let resolver = aliases.resolver(modelIDs: ids)
        devices = devices.filter { key, _ in entries.contains { $0.0 == key } }
        for (id, name, period) in entries {
            var device = devices[id] ?? Device(name: name)
            device.name = name
            if device.observe(period, resolver: resolver, at: now) { lastDisplay = nil }
            devices[id] = device
        }
        if let live = liveReading(at: now) { lastDisplay = live }
    }

    mutating func reading(at now: Date) -> Reading? {
        if let live = liveReading(at: now) {
            lastDisplay = live
            return live.reading
        }
        guard let lastDisplay, (0..<180).contains(now.timeIntervalSince(lastDisplay.at)) else { return nil }
        return Reading(tokensPerSecond: lastDisplay.reading.tokensPerSecond, isIdle: true,
                       devices: [], deviceCount: 0)
    }

    private func liveReading(at now: Date) -> (reading: Reading, at: Date)? {
        var total = 0.0, latest = Date.distantPast, count = 0
        var rows: [DeviceReading] = []
        for (id, device) in devices.sorted(by: { $0.key < $1.key }) {
            let parts = device.active(at: now)
            guard !parts.isEmpty else { continue }
            count += 1
            let duration = parts.reduce(0) { $0 + $1.1.counters.duration }
            if duration > 0 { total += parts.reduce(0) { $0 + $1.1.counters.output } / duration * 1_000 }
            latest = max(latest, parts.map { $0.1.at }.max() ?? .distantPast)
            let models = parts.compactMap { key, sample -> ModelReading? in
                key.map { ModelReading(id: $0, tokensPerSecond: sample.counters.speed,
                                     timedOutput: sample.counters.output, timedDuration: sample.counters.duration) }
            }.sorted { $0.id < $1.id }
            if !models.isEmpty { rows.append(DeviceReading(id: id, name: device.name, models: models)) }
        }
        guard count > 0 else { return nil }
        return (Reading(tokensPerSecond: min(1e12, total), isIdle: false, devices: rows, deviceCount: count), latest)
    }
}
