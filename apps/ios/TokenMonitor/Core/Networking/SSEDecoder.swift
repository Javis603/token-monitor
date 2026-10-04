import Foundation

// Parse bytes ourselves: AsyncBytes.lines is a text convenience, whereas SSE
// requires preserving empty lines and accepting CR, LF and CRLF delimiters.
nonisolated struct SSEDecoder {
    static let maximumEventBytes = 16 * 1_024 * 1_024
    private var lineBytes: [UInt8] = []
    private var previousWasCR = false
    private var firstLine = true
    private var dataLines: [String] = []
    private var eventBytes = 0
    private var baseline: [String: Any]?

    mutating func consume(byte: UInt8, decoder: JSONDecoder) throws -> HubStats? {
        if byte == 10, previousWasCR {
            previousWasCR = false
            return nil
        }
        previousWasCR = byte == 13
        if byte == 10 || byte == 13 {
            var line = String(decoding: lineBytes, as: UTF8.self)
            lineBytes.removeAll(keepingCapacity: true)
            if firstLine {
                firstLine = false
                if line.hasPrefix("\u{FEFF}") { line.removeFirst() }
            }
            return try consume(line: line, decoder: decoder)
        }
        guard lineBytes.count < Self.maximumEventBytes else {
            throw HubClientError.invalidResponse
        }
        lineBytes.append(byte)
        return nil
    }

    mutating func consume(line: String, decoder: JSONDecoder) throws -> HubStats? {
        if line.isEmpty {
            defer {
                dataLines.removeAll(keepingCapacity: true)
                eventBytes = 0
            }
            guard !dataLines.isEmpty else { return nil }
            let data = Data(dataLines.joined(separator: "\n").utf8)
            guard let event = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = event["type"] as? String,
                  let stats = event["stats"] as? [String: Any] else { return nil }
            switch type {
            case "stats":
                baseline = stats
            case "freshness":
                // A patch is meaningful only after this stream's full snapshot.
                guard var current = baseline else { return nil }
                for key in ["updatedAt", "staleAfterMs"] {
                    if let value = stats[key], !(value is NSNull) { current[key] = value }
                }
                if let patch = stats["limits"] as? [String: Any] {
                    var limits = current["limits"] as? [String: Any] ?? [:]
                    if let value = patch["updatedAt"] { limits["updatedAt"] = value }
                    current["limits"] = limits
                }
                let patches = stats["devices"] as? [[String: Any]] ?? []
                current["devices"] = (current["devices"] as? [[String: Any]] ?? []).map { device in
                    guard let id = device["deviceId"] as? String,
                          let patch = patches.first(where: { $0["deviceId"] as? String == id }) else {
                        return device
                    }
                    var merged = device
                    for key in ["updatedAt", "receivedAt", "ageMs", "stale"] {
                        if let value = patch[key] { merged[key] = value }
                    }
                    return merged
                }
                baseline = current
            default:
                return nil
            }
            return try decoder.decode(HubStats.self, from: JSONSerialization.data(withJSONObject: baseline!))
        }
        guard !line.hasPrefix(":") else { return nil }
        let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.first == "data" else { return nil }
        var value = parts.count > 1 ? String(parts[1]) : ""
        if value.hasPrefix(" ") { value.removeFirst() }
        eventBytes += value.utf8.count + 1
        guard eventBytes <= Self.maximumEventBytes else { throw HubClientError.invalidResponse }
        dataLines.append(value)
        return nil
    }
}
