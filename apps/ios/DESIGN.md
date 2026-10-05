---
name: Token Monitor for iOS
description: Measured instruments for usage and quota headroom, in native iOS chrome.
rounded:
  card: "20pt"
  compact: "16pt"
spacing:
  screen: "20pt"
  section: "24pt"
  card: "20pt"
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

The reading story moves from current measured use and available quota to historical context. Quiet surfaces and a clear numerical hierarchy let the readings carry the screen. Preserve the existing read-only companion character and system-surface customization.

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

Use the system font and semantic SwiftUI text styles for titles, body and metadata. Native large navigation titles establish page identity. Section headings use headline or semibold title styles; caption and footnote styles distinguish supporting information.

`HeroSummaryCard` has a rounded semibold token reading, scaled from its existing large-title-relative base; cost has a medium title treatment. Use monospaced digits for measured values, with localized currency and numeric formatting. Prose stays in the system proportional font. Preserve exact-value accessibility labels alongside abbreviated display values.

Dynamic Type determines layout, not just font size. Accessibility sizes stack paired metrics, account metadata and quota windows; maintain readable labels and VoiceOver grouping rather than shrinking the whole interface.

## Layout

Use the frontmatter spacing and shape values from `DesignTokens`; they are native points, not CSS pixels. Scrollable pages use a single reading column with continuous sections and shared screen edges. Dividers separate the readings without enclosing every section in a card. Native tabs and per-tab navigation stacks provide the persistent frame. The first Overview viewport establishes the native large title, period selector and unified reading panel; connection notices appear when needed. Limits opens onto provider accounts.

Page composition stays local to its surface:

- **Overview:** one selected-period glass usage/cost/cache/output/Sessions summary, followed by open quota previews, compact daily chart, usage breakdowns and devices.
- **Limits:** open provider groups, divided account sections with plan and freshness, paired Session/Weekly windows when present. Keep the supplied account/window order and stack windows at accessibility sizes. Monetary balances remain distinct from percentages.
- **Insights:** lifetime readings lead into yearly activity and daily trend, preserving the original iOS reading order. Distinct metric icons aid scanning; the chart owns its compact token/cost selector. Breakdowns and monthly history follow as continuous sections.
- **Sessions and Settings:** Sessions is an Overview destination with native back navigation and bounded authenticated summaries. Settings uses native forms, separating connection, display and system-surface configuration.

Do not turn these page sequences into a rule that every screen needs the same panel composition. Native navigation and accessibility take precedence over reproducing desktop dimensions.

## Elevation & Depth

The Overview summary is the sole glass reading panel, following the user's original iOS reference. `SurfaceCard(glass: true)` applies native regular `glassEffect` after layout, without a custom blur or shadow. Reduce Transparency and older iOS versions use the opaque semantic fallback. Other reading sections remain open, preserving the desktop information relationships. Native tab/navigation chrome and actions retain system-owned materials. `AppActionStyle` uses the native glass-prominent style when available and permitted, with bordered-prominent fallback for Reduce Transparency.

**The Host Material Rule.** The Lock Screen Live Activity exposes ActivityKit's system host glass through clear `activityBackgroundTint`, as in the user's pingdotgg/t3code reference. Reduce Transparency uses the host default tint. The app's Settings preview uses native `glassEffect` with an opaque accessibility fallback; it is an illustrative simulation, not the host itself. Dynamic Island keeps its native black surface.

## Shapes

Cards use the existing continuous native rounded rectangles; compact shapes follow the compact radius token. Quota meters use capsules. Native controls retain their platform silhouettes. The Settings Activity preview's larger enclosure is surface-specific, not a new global card radius. No decorative frame or custom glass shell is needed around the readings.

## Components

- **SurfaceCard / DesignTokens:** tokenized padding/radius, opt-in native glass for the Overview summary, and an opaque semantic fallback. Preserve light/dark adaptation and Reduce Transparency.
- **OverviewView / HeroSummaryCard:** one panel relates total tokens and cost to cache read, cache write and output; Sessions remains a destination within it. Period and update metadata explain the reading. Accessibility layouts stack the existing metric groups.
- **ProviderLimitCard / LimitWindowRow:** provider heading, divided account sections, per-account plan/status/freshness, and paired quota windows. Names and plans share the first text baseline; provider marks occupy a separate leading overlay so artwork does not shift that baseline. Each window relates its label, monochrome value, tinted meter and reset/detail text; combine those for VoiceOver. Missing values use an explicit unknown reading, never a fabricated zero or full meter.
- **InsightStatsGrid / InsightMetricCard:** two aligned columns of lifetime readings, with colored semantic SF Symbols and stronger emphasis on total tokens/cost. Accessibility sizes use one column; absent readings remain unknown.
- **InsightTrendCard / UsageTrendChart:** pale blue monotone curves, subtle area fill, no grid or vertical axis, and three aligned date labels. A compact selector beside the daily chart controls tokens/cost. Native chart selection shows the actual nearest available day's date and value, with an indicator and bounded annotation. Peak, period and favorite-model metadata preserve context. Yearly activity stays independent of the chart's metric, with a light blue intensity ramp and month labels above it. Its dense grid is visual; an expandable summary exposes the native date picker and selected reading in a 44pt control row. Keep period context and empty states explicit.
- **BreakdownItem / BreakdownDetailView:** icons, names and token readings share the first text baseline; percentages and cost occupy their own aligned secondary row. Accessibility text stacks measured values beneath the name.
- **Navigation / forms / actions:** use native TabView, NavigationStack, pickers, Form and button styles. Sessions retains native back navigation. Settings communicates truthful local/remote Activity status.
- **TokenMonitorActivityWidget / Shared/ActivityViews:** ContentState v2 carries structured data (quota, windows, layout options) and the same shared views render the running activity and the Settings customizer — no preview-only duplicates. Compact and expanded Dynamic Island stay native-black compositions; the Lock Screen keeps a clear background tint for host glass.
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

<!-- Native source of truth: TokenMonitor/DesignSystem/{DesignTokens,SurfaceCard}.swift; TokenMonitor/Features/Overview/{OverviewView,HeroSummaryCard}.swift; TokenMonitor/Features/Limits/{ProviderLimitCard,LimitWindowRow}.swift; TokenMonitor/Features/Insights/InsightTrendCard.swift; Widgets/TokenMonitorActivityWidget.swift; Shared/ActivityViews.swift; TokenMonitor/Features/Settings/LiveActivityCustomizerView.swift. -->
