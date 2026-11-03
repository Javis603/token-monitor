import SwiftUI

/// An annotated five-layer symbol lets the system animate while the app is
/// suspended. App previews use this same implementation, without a render loop.
struct ActivityWaveform: View {
    let isStale: Bool
    var tint: Color = .primary
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var luminanceReduced

    var body: some View {
        Image("ActivityWave")
            .resizable()
            .scaledToFit()
            .symbolEffect(.breathe.byLayer, options: .repeat(.continuous),
                          isActive: !reduceMotion && !luminanceReduced && !isStale)
            .foregroundStyle(tint)
            .frame(width: 25, height: 18.4)
            .accessibilityHidden(true)
    }
}
