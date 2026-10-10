import SwiftUI

enum OverviewSection: String, CaseIterable, Identifiable {
    case summary
    case limits
    case sessions
    case trend
    case tools
    case models
    case devices

    var id: String { rawValue }

    var title: String {
        switch self {
        case .summary: "Token summary"
        case .limits: "AI Limits"
        case .sessions: "Sessions"
        case .trend: "Trend"
        case .tools: "Tools"
        case .models: "Models"
        case .devices: "Devices"
        }
    }

    var symbol: String {
        switch self {
        case .summary: "sum"
        case .limits: "gauge.with.needle"
        case .sessions: "bubble.left.and.bubble.right"
        case .trend: "chart.xyaxis.line"
        case .tools: "square.grid.2x2"
        case .models: "cpu"
        case .devices: "desktopcomputer"
        }
    }

    static func ordered(by savedOrder: [String]) -> [Self] {
        var seen: Set<Self> = []
        return (savedOrder.compactMap(Self.init(rawValue:)) + allCases)
            .filter { seen.insert($0).inserted }
    }
}

struct OverviewSectionOrderEditor: View {
    @Environment(AppPreferences.self) private var preferences

    @State private var editMode = EditMode.inactive

    var body: some View {
        List {
            Section {
                ForEach(sections) { section in
                    row(for: section)
                }
                .onMove(perform: move)
            } header: {
                Text("Sections")
            } footer: {
                Text("Drag to reorder. Hide sections you do not need; the connection notice stays visible.")
            }

            Section {
                Button("Reset Overview layout") {
                    preferences.overviewSectionOrder = []
                    preferences.hiddenOverviewSections = []
                }
                .disabled(preferences.overviewSectionOrder.isEmpty && preferences.hiddenOverviewSections.isEmpty)
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(DesignTokens.sectionSpacing)
        .scrollContentBackground(.hidden)
        .background { AppBackground() }
        .navigationTitle("Customize Overview")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                EditButton()
            }
        }
        .environment(\.editMode, $editMode)
        .environment(\.defaultMinListRowHeight, DesignTokens.controlHeight)
    }

    private var sections: [OverviewSection] {
        OverviewSection.ordered(by: preferences.overviewSectionOrder)
    }

    private func row(for section: OverviewSection) -> some View {
        let hidden = preferences.hiddenOverviewSections.contains(section.id)
        return HStack(spacing: 12) {
            Image(systemName: section.symbol)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .frame(width: 22)
                .accessibilityHidden(true)
            Text(LocalizedStringKey(section.title))
                .font(DesignTokens.rowTitle)
                .foregroundStyle(hidden ? .secondary : .primary)
            Spacer()
            Button {
                if hidden {
                    preferences.hiddenOverviewSections.remove(section.id)
                } else {
                    preferences.hiddenOverviewSections.insert(section.id)
                }
            } label: {
                Image(systemName: hidden ? "eye.slash" : "eye")
                    .foregroundStyle(.secondary)
                    .frame(minWidth: DesignTokens.controlHeight, minHeight: DesignTokens.controlHeight)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(accessibilityAction(for: section, hidden: hidden))
            .accessibilityValue(hidden ? "Hidden" : "Visible")
        }
        .frame(minHeight: DesignTokens.controlHeight)
        .listRowInsets(EdgeInsets(
            top: 0, leading: DesignTokens.cardPadding,
            bottom: 0, trailing: DesignTokens.cardPadding
        ))
    }

    private func move(from source: IndexSet, to destination: Int) {
        var reordered = sections
        reordered.move(fromOffsets: source, toOffset: destination)
        preferences.overviewSectionOrder = reordered.map(\.id)
    }

    private func accessibilityAction(for section: OverviewSection, hidden: Bool) -> Text {
        let title = Text(LocalizedStringKey(section.title))
        return hidden ? Text("Show \(title)") : Text("Hide \(title)")
    }
}
