import Foundation
import Testing
@testable import TokenMonitor

struct LimitProviderOrderTests {
    private func provider(
        _ id: String,
        accountKey: String = "key",
        accountLabel: String? = nil,
        planLabel: String? = nil,
        accountEmail: String? = nil,
        status: String? = "ok",
        stale: Bool? = false
    ) -> LimitProvider {
        LimitProvider(
            provider: id,
            accountKey: accountKey,
            accountLabel: accountLabel,
            planLabel: planLabel,
            accountName: nil,
            accountEmail: accountEmail,
            workspaceKind: nil,
            status: status,
            source: nil,
            sourceDetail: nil,
            updatedAt: nil,
            windows: nil,
            balanceUsd: nil,
            balance: nil,
            sourceDeviceId: nil,
            stale: stale
        )
    }

    // MARK: - Ordering

    @Test func defaultOrderFollowsDesktopCatalog() {
        let providers = [
            provider("opencode"),
            provider("claude"),
            provider("codex"),
            provider("cursor")
        ]
        let ordered = LimitProviderOrder.ordered(providers, order: [])
        #expect(ordered.map(\.normalizedProviderID) == ["claude", "codex", "opencode", "cursor"])
    }

    @Test func savedOrderWinsThenCatalogFillsIn() {
        let providers = [
            provider("claude"),
            provider("codex"),
            provider("opencode"),
            provider("commandcode")
        ]
        let ordered = LimitProviderOrder.ordered(
            providers,
            order: ["commandcode", "codex"]
        )
        // Saved ids first in saved sequence, then catalog order for the rest.
        #expect(ordered.map(\.normalizedProviderID) == ["commandcode", "codex", "claude", "opencode"])
    }

    @Test func unknownProvidersSortAlphabeticallyAfterCatalog() {
        let providers = [
            provider("zzcustom"),
            provider("claude"),
            provider("aacustom")
        ]
        let ordered = LimitProviderOrder.ordered(providers, order: [])
        #expect(ordered.map(\.normalizedProviderID) == ["claude", "aacustom", "zzcustom"])
    }

    @Test func hiddenProvidersAreDroppedAndAccountsKeepHubOrder() {
        let providers = [
            provider("codex", accountKey: "a"),
            provider("claude"),
            provider("codex", accountKey: "b"),
            provider("cursor")
        ]
        let ordered = LimitProviderOrder.ordered(
            providers,
            order: [],
            hidden: ["cursor"]
        )
        #expect(ordered.map(\.normalizedProviderID) == ["claude", "codex", "codex"])
        #expect(
            ordered.filter { $0.normalizedProviderID == "codex" }
                .map(\.accountKey) == ["a", "b"]
        )
    }

    @Test func idsAreNormalizedBeforeOrdering() {
        let providers = [provider("Codex"), provider("  Claude  ")]
        let ordered = LimitProviderOrder.ordered(providers, order: [" CODEX "])
        #expect(ordered.map(\.normalizedProviderID) == ["codex", "claude"])
    }

    @Test func sortedIDsOrdersEditorRows() {
        let rows = LimitProviderOrder.sortedIDs(
            ["unknownx", "cursor", "claude", "zzz"],
            order: ["cursor"]
        )
        #expect(rows == ["cursor", "claude", "unknownx", "zzz"])
    }

    // MARK: - Plan label + status

    @Test func planFallsBackThroughEmptyPlanLabel() {
        // The real Hub sends planLabel: "" with the plan in accountLabel.
        let item = provider("codex", accountLabel: "Plus", planLabel: "")
        #expect(item.secondaryTitle == "Plus")
        #expect(item.planCell == .plan("Plus"))
    }

    @Test func planCellIsNilForHealthyProviderWithoutPlan() {
        let item = provider("cursor", accountLabel: "", planLabel: "")
        #expect(item.secondaryTitle == nil)
        #expect(item.planCell == nil)
    }

    @Test func statusBeatsPlanForUnhealthyProvider() {
        let item = provider("cursor", accountLabel: "Free", planLabel: "", status: "notConfigured")
        #expect(item.planCell == .status("Not signed in"))
    }

    @Test func staleProviderShowsPlanOverStatus() {
        let item = provider("cursor", accountLabel: "Pro", planLabel: "", status: "rateLimited", stale: true)
        #expect(item.planCell == .plan("Pro"))
        let noPlan = provider("cursor", status: "rateLimited", stale: true)
        #expect(noPlan.planCell == .status("Limited"))
    }

    @Test func statusLabelsUseCamelCaseWireValues() {
        #expect(provider("x", status: "ok").statusLabelKey == "Live")
        #expect(provider("x", status: "disabled").statusLabelKey == "Disabled")
        #expect(provider("x", status: "notConfigured").statusLabelKey == "Not signed in")
        #expect(provider("x", status: "unauthorized").statusLabelKey == "Sign in again")
        #expect(provider("x", status: "rateLimited").statusLabelKey == "Limited")
        #expect(provider("x", status: "sourceRateLimited").statusLabelKey == "Usage API limited")
        #expect(provider("x", status: "unavailable").statusLabelKey == "Unavailable")
        #expect(provider("x", status: "bogus").statusLabelKey == "Error")
    }

    @Test func zaiPlanLabelStripsRepeatedProviderName() {
        let item = provider("zai", planLabel: "GLM Coding Pro")
        #expect(item.planCell == .plan("Pro"))
    }

    // MARK: - Email masking

    @Test func maskEmailAddressMatchesDesktop() {
        #expect(AccountIdentity.maskEmailAddress("javis@example.com") == "j***s@example.com")
        #expect(AccountIdentity.maskEmailAddress("a@b.co") == "a***@b.co")
        #expect(AccountIdentity.maskEmailAddress("  first.last@x.io ") == "f***t@x.io")
        #expect(AccountIdentity.maskEmailAddress("not-an-email") == "not-an-email")
        #expect(AccountIdentity.maskEmailAddress("@domain.com") == "@domain.com")
        #expect(AccountIdentity.maskEmailAddress("user@") == "user@")
    }

    @Test func accountTitleMasksEmailOnlyWhenEnabled() {
        let item = provider("codex", accountEmail: "javis@icloud.com")
        #expect(item.accountTitle == "javis@icloud.com")
        #expect(item.accountTitle(maskingEmails: true) == "j***s@icloud.com")
    }
}
