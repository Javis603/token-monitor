# Settings help popovers

`src/electron/renderer/helpPopover.js` pairs an info button with caller-owned help content. Load `selectControl.js` and `helpPopover.js` before the code that initializes it. The shared `settings-help-trigger` and `settings-help-popover` classes follow the app popup surface in regular and native glass modes.

```html
<button id="exampleHelp" type="button" class="settings-help-trigger" aria-label="Explain this setting"><span aria-hidden="true">i</span></button>
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

Hover, focus and click open the help without changing the associated setting. Escape, blur, outside click, external scrolling and window resizing close it. A short leave delay lets the pointer cross into the popover for reading or selecting code. Positioning reuses `selectControl.popupPosition`, bounds the card to the viewport and flips it above when needed; `maxWidth` (default 280), `align` (default `end`) and `closeDelay` (default 150 ms) may be supplied.

Only one help card is active per document. Hidden, inert or disconnected triggers cannot open one; hiding/removing their ancestor also closes an open card. The module manages `aria-describedby`, `aria-controls` and `aria-expanded`; each trigger still needs a localized accessible name and each popover needs a unique ID. Caller code owns the translated content and any setting-specific visibility conditions. Use a dialog for decisions or interactive forms; this help surface contains explanatory text.
