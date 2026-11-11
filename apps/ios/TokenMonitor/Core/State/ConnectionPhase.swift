import Foundation

enum ConnectionPhase: Equatable {
    case idle
    case connecting
    case live
    case failed(String)
}
