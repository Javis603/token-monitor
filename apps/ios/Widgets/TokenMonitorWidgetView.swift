import SwiftUI
import WidgetKit

/// The three Home Screen surfaces. Solid paints the removable system
/// background; Transparent and Liquid Glass stay clear so the extension's
/// host descriptor owns the material.
enum TokenMonitorWidgetSurface {
    case solid
    case transparent
    case liquidGlass

    var kind: String {
        switch self {
        case .solid: "TokenMonitorSolidWidget"
        case .transparent: "TokenMonitorTransparentWidget"
        case .liquidGlass: "TokenMonitorGlassWidget"
        }
    }

    var name: LocalizedStringKey {
        switch self {
        case .solid: "Token Monitor · Solid"
        case .transparent: "Token Monitor · Transparent"
        case .liquidGlass: "Token Monitor · Liquid Glass"
        }
    }
}

/// Root of every widget render: resolves ink from the surface and entry,
/// stamps the shared `widgetInk` environment, then dispatches on the
/// (explicit) widget family. The family is a parameter — not the read-only
/// environment — so the app can render the same view in Settings.
struct TokenMonitorWidgetView: View {
    @Environment(\.widgetRenderingMode) private var renderingMode
    let entry: TokenMonitorWidgetEntry
    let surface: TokenMonitorWidgetSurface
    let family: WidgetFamily

    var body: some View {
        Group {
            switch surface {
            case .solid:
                widgetContent.containerBackground(.background, for: .widget)
            case .liquidGlass:
                // The host descriptor supplies the glass. A SwiftUI material
                // composites as an opaque card and hides that background.
                widgetContent.containerBackground(.clear, for: .widget)
            case .transparent:
                widgetContent.containerBackground(.clear, for: .widget)
            }
        }
        .environment(\.widgetInk, inkColors)
        .foregroundStyle(inkColors.primary)
        .widgetURL(destination)
        .environment(\.locale, entry.locale)
    }

    @ViewBuilder private var widgetContent: some View {
        switch family {
        case .accessoryInline, .accessoryCircular, .accessoryRectangular:
            WidgetAccessoryView(entry: entry, family: family)
        default:
            homeContent
        }
    }

    @ViewBuilder private var homeContent: some View {
        Group {
            if entry.hasData {
                switch entry.content {
                case "limits": WidgetLimitsView(entry: entry, family: family)
                case "activity": WidgetActivityView(entry: entry, family: family)
                default: WidgetUsageView(entry: entry, family: family)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    WidgetHeader(entry: entry, isCompact: family == .systemSmall)
                    WidgetEmptyState(noSnapshot: entry.snapshot == nil)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var usesWallpaperInk: Bool {
        surface == .transparent && renderingMode == .fullColor
    }

    private var inkColors: WidgetInkColors {
        let accent = renderingMode == .fullColor ? WidgetPresentation.accent : .primary
        switch entry.ink {
        case .light:
            return WidgetInkColors(
                primary: .white,
                secondary: .white.opacity(0.82),
                accent: accent
            )
        case .dark:
            return WidgetInkColors(
                primary: .black,
                secondary: .black.opacity(0.74),
                accent: accent
            )
        case .recommended:
            if usesWallpaperInk {
                return WidgetInkColors(
                    primary: .white,
                    secondary: .white.opacity(0.82),
                    accent: accent
                )
            }
            return WidgetInkColors(primary: .primary, secondary: .secondary, accent: accent)
        }
    }

    private var destination: URL? {
        URL(string: "tokenmonitor://\(entry.content == "limits" ? "limits" : (entry.content == "activity" ? "insights" : "overview"))")
    }
}

