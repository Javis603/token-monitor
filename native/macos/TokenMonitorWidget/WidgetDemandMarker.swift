import Foundation

// The demand lease signal for the snapshot pipeline. Electron skips snapshot
// work entirely while no Widget is on screen; it learns "a Widget wants data"
// from this zero-content marker's mtime, which WidgetKit-driven entry points
// touch whenever they genuinely render. Only real placements may write demand:
// the gallery preview (`context.isPreview`) and the placeholder are not a
// Widget the user actually keeps, so they must not create the marker — a
// marker that has never existed is the one faithful "no Widget has ever asked".
//
// The file lives in the app group container, so the extension and the host app
// resolve it to the same path, and it is touched by updating mtime only (never
// content), matching the host's `lstatSync`-based lease check.
enum WidgetDemandMarker {
    /// Touched by timeline(): a placed Widget asks for its next update. Fresh
    /// means "a Widget is on screen and wants updates", so this is the full lease.
    static let fileName = "widget-demand"

    /// Touched by snapshot() outside the gallery. WidgetKit calls snapshot() for
    /// transient situations that include the add flow, before the user confirms
    /// placement, so this signal only warms up a possible first placement and
    /// must grant a short lease, never the full one.
    static let provisionalFileName = "widget-demand-provisional"

    static func noteRequested(
        fileName: String = Self.fileName,
        appGroup: String = "",
        container: URL? = nil,
        fileManager: FileManager = .default,
        now: Date = Date()
    ) {
        let resolved = container ?? (appGroup.isEmpty ? nil : fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: appGroup
        ))
        guard let directory = resolved else { return }
        let url = directory.appendingPathComponent(fileName)
        if !fileManager.fileExists(atPath: url.path) {
            try? Data().write(to: url, options: .atomic)
        }
        try? fileManager.setAttributes([.modificationDate: now], ofItemAtPath: url.path)
    }
}
