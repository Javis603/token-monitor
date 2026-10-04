import SwiftUI

struct SessionsView: View {
    @Environment(TokenMonitorStore.self) private var store
    @Environment(AppPreferences.self) private var preferences
    @State private var period: UsagePeriodKey = .today
    @State private var query = ""

    private var usage: UsagePeriod { store.stats?.period(period) ?? .empty }

    private var sessions: [(key: String, value: SessionUsage)] {
        (usage.sessions ?? [:])
            .filter { $0.value.matches(query) }
            .sorted {
                let left = $0.value.lastActivity ?? .distantPast
                let right = $1.value.lastActivity ?? .distantPast
                return left == right ? $0.key < $1.key : left > right
            }
    }

    var body: some View {
        List {
            Section {
                Picker("Period", selection: $period) {
                    Text("Today").tag(UsagePeriodKey.today)
                    Text("This month").tag(UsagePeriodKey.month)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }

            if sessions.isEmpty {
                ContentUnavailableView {
                    Label(query.isEmpty ? "No sessions available" : "No matching sessions",
                          systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text(query.isEmpty
                         ? "Session summaries appear when your devices sync activity to this Hub."
                         : "Try another tool, model, project, or session title.")
                }
                .listRowBackground(Color.clear)
            } else {
                Section {
                    ForEach(sessions, id: \.key) { item in
                        sessionRow(item.value)
                    }
                } header: {
                    Text("Recent activity")
                } footer: {
                    Text("Summaries include the session details supplied by your devices. Conversation titles appear only when title sync is enabled on the sending device and Hub.")
                }
            }

            if let omitted = usage.sessionDetailsOmitted, omitted > 0 {
                Section {
                    Label("Some session details were omitted by the sending device. Usage totals still include them.",
                          systemImage: "info.circle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .navigationTitle("Sessions")
        .searchable(text: $query, prompt: "Search sessions")
        .refreshable { await store.refresh() }
    }

    private func sessionRow(_ session: SessionUsage) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(session.displayTitle ?? ClientPresentation.displayName(for: session.client ?? "unknown"))
                .font(.headline)
                .lineLimit(3)

            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) {
                    attribution(session)
                    Spacer(minLength: 12)
                    metrics(session)
                }
                VStack(alignment: .leading, spacing: 8) {
                    attribution(session)
                    metrics(session)
                }
            }

            if let project = session.projectLabel, !project.isEmpty {
                Label(project, systemImage: "folder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            if let date = session.lastActivity {
                Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private func attribution(_ session: SessionUsage) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(ClientPresentation.displayName(for: session.client ?? "unknown"))
                .font(.subheadline)
            if let model = session.primaryModel {
                Text(model)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    private func metrics(_ session: SessionUsage) -> some View {
        VStack(alignment: .trailing, spacing: 3) {
            if let tokens = session.measuredTokens {
                Text("\(MetricFormatter.tokens(tokens)) tokens")
                    .font(.subheadline.weight(.semibold))
            } else {
                Text("Tokens unavailable")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            if let cost = session.costUsd, cost.isFinite, cost >= 0 {
                Text(MetricFormatter.currencyFromUSD(cost, currency: preferences.currency))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .monospacedDigit()
        .fixedSize(horizontal: true, vertical: false)
    }
}
