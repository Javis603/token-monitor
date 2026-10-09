import SwiftUI

/// Order/visibility editor for AI Limits. Rows are the union of providers the
/// Hub reports and ids in the saved order; the desktop catalog order is the
/// default and fills in behind it.
struct LimitProviderOrderEditor: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store

    @State private var editMode = EditMode.inactive

    @ScaledMetric(relativeTo: .subheadline) private var markSize = 18.0

    var body: some View {
        List {
            Section {
                ForEach(rowIDs, id: \.self) { id in
                    row(for: id)
                }
                .onMove(perform: move)
            } header: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Providers")
                        Spacer()
                        Text("\(visibleCount) visible")
                    }
                    Text("Tap the eye to show or hide a provider. Tap Edit to reorder.")
                        .font(.footnote)
                        .textCase(nil)
                }
            } footer: {
                Text("Changes apply to this iPhone and its widgets. They do not change Hub collection.")
            }

            Section {
                Button("Reset to default order") {
                    preferences.limitProviderOrder = []
                }
                .disabled(preferences.limitProviderOrder.isEmpty)

                Button("Show all providers") {
                    preferences.hiddenLimitProviders = []
                }
                .disabled(preferences.hiddenLimitProviders.isEmpty)
            } footer: {
                Text("Default order matches the desktop app.")
            }

        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(DesignTokens.sectionSpacing)
        .scrollContentBackground(.hidden)
        .background { AppBackground() }
        .navigationTitle("AI Limits")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarVisibility(.visible, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                EditButton()
                    .disabled(rowIDs.count < 2)
            }
        }
        .environment(\.editMode, $editMode)
        .environment(\.defaultMinListRowHeight, DesignTokens.controlHeight)
    }

    /// Hub-reported providers plus saved entries, in the effective order.
    private var rowIDs: [String] {
        let present = (store.stats?.limits?.providers ?? []).map {
            $0.normalizedProviderID
        }
        let ids = present
            + preferences.limitProviderOrder
            + Array(preferences.hiddenLimitProviders)
        return LimitProviderOrder.sortedIDs(ids, order: preferences.limitProviderOrder)
    }

    private var visibleCount: Int {
        rowIDs.filter { !preferences.hiddenLimitProviders.contains($0) }.count
    }

    private func row(for id: String) -> some View {
        let hidden = preferences.hiddenLimitProviders.contains(id)
        let name = ProviderPresentation.displayName(for: id)
        return HStack(spacing: 12) {
            ProviderMark(provider: id, size: markSize)
                .accessibilityHidden(true)
            Text(name)
                .font(DesignTokens.rowTitle)
                .foregroundStyle(hidden ? .secondary : .primary)
            Spacer()
            Button {
                if hidden {
                    preferences.hiddenLimitProviders.remove(id)
                } else {
                    preferences.hiddenLimitProviders.insert(id)
                }
            } label: {
                Image(systemName: hidden ? "eye.slash" : "eye")
                    .foregroundStyle(.secondary)
                    .frame(minWidth: DesignTokens.controlHeight, minHeight: DesignTokens.controlHeight)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(hidden ? Text("Show \(name)") : Text("Hide \(name)"))
            .accessibilityValue(hidden ? "Hidden" : "Visible")
        }
        .frame(minHeight: DesignTokens.controlHeight)
        .listRowInsets(EdgeInsets(
            top: 0, leading: DesignTokens.cardPadding,
            bottom: 0, trailing: DesignTokens.cardPadding
        ))
        .accessibilityElement(children: .contain)
    }

    private func move(from source: IndexSet, to destination: Int) {
        var ids = rowIDs
        ids.move(fromOffsets: source, toOffset: destination)
        preferences.limitProviderOrder = ids
    }
}

#Preview {
    NavigationStack {
        LimitProviderOrderEditor()
            .environment(TokenMonitorStore.preview)
            .environment(AppPreferences.preview)
    }
}
