import SwiftUI

/// Matches the macOS Notch's session-only reading: wave, count, waiting badge.
struct ActivityWorkStatus: View {
    let agents: ActivityState.Agents
    let updatedAt: Date
    var isStale = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var tint: Color { ActivityPalette.quotaTint(agents.clients.first) }
    private let waitingTint = Color(red: 0xe7 / 255, green: 0xb7 / 255, blue: 0x64 / 255)

    private var countStyle: AnyShapeStyle {
        if agents.clients.count > 1 {
            AnyShapeStyle(LinearGradient(stops: [
                .init(color: Color(red: 0x81 / 255, green: 0xd9 / 255, blue: 0xe0 / 255), location: 0.08),
                .init(color: Color(red: 0xad / 255, green: 0xbf / 255, blue: 0xdf / 255), location: 0.48),
                .init(color: Color(red: 0xef / 255, green: 0xb0 / 255, blue: 0x8e / 255), location: 0.95)
            ], startPoint: .init(x: 0.047, y: 0.289), endPoint: .init(x: 0.953, y: 0.711)))
        } else {
            AnyShapeStyle(tint)
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            if agents.running == 1 && (agents.waiting ?? 0) == 0 {
                ActivityWaveform(isStale: isStale, tint: tint)
            } else {
                if agents.running > 0 {
                    Text(verbatim: agents.running.formatted())
                        .font(.system(size: 16, weight: .semibold).monospacedDigit())
                        .foregroundStyle(countStyle)
                        .contentTransition(.numericText())
                        .animation(reduceMotion || isStale ? nil : .easeOut(duration: 0.2), value: agents.running)
                }
                if let waiting = agents.waiting, waiting > 0 {
                    HStack(spacing: 3) {
                        ActivityWaitingGlyph()
                            .stroke(waitingTint, style: StrokeStyle(lineWidth: 1, lineCap: .round, lineJoin: .round))
                            .frame(width: 11, height: 11)
                        Text(verbatim: waiting.formatted())
                            .font(.system(size: 12, weight: .semibold).monospacedDigit())
                            .contentTransition(.numericText())
                            .animation(reduceMotion || isStale ? nil : .easeOut(duration: 0.2), value: waiting)
                    }
                    .foregroundStyle(waitingTint)
                    .padding(.vertical, 3)
                    .padding(.horizontal, 4)
                    .background(waitingTint.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
                }
            }
        }
        .fixedSize()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("\(agents.running) running, \(agents.waiting ?? 0) waiting"))
    }
}

/// The desktop's outlined conversation glyph, rather than a different SF Symbol.
nonisolated private struct ActivityWaitingGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 4, y: 2.5))
        path.addLine(to: CGPoint(x: 12, y: 2.5))
        path.addQuadCurve(to: CGPoint(x: 13.5, y: 4), control: CGPoint(x: 13.5, y: 2.5))
        path.addLine(to: CGPoint(x: 13.5, y: 9))
        path.addQuadCurve(to: CGPoint(x: 12, y: 10.5), control: CGPoint(x: 13.5, y: 10.5))
        path.addLine(to: CGPoint(x: 7, y: 10.5))
        path.addLine(to: CGPoint(x: 3.5, y: 13.5))
        path.addLine(to: CGPoint(x: 3.5, y: 10.5))
        path.addQuadCurve(to: CGPoint(x: 2, y: 9), control: CGPoint(x: 2, y: 10.5))
        path.addLine(to: CGPoint(x: 2, y: 4))
        path.addQuadCurve(to: CGPoint(x: 4, y: 2.5), control: CGPoint(x: 2, y: 2.5))
        path.closeSubpath()
        path.move(to: CGPoint(x: 5.5, y: 6.5))
        path.addLine(to: CGPoint(x: 10.5, y: 6.5))
        return path.applying(CGAffineTransform(scaleX: rect.width / 16, y: rect.height / 16)
            .concatenating(.init(translationX: rect.minX, y: rect.minY)))
    }
}
