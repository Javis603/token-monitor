import SwiftUI

struct HomeCountControls: View {
    @Environment(AppPreferences.self) private var preferences

    var body: some View {
        countRow("Tools", module: "tool")
        countRow("Models", module: "model")
        countRow("Sessions", module: "session")
        countRow("Devices", module: "device")
        Text(String(localized: "Running and waiting sessions remain visible beyond this count.", table: "AppAlignment"))
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func countRow(_ title: LocalizedStringKey, module: String) -> some View {
        Stepper(value: Binding(
            get: { preferences.homeCount(module) },
            set: { preferences.setHomeCount($0, for: module) }
        ), in: 1...50) {
            LabeledContent(title) {
                Text(preferences.homeCount(module), format: .number).monospacedDigit()
            }
        }
    }
}
