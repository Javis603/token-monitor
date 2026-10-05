import Foundation

/// Port of `maskEmailAddress` from src/electron/renderer/accountIdentity.js.
nonisolated enum AccountIdentity {
    /// `javis@example.com` → `j***s@example.com`; a one-character local part
    /// masks to `j***@example.com`.
    static func maskEmailAddress(_ value: String) -> String {
        let email = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let at = email.lastIndex(of: "@"),
              at > email.startIndex,
              email.index(after: at) < email.endIndex else {
            return email
        }
        let local = email[..<at]
        let domain = email[email.index(after: at)...]
        let first = local[local.startIndex]
        let last = local.count > 1 ? String(local[local.index(before: local.endIndex)]) : ""
        return "\(first)***\(last)@\(domain)"
    }
}
