import SwiftUI

/// Order/visibility editor for AI Limits. Rows are the union of providers the
/// Hub reports and ids in the saved order; the desktop catalog order is the
/// default and fills in behind it.
struct LimitProviderOrderEditor: View {
    @Environment(AppPreferences.self) private var preferences
    @Environment(TokenMonitorStore.self) private var store

    var body: some View {
        @Bindable var preferences = preferences

        List {
            Section {
                ForEach(rowIDs, id: \.self) { id in
                    row(for: id)
                }
                .onMove(perform: move)
            } footer: {
                Text("Default order matches the desktop app.")
            }

            Section {
                Button("Reset to default order") {
                    preferences.limitProviderOrder = []
                }
                .disabled(preferences.limitProviderOrder.isEmpty)

                Toggle("Mask account emails", isOn: $preferences.masksAccountEmails)
            }
        }
        .environment(\.editMode, .constant(.active))
        .navigationTitle("AI Limits")
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

    private func row(for id: String) -> some View {
        let hidden = preferences.hiddenLimitProviders.contains(id)
        return HStack(spacing: 12) {
            ProviderMark(provider: id)
            Text(ProviderPresentation.displayName(for: id))
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
                    .foregroundStyle(hidden ? .tertiary : .secondary)
                    .frame(minWidth: DesignTokens.controlHeight, minHeight: DesignTokens.controlHeight)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(hidden ? "Show provider" : "Hide provider")
        }
        .accessibilityElement(children: .combine)
        .accessibilityHint(hidden ? "Hidden" : "Visible")
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
