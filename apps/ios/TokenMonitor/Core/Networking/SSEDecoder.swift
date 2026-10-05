import Foundation

nonisolated struct SSEDecoder {
    private var dataLines: [String] = []

    mutating func consume(line: String, decoder: JSONDecoder) throws -> HubStats? {
        if line.isEmpty {
            defer { dataLines.removeAll(keepingCapacity: true) }
            guard !dataLines.isEmpty else {
                return nil
            }
            let payload = dataLines.joined(separator: "\n")
            let event = try decoder.decode(HubStreamEvent.self, from: Data(payload.utf8))
            return event.stats
        }
        guard !line.hasPrefix(":") else {
            return nil
        }
        if line.hasPrefix("data:") {
            let value = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            dataLines.append(value)
        }
        return nil
    }
}
