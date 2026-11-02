# Token Monitor for Android

Read-only remote client for a Token Monitor hub. The phone does not collect local usage and does not call tokscale. It reads `GET /api/stats` with `Authorization: Bearer`, and subscribes to `GET /api/stats/stream` while the app is in the foreground. The shared secret is never placed in the URL.

Open the `android/` directory in Android Studio (JDK 17). `minSdk` is 26 and `targetSdk` is 36.

```bash
cd android
./gradlew :core:test :app:assembleDebug
```

## Connect

On first launch, paste the hub address and the shared secret from the desktop app at Settings → Multi-device Sync.

- Worker: `https://<name>.workers.dev`
- Node hub on the LAN: `http://<host>:17321`

The secret is stored with EncryptedSharedPreferences. Cleartext HTTP is allowed so a Node hub without TLS can be reached. Use HTTPS for a Worker.

The app keeps the last good snapshot when a request fails. It surfaces an unreachable hub, HTTP 401, `secret_required`, and `hub_stopping` separately.

## Home-screen widgets

The picker offers four sizes. Width comes first:

- **1×2** shows today's tokens and cost in a tall strip, with the sync time.
- **2×1** shows today's tokens and cost on one row.
- **2×2** adds a 7-day chart.
- **4×3** shows today and this month, the top model and tool, and the 7-day chart.

Token counts use the full grouped number when it fits the card, and a K/M/B form only when it does not. The island switch and the buttons that pin these widgets are in Settings.

They are ordinary Android app widgets, so Xiaomi lists them under 安卓小部件. Marking them `miuiWidget` removes that entry, and the Xiaomi widget center only shows widgets that have passed its store review, which left both lists empty. The card still follows the Xiaomi visual spec: a solid light or dark background, a 12.67dp corner (14.48dp on 2K), and a content inset. Titles use the system font at 40% opacity; the number is the primary line.

WorkManager still fetches the hub about every 15 minutes. A visible Xiaomi widget only re-reads that saved snapshot.

## Xiaomi HyperOS island

The in-app switch is off until you turn it on. It posts one ongoing notification from the same snapshot:

- HyperOS 3 (`notification_focus_protocol` 3) shows a Super Island. The summary is a compact token count such as `1.2M`. The expanded card shows today's cost, or the quota window with the highest `usedPercent` when one exists.
- HyperOS 2 (protocol 2) shows the same payload as a status-bar focus notification.
- Other phones, and a HyperOS device that has not granted focus permission, show an ordinary ongoing notification.

A refresh keeps the island collapsed. Two hub failures in a row remove the notification. Turning the switch off removes it too.

Xiaomi authorizes the package name and signing certificate. Without an App Id, a test-device allowlist, and a scene review, a Xiaomi phone keeps the ordinary notification. The client posts `miui.focus.param` either way. See the [development guide](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2131) and the [onboarding steps](https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2132).

1. Create the app on the Xiaomi developer console and copy its App Id.
2. Pass that id to Gradle as `XIAOMI_APP_ID` (for example in `~/.gradle/gradle.properties`). The manifest writes `com.xiaomi.xms.APP_ID`. Debug builds set `com.xiaomi.xms.BUILD_TYPE_DEBUG` to `true`.
3. Add the phone's OAID to the device allowlist. The allowlist holds 10 devices and expires after 30 days.
4. A store build needs a separate scene review. Describe it as a live update: it appears when the user turns the switch on, disappears when they turn it off or the hub fails twice, refreshes about every 15 minutes, and shows today's tokens, cost, and the tightest quota percentage.

## 中文

用 Android Studio 打开 `android/` 目录。首次启动填入桌面端「设置 → 多设备同步」里的 Hub 地址和共享密钥。密钥只放在 `Authorization: Bearer` 里。局域网 Node Hub 一般是 `http://<主机>:17321`，所以应用允许明文 HTTP；Cloudflare Worker 请用 HTTPS。

桌面有四种尺寸，宽在前：1×2 竖条、2×1 横条、2×2 今日加近 7 日、4×3 今日和本月，再加上用量最高的模型和工具。数字在格子里放得下时用完整的千分位，放不下才缩成 K/M/B。超级岛开关和添加到桌面都在设置里。在小米上从「安卓小部件」里添加。标成小米小部件中心的条目后，没过审的应用会从两个列表里一起消失。卡片仍按小米视觉规范：不透明的浅色和深色底、圆角、内容内边距，标题 40% 透明度，数字是主信息。WorkManager 大约每 15 分钟向 Hub 拉一次。

「小米超级岛」开关默认关闭。打开后，澎湃 OS 3 显示超级岛，澎湃 OS 2 显示状态栏焦点通知，其他手机显示一条常驻通知。没有小米开发者平台的 App Id、测试机白名单和场景审核时，小米手机上也只会看到这条普通通知。把 App Id 配成 Gradle 属性 `XIAOMI_APP_ID`。
