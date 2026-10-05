import Foundation

actor HubClient {
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(session: URLSession = .shared) {
        self.session = session
    }

    func fetchStats(configuration: HubConfiguration) async throws -> HubStats {
        try await fetch(HubStats.self, path: "api/stats", configuration: configuration)
    }

    func fetchHistory(configuration: HubConfiguration) async throws -> UsageHistory {
        try await fetch(UsageHistory.self, path: "api/history", configuration: configuration)
    }

    func registerLiveActivity(
        activityID: String,
        pushToken: Data,
        preferences: TokenMonitorSharedPayload.Preferences,
        locale: String,
        configuration: HubConfiguration
    ) async throws -> Bool {
        let payload = LiveActivityRegistrationPayload(
            activityID: activityID,
            token: pushToken.map { String(format: "%02x", $0) }.joined(),
            preferences: preferences,
            locale: locale
        )
        var request = request(
            path: "api/live-activities/register",
            configuration: configuration
        )
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(payload)
        let (data, response) = try await session.data(for: request)
        try Self.validate(response)
        let result = try decoder.decode(
            LiveActivityRegistrationResponse.self,
            from: data
        )
        return result.pushEnabled
    }

    func unregisterLiveActivity(
        activityID: String,
        configuration: HubConfiguration
    ) async throws {
        var request = request(
            path: "api/live-activities/\(activityID)",
            configuration: configuration
        )
        request.httpMethod = "DELETE"
        let (_, response) = try await session.data(for: request)
        try Self.validate(response)
    }

    func statsStream(
        configuration: HubConfiguration
    ) -> AsyncThrowingStream<HubStats, any Error> {
        let request = request(path: "api/stats/stream", configuration: configuration)
        let session = session

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request)
                    try Self.validate(response)
                    var parser = SSEDecoder()
                    let eventDecoder = JSONDecoder()
                    for try await line in bytes.lines {
                        try Task.checkCancellation()
                        if let stats = try parser.consume(line: line, decoder: eventDecoder) {
                            continuation.yield(stats)
                        }
                    }
                    continuation.finish(throwing: HubClientError.streamEnded)
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    private func fetch<Value: Decodable & Sendable>(
        _ type: Value.Type,
        path: String,
        configuration: HubConfiguration
    ) async throws -> Value {
        let (data, response) = try await session.data(
            for: request(path: path, configuration: configuration)
        )
        try Self.validate(response)
        return try decoder.decode(type, from: data)
    }

    private func request(path: String, configuration: HubConfiguration) -> URLRequest {
        var request = URLRequest(url: configuration.baseURL.appending(path: path))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !configuration.secret.isEmpty {
            request.setValue(
                "Bearer \(configuration.secret)",
                forHTTPHeaderField: "Authorization"
            )
        }
        return request
    }

    private static func validate(_ response: URLResponse) throws {
        guard let response = response as? HTTPURLResponse else {
            throw HubClientError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            throw HubClientError.httpStatus(response.statusCode)
        }
    }
}

nonisolated struct LiveActivityRegistrationPayload: Encodable, Sendable {
    let activityID: String
    let token: String
    let preferences: TokenMonitorSharedPayload.Preferences
    let locale: String
}

nonisolated struct LiveActivityRegistrationResponse: Decodable, Sendable {
    let pushEnabled: Bool

    private enum CodingKeys: String, CodingKey {
        case pushEnabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        pushEnabled = try container.decodeIfPresent(Bool.self, forKey: .pushEnabled) ?? false
    }
}
