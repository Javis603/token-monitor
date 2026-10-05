import Foundation
import Observation

@MainActor
@Observable
final class ConnectionSettings {
    var hubURL: String
    var secret: String
    var validationMessage: String?

    @ObservationIgnored
    private let defaults: UserDefaults

    @ObservationIgnored
    private let keychain: KeychainStore

    init(
        defaults: UserDefaults = .standard,
        keychain: KeychainStore = KeychainStore(
            service: "com.javis.tokenmonitor.ios",
            account: "hub-secret"
        )
    ) {
        self.defaults = defaults
        self.keychain = keychain
        hubURL = defaults.string(forKey: "hubURL") ?? ""
        secret = (try? keychain.load()) ?? ""
    }

    var configuration: HubConfiguration? {
        HubConfiguration.make(urlText: hubURL, secret: secret)
    }

    func save() -> HubConfiguration? {
        guard let configuration else {
            validationMessage = "Enter a valid HTTP or HTTPS Hub URL."
            return nil
        }
        do {
            defaults.set(configuration.baseURL.absoluteString, forKey: "hubURL")
            if configuration.secret.isEmpty {
                try keychain.delete()
            } else {
                try keychain.save(configuration.secret)
            }
            hubURL = configuration.baseURL.absoluteString
            validationMessage = nil
            return configuration
        } catch {
            validationMessage = error.localizedDescription
            return nil
        }
    }
}

extension ConnectionSettings {
    static var preview: ConnectionSettings {
        let defaults = UserDefaults(suiteName: "TokenMonitorPreview") ?? .standard
        let settings = ConnectionSettings(
            defaults: defaults,
            keychain: KeychainStore(
                service: "com.javis.tokenmonitor.ios.preview",
                account: "hub-secret"
            )
        )
        settings.hubURL = "https://hub.example.com"
        settings.secret = "preview-secret"
        return settings
    }
}
