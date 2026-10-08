import Foundation

nonisolated struct ModelAliasDocument: Decodable, Sendable {
    let revision: Int
    let value: ModelAliasSettings?
}
