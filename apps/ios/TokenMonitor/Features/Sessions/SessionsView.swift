import SwiftUI

struct SessionsView: View {
    @Environment(TokenMonitorStore.self) private var store
    @State private var period: UsagePeriodKey = .today
    @State private var query = ""
    @State private var initializedPeriod = false
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .largeTitle) private var emptyMarkSize = 48.0

    private var usage: UsagePeriod { store.displayPeriod(period) }
    private var sessions: [SessionListEntry] {
        SessionListEntry.rows(usage.sessions ?? [:], query: query,
                              grokBotIDs: SessionListEntry.grokBotIDs(store.stats?.periods ?? [:],
                                                                    authoritative: store.stats?.grokBotSessionIds))
    }

    var body: some View {
        let rows = sessions
        let maximum = UsageRowPresentation.maximum(rows.map(\.tokens))
        return ZStack {
            AppBackground()
            GeometryReader { geometry in
                ScrollView {
                    VStack(alignment: .leading, spacing: DesignTokens.sectionSpacing) {
                        if store.stats != nil && store.connectionNoticePhase != .live {
                            ConnectionStatusNotice(phase: store.connectionNoticePhase) {
                                Task { await store.refresh() }
                            }
                        }
                        if rows.isEmpty {
                            emptyState
                        } else {
                            TimelineView(.periodic(from: .now, by: 30)) { timeline in
                                SurfaceCard {
                                    LazyVStack(alignment: .leading, spacing: DesignTokens.rowDividerSpacing) {
                                        ForEach(Array(rows.enumerated()), id: \.element.id) { index, item in
                                            if index > 0 { Divider() }
                                            if let session = item.session {
                                                SessionRow(session: session, sessionKey: item.id,
                                                           maximum: maximum, now: timeline.date)
                                            } else {
                                                BackgroundReviewGroupRow(entry: item, maximum: maximum, now: timeline.date)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        if let omitted = usage.sessionDetailsOmitted, omitted > 0 {
                            Label("Some session details were omitted by the sending device. Usage totals still include them.",
                                  systemImage: "info.circle")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity,
                           minHeight: rows.isEmpty ? max(0, geometry.size.height - 8 - DesignTokens.sectionSpacing) : 0,
                           alignment: rows.isEmpty ? .center : .topLeading)
                    .padding(.horizontal, DesignTokens.screenPadding)
                    .padding(.top, 8)
                    .padding(.bottom, DesignTokens.sectionSpacing)
                }
                .refreshable { await store.refresh() }
            }
        }
        .modifier(RootPageHeader("Sessions") { periodPicker })
        .searchable(text: $query, prompt: "Search sessions")
        .onAppear {
            guard !initializedPeriod else { return }
            period = store.selectedPeriod == .allTime ? .today : store.selectedPeriod
            initializedPeriod = true
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            if !query.isEmpty {
                Label("No matching sessions", systemImage: "magnifyingglass")
            } else if store.stats != nil || store.phase == .live {
                Label {
                    Text(period == .today ? "No sessions today" : "No sessions this month")
                } icon: {
                    Image("DesktopSessions")
                        .resizable()
                        .scaledToFit()
                        .frame(width: emptyMarkSize, height: emptyMarkSize)
                        .accessibilityHidden(true)
                }
            } else {
                switch store.phase {
                case .idle:
                    Label("Connect Your Hub", systemImage: "link.badge.plus")
                case .connecting:
                    Label("Connecting", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                case .failed:
                    Label("Hub Unavailable", systemImage: "exclamationmark.icloud")
                case .live:
                    Label(period == .today ? "No sessions today" : "No sessions this month", image: "DesktopSessions")
                }
            }
        } description: {
            if !query.isEmpty {
                Text("Try another tool, model, project, or session title.")
            } else if store.stats != nil || store.phase == .live {
                Text(period == .today
                     ? "No session summaries have been reported for today. Try This month to see earlier sessions."
                     : "No session summaries have been reported for this month.")
            } else {
                switch store.phase {
                case .idle:
                    Text("Add your Hub connection in Settings to view session summaries.")
                case .connecting:
                    Text("Establishing a secure live connection to Token Monitor Hub.")
                case let .failed(message):
                    Text(verbatim: message)
                case .live:
                    Text(period == .today
                         ? "No session summaries have been reported for today. Try This month to see earlier sessions."
                         : "No session summaries have been reported for this month.")
                }
            }
        } actions: {
            if query.isEmpty && (store.stats != nil || store.phase == .live) && period == .today {
                Button("This month") { period = .month }
                    .buttonStyle(.bordered)
            }
        }
    }

    private var periodPicker: some View {
        ViewThatFits(in: .horizontal) {
            PeriodPicker(selection: $period, compact: true, periods: [.today, .month])
                .fixedSize(horizontal: true, vertical: false)
            Picker("Period", selection: $period) {
                Text("Today").tag(UsagePeriodKey.today)
                Text("This month").tag(UsagePeriodKey.month)
            }
            .pickerStyle(.menu)
            .frame(minHeight: DesignTokens.controlHeight)
            .sensoryFeedback(.selection, trigger: period)
        }
    }
}
