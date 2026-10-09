import SwiftUI

struct SessionsView: View {
    @Environment(TokenMonitorStore.self) private var store
    @State private var period: UsagePeriodKey = .today
    @State private var query = ""
    @State private var page = 0
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    private var usage: UsagePeriod { store.displayPeriod(period) }
    private var sessions: [SessionListEntry] {
        SessionListEntry.rows(usage.sessions ?? [:], query: query)
    }

    var body: some View {
        let rows = sessions
        let maximum = UsageRowPresentation.maximum(rows.map(\.tokens))
        let pageCount = max(1, (rows.count + 99) / 100)
        let currentPage = min(page, pageCount - 1)
        let visibleRows = Array(rows.dropFirst(currentPage * 100).prefix(100))
        return ZStack {
            AppBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: DesignTokens.sectionSpacing) {
                    periodPicker
                    if rows.isEmpty {
                        ContentUnavailableView {
                            Label(query.isEmpty ? "No sessions available" : "No matching sessions",
                                  systemImage: "bubble.left.and.bubble.right")
                        } description: {
                            Text(query.isEmpty
                                 ? "Session summaries appear when your devices sync activity to this Hub."
                                 : "Try another tool, model, project, or session title.")
                        }
                    } else {
                        TimelineView(.periodic(from: .now, by: 30)) { timeline in
                            SurfaceCard {
                                LazyVStack(alignment: .leading, spacing: DesignTokens.rowDividerSpacing) {
                                    ForEach(Array(visibleRows.enumerated()), id: \.element.id) { index, item in
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
                    if pageCount > 1 {
                        HStack {
                            Button("Previous", systemImage: "chevron.left") { page = currentPage - 1 }
                                .disabled(currentPage == 0)
                            Spacer()
                            Text("\(currentPage + 1) / \(pageCount)")
                                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                            Spacer()
                            Button("Next", systemImage: "chevron.right") { page = currentPage + 1 }
                                .disabled(currentPage == pageCount - 1)
                        }
                        .buttonStyle(.bordered)
                        .frame(minHeight: DesignTokens.controlHeight)
                    }
                    if let omitted = usage.sessionDetailsOmitted, omitted > 0 {
                        Label("Some session details were omitted by the sending device. Usage totals still include them.",
                              systemImage: "info.circle")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, DesignTokens.screenPadding)
                .padding(.top, 8)
                .padding(.bottom, DesignTokens.sectionSpacing)
            }
            .refreshable { await store.refresh() }
        }
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
        .searchable(text: $query, prompt: "Search sessions")
        .onChange(of: query) { page = 0 }
        .onChange(of: period) { page = 0 }
        .onAppear { period = store.selectedPeriod == .allTime ? .today : store.selectedPeriod }
    }

    private var periodPicker: some View {
        let picker = Picker("Period", selection: $period) {
            Text("Today").tag(UsagePeriodKey.today)
            Text("This month").tag(UsagePeriodKey.month)
        }
        return Group {
            if dynamicTypeSize.isAccessibilitySize {
                picker.pickerStyle(.menu).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                picker.pickerStyle(.segmented)
            }
        }
        .sensoryFeedback(.selection, trigger: period)
    }
}
