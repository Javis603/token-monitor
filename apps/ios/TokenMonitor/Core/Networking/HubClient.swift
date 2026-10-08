import Foundation

nonisolated protocol HubDataClient: Sendable {
    func fetchStats(configuration: HubConfiguration) async throws -> HubStats
    func fetchHistory(configuration: HubConfiguration) async throws -> UsageHistory
    func fetchModelAliases(configuration: HubConfiguration) async throws -> ModelAliasDocument?
    func statsStream(configuration: HubConfiguration) async -> AsyncThrowingStream<HubStats, any Error>
}

extension HubDataClient {
    func fetchModelAliases(configuration: HubConfiguration) async throws -> ModelAliasDocument? { nil }
}

nonisolated protocol LiveActivityClient: Sendable {
    func registerLiveActivity(activityID: String, pushToken: Data,
        preferences: TokenMonitorSharedPayload.Preferences, locale: String,
        configuration: HubConfiguration) async throws -> Bool
    func unregisterLiveActivity(activityID: String, configuration: HubConfiguration) async throws
}

// Credentials must never follow an HTTP redirect, even within the same host:
// a reverse proxy may redirect an authenticated API request to a login service.
nonisolated final class HubRedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

actor HubClient: HubDataClient, LiveActivityClient {
    private let session: URLSession
    private let decoder = JSONDecoder()

    private let redirectGuard = HubRedirectGuard()

    init(session: URLSession? = nil) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 60 * 60
        self.session = session ?? URLSession(configuration: configuration)
    }

    func fetchStats(configuration: HubConfiguration) async throws -> HubStats {
        try await fetch(HubStats.self, path: "api/stats", configuration: configuration)
    }

    func fetchHistory(configuration: HubConfiguration) async throws -> UsageHistory {
        try await fetch(UsageHistory.self, path: "api/history", configuration: configuration)
    }

    func fetchModelAliases(configuration: HubConfiguration) async throws -> ModelAliasDocument? {
        do {
            return try await fetch(ModelAliasDocument.self, path: "api/sync/settings/modelAliases", configuration: configuration)
        } catch HubClientError.httpStatus(404) {
            return nil
        }
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
        let (data, response) = try await session.data(for: request, delegate: redirectGuard)
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
        let (_, response) = try await session.data(for: request, delegate: redirectGuard)
        try Self.validate(response)
    }

    func statsStream(
        configuration: HubConfiguration
    ) -> AsyncThrowingStream<HubStats, any Error> {
        var request = request(path: "api/stats/stream", configuration: configuration)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("2", forHTTPHeaderField: "x-token-monitor-stream")
        let session = session

        return AsyncThrowingStream(bufferingPolicy: .bufferingNewest(1)) { continuation in
            let task = Task {
                do {
                    let (bytes, response) = try await session.bytes(for: request, delegate: redirectGuard)
                    try Self.validate(response)
                    guard response.mimeType?.lowercased() == "text/event-stream" else {
                        throw HubClientError.invalidResponse
                    }
                    var parser = SSEDecoder()
                    let eventDecoder = JSONDecoder()
                    for try await byte in bytes {
                        try Task.checkCancellation()
                        if let stats = try parser.consume(byte: byte, decoder: eventDecoder) {
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
            for: request(path: path, configuration: configuration), delegate: redirectGuard
        )
        try Self.validate(response)
        return try decoder.decode(type, from: data)
    }

    private func request(path: String, configuration: HubConfiguration) -> URLRequest {
        var request = URLRequest(url: configuration.baseURL.appending(path: path))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !configuration.secret.isEmpty {
            request.setValue(
                "Bearer \(configuration.secret)",
                forHTTPHeaderField: "Authorization"
            )
        }
        return request
    }

    nonisolated private static func validate(_ response: URLResponse) throws {
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
