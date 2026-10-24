import SwiftUI

struct SubscriptionDetailView: View {
    let record: SharedSubscription
    @Environment(AppPreferences.self) private var preferences

    var body: some View {
        List {
            Section { SubscriptionRow(record: record) }
            Section {
                if let email = record.binding?.accountEmail, !email.isEmpty {
                    LabeledContent("Account") {
                        Text(preferences.masksAccountEmails ? AccountIdentity.maskEmailAddress(email) : email)
                            .privacySensitive()
                    }
                } else if let profile = record.binding?.profileName, !profile.isEmpty {
                    LabeledContent("Account", value: profile).privacySensitive()
                }
                if !record.isTopUp {
                    if let start = SharedSubscription.validDay(record.startDate) {
                        LabeledContent(String(localized: "Start date", table: "AppAlignment"), value: start)
                    }
                    LabeledContent(String(localized: "Auto renew", table: "AppAlignment"), value: record.autoRenew == false ? String(localized: "Off") : String(localized: "On", table: "AppAlignment"))
                    TimelineView(.periodic(from: .now, by: 60)) { context in
                        if let renewal = record.nextRenewal(today: SharedSubscription.dayString(context.date)) {
                            LabeledContent(String(localized: "Next renewal", table: "AppAlignment"), value: renewal)
                        }
                    }
                    if let end = record.coverageStop { LabeledContent(String(localized: "Coverage ends", table: "AppAlignment"), value: end) }
                }
            }
            if record.isTopUp {
                Section(String(localized: "Top-ups", table: "AppAlignment")) {
                    ForEach((record.topUps ?? []).sorted { $0.date > $1.date }) { payment in
                        LabeledContent(payment.date) {
                            Text(verbatim: MetricFormatter.currency(payment.amountMinor / 100, code: record.currency))
                                .monospacedDigit()
                        }
                    }
                }
            }
            if let note = record.note, !note.isEmpty {
                Section(String(localized: "Note", table: "AppAlignment")) { Text(note).privacySensitive() }
            }
        }
        .navigationTitle(String(localized: "Subscription details", table: "AppAlignment"))
        .navigationBarTitleDisplayMode(.inline)
        .scrollContentBackground(.hidden)
        .background { AppBackground() }
    }
}
