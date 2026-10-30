**EN** | [简](README.zh-CN.md) | [繁](README.zh-TW.md) | [KO](README.ko.md) | [JA](README.ja.md) | [PT](README.pt-BR.md)

# Quota alerts

Receive desktop alerts when an account’s session quota runs low, recovers or returns to full.

![Quota alerts icon](assets/icon.png)

## Features

- A settings-only interface with switches that save immediately.
- A configurable threshold, with one alert per provider/account until quota recovers.
- Desktop notifications with a manual test button.
- Interface and README in English, Simplified Chinese, Traditional Chinese, Korean, Japanese and Brazilian Portuguese.

## Compatibility

Version 0.1.0 targets the current experimental `tmApi: 1` host and the accompanying display-metadata patches. Build and validation commands are in [MAINTAINING.md](MAINTAINING.md).

Focused automated checks cover evaluation, settings, mock delivery and package integrity. **Final native layout and real notification delivery remain unverified**; a development test reported a desktop-notification failure. Windows, Linux and packaged-host operation also remain unverified.

The plugin uses existing quota readings, not additional provider requests. Missing or stale data is not treated as zero. There is no Home card, standalone page or whole-window pulse.

## Install

In App builds that include this optional official plugin, open **Settings → Plugins → Discover**, select **Quota alerts** from the Token Monitor official group and choose **Install and enable**. Choose **Install only** to leave it disabled. Review the suggested background setting; the global plugin switch and safe mode still apply.

No catalog URL is needed. You can also import `quota-alerts-0.1.0.tmplugin` or this complete source folder through Settings → Plugins. A local import has local provenance; official branding belongs to the App-bundled package.

## Usage

1. Open the plugin settings, enable **Low-quota alerts**, and choose a remaining-quota threshold, for example 10%.
2. Optionally enable **Quota recovery / full alerts**. A fresh reading rising from below the threshold back to it produces a recovery alert; a reading returning from below 100% to exactly 100% produces a full-quota alert. A full event produces one notification, not a second recovery notification.
3. Select **Test desktop notification** to check delivery. It sends a real, labeled test notification without using quota readings or changing notification history. You can test delivery with both automatic alert switches off.
4. Allow background execution in plugin management to keep receiving alerts after closing settings. The App suggests it during first-use review, but you can decline or change it later. Token Monitor must stay running.

Both alert switches start off and can be used independently. First readings, source changes and backend restarts establish a silent recovery baseline; they do not announce an already full account. Repeated full readings stay silent. A reset countdown alone never proves recovery.

Switches save immediately. The threshold field saves on blur or Enter. Failed saves restore confirmed values and show feedback.

Repeated low readings do not notify again until recovery. App restart or source identity changes may start another alert episode. Failed delivery is not automatically retried.

Example notification text generated from fixture data; these are not OS screenshots:

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

Official package updates arrive with App updates. Review and approve changed plugin code before running it; enablement, preferences and confirmed background choices remain user-controlled. Rollback restores code, not notifications already sent.

## License and credits

Maintained by **Javis603**. Adapted from **Matheus Rosendo (@matheusrosendo)**'s [PR #538](https://github.com/Javis603/token-monitor/pull/538), rather than merged wholesale. This credit does not imply that he maintains or endorses the adaptation.

Source attribution and reused portions are documented in [NOTICE.md](NOTICE.md). The original [MIT license](LICENSE) is included. The notification-bell icon is original artwork for this adaptation under the same license. See [MAINTAINING.md](MAINTAINING.md) for technical details and outstanding acceptance checks.
