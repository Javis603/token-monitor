---
name: Token Monitor for iOS
description: Measured instruments for usage and quota headroom, in native iOS chrome.
rounded:
  card: "24pt"
  compact: "16pt"
spacing:
  screen: "20pt"
  section: "24pt"
  card: "16pt"
components:
  surface-card:
    rounded: "{rounded.card}"
    padding: "{spacing.card}"
  control:
    height: "44pt"
---

# Design System: Token Monitor for iOS

## Overview

**Creative North Star: "Measured instruments"**

A polished native companion for reading measured use, cost and quota headroom. The incumbent desktop quota screenshot defines the information density and account/window relationships; native iOS conventions define navigation, controls and accessibility. This is the established visual world, with no separate invented composition or concept.

On Overview, the reading story moves from full total tokens and cost to cache hit rate, message count and average generation speed, with a compact Sessions shortcut, then quota headroom and historical context. Quiet surfaces and a clear numerical hierarchy let the readings carry the screen. Preserve the existing read-only companion character and system-surface customization.

**Key Characteristics:**

- Dense desktop quota semantics within native iOS chrome.
- Semantic monochrome provider marks and text; vendor color on quota meters.
- One glass Overview summary, continuous reading sections and accessible stacking.
- Measured zero, missing data and stale readings remain distinguishable.

## Colors

Use the live SwiftUI/UIKit semantic palette. Appearance-dependent colors are intentionally described here rather than converted into fabricated fixed CSS swatches in frontmatter.

### Primary

`DesignTokens.accent` is `Color.blue`, the shared action and selection accent. It is independent of provider identity. `critical` and `warning` use `Color.red` and `Color.orange` for status where applicable; pair status with readable text or symbols.

### Neutral

The canvas uses the pale blue light and ink dark tokens in `DesignTokens`. Primary readings and template provider icons use `.primary`; labels, plan, reset and freshness metadata use `.secondary`. The Overview summary uses native regular Liquid Glass; enclosed fallback surfaces use `secondarySystemGroupedBackground` and a thin semantic separator border.

**The Meter Color Rule.** Provider tint belongs to quota bars and their tracks. Keep provider icons, names and numeric readings monochrome; source vendor colors from the existing presentation helpers, without introducing a second palette. Stale Activity progress uses a secondary foreground.

## Typography

Use the system font and semantic SwiftUI text styles for titles, body and metadata. All four root tabs apply `RootPageHeader` with an inline native navigation bar and a leading `.title2.weight(.semibold)` heading in its `.principal` placement. The shared frame follows measured content width minus twice the 20pt screen padding, so the headings and reading columns align across Overview, Limits, Insights and Settings. Overview replaces the visible heading with the desktop-style monochrome `Σ.` mark, using bold system monospaced type at the same title2 scale and giving it the accessible name Token Monitor. Its semantic navigation title stays Overview for native back navigation. The other three root tabs retain their text headings. Keep this compact mark within the existing navigation chrome without a duplicate content heading or added brand bar. Pushed destinations retain their own compact inline titles and native back navigation. Section headings use headline or semibold title styles; caption and footnote styles distinguish supporting information.

Overview places the existing compact native segmented period picker at the trailing edge of that shared header, making Today, Month and Total directly selectable. A container-aware `ViewThatFits` uses the current-period menu with a chevron when the segmented control cannot fit; accessibility text sizes use that menu directly. Both controls retain the selected-period binding. This selection applies to Overview's usage sections, while the summary card concentrates on readings. `HeroSummaryCard` keeps the Total tokens label and Sessions shortcut together at the top. The label, exact token reading and secondary title3 cost form one tight group with 8pt intervals. The Sessions shortcut uses regular caption text and a medium caption2 chevron so its visual weight stays below the main reading. The shortcut uses a trailing overlay so its expanded 44pt hit area does not enlarge the label row or create space between the label and number; it remains clear of other controls. The full exact token reading dominates. Cache hit rate, Messages and Average speed follow the divider as three aligned columns with quiet caption labels and semibold values; accessibility text stacks those columns. The normal summary omits freshness text and a standalone refresh icon. Pull-to-refresh remains available; the existing connection notice exposes failed/offline recovery, and an explicit all-sources-stale flag adds a compact warning below cost. Sessions retains its 44pt target. When the initial connection fails or has no usage yet, the empty state retains a refresh action beside the settings recovery action. The exact token reading uses standard system semibold type, scaled from its large-title-relative base. Use monospaced digits for measured values, with localized currency and numeric formatting. Live updates to the exact Overview token reading use a scoped native numeric-text transition with a 0.25-second ease-out; period switches retain the same reading identity and use that short transition too, with direction following the new value. Reduce Motion disables the number transition, and neither surrounding cards nor secondary readings animate. Prose stays in the system proportional font. Preserve exact-value accessibility labels alongside abbreviated display values.

