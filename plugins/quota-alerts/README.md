# Quota alerts

Receive desktop alerts when an account’s session quota runs low, recovers or returns to full.

## Features

- A settings-only interface with switches that save immediately.
- A configurable threshold, with one alert per provider/account until quota recovers.
- Desktop notifications with a manual test button.
- Interface and README in English, Simplified Chinese, Traditional Chinese, Korean, Japanese and Brazilian Portuguese.

## Compatibility

Use Token Monitor 0.81.0 or later with the official plugin catalog. The plugin uses the experimental `tmApi: 1` interface.

The plugin uses existing quota readings, not additional provider requests. Missing or stale data is not treated as zero. There is no Home card, standalone page or whole-window pulse.

## Install

Open **Settings → Plugins → Discover**, select **Quota alerts** from the Token Monitor official group and choose **Install and enable**. Choose **Install only** to leave it disabled. Review the suggested background setting; the global plugin switch and safe mode still apply.

No catalog URL is needed. You can also import `quota-alerts-0.1.0.tmplugin` or this complete source folder through Settings → Plugins. Local imports have local provenance; official identity comes from the App-designated official catalog.

## Usage

1. Open the plugin settings, enable **Low-quota alerts**, and choose a remaining-quota threshold, for example 10%.
2. Optionally enable **Quota recovery / full alerts**. A fresh reading rising from below the threshold back to it produces a recovery alert; a reading returning from below 100% to exactly 100% produces a full-quota alert. A full event produces one notification, not a second recovery notification.
3. Select **Test desktop notification** to check delivery. It sends a real, labeled test notification without using quota readings or changing notification history. You can test delivery with both automatic alert switches off.
4. Allow background execution in plugin management to keep receiving alerts after closing settings. The App suggests it during first-use review, but you can decline or change it later. Token Monitor must stay running.

Both alert switches start off and can be used independently. First readings, source changes and backend restarts establish a silent recovery baseline; they do not announce an already full account. Repeated full readings stay silent. A reset countdown alone never proves recovery.

Switches save immediately. The threshold field saves on blur or Enter. Failed saves restore confirmed values and show feedback.

Repeated low readings do not notify again until recovery. App restart or source identity changes may start another alert episode. Failed delivery is not automatically retried.

A change in the available session windows establishes a new baseline without announcing recovery or full quota.

Example notifications:

```text
Codex: quota low
Session: 7% remaining
```

```text
Codex: quota full
Session: 100% remaining
```

## Data and access

Plugins run trusted code with the local user's authority. This plugin reads captured quota data and the App language preference, without reading provider credentials or starting provider probes. Preferences and alert history are stored in the App-managed plugin data directory.

Desktop alerts use the host notification operation. This plugin makes no direct network requests.

## Updates

Official plugin updates are published independently of App releases. Refresh the catalog and choose Update to review and approve a compatible version; nothing installs automatically. Enablement, preferences and confirmed background choices remain user-controlled. Discovery and downloads require an internet connection. Rollback restores code, not notifications already sent.

## License

[MIT](LICENSE).
