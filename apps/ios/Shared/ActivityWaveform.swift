import SwiftUI

extension EnvironmentValues {
    // Opt in only on the app's preview stage. WidgetKit does not run a render
    // loop; real Live Activities animate a data update for one 1.05s cycle.
    @Entry var activityPreviewAnimated = false
}

/// Geometry and timing from notch.css, including its negative phase offsets.
nonisolated enum ActivityWaveGeometry {
    static let duration = 1.05
    static let heights: [Double] = [7, 13, 9, 15, 6]
    static let offsets: [Double] = [0.2, 0.55, 0.85, 0.35, 0.7]
    static let width = 25.0
    static let height = 18.4
    private static let ease = UnitCurve.bezier(
        startControlPoint: .init(x: 0.42, y: 0), endControlPoint: .init(x: 0.58, y: 1)
    )

    static func barHeight(_ index: Int, phase: Double) -> Double {
        let position = phase + offsets[index] / duration
        let cycle = position - floor(position)
        let halfCycle = cycle < 0.5 ? cycle * 2 : (1 - cycle) * 2
        return heights[index] * 1.15 * (1 - 0.6 * ease.value(at: halfCycle))
    }
}

struct ActivityWaveform: View {
    let updatedAt: Date
    let isStale: Bool
    var tint: Color = .primary
    @Environment(\.activityPreviewAnimated) private var previewAnimated
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.isLuminanceReduced) private var luminanceReduced
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if reduceMotion || luminanceReduced || isStale {
                ActivityWaveShape(phase: 0).fill(tint)
            } else if previewAnimated {
                TimelineView(.animation(minimumInterval: 1 / 30, paused: scenePhase != .active)) { tick in
                    ActivityWaveShape(phase: tick.date.timeIntervalSinceReferenceDate / ActivityWaveGeometry.duration)
                        .fill(tint)
                }
            } else {
                // A custom insertion transition animates the five bars through
                // one complete cycle when genuine content changes. No timer,
                // repeatForever or additional Hub/APNs traffic is needed.
                Color.clear
                    .id(updatedAt)
                    .transition(.asymmetric(
                        insertion: .modifier(active: ActivityWavePulse(phase: -1, tint: tint),
                                             identity: ActivityWavePulse(phase: 0, tint: tint))
                            .animation(.linear(duration: ActivityWaveGeometry.duration)),
                        removal: .identity
                    ))
            }
        }
        .frame(width: ActivityWaveGeometry.width, height: ActivityWaveGeometry.height)
        .accessibilityHidden(true)
    }
}

nonisolated struct ActivityWaveShape: Shape {
    var phase: Double

    var animatableData: Double {
        get { phase }
        set { phase = newValue }
    }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let scale = min(rect.width / ActivityWaveGeometry.width, rect.height / ActivityWaveGeometry.height)
        let startX = rect.midX - ActivityWaveGeometry.width * scale / 2
        for index in ActivityWaveGeometry.heights.indices {
            let height = ActivityWaveGeometry.barHeight(index, phase: phase) * scale
            path.addRoundedRect(in: CGRect(x: startX + Double(index) * 5.5 * scale,
                                          y: rect.midY - height / 2, width: 3 * scale, height: height),
                                cornerSize: CGSize(width: 1.5 * scale, height: 1.5 * scale))
        }
        return path
    }
}

private struct ActivityWavePulse: ViewModifier, Animatable {
    var phase: Double
    var tint: Color

    var animatableData: Double {
        get { phase }
        set { phase = newValue }
    }

    func body(content: Content) -> some View {
        content.overlay { ActivityWaveShape(phase: phase).fill(tint) }
    }
}
