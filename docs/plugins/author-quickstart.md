# Plugin development guide

Read the [API and trust contract](README.md) first. This experimental API runs author UI in the App document and optional Node code with the user's local authority. Only install code you trust. The manifest declares `tmApi: 1`.

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
      const output = document.createElement('p');
      container.append(output);
      function update(next) {
        output.textContent = `My view: ${next.period || next.surface}`;
      }
      update(context);
      return { update, dispose() { output.remove(); } };
    }
  };
}
```

In Settings → Plugins → Installed → More actions, import the folder. Installation copies the declared files into managed storage without executing them. Review the trusted-code warning, enable it, and choose Home or Main app page.

## Interface

Add a CSS file to both `files` and `css` for your own design. Add `targets` and a mode to extend original pages; the user explicitly chooses replacements. Native composition uses real host DOM and optional helpers, not another UI engine. See [surfaces](author-ui-options.md).

## Data and settings

Read existing App data through `ctx.data.query({resource:'usage',period:'today'})`; handle unavailable/stale/unknown results. Subscribe for updates and release subscriptions. Declare a versioned `settings` schema for the native form or a `settings` view for your own editor. For local files, external APIs or computations, add `backend.cjs` to `files` and declare `backend`; use `ctx.backend.call`. The backend may use Node libraries, but the UI cannot import Node modules. Ship prebundled dependencies; do not ask the installer to run npm scripts.

## Test and distribute

Test in a disposable profile with synthetic data. Cover no-demand idle, multiple locations sharing one backend, source/period changes, keyboard interaction, failure/native fallback, disabled/startup safe mode and updates. Save drafts before changing loaded code: affected renderers may reload. Package with:

```sh
node scripts/build-plugin-package.js /path/to/my-panel /path/to/my-panel.tmplugin
```

The output must not already exist. Share the file or use a trusted HTTPS catalog. Update `version`, test against the target App/OS, and disclose local/network/data access accurately. Do not present a hash as an audit. See [distribution](distribution-design.md) and [verification](validation.md).

Optional `defaultSurfaces` suggests initial locations from the view's supported surfaces. Users confirm or change these at installation; install-only defers placement until first enable. Updates preserve user choices. Surface master switches stay unchanged, full locations are skipped, and native replacements remain explicit user choices. See [placement semantics](README.md) for reinstall and recovery behavior.
