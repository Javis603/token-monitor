import Foundation

nonisolated enum HubClientError: LocalizedError, Sendable {
    case invalidResponse
    case httpStatus(Int)
    case streamEnded

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            "The Hub returned an invalid response."
        case let .httpStatus(status):
            status == 401
                ? "The Hub rejected the shared secret."
                : "The Hub returned HTTP \(status)."
        case .streamEnded:
            "The live connection ended."
        }
    }
}
