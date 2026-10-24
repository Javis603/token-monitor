import AppIntents

struct ProviderEntity: AppEntity {
    let id: String
    let name: String

    static let typeDisplayRepresentation = TypeDisplayRepresentation(
        name: "AI Provider"
    )

    static let defaultQuery = ProviderEntityQuery()

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)")
    }
}

struct ProviderEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [ProviderEntity] {
        ([allProviders] + availableProviders()).filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [ProviderEntity] {
        [allProviders] + availableProviders()
    }

    /// An explicit automatic choice can override a named provider in the
    /// app defaults; nil continues to mean "follow app" for existing widgets.
    private var allProviders: ProviderEntity {
        ProviderEntity(id: "all", name: String(localized: "All providers"))
    }

    private func availableProviders() -> [ProviderEntity] {
        let limits = (try? SharedSnapshotStore().load().snapshot?.limits) ?? []
        return limits
            .reduce(into: [String: ProviderEntity]()) { result, limit in
                result[limit.providerID] = ProviderEntity(
                    id: limit.providerID,
                    name: WidgetPresentation.displayName(for: limit.providerID)
                )
            }
            .values
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}
