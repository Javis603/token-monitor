# Plugin development guide

Start with the UI below, then add data or settings as needed. This experimental API runs UI without Node in the App document; an optional Node backend has the OS user's file, credential and network authority. Use a disposable profile and only run code you trust. See the [API and trust reference](README.md) when choosing capabilities. The manifest declares `tmApi: 1`.

## First UI

Create `manifest.json`:

```json
{"tmApi":1,"id":"my-panel","name":"My panel","version":"1.0.0","ui":"ui.mjs","files":["ui.mjs"],"views":[{"id":"panel","title":"My panel","surfaces":["home","page"],"defaultSurfaces":["page"]}]}
```

Create `ui.mjs`:

```js
export function activate(ctx) {
  return {
    mount(container, context) {
      const contextLabel = document.createElement('p');
      container.append(contextLabel);
      function update(next) {
        contextLabel.textContent = `My view: ${next.period || next.surface}`;
      }
      update(context);
      return { update, dispose() { contextLabel.remove(); } };
    }
  };
}
```

In Settings → Plugins → Installed → More actions, import the folder and review the trusted-code warning. Choose Trust, install and enable to approve the previewed code and run it, or Install only to copy the declared files into managed storage without executing them. With the master switch off or safe mode active, installation stays disabled. Once enabled, choose Home or Main app page.

## Interface

Add a CSS file to both `files` and `css` for your own design. Add `targets` and a mode to extend original pages; the user explicitly chooses replacements. Native composition uses real host DOM and optional helpers, not another UI engine. See [surfaces](author-ui-options.md).

## Data and settings

This standalone helper demonstrates one query and returns a labelled string. It does not mount or retain data in the first UI:

```js
async function describeToday(ctx) {
  try {
    const result = await ctx.data.query({ resource: 'usage', period: 'today' });
    return result.availability === 'available'
      ? `Today snapshot: ${result.rows.map(row => row.totalTokens ?? 'Unknown').join(', ')} tokens`
      : `Today snapshot: ${result.availability}`;
  } catch (error) {
    return `Today snapshot: could not read data: ${error.message}`;
  }
}
```

Call `await describeToday(ctx)` from an async function with the plugin context. This reads existing data without triggering collection; the host supplies query version 1. It is a one-shot **today** snapshot, not a live value for the currently selected period or source. An empty or unavailable result is not proof of zero usage or zero cost.

For a mounted data display, use the [complete live UI example](author-data-settings.md#live-updates-with-cleanup) instead of copying this helper into the first mount. Its subscription clears old output on source/privacy resets, refetches, and unsubscribes on disposal. A one-shot query has no reset callback: do not retain its returned data across source/privacy changes.

For a complete replacement `ui.mjs` with live updates and unsubscribe cleanup, plus a copyable manifest settings schema and update example, see [Data and settings API](author-data-settings.md). That reference covers query options, result metadata, cursor recovery and save conflicts. You do not need a backend for these operations.

Before choosing chart values, check the [resource fields and coverage](author-data-resources.md). Missing data is not zero; use the [live-rate resource](author-data-resources.md#live-token-rate) for host-computed speed and idle state rather than dividing cumulative tokens by refresh time.

For local files, external APIs or computations, add `backend.cjs` to `files` and declare `backend`; use `ctx.backend.call` and the [backend contract](README.md#local-backend). The UI cannot import Node modules. Ship prebundled dependencies; installation does not run npm scripts.

## Test and distribute

Use the [author self-check](validation.md#author-self-check) in a disposable profile with synthetic data; select checks for the capabilities you ship. Save drafts before changing loaded code: affected renderers may reload. Package with:

```sh
node scripts/build-plugin-package.js /path/to/my-panel /path/to/my-panel.tmplugin
```

The output must not already exist. Share the file or use a trusted HTTPS catalog. Update `version`, test against the target App/OS, and disclose local/network/data access accurately. Do not present a hash as an audit. Before sharing publicly, follow the [publishing guide and README template](publishing.md). See [distribution](distribution-design.md) for package and catalog details; the [platform acceptance section](validation.md#maintainer-platform-acceptance) is for host maintainers.

Optional `defaultSurfaces` suggests initial locations from the view's supported surfaces. Users confirm or change these at installation; install-only defers placement until first enable. Updates preserve user choices. Surface master switches stay unchanged, full locations are skipped, and native replacements remain explicit user choices. See [placement semantics](README.md) for reinstall and recovery behavior.
