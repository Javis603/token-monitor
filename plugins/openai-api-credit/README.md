# OpenAI API Credits

Show your actual OpenAI Platform API credit balance in Token Monitor’s native Limits page.

![OpenAI API credit balance in the Limits page](assets/limits.png)

Interface example. Balance and expiry depend on your account.

## Features

- A sortable **OpenAI** entry with native Codex artwork and colors, including your color overrides.
- A progress bar and balance, or balance only.
- Remaining amounts and UTC expiry times for multiple usable grants with different expiry dates.
- Manual session credentials, verified and managed by the App.
- Interface, README and changelog in English, Traditional Chinese, Simplified Chinese, Japanese, Korean and Brazilian Portuguese.

## Compatibility and installation

Requires **Token Monitor 0.88.0 or later**.

If plugins are globally disabled, first turn on **Enable plugins** under **Settings → Plugins → Installed → More plugin actions**. Otherwise, installation offers **Install only** and keeps the plugin disabled.

Open **Settings → Plugins → Discover**. Under **Featured plugins**, select **OpenAI API Credits** with the Token Monitor official badge, review it and choose **Install and enable**. You can also import a `.tmplugin` file or this complete source folder through **Settings → Plugins**. Make sure the plugin is enabled, then select and expand **OpenAI** in **AI Tool Limits** to set up your account.

## Setup

1. Copy the billing URL in the OpenAI settings into your usual browser. Sign in and select your organization.
2. Open DevTools (**F12** or **Cmd+Opt+I**) → **Network**, reload and select `credit_grants`.
3. In **Headers → Request Headers**, copy `Authorization` into **Platform session token** and `OpenAI-Organization` into **Organization ID**. The token can include the `Bearer` prefix. Do not use an ordinary API key, Cookie header or ChatGPT/Codex token.
4. Save the credentials. The App verifies them and folds the editor on success. Return to **Limits** to view your balance.

Use **Change credentials** to replace saved values; secrets are never filled back into the inputs. If the session expires, obtain fresh credentials. Never share them in chat or screenshots.

## Display and refresh

The balance comes directly from OpenAI. In bar mode, the total includes currently usable grants with credit remaining. Expired or depleted grants are excluded, so the total can change as grants expire or run out. The App’s used/remaining setting controls the percentage, bar fill and displayed amount together; the used amount applies to this current credit pool.

When a reliable total is unavailable, only the balance is shown. The expiry below the bar is the earliest known expiry of usable credit. For two to twelve usable grants with different expiries, the tooltip lists each remaining amount and expiry time. Larger breakdowns are omitted.

Refresh follows the App’s Limits interval, adaptive setting and visibility. The display option saves immediately when changed. Saving credentials performs a separate verification.

## Data and access

The App stores credentials in a private, unencrypted file at `plugin-credentials/openai-api-credit/credits.json` under its user data directory, separate from plugin code and ordinary preferences. The backend sends them to `https://api.openai.com/v1/dashboard/billing/credit_grants` through the App’s proxy-aware transport. This undocumented endpoint and session credentials may change or expire. On Windows, access follows inherited folder permissions; the App does not set an owner-only ACL.

The plugin uses the session credentials you enter and does not read other apps’ login files or send analytics. Plugins run as trusted local code with access to the operating-system user’s files.

## Updates

Import a newer package through **Settings → Plugins** and review the update. Nothing installs automatically. See [CHANGELOG](CHANGELOG.md).

To build from the repository root, choose an output path that does not already exist:

```sh
node scripts/build-plugin-package.js plugins/openai-api-credit ./openai-api-credit-0.1.0.tmplugin
```

## License

[MIT](LICENSE).
