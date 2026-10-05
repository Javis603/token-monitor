import SwiftUI

struct CompactLimitProviderCard: View {
    let providers: [LimitProvider]

    init(provider: LimitProvider) {
        providers = [provider]
    }

    init(providers: [LimitProvider]) {
        self.providers = providers
    }

    var body: some View {
        ProviderLimitCard(providers: providers, compact: true)
    }
}
