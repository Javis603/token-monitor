# Settings help popovers

`src/electron/renderer/helpPopover.js` pairs an info button with caller-owned help content. Load `selectControl.js` and `helpPopover.js` before the code that initializes it. The shared `settings-help-trigger` and `settings-help-popover` classes follow the app popup surface in regular and native glass modes.

```html
<button id="exampleHelp" type="button" class="settings-help-trigger" data-i18n-aria-label="settings.example.helpLabel" aria-label="Explain this setting"><span aria-hidden="true">i</span></button>
<div id="exampleHelpText" class="settings-help-popover" popover="auto" role="tooltip">Your localized explanation.</div>
```

```js
const help = window.TokenMonitorHelpPopover.createHelpPopover({
  trigger: document.getElementById('exampleHelp'),
  popover: document.getElementById('exampleHelpText')
});
// Explicit semantic changes, such as switching the server:
help.close();
// Before removing or replacing this component:
help.dispose();
```

Hover, focus and click open the help without changing the associated setting. Escape, focus leaving the trigger and popover, outside click, external scrolling and window resizing close it. Clicking selectable plain text inside keeps the help open even when the trigger loses focus without a new focus target. A short leave delay lets the pointer cross into the popover for reading or selecting code. Positioning reuses `selectControl.popupPosition`, bounds the card to the available viewport height without the select menu’s 320 px cap, and flips it above when needed; `maxWidth` (default 280), `align` (default `end`) and `closeDelay` (default 150 ms) may be supplied.

Only one help card is active per document. Hidden, inert or disconnected triggers cannot open one; hiding/removing their ancestor also closes an open card. The module manages `aria-describedby`, `aria-controls` and `aria-expanded`; callers must give each trigger a localized accessible name and each popover a unique ID, `popover="auto"` and `role="tooltip"`. Caller code owns the translated content and any setting-specific visibility conditions. Use a dialog for decisions or interactive forms; this help surface contains explanatory text.
