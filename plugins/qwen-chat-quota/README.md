# Qwen Chat subscription quota

An optional Token Monitor plugin that shows the actual remaining weekly quota and reset time for Qwen Plus/Pro subscriptions. This allowance is shared by Qwen Code, Agent Mode, Coder and Deep Research. Ordinary Qwen Chat conversations are excluded.

## Compatibility

- Token Monitor 0.100.0 or newer; plugin API 1.
- Tested with the Qwen desktop app on Windows x64.
- Standard macOS and Linux Qwen profile locations are recognized, but live account acceptance on those platforms has not been tested.
- Requires an existing signed-in Qwen **desktop app** session. A browser-only login or Qwen Code OAuth credentials alone do not configure this plugin.

## Install

From a Token Monitor checkout, build an importable package:

```sh
node scripts/build-plugin-package.js plugins/qwen-chat-quota qwen-chat-quota-0.1.0.tmplugin
```

The output path must not already exist. Alternatively, import the `plugins/qwen-chat-quota` folder directly.

1. Sign in to the Qwen desktop app and open **Settings → Usage → Agent usage**.
2. In Token Monitor, open **Settings → Plugins → Installed → More actions** and import the folder or package.
3. Review its local file and network access, then choose **Trust, install and enable**. **Install only** leaves it disabled. The plugin master switch and safe mode still apply.
4. Select **Qwen** in **AI Tool Limits**. To show it at the screen edge, add its limits module in **Window → Edge Dock**.

This source plugin is not added to Token Monitor's official distribution catalog by this change. Importing or enabling it does not change other providers or turn on a desktop surface.

## Usage and session expiry

The host's normal fixed/adaptive limits refresh setting applies while a selected quota surface is visible. The plugin has no independent polling timer or background work.

Qwen access tokens expire independently of the app's longer-lived login. If Token Monitor reports an expired or unavailable session, open Qwen's **Usage** page again so Qwen can renew its own session, then refresh or reveal the quota surface. The plugin reads the renewed token on its next check. It does not read refresh cookies, sign in, refresh credentials itself, consume reset grants or make inference requests.

The displayed percentage and reset time come from Qwen's quota service, not local transcript totals. Network failures, rate limits and malformed responses are reported as unavailable rather than a guessed percentage. Qwen's web API is not a published stable integration contract and may change.

## Access and privacy

The backend reads only authentication values for `https://chat.qwen.ai` in the Qwen desktop app's Local Storage database. Profile locations are:

- Windows: `%APPDATA%/Qwen/Local Storage/leveldb`
- macOS: `~/Library/Application Support/Qwen/Local Storage/leveldb`
- Linux: `$XDG_CONFIG_HOME/Qwen/Local Storage/leveldb`, or `~/.config/Qwen/Local Storage/leveldb`

Reading is bounded and read-only. Only current LevelDB files from its manifest are used, including deletion/logout records. The plugin does not decode chat history or copy the profile database. Passwords, refresh cookies and Qwen Code credentials are not read. The access token stays in memory and is not saved in plugin data, settings, output or logs.

It sends the access token only to `https://sg-entitlement.qwen.com/api/entitlement/agent/usage`, using Token Monitor's injected proxy-aware network transport. Redirects are refused, and requests/responses are bounded. Only quota display fields return to the renderer. Disabling the plugin stops sampling without modifying Qwen's login or either application's binaries.

## Validation

```sh
node --test tests/electron/qwenChatSession.test.js tests/electron/qwenChatQuota.test.js
npm run verify
```

All fixtures use synthetic credentials. Tests cover quota boundaries, failure redaction, the injected transport, package/native reading compatibility, session rotation and deletion, manifest recovery and Snappy-compressed LevelDB tables. No additional dependencies are required.

## License

MIT; see [LICENSE](LICENSE).
