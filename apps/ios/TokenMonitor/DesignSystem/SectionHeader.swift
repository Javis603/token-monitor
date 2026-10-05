import SwiftUI

struct SectionHeader: View {
    let title: String
    let systemImage: String
    let actionTitle: String?
    let action: (() -> Void)?

    init(
        _ title: String,
        systemImage: String,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.title = title
        self.systemImage = systemImage
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        HStack {
            Label(title, systemImage: systemImage)
                .font(.headline)

            Spacer()

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.subheadline)
                    .bold()
            }
        }
    }
}
