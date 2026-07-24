'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
const composer = fs.readFileSync(path.join(rendererDir, 'trayComposer.js'), 'utf8');
const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');

function functionBody(name, nextName) {
  const start = composer.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = composer.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return composer.slice(start, end);
}

function appFunctionBody(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} function should exist`);
  const end = app.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} function should follow ${name}`);
  return app.slice(start, end);
}

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} rule should exist`);
  return match[1];
}

test('tray composer drag keeps live movement local and commits once on release', () => {
  const begin = functionBody('beginDrag', 'moveDrag');
  const move = functionBody('moveDrag', 'endDrag');
  const end = functionBody('endDrag', 'keyboardMove');

  assert.match(begin, /window\.addEventListener\('pointermove', moveDrag, true\)/);
  assert.match(begin, /window\.addEventListener\('pointerup', endDrag, true\)/);
  assert.match(begin, /window\.addEventListener\('pointercancel', cancelDrag, true\)/);
  assert.match(begin, /itemEl\.addEventListener\('lostpointercapture', cancelDrag/);
  assert.doesNotMatch(move, /\bemit\(/);
  assert.doesNotMatch(move, /insertBefore/);
  assert.match(move, /moveTrayLayoutItem\(drag\.initialLayout, drag\.id, targetIndex\)/);
  assert.match(move, /updateDragSpacing\(\)/);
  assert.match(end, /window\.removeEventListener\('pointermove', moveDrag, true\)/);
  assert.match(end, /itemEl\.removeEventListener\('lostpointercapture', cancelDrag\)/);
  assert.match(end, /releasePointerCapture\(pointerId\)/);
  assert.match(end, /if \(completed && commit\) \{\s*emit\(next, true\);\s*render\(\)/);
});

test('tray composer offers the Token Monitor icon and real quota windows without duplicate presets', () => {
  const iconEditor = functionBody('barIconEditor', 'renderItemPopover');
  const windowChoices = appFunctionBody('trayComposerWindowChoices', 'trayComposerWindowLabel');
  const itemCanvas = appFunctionBody('renderCustomTrayItemCanvas', 'renderCustomTrayLayout');

  assert.match(iconEditor, /value: 'app'/);
  assert.match(iconEditor, /trayComposer\.icon\.app/);
  assert.match(windowChoices, /sourceWindowOptions/);
  assert.doesNotMatch(windowChoices, /\[\.\.\.presets, \.\.\.exact\]/);
  assert.match(itemCanvas, /item\.icon === 'app' \? 'app'/);
  assert.match(itemCanvas, /const iconSize = h;/);
});

test('AI tool icon editor asks only for the tool and keeps quota selection internal', () => {
  const source = functionBody('sourceEditor', 'barIconEditor');
  const editor = functionBody('renderItemPopover', 'openItemPopover');

  assert.match(source, /options\.includeWindow !== false/);
  assert.match(source, /options\.includeAccount !== false/);
  assert.match(editor, /includeAccount: false/);
  assert.match(editor, /includeAllProviders: true/);
  assert.match(editor, /includeValue: false/);
  assert.match(editor, /includeWindow: false/);
  assert.match(source, /includeAll: options\.includeAllProviders === true/);
});

test('tray picker uses one anchored top-layer dropdown outside the editor scroller', () => {
  const position = functionBody('positionPickerMenu', 'closePickerMenu');
  const menu = functionBody('openPickerMenu', 'picker');
  const picker = functionBody('picker', 'updateItem');

  assert.match(position, /below < 140 && above > below/);
  assert.match(position, /--picker-max-height/);
  assert.match(menu, /tray-composer-picker-menu/);
  assert.match(menu, /setAttribute\('popover', 'manual'\)/);
  assert.match(menu, /owner\.append\(menu\)/);
  assert.match(menu, /menu\.showPopover\(\)/);
  assert.match(menu, /search\.type = 'search'/);
  assert.match(picker, /openPickerMenu/);
  assert.doesNotMatch(composer, /tray-composer-picker-sheet/);
  assert.match(cssRule('.tray-composer-picker-menu'), /position:\s*fixed/);
  assert.match(cssRule('.tray-composer-picker-menu'), /max-height:\s*var\(--picker-max-height/);
  assert.match(cssRule('.tray-composer-picker-list'), /overflow:\s*hidden auto/);
});

test('tray composer shows every supported fixed icon while quota sources stay live-data scoped', () => {
  const providers = appFunctionBody('trayComposerProviderChoices', 'trayComposerAccountChoices');
  const delivery = appFunctionBody('deliverTrayProviderIcons', 'setAccountGroupExpanded');
  const groups = composer.slice(
    composer.indexOf('const STYLE_GROUPS'),
    composer.indexOf('function clamp')
  );

  assert.match(app, /const TRAY_ICON_VARIANTS = \[\s*\{ id: 'claude-brand', label: 'Claude', after: 'claude' \},\s*\{ id: 'chatgpt', label: 'ChatGPT', after: 'codex' \}/);
  assert.match(app, /KNOWN_CLIENTS\.flatMap\(\(provider\) => \[\s*provider,\s*\.\.\.TRAY_ICON_VARIANTS\.filter\(\(variant\) => variant\.after === provider\.id\)/);
  assert.match(app, /\.\.\.TRAY_ICON_VARIANTS\.map\(\(provider\) => provider\.id\)/);
  assert.match(providers, /providerOptions\(state\.stats \|\| \{\}\)/);
  assert.match(providers, /includeAll \? TRAY_ICON_PROVIDERS : LIMIT_PROVIDERS/);
  assert.match(providers, /includeAll \|\| available\.has\(provider\.id\) \|\| current\.has\(provider\.id\)/);
  assert.match(providers, /trayComposer\.provider\.unavailable/);
  assert.match(delivery, /trayProviderIconSources\(trayIconProviderIds\)/);
  assert.doesNotMatch(groups, /'cost', 'account'/);
  assert.match(groups, /'spacer', 'separatorDot'/);
});

test('tray composer previews tint provider artwork like a macOS template image', () => {
  const sample = appFunctionBody('providerImageOpticalSample', 'paintProviderImage');
  const paint = appFunctionBody('paintProviderImage', 'drawProviderImage');
  const item = appFunctionBody('renderCustomTrayItemCanvas', 'renderCustomTrayLayout');
  const providerIcon = appFunctionBody('trayComposerProviderIcon', 'trayComposerProviderChoices');
  const renderer = appFunctionBody('renderTrayComposerItem', 'createTrayComposer');

  assert.match(sample, /getImageData/);
  assert.match(sample, /pixels\[\(y \* sampleSize \+ x\) \* 4 \+ 3\]/);
  assert.match(paint, /trayProviderOpticalLayout\(sample\.bounds, size, opticalRatio\)/);
  assert.match(paint, /trayProviderOpticalRatio\(trayProviderImageIds\.get\(image\)\)/);
  assert.match(paint, /globalCompositeOperation = 'source-in'/);
  assert.match(paint, /fillStyle = templateColor/);
  assert.match(item, /options\.templateIconColor \|\| ''/);
  assert.match(providerIcon, /templateColor: floatingBubbleGeneratedColors\(\)\.text/);
  assert.match(renderer, /templateIconColor: floatingBubbleGeneratedColors\(\)\.text/);
});

test('stacked values support metric-specific alignment and spacers can render a separator dot', () => {
  const itemCanvas = appFunctionBody('renderCustomTrayItemCanvas', 'renderCustomTrayLayout');
  const editor = functionBody('renderItemPopover', 'openItemPopover');

  assert.match(itemCanvas, /item\.alignment === 'left' \? 'left' : 'right'/);
  assert.match(itemCanvas, /ctx\.textAlign = alignment/);
  assert.match(itemCanvas, /const textBaselineOffset = Math\.max\(1, Math\.round\(h \* 0\.025\)\)/);
  assert.match(itemCanvas, /0\.72\) \+ textBaselineOffset/);
  assert.match(itemCanvas, /item\.variant === 'dot'/);
  assert.match(itemCanvas, /ctx\.arc\(/);
  assert.match(editor, /trayComposer\.alignment/);
  assert.match(editor, /trayComposer\.spacer\.variant/);
  assert.match(composer, /'cost', 'doubleInfo', 'customText'/);
  assert.match(editor, /item\.metric !== 'mixed'/);
  assert.match(editor, /includeMetric: item\.metric === 'mixed'/);
  assert.match(functionBody('sourceEditor', 'barIconEditor'), /metric === 'tokens' \|\| metric === 'cost'/);
});

test('textual tray items offer distinct system and compact-mono styles on the tray canvas', () => {
  const fontEditor = functionBody('fontStyleEditor', 'renderItemPopover');
  const editor = functionBody('renderItemPopover', 'openItemPopover');
  const canvasFont = appFunctionBody('trayTextCanvasFont', 'renderCustomTrayItemCanvas');
  const itemCanvas = appFunctionBody('renderCustomTrayItemCanvas', 'renderCustomTrayLayout');

  assert.match(fontEditor, /value: 'normal'/);
  assert.match(fontEditor, /value: 'condensed'/);
  assert.match(fontEditor, /value: 'menubar'/);
  assert.match(fontEditor, /value: 'compactMono'/);
  assert.match(fontEditor, /getFontStylePreview\?\.\(item, choice\.value\)/);
  assert.match(editor, /popover\.append\(fontStyleEditor\(item\)\)/);
  assert.match(canvasFont, /style === 'compactMono'/);
  assert.match(canvasFont, /SFMono-Regular/);
  assert.match(canvasFont, /style === 'menubar' \? 700/);
  assert.match(canvasFont, /style === 'compactMono' \? 600/);
  assert.match(canvasFont, /function trayTextSpaceScale/);
  assert.match(canvasFont, /fontStyle === 'compactMono' \? 0\.55 : 1/);
  assert.doesNotMatch(appFunctionBody('trayTextHorizontalScale', 'trayTextSpaceScale'), /compactMono/);
  assert.match(itemCanvas, /trayTextCanvasFont\(item, fontSize, 600\)/);
  assert.match(itemCanvas, /trayTextCanvasFont\(item, fontSize, 500\)/);
  assert.match(itemCanvas, /trayTextHorizontalScale\(item\)/);
  assert.match(itemCanvas, /measureTrayText\(measure, row\.text \|\| '--', item, horizontalScale\)/);
  assert.match(itemCanvas, /measureTrayText\(measure, text, item, horizontalScale\)/);
  assert.match(app, /function renderTrayComposerFontPreview\(item, fontStyle\)/);
  assert.match(app, /renderTrayComposerItem\(\{ \.\.\.item, fontStyle \}\)/);
  assert.doesNotMatch(appFunctionBody('renderTrayComposerFontPreview', 'createTrayComposer'), /100%|81%/);
  assert.match(app, /getFontStylePreview: renderTrayComposerFontPreview/);
});

test('tray composer supports live single-line and stacked custom text', () => {
  const groups = composer.slice(
    composer.indexOf('const STYLE_GROUPS'),
    composer.indexOf('function clamp')
  );
  const input = functionBody('textInput', 'customTextEditor');
  const editor = functionBody('customTextEditor', 'sourceEditor');
  const inlineUpdate = functionBody('updateTextItem', 'queueTextItemUpdate');
  const renderer = appFunctionBody('previewItemForStyle', 'renderTrayComposerItem');

  assert.match(groups, /'customText', 'doubleCustomText'/);
  assert.match(input, /input\.maxLength = 40/);
  assert.match(input, /addEventListener\('input'/);
  assert.match(input, /addEventListener\('change'/);
  assert.match(editor, /item\.type === 'stack'/);
  assert.match(editor, /trayComposer\.customText\.top/);
  assert.match(editor, /trayComposer\.customText\.bottom/);
  assert.match(inlineUpdate, /emit\(next, commit\)/);
  assert.match(inlineUpdate, /reflectItemPreview\(nextItem\)/);
  assert.match(renderer, /return trayLayoutApi\.createTrayLayoutItem\(style\)/);
  assert.doesNotMatch(renderer, /codex|provider\s*=/);
  assert.match(cssRule('.tray-composer-text-input'), /min-height:\s*27px/);
  assert.match(cssRule('.tray-composer-text-input'), /font-size:\s*10\.5px/);
});

test('tray item editor owns compact typography instead of inheriting the app body scale', () => {
  assert.match(cssRule('.tray-composer-popover'), /font-size:\s*10px/);
  assert.match(cssRule('.tray-composer-popover'), /font-family:\s*inherit/);
  assert.match(cssRule('.tray-composer-popover'), /rgba\(var\(--glass-rgb\),\s*0\.76\)/);
  assert.match(cssRule('.tray-composer-picker-menu'), /font-family:\s*inherit/);
  assert.match(cssRule('.tray-composer-picker-menu'), /backdrop-filter:\s*blur\(28px\) saturate\(115%\)/);
  assert.match(cssRule('.tray-composer-editor'), /width:\s*min\(276px,/);
  assert.match(cssRule('.tray-composer-editor .tray-composer-picker'), /min-height:\s*24px/);
  assert.match(cssRule('.tray-composer-editor .tray-composer-picker'), /font-size:\s*10px/);
});

test('live tray preview stays compact while preserving a visible drag affordance', () => {
  assert.match(cssRule('.tray-composer-strip'), /min-height:\s*36px/);
  assert.match(cssRule('.tray-composer-items'), /gap:\s*0\.5px/);
  assert.match(cssRule('.tray-composer-item'), /min-width:\s*0/);
  assert.match(cssRule('.tray-composer-item'), /height:\s*22px/);
  assert.match(cssRule('.tray-composer-item'), /padding:\s*2px 0/);
  assert.match(cssRule('.tray-composer-item'), /--drag-shift/);
  assert.match(cssRule('.tray-composer-item .tray-composer-preview-image'), /height:\s*18px/);
});