Dynamic Type determines layout, not just font size. Accessibility sizes stack paired metrics, account metadata and quota windows; maintain readable labels and VoiceOver grouping rather than shrinking the whole interface.

## Layout

Use the frontmatter spacing and shape values from `DesignTokens`; they are native points, not CSS pixels. Root pages share 20pt content edges and an 8pt top content inset beneath the compact native header. Settings applies the same horizontal margins to its native Form. Native tabs and per-tab navigation stacks provide the persistent frame. The first Overview viewport starts with the glass reading panel; connection notices appear when needed. The summary's 10pt vertical rhythm keeps its shortcut, total, cost and three secondary readings compact so more quota previews fit in the first viewport. Limits retains its provider list and display-customization shortcuts; Insights retains its historical content. The four root headers use the same geometry and typography rather than separate title-size conventions.

Page composition stays local to its surface:

- **Overview:** one selected-period glass token/cost/efficiency/activity summary with a Sessions shortcut, followed by quota previews, compact daily chart, usage breakdowns and devices.
- **Limits:** provider groups, divided account sections with plan and freshness, paired Session/Weekly windows when present. Keep the supplied account/window order and stack windows at accessibility sizes. Monetary balances remain distinct from percentages.
- **Insights:** lifetime readings lead into yearly activity and daily trend, preserving the original iOS reading order. Distinct metric icons aid scanning; the chart owns its compact token/cost selector. Monthly history follows the trend directly. Selected-period tool and model breakdowns belong to Overview; Insights focuses on historical activity and trends.
- **Sessions and Settings:** Sessions is an Overview destination with native back navigation and bounded authenticated summaries. Settings uses native forms, separating connection, display and system-surface configuration. Destination rows summarize current values and stack those values at accessibility sizes. Provider visibility rows use 44pt touch targets without additional vertical row insets; a native Edit button reveals reordering. Explain that display controls affect this iPhone rather than Hub collection, and expose the installed version/build and project support links in About.

Do not turn these page sequences into a rule that every screen needs the same panel composition. Native navigation and accessibility take precedence over reproducing desktop dimensions.

## Elevation & Depth

`SurfaceCard` applies native regular `glassEffect` after layout, without a custom blur or shadow, to the existing reading cards. Preserve that glass treatment across the summary and other card content. Reduce Transparency uses the opaque semantic fallback. Native tab/navigation chrome and actions retain system-owned materials. `AppActionStyle` uses the native glass-prominent style when available and permitted, with bordered-prominent fallback for Reduce Transparency.

**The Host Material Rule.** The Lock Screen Live Activity exposes ActivityKit's system host glass through clear `activityBackgroundTint`, as in the user's pingdotgg/t3code reference. Reduce Transparency uses the host default tint. The app's Settings preview uses native `glassEffect` with an opaque accessibility fallback; it is an illustrative simulation, not the host itself. Dynamic Island keeps its native black surface.

## Shapes

Cards use the existing continuous native rounded rectangles; compact shapes follow the compact radius token. Quota meters use capsules. Native controls retain their platform silhouettes. The Settings Activity preview's larger enclosure is surface-specific, not a new global card radius. No decorative frame or custom glass shell is needed around the readings.

## Components

