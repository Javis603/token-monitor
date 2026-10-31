import SwiftUI

struct UsageMeter: View {
    let value: Double?
    let maximum: Double
    let color: Color

    var body: some View {
        if let fraction = UsageRowPresentation.fraction(value, maximum: maximum) {
            GeometryReader { geometry in
                Capsule().fill(color.opacity(0.16))
                    .overlay(alignment: .leading) {
                        Capsule().fill(color)
                            .frame(width: geometry.size.width * fraction)
                    }
            }
            .frame(height: 6)
            .accessibilityHidden(true)
        }
    }
}
