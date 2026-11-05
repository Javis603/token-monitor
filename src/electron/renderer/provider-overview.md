# Services surface brief

**Surface: Operate.** Inspect one tracked product’s usage, quota and service health. Services (服務) is an additional page; existing pages and navigation remain available. Hide the aggregate Total Tokens panel and show the selected provider’s tokens and cost.

## Layout

Inherit the widget’s compact typography, theme, icons and separators. The service tab strip fills the titlebar; this page omits the app-mark column and its hover Easter egg. Icons identify providers and the selected tab shows its name. Quota content scrolls below it. The page hides the global period tabs. Footer navigation and settings remain visible. The rail supports horizontal overflow and keyboard selection. At very short window heights, retain the header, rail and footer while hiding content.

## Selection and scope

Choose one provider. A single account selector controls both the native quota rows and embedded history. Only the selected account is shown; multiple product lanes belonging to one MiMo account remain together in quota, with a separately labelled product selector for history. Account selection survives record reordering. Account identity is shown once, with the native quota title serving as a quota label rather than repeating the service name. Usage spans the tracked product’s tool accounts and cannot be attributed to the selected quota account. Group client usage through the existing `providerForClient` mapping; a model vendor does not determine the provider.

A local Today/Month/Total control belongs to the usage section only. It changes usage totals and all usage content without changing quota history or other pages. A compact model distribution and value ledger lead into project-grouped conversation activity. Sessions reuse existing family/review grouping and detail navigation; there are no separate model/project/session tabs. Families belong to the main conversation’s project, while review groups spanning projects remain intact and explicitly labelled. Project totals include only available provider-scoped sessions; disclose incomplete session coverage.

## Content and constraints

Show the original quota presentation first, followed by embedded remaining/spend history and measured daily quota consumption. The shared account selector and history quota-window buttons change displayed data directly; opening a hover card is unnecessary. History uses the same scoped local query and calculation model as the existing card. Unknown samples remain gaps, measured zero stays distinct, and unallocated consumption remains visible. Changing account or backend immediately clears the previous scope; superseded reads cannot replace a newer selection.

Usage details follow in the app’s native row presentation, without disclosure controls or “Show all” sections. All rows are available through the page’s scroll area. Quota history stays independent of the global token-period selector and the hover-preview opening preference. A read never starts a provider probe.