- **SurfaceCard / DesignTokens:** tokenized padding/radius, native regular glass for reading cards, and an opaque semantic fallback. Preserve light/dark adaptation and Reduce Transparency.
- **OverviewView / HeroSummaryCard:** one panel relates total tokens and cost to cache hit rate, Messages and Average speed; Sessions remains a destination within it. The compact period selector belongs to the shared page header, with a menu fallback at narrow widths and accessibility text sizes. Normal freshness metadata is hidden; explicit stale and connection states remain visible. Cache hit rate uses the desktop classified-input denominator, excluding output and unclassified tokens. A partial split with an explicit unclassified count can still produce a rate for known input even when the complete-component capability is false; show a small info icon beside the label and reveal the localized classified-data explanation in a compact native popover on tap. The explanation adds no persistent row or card height; its entire column is tappable and VoiceOver receives the explanation as a hint. A false capability without an explicit unknown portion, or no classified input, remains unavailable. Message counts come from full history day, monthly per-client rollups, or lifetime summary for the selected period, using Gregorian calendar keys in the viewing device time zone; compact previews without those counts remain unknown until full history arrives. Average speed divides timed output by its own reported durations, not total output or wall-clock time, and is distinct from live TPS. Missing or unavailable readings show a dash. Accessibility sizes stack the metric group, and VoiceOver receives the exact message count and the timing-coverage explanation.
- **ProviderLimitCard / LimitWindowRow:** provider heading, divided account sections, per-account plan/status/freshness, and paired quota windows. Names and plans share the first text baseline; provider marks occupy a separate leading overlay so artwork does not shift that baseline. Each window relates its label, monochrome value, tinted meter and reset/detail text; combine those for VoiceOver. Missing values use an explicit unknown reading, never a fabricated zero or full meter.
- **InsightStatsGrid / InsightMetricCard:** two aligned columns of lifetime readings, with colored semantic SF Symbols and stronger emphasis on total tokens/cost. Accessibility sizes use one column; absent readings remain unknown.
- **InsightTrendCard / UsageTrendChart:** pale blue monotone curves, subtle area fill, no grid or vertical axis, and three aligned date labels. A compact selector beside the daily chart controls tokens/cost. Native chart selection shows the actual nearest available day's date and value, with an indicator and bounded annotation. Peak, period and favorite-model metadata preserve context. Yearly activity stays independent of the chart's metric, with a light blue intensity ramp and month labels above it. Its dense grid is visual; an expandable summary exposes the native date picker and selected reading in a 44pt control row. Keep period context and empty states explicit.
- **BreakdownItem / BreakdownDetailView:** icons, names and token readings share the first text baseline; percentages and cost occupy their own aligned secondary row. Accessibility text stacks measured values beneath the name.
- **Navigation / forms / actions:** use native TabView, NavigationStack, pickers, Form and button styles. Each common tab Label sets `.environment(\.symbolVariants, .none)` to preserve outline SF Symbols within the native tab bar. Sessions retains native back navigation. Settings communicates truthful local/remote Activity status.
- **TokenMonitorActivityWidget / Shared/ActivityViews:** ContentState v4 carries data only (usage, the recent tool's share, up to eight quota records, running agents) with null fields omitted for the 4 KB push budget; `LiveActivityLayout` lives in the app group and the extension reads it at render time. As in the desktop menu bar, each surface pairs an appearance with a data source — an automatic condition (lowest remaining, most recently used) or a named AI tool, an account, a quota window preset, remaining or used, a period and a tool scope — resolved on the device; the layout's named providers and accounts are registered so the Hub sends them. Colour, type and wording stay fixed by this system: monochrome marks, names and readings, vendor colour only on rings and meters, and the Limits screen's `99% left` / `Reset 1h 52m`. Compact slots hug their content with no fixed frames. Hierarchy puts weight on numbers and keeps words quiet: compact readings are 14pt semibold with 10pt units and a 22pt ring with a clearer centre mark, so the island never outweighs the status-bar clock. Expanded and Lock Screen type retains its original scale. The Settings customizer follows the user's reference: a swipeable four-page stage (compact, beside another activity, expanded, Lock Screen) showing a short top crop of an iPhone — one continuous thin rim, an even black bezel and matching screen corners, fading into the page. Page indicators make the four previews discoverable, and the Lock Screen preview shows the activity without an illustrative clock or date; tapping either side of the compact island selects that slot with a thin arc around its end and floats a glass Edit | Delete capsule beneath it. Option tiles are black squircles with a quiet shadow, and the one in use carries a letter badge (L, R, M, E, L) before its caption rather than an outline. Edit opens the data source as a native form sheet showing only the rows the chosen appearance uses. Wide tiles lay out at device width and scale down, keeping phone proportions. The same shared views render the running activity and every preview. Compact and expanded Dynamic Island stay native-black compositions; the Lock Screen keeps a clear background tint for host glass.
- **Widgets:** respect WidgetKit full-color and accented/clear rendering. Small sizes show one meaningful reading; larger sizes add attribution and windows. Accessory layouts are purpose-built and update timing remains subject to platform budgets.

## Do's and Don'ts

### Do:

- **Do** preserve desktop account grouping and paired window meaning while adapting density to native iOS.
- **Do** support light/dark appearance, Dynamic Type, VoiceOver, Reduce Motion and Reduce Transparency.
- **Do** distinguish measured zero, missing readings, stale content and illustrative preview data.
- **Do** keep the current Hub's last received readings visible offline and clear prior-Hub readings when the destination changes.

### Don't:

- **Don't** tint provider icons, names or quota values with vendor colors.
- **Don't** repeat the Token Monitor headline in Lock Screen Live Activity content or paint a custom material over the system host glass.
- **Don't** imply source freshness from a transport timestamp alone or promise immediate Widget/Activity updates.
- **Don't** retrieve session transcripts, present previews as live readings, or canonize isolated clipping, spacing or simulator-rendering defects as design rules.

<!-- Native source of truth: TokenMonitor/App/AppShellView.swift; TokenMonitor/DesignSystem/SectionHeader.swift; TokenMonitor/DesignSystem/{DesignTokens,SurfaceCard}.swift; TokenMonitor/Features/Overview/{OverviewView,HeroSummaryCard}.swift; TokenMonitor/Features/Limits/{ProviderLimitCard,LimitWindowRow}.swift; TokenMonitor/Features/Insights/InsightTrendCard.swift; Widgets/TokenMonitorActivityWidget.swift; Shared/ActivityViews.swift; TokenMonitor/Features/Settings/LiveActivityCustomizerView.swift. -->
