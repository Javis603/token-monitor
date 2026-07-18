'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const mainSource = fs.readFileSync(path.join(root, 'src', 'electron', 'main.js'), 'utf8');
const widgetSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'TokenMonitorWidget.swift'),
  'utf8'
);
const widgetIntentSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetConfigurationIntent.swift'),
  'utf8'
);
const widgetViewModelSource = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetViewModel.swift'),
  'utf8'
);
const widgetInfo = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'Info.plist'),
  'utf8'
);
const widgetProject = fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget.xcodeproj', 'project.pbxproj'),
  'utf8'
);
const widgetBuildSource = fs.readFileSync(path.join(root, 'scripts', 'build-macos-widget.js'), 'utf8');
const widgetLocalization = JSON.parse(fs.readFileSync(
  path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'Localizable.xcstrings'),
  'utf8'
));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const {
  DEFAULT_APP_GROUP,
  DEFAULT_WIDGET_BUNDLE_ID,
  packageVersion,
  validateDistributionIdentifiers
} = require('../../scripts/build-macos-widget');

test('publishes final stats to the macOS Widget from the single sendPush outlet', () => {
  const start = mainSource.indexOf('function sendPush(payload)');
  const end = mainSource.indexOf('\nfunction statsHistoryRevision', start);
  assert.ok(start >= 0 && end > start, 'sendPush function should exist');
  const sendPush = mainSource.slice(start, end);
  assert.match(sendPush, /latestStats = payload\.data\.stats;\s+scheduleMacWidgetSnapshot\(latestStats\);/);
  assert.equal((mainSource.match(/scheduleMacWidgetSnapshot\(latestStats\)/g) || []).length, 1);
});

test('registers the Widget deep link and embeds the appex in macOS packages', () => {
  const mac = packageJson.build.mac;
  assert.deepEqual(mac.extendInfo.CFBundleURLTypes[0].CFBundleURLSchemes, ['token-monitor']);
  assert.equal(mac.extraFiles[0].to, 'PlugIns/TokenMonitorWidget.appex');
  assert.equal(mac.extraResources[0].to, 'token-monitor-widget.json');
  assert.equal(mac.extraResources[1].to, 'TokenMonitorWidgetReloader');
  assert.equal(mac.sign, 'scripts/sign-macos-with-widget.js');
  assert.match(packageJson.scripts['predist:mac'], /build:mac-widget/);
});

test('supports an isolated local Widget URL scheme without changing the release default', () => {
  assert.match(mainSource, /parseMacWidgetDeepLink\(url, urlScheme\)/);
  assert.match(widgetSource, /static let urlScheme = Bundle\.main\.object/);
  assert.match(widgetInfo, /<key>TokenMonitorURLScheme<\/key>/);
  assert.deepEqual(
    packageJson.build.mac.extendInfo.CFBundleURLTypes[0].CFBundleURLSchemes,
    ['token-monitor']
  );
});

