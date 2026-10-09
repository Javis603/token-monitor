import Foundation

nonisolated struct HistoryMonth: Decodable, Identifiable, Sendable {
    let month: String?
    let tokens: Double?
    let cost: Double?
    let activeTimeMs: Double?
    var perClient: [String: ClientMessages]? = nil

    nonisolated struct ClientMessages: Decodable, Sendable {
        let messages: Double?
    }

    var messageCount: Double? {
        guard let perClient else { return nil }
        var count = 0.0
        for client in perClient.values {
            guard let messages = client.messages, messages.isFinite, messages >= 0 else { return nil }
            count += messages
        }
        return count.isFinite ? count : nil
    }

    var id: String { month ?? "unknown-month" }

    var dateValue: Date? {
        Date.hubMonth(from: month)
    }
}
