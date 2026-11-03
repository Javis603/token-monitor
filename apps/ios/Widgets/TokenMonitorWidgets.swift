import CoreText
import SwiftUI
import WidgetKit

@main
struct TokenMonitorWidgets: WidgetBundle {
    init() {
        // The system renderer resolves shared fonts from the containing app.
        // Registering only the extension's copy leaves dynamic text blank.
        let appBundle = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let fontURL = appBundle.appendingPathComponent("TokenMonitorActivityWave.ttf")
        CTFontManagerRegisterFontsForURL(fontURL as CFURL, .process, nil)
    }

    var body: some Widget {
        TokenMonitorWidget(surface: .liquidGlass)
        TokenMonitorWidget(surface: .transparent)
        TokenMonitorWidget(surface: .solid)
        TokenMonitorActivityWidget()
    }
}
