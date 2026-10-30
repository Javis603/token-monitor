# Attribution and source

This optional plugin adapts the session quota alert work by **matheusrosendo** in [Token Monitor PR #538](https://github.com/Javis603/token-monitor/pull/538), inspected at head `ba4e3c52ebe4b64136fdb086991b65bb412eccbc`.

Reused and adapted: threshold crossing/rearm algorithm and reset-time formatter from [`src/electron/sessionAlertEvaluator.js`](https://github.com/matheusrosendo/token-monitor/blob/ba4e3c52ebe4b64136fdb086991b65bb412eccbc/src/electron/sessionAlertEvaluator.js); window-summary notification formatting from [`src/electron/main.js`](https://github.com/matheusrosendo/token-monitor/blob/ba4e3c52ebe4b64136fdb086991b65bb412eccbc/src/electron/main.js). Whole-window visual effects and mobile push are not included in this settings-only adaptation. Plugin lifecycle, formal DTO adaptation, persistent dedup, recovery/full observation logic, opt-in settings and tests are new adaptations. The original PR was not merged or copied wholesale.

The source repository's [MIT license](https://github.com/matheusrosendo/token-monitor/blob/ba4e3c52ebe4b64136fdb086991b65bb412eccbc/LICENSE), including `Copyright (c) 2026 Javis`, is reproduced in LICENSE and distributed with this plugin. Author credit above is additional to, and does not replace, that notice.

Current maintenance is by Javis603. Matheus Rosendo is credited for the original contribution, not represented as this plugin's current maintainer. The new notification-bell icon (`assets/icon.svg` and `assets/icon.png`) is original artwork for this adaptation and distributed under the included MIT license.
