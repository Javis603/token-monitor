import SwiftUI

struct SubscriptionsView: View {
    @Environment(TokenMonitorStore.self) private var store
    @Environment(AppPreferences.self) private var preferences

    var body: some View {
        List {
            let state = store.subscriptions
            if state.isLoading { ProgressView(String(localized: "Loading subscriptions", table: "AppAlignment")) }
            if let error = state.errorMessage {
                Section {
                    Label(String(localized: "Subscriptions unavailable", table: "AppAlignment"), systemImage: "wifi.exclamationmark")
                    Text(error).font(.caption).foregroundStyle(.secondary)
                    Button("Retry") { state.refresh() }
                }
            }
            if state.isStale {
                Text(String(localized: "Showing the last loaded subscription records.", table: "AppAlignment"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let document = state.document {
                if document.subscriptions.isEmpty {
                    ContentUnavailableView(String(localized: "No subscriptions", table: "AppAlignment"), systemImage: "creditcard",
                        description: Text(String(localized: "Record subscriptions in the Desktop app connected to this Hub.", table: "AppAlignment")))
                } else {
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        let today = SharedSubscription.dayString(context.date)
                        LabeledContent(String(localized: "Monthly equivalent", table: "AppAlignment")) {
                            Text(document.monthlyTotalUSD(today: today).map {
                                MetricFormatter.currencyFromUSD($0, currency: preferences.currency)
                            } ?? "—").monospacedDigit()
                        }
                    }
                    Section(String(localized: "Subscriptions", table: "AppAlignment")) {
                        ForEach(document.subscriptions) { record in
                            NavigationLink {
                                SubscriptionDetailView(record: record)
                            } label: {
                                SubscriptionRow(record: record)
                            }
                        }
                    }
                    Section {
                        Text(String(localized: "Recurring plans are normalized by their billing interval; top-ups include this calendar month’s payments. Expired plans are excluded.", table: "AppAlignment"))
                        Text(String(localized: "Manage these shared records in the Desktop app connected to this Hub.", table: "AppAlignment"))
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
            } else if state.isUnsupported {
                ContentUnavailableView(String(localized: "Subscriptions unavailable", table: "AppAlignment"), systemImage: "creditcard",
                    description: Text(String(localized: "This Hub does not support shared subscription records.", table: "AppAlignment")))
            } else if !state.isLoading && state.errorMessage == nil {
                ContentUnavailableView("Connect to a Hub", systemImage: "network",
                    description: Text(String(localized: "Connect a Hub to view shared subscription records.", table: "AppAlignment")))
            }
        }
        .navigationTitle(String(localized: "Subscriptions", table: "AppAlignment"))
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background { AppBackground() }
        .task { store.subscriptions.observe(revision: store.stats?.subscriptionsUpdatedAt) }
        .refreshable { store.subscriptions.refresh() }
    }
}