test('uses AppIntent configuration and page-specific deep links', () => {
  assert.match(widgetSource, /AppIntentConfiguration\(/);
  assert.match(widgetSource, /url\(for: entry\.page\)/);
  assert.match(widgetSource, /\.systemLarge/);
  assert.match(widgetSource, /com\.tokenmonitor\.dashboard/);
  assert.doesNotMatch(widgetSource, /StaticConfiguration\(/);
});

test('Widget period controls are real App Intent buttons without fake dropdown state', () => {
  assert.match(widgetSource, /Button\(intent: CycleWidgetPeriodIntent\(\)\)/);
  assert.match(widgetSource, /Button\(intent: SetWidgetPeriodIntent\(period: period\)\)/);
  assert.doesNotMatch(widgetSource, /onTapGesture/);
  assert.doesNotMatch(widgetSource, /chevron\.down/);
  assert.doesNotMatch(widgetSource, /TOKEN_MONITOR_WIDGET_KIND.*v4|v3-temp|dev/);
});

test('Widget page control cycles pages with per-family App Intent state', () => {
  const footerStart = widgetSource.indexOf('private func footer(page: WidgetPage, familyScope: WidgetFamilyScope?)');
  const footerEnd = widgetSource.indexOf('\n    private func statusState', footerStart);
  assert.ok(footerStart >= 0 && footerEnd > footerStart, 'footer should exist');
  const footerSource = widgetSource.slice(footerStart, footerEnd);
  const pageControlStart = widgetSource.indexOf('struct WidgetPageControl: View');
  const pageControlEnd = widgetSource.indexOf('\n}', pageControlStart);
  assert.ok(pageControlStart >= 0 && pageControlEnd > pageControlStart, 'WidgetPageControl should exist');
  const pageControlSource = widgetSource.slice(pageControlStart, pageControlEnd);
  assert.match(widgetIntentSource, /struct CycleWidgetPageIntent: AppIntent/);
  assert.match(widgetIntentSource, /static var openAppWhenRun: Bool \{ false \}/);
  assert.match(widgetIntentSource, /enum WidgetFamilyScope: String, Codable, AppEnum, CaseIterable/);
  assert.match(widgetIntentSource, /widget\.presentation\.page/);
  assert.match(widgetSource, /Button\(intent: CycleWidgetPageIntent\(family: family, currentPage: page\)\)/);
  assert.match(widgetSource, /Image\(systemName: "chevron\.right"\)/);
  assert.doesNotMatch(pageControlSource, /Link\(/, 'page control should not be wrapped in a Link');
  assert.match(footerSource, /Link\(destination: TokenMonitorWidgetConfiguration\.url\(for: page\)\)/);
  assert.doesNotMatch(widgetIntentSource, /selectedPageKey\s*=\s*"selectedPage"/);
  assert.doesNotMatch(`${widgetSource}\n${widgetIntentSource}`, /reloadAllTimelines/);
});

test('macOS Widget packaging keeps the canonical Token Monitor app identity', () => {
  assert.equal(packageJson.scripts['mac:local'], undefined);
  assert.equal(packageJson.scripts['mac:local:open'], undefined);
  assert.equal(packageJson.productName, 'Token Monitor');
  assert.equal(packageJson.build.productName, 'Token Monitor');
});

test('Widget build provenance fields are injected into the extension Info.plist', () => {
  for (const key of [
    'TMWidgetGitRevision',
    'TMWidgetBuildTimestamp',
    'TMWidgetSchemaVersion',
    'TMWidgetUIVersion',
    'TMWidgetKind'
  ]) {
    assert.match(widgetInfo, new RegExp(`<key>${key}</key>`));
  }
  assert.match(widgetProject, /TOKEN_MONITOR_WIDGET_KIND = com\.tokenmonitor\.dashboard;/);
  assert.match(widgetProject, /TOKEN_MONITOR_WIDGET_GIT_REVISION = unknown;/);
  assert.match(widgetBuildSource, /const WIDGET_UI_VERSION = 19;/);
  assert.match(widgetBuildSource, /const WIDGET_SCHEMA_VERSION = 5;/);
  assert.equal(packageVersion(), packageJson.version);
  assert.match(widgetProject, /MARKETING_VERSION = "\$\(TOKEN_MONITOR_PACKAGE_VERSION\)";/);
  assert.match(widgetProject, /CURRENT_PROJECT_VERSION = "\$\(TOKEN_MONITOR_PACKAGE_VERSION\)";/);
  assert.match(widgetBuildSource, /xcconfigLine\('MARKETING_VERSION', currentProjectVersion\)/);
  assert.match(widgetInfo, /<key>TMWidgetSchemaVersion<\/key>\s*<string>5<\/string>/);
  assert.match(widgetInfo, /<key>TMWidgetUIVersion<\/key>\s*<string>19<\/string>/);
});

test('distribution Widget builds reject implicit example identifiers', () => {
  assert.throws(() => validateDistributionIdentifiers({
    appGroup: DEFAULT_APP_GROUP,
    bundleId: DEFAULT_WIDGET_BUNDLE_ID,
    distributionBuild: true
  }), /TOKEN_MONITOR_APP_GROUP/);
  assert.doesNotThrow(() => validateDistributionIdentifiers({
    appGroup: 'group.org.example-project.tokenmonitor',
    bundleId: 'org.example-project.tokenmonitor.widget',
    distributionBuild: false
  }));
});

test('Widget user-facing strings are localized in five languages', () => {
  const swiftSources = [widgetSource, widgetIntentSource, widgetViewModelSource];
  const snapshotSource = fs.readFileSync(
    path.join(root, 'native', 'macos', 'TokenMonitorWidget', 'WidgetSnapshot.swift'),
    'utf8'
  );
  swiftSources.push(snapshotSource);
  assert.doesNotMatch(swiftSources.join('\n'), /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/);
  assert.equal(widgetLocalization.sourceLanguage, 'en');
  for (const [key, entry] of Object.entries(widgetLocalization.strings)) {
    assert.deepEqual(
      Object.keys(entry.localizations).sort(),
      ['en', 'ja', 'ko', 'zh-Hans', 'zh-Hant'],
      `missing localization for ${key}`
    );
    assert.ok(Object.values(entry.localizations).every((localization) => (
      localization.stringUnit?.state === 'translated' && localization.stringUnit.value
    )), `incomplete localization for ${key}`);
  }
});

test('Widget layout uses system margins and fixed scaffold metrics without changing kind', () => {
  assert.match(widgetViewModelSource, /struct WidgetLayoutMetrics/);
  assert.match(widgetViewModelSource, /struct WidgetScaffoldGeometry/);
  assert.match(widgetViewModelSource, /static let small = WidgetLayoutMetrics/);
  assert.match(widgetViewModelSource, /static let medium = WidgetLayoutMetrics/);
  assert.match(widgetViewModelSource, /static let large = WidgetLayoutMetrics/);
  assert.equal((widgetViewModelSource.match(/outerTopInset: 0/g) || []).length, 3);
  assert.equal((widgetViewModelSource.match(/outerBottomInset: 0/g) || []).length, 3);
  assert.equal((widgetViewModelSource.match(/horizontalInset: 0/g) || []).length, 3);
  assert.match(widgetViewModelSource, /contentGap: WidgetDesignTokens\.largeGap/);
  assert.match(widgetSource, /VStack\(spacing: metrics\.contentGap\)/);
  assert.match(widgetSource, /\.padding\(metrics\.outerInsets\)/);
  assert.doesNotMatch(widgetSource, /\.contentMarginsDisabled\(\)/);
  assert.match(widgetSource, /ViewThatFits\(in: \.vertical\)/);
  assert.doesNotMatch(widgetSource, /\.clipped\(\)/);
  assert.match(widgetSource, /\.frame\(maxWidth: \.infinity, maxHeight: \.infinity, alignment: \.topLeading\)/);
  assert.match(widgetSource, /measureWidgetLayoutRegion\(\.header\)/);
  assert.match(widgetSource, /measureWidgetLayoutRegion\(\.content\)/);
  assert.match(widgetSource, /measureWidgetLayoutRegion\(\.footer\)/);
  assert.match(widgetSource, /\.frame\(height: metrics\.footerHeight\)/);
  assert.match(widgetSource, /\.frame\(width: metrics\.pageControlWidth, height: WidgetDesignTokens\.pageControlHeight, alignment: \.leading\)/);
  assert.match(widgetSource, /Image\(systemName: "arrow\.up\.right"\)[\s\S]*\.frame\(width: WidgetDesignTokens\.openButtonSize, height: WidgetDesignTokens\.openButtonSize\)/);
  assert.match(widgetInfo, /<key>TMWidgetSchemaVersion<\/key>\s*<string>5<\/string>/);
  assert.match(widgetProject, /TOKEN_MONITOR_WIDGET_KIND = com\.tokenmonitor\.dashboard;/);
});

test('Widget scaffold keeps header and footer outside page content switches', () => {
  const scaffoldStart = widgetSource.indexOf('private func scaffold<Header: View, Content: View, Footer: View>');
  const scaffoldEnd = widgetSource.indexOf('\n    private var familyScope', scaffoldStart);
  assert.ok(scaffoldStart >= 0 && scaffoldEnd > scaffoldStart, 'scaffold should exist');
  const scaffoldSource = widgetSource.slice(scaffoldStart, scaffoldEnd);
  const pageBodyStart = widgetSource.indexOf('private func pageBody');
  const pageBodyEnd = widgetSource.indexOf('\n    private func overview', pageBodyStart);
  const pageBodySource = widgetSource.slice(pageBodyStart, pageBodyEnd);

  assert.match(scaffoldSource, /header[\s\S]*\.measureWidgetLayoutRegion\(\.header\)/);
  assert.match(scaffoldSource, /footer[\s\S]*\.measureWidgetLayoutRegion\(\.footer\)/);
  assert.match(scaffoldSource, /VStack\(spacing: metrics\.contentGap\)/);
  assert.doesNotMatch(pageBodySource, /header\(/);
  assert.doesNotMatch(pageBodySource, /footer\(/);
  assert.doesNotMatch(pageBodySource, /WidgetPageControl/);
  assert.match(pageBodySource, /GeometryReader \{ proxy in/);
  assert.doesNotMatch(widgetSource, /fixedSize\s*\([^)]*vertical:\s*true/);
  assert.doesNotMatch(widgetSource, /\.offset\(y:\s*-/);
  assert.match(widgetSource, /\.supportedFamilies\(\[\.systemSmall, \.systemMedium, \.systemLarge\]\)/);
});

test('Activity layout adapts density and heatmap size without clipping the scaffold', () => {
  const activityStart = widgetSource.indexOf('private func activity(_ snapshot: WidgetSnapshot, context: WidgetContentContext)');
  const activityEnd = widgetSource.indexOf('\n    private func trend', activityStart);
  assert.ok(activityStart >= 0 && activityEnd > activityStart, 'activity view should exist');
  const activitySource = widgetSource.slice(activityStart, activityEnd);
  assert.match(activitySource, /adaptiveContent \{/);
  assert.match(widgetSource, /private func activityLayout\(/);
  assert.match(widgetSource, /case \.small: 16/);
  assert.match(widgetSource, /case \.medium: 14/);
  assert.match(widgetSource, /case \.large: 26/);
  assert.match(widgetSource, /private func mediumActivityView\(/);
  assert.match(widgetSource, /WidgetMediumActivityLayoutPlan\.make\(availableSize: context\.size\)/);
  assert.match(widgetSource, /HStack\(alignment: \.center, spacing: plan\.spacing\)/);
  assert.match(widgetSource, /CGSize\(width: plan\.heatmapWidth, height: context\.size\.height\)/);
  assert.match(widgetSource, /WidgetHeatmapLayoutCalculator\.make\(/);
  assert.match(widgetSource, /Text\(WidgetL10n\.format\("%lld days", spec\.activeDays\)\)/);
  assert.match(widgetSource, /struct ActivityHeatmap: View/);
  assert.match(widgetSource, /Grid\(horizontalSpacing: layout\.spacing, verticalSpacing: layout\.spacing\)/);
  assert.match(widgetSource, /ForEach\(0\.\.<7, id: \\.self\)/);
  assert.match(widgetSource, /GridRow \{/);
  assert.match(widgetSource, /\.frame\(width: layout\.renderedWidth, height: layout\.renderedHeight/);
  assert.match(widgetViewModelSource, /let cellWidth: CGFloat/);
  assert.match(widgetViewModelSource, /let cellHeight: CGFloat/);
  assert.match(widgetViewModelSource, /struct WidgetMediumActivityLayoutPlan: Equatable/);
  assert.match(widgetViewModelSource, /let summaryWidth: CGFloat/);
  assert.match(widgetViewModelSource, /let heatmapWidth: CGFloat/);
  assert.match(widgetSource, /width: layout\.cellWidth,[\s\S]*height: layout\.cellHeight/);
  assert.doesNotMatch(widgetSource, /minimumWidthRatio:\s*0\.65/);
  assert.doesNotMatch(widgetSource, /allowsVerticalOverflow:\s*true/);
  assert.doesNotMatch(widgetSource, /LazyVGrid/);
  assert.doesNotMatch(widgetSource, /\.offset\(x:\s*-/);
  assert.doesNotMatch(widgetSource, /\.padding\(\.leading,\s*-/);
  assert.doesNotMatch(widgetSource, /rotationEffect/);
});

test('Medium and Large activity cells are App Intent buttons with stable selection details', () => {
  const heatmapStart = widgetSource.indexOf('struct ActivityHeatmap: View');
  const heatmapEnd = widgetSource.indexOf('\nenum WidgetPeriodControlStyle', heatmapStart);
  assert.ok(heatmapStart >= 0 && heatmapEnd > heatmapStart, 'activity heatmap should exist');
  const heatmapSource = widgetSource.slice(heatmapStart, heatmapEnd);
  const mediumStart = widgetSource.indexOf('private func mediumActivityView(');
  const mediumEnd = widgetSource.indexOf('\n    private func selectedDayDetail(', mediumStart);
  const mediumSource = widgetSource.slice(mediumStart, mediumEnd);

  assert.match(widgetIntentSource, /struct SelectActivityDayIntent: AppIntent/);
  assert.match(widgetIntentSource, /static var openAppWhenRun: Bool \{ false \}/);
  assert.match(widgetIntentSource, /widget\.presentation\.activity-day/);
  assert.match(heatmapSource, /Button\(intent: SelectActivityDayIntent\(family: family, date: cell\.date\)\)/);
  assert.match(heatmapSource, /if let family, cell\.isSelectable/);
  assert.doesNotMatch(heatmapSource, /hasActivityData/);
  assert.match(heatmapSource, /\.buttonStyle\(\.plain\)/);
  assert.match(heatmapSource, /\.overlay \{[\s\S]*\.strokeBorder\(\.primary, lineWidth: 2\)/);
  assert.doesNotMatch(heatmapSource, /Link\(/, 'cell buttons must not be nested in links');
  assert.match(widgetSource, /context\.layout == \.large \? \.large : nil/);
  assert.match(widgetSource, /ActivityHeatmap\(layout: spec, family: \.medium, selectedDate: entry\.selectedActivityDate\)/);
  assert.match(mediumSource, /selectedDayDetail\(snapshot\)[\s\S]*\.frame\(height: 32/);
  assert.match(widgetSource, /context\.layout == \.large \{[\s\S]*secondary\(largeActivityCaptionText\(snapshot, layout: spec\)\)/);
  assert.match(widgetSource, /private func largeActivityCaptionText\([\s\S]*return activityDateRangeText\(layout\)/);
  assert.doesNotMatch(widgetSource, /selectedDayDetailLine/);
  assert.match(widgetSource, /WidgetFormat\.tokens\(day\.totalTokens, style: snapshot\.presentation\.numberStyle\)/);
  assert.match(widgetSource, /WidgetActivitySelection\.detailDay\(/);
  assert.doesNotMatch(widgetSource, /onHover|@State/);
});

test('Large overview quota and model rows share the same row component', () => {
  const largeOverviewStart = widgetSource.indexOf('private func largeOverview(');
  const largeOverviewEnd = widgetSource.indexOf('\n    private func quotaSummary', largeOverviewStart);
  const largeOverviewSource = widgetSource.slice(largeOverviewStart, largeOverviewEnd);
  const modelRowsStart = widgetSource.indexOf('private func modelOverviewRows');
  const modelRowsEnd = widgetSource.indexOf('\n    private func summaryLinkRow', modelRowsStart);
  const modelRowsSource = widgetSource.slice(modelRowsStart, modelRowsEnd);

  assert.match(widgetSource, /private struct LargeOverviewListRow: View/);
  assert.match(widgetSource, /struct Model: Equatable/);
  assert.match(widgetSource, /private let rowHeight: CGFloat = 16/);
  assert.match(widgetSource, /private let fontSize: CGFloat = 10/);
  assert.match(largeOverviewSource, /ViewThatFits\(in: \.vertical\)/);
  assert.match(largeOverviewSource, /quotaLimit: 3, modelLimit: 2, showsMoreRows: true/);
  assert.match(largeOverviewSource, /quotaLimit: 2, modelLimit: 2, showsMoreRows: true/);
  assert.match(largeOverviewSource, /quotaLimit: 1, modelLimit: 1, showsMoreRows: false/);
  assert.match(widgetSource, /\.font\(\.system\(size: fontSize, weight: \.medium\)\)/);
  assert.match(widgetSource, /\.font\(\.system\(size: fontSize, weight: \.medium, design: \.monospaced\)\)/);
  assert.match(widgetSource, /\.frame\(height: rowHeight, alignment: \.center\)/);
  assert.match(largeOverviewSource, /LargeOverviewListRow\(label: row\.label, value: row\.value, style: row\.style\)/);
  assert.ok((widgetSource.match(/LargeOverviewListRow\(/g) || []).length >= 3);
  assert.match(modelRowsSource, /LargeOverviewListRow\.Model/);
  assert.doesNotMatch(modelRowsSource, / · /);
});

test('Quota and model pages derive row density from measured content height', () => {
  const quotaStart = widgetSource.indexOf('private func quota(_ snapshot: WidgetSnapshot, context: WidgetContentContext)');
  const quotaEnd = widgetSource.indexOf('\n    private func models', quotaStart);
  const modelStart = widgetSource.indexOf('private func models(_ snapshot: WidgetSnapshot, context: WidgetContentContext)');
  const modelEnd = widgetSource.indexOf('\n    private func activity', modelStart);
  const quotaPageSource = widgetSource.slice(quotaStart, quotaEnd);
  const modelPageSource = widgetSource.slice(modelStart, modelEnd);

  assert.match(widgetViewModelSource, /enum WidgetListCapacity/);
  assert.match(widgetViewModelSource, /for density in \[WidgetContentDensity\.regular, \.compact, \.summary\]/);
  assert.match(widgetViewModelSource, /availableForRows/);
  assert.equal((widgetSource.match(/WidgetListCapacity\.plan\(/g) || []).length, 2);
  assert.equal((widgetSource.match(/availableHeight: context\.size\.height/g) || []).length, 3);
  assert.doesNotMatch(quotaPageSource, /quotaLimit|modelLimit/);
  assert.doesNotMatch(modelPageSource, /quotaLimit|modelLimit/);
});

test('macOS Widget integration leaves non-macOS packaging sections unchanged', () => {
  assert.ok(packageJson.build.win);
  assert.ok(packageJson.build.linux);
  assert.equal(packageJson.build.win.extraFiles, undefined);
  assert.equal(packageJson.build.linux.extraFiles, undefined);
});
