import SwiftUI

/// The system clock advances the last fractional digit pair; its custom glyph is a
/// waveform frame. No app render loop or periodic activity update is required.
struct ActivityWaveform: View {
    let updatedAt: Date
    let isStale: Bool
    var tint: Color = .primary
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var luminanceReduced

    var body: some View {
        Group {
            if reduceMotion || luminanceReduced || isStale {
                Image("ActivityWave").resizable().scaledToFit()
            } else {
                Text(.currentDate, format: .stopwatch(startingAt: updatedAt,
                     maxPrecision: .milliseconds(10)).locale(Locale(identifier: "en_US_POSIX")))
                    .font(.custom("TokenMonitorActivityWaveSmooth", fixedSize: 20))
                    .multilineTextAlignment(.trailing)
                    // Give the system text a finite canvas before cropping its
                    // last digit pair. Intrinsic sizing can produce an empty archive.
                    .frame(width: 250, height: 18.4, alignment: .trailing)
                    .frame(width: 25, height: 18.4, alignment: .trailing)
                    .clipped()
            }
        }
        .foregroundStyle(tint)
        .frame(width: 25, height: 18.4)
        .accessibilityHidden(true)
    }
}
