# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Compact token units:** With **Show compact token total** on, choose **International (K/M/B)** or **East Asian (萬/億)** under **Settings → Appearance**.
- **Website:** **Settings → About Token Monitor** now opens the redesigned Token Monitor site, with platform-aware downloads and product previews. (#283)

### Improved
- **Battery and CPU:** **Live watch** collection now reacts to native filesystem events on macOS, Windows, and Linux instead of re-checking watched folders every two seconds, and a change refreshes only the tool whose data moved. Updates stay in the usual 3–5 second range; if the OS runs out of watch descriptors, collection falls back to polling on its own. (#282, #285)
- **Hidden window:** Usage re-renders are coalesced while the widget is hidden, and the latest state is drawn once it becomes visible again. Tray icon updates are never delayed. (#282)

### Fixed
- **Home activity heatmap:** Hovering a day keeps its tooltip through live refreshes instead of losing it every few seconds.
- **Kimi icons:** Kimi now uses its own logo in tool lists, **AI Tool Limits**, the tray, and chart colors instead of the Moonshot mark.
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.38.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-0.38.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.38.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-0.38.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.38.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-Setup-0.38.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.38.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-0.38.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.38.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-0.38.0.AppImage)

<details>
<summary><strong>First launch and other notes</strong></summary>

### First launch

**macOS:** the app is Developer ID-signed and notarized by Apple. Open the `.dmg`, then drag Token Monitor to Applications.

**Windows:** both executables are signed ([how to verify](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)).

**Linux:** mark the AppImage executable, then run it:

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

### Other notes

Other platforms are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

### tokscale dependency

Tokscale is bundled with this app. See **Settings → Tokscale** for the exact version
and the option to download a newer version directly from npm. Tokscale is MIT,
open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **Token 简写单位：** 开启 **显示简写总 Token** 后，可在 **设置 → 外观** 中选择 **国际（K/M/B）** 或 **中文（万/亿）**。
- **网站：** **设置 → 关于 Token Monitor** 现在可以打开重新设计的 Token Monitor 网站，提供按平台推荐的下载与产品预览。（#283）

### 改进
- **电量与 CPU：** **实时追踪** 现在在 macOS、Windows 和 Linux 上都改用系统原生的文件事件，不再每两秒重新检查一次被监视的目录；数据有变化时只重新扫描对应的那个工具。更新仍保持在 3–5 秒；如果系统的监视句柄用尽，采集会自动回退到轮询。（#282、#285）
- **窗口隐藏时：** 窗口隐藏期间会合并用量重绘，重新显示时只绘制最新状态；托盘图标更新不会延迟。（#282）

### 修复
- **主页 Token 活动：** 悬停某一天时，提示不会再被几秒一次的实时刷新弄丢。
- **Kimi 图标：** 工具列表、**AI 工具额度**、托盘与图表配色中的 Kimi 现在使用自己的品牌标识，不再沿用 Moonshot 标识。
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.38.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-0.38.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.38.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-0.38.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.38.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-Setup-0.38.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.38.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-0.38.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.38.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.38.0/Token-Monitor-0.38.0.AppImage)

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 应用已使用 Developer ID 签名并通过 Apple 公证。打开 `.dmg`，然后把 Token Monitor 拖到 Applications。

**Windows：** 两个可执行文件均已签名（[查看验证方法](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)）。

**Linux：** 先给 AppImage 执行权限，然后运行：

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

### 其他说明

其他平台暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

### tokscale 依赖

Tokscale 已随应用内置。你可以在 **设置 → Tokscale** 查看确切版本，
也可以直接从 npm 下载更新版本。Tokscale 是 MIT 开源项目：
https://github.com/junhoyeo/tokscale

</details>
