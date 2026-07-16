# English

**Open-source build.** macOS is signed and notarized; Windows is unsigned (SmartScreen may appear); Linux AppImages need executable permission — see notes below.

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Low-limit highlights:** Added an optional Home setting that highlights remaining AI tool limits below 50% and marks critical limits below 20%. (#161)
- **Reduce Motion:** Added a three-state preference under Appearance. System follows the OS setting, On reduces animations, and Off keeps animations enabled across the main widget and Usage Dashboard. (#167)

### Improved
- **Usage animations:** Live token totals and breakdown values now transition smoothly, while bars, activity heatmaps, trend lines, and Dashboard bar/K-line charts animate data and period changes. Page navigation stays immediate. (#163, #166)
- **Update release notes:** Improved the contrast and readability of the release notes popover. (#162)

### Fixed
- **App updates:** Dismissed updates remain available through manual checks and Settings, while downloaded updates expose the restart action instead of staying hidden. (#158)
- **Claude limits:** Fall back to the Claude CLI when OAuth credentials cannot be found, so limits continue to load for signed-in CLI sessions. (#159)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.29.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.29.0/Token-Monitor-0.29.0-arm64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.29.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.29.0/Token-Monitor-Setup-0.29.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.29.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.29.0/Token-Monitor-0.29.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.29.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.29.0/Token-Monitor-0.29.0.AppImage)

<details>
<summary><strong>First launch and other notes</strong></summary>

### First launch

**macOS:** open the `.dmg`, drag Token Monitor to Applications.

**Windows:** SmartScreen → More info → Run anyway.

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

**这是开源构建。** macOS 已签名并 notarize；Windows 尚未签名（可能跳出 SmartScreen）；Linux AppImage 需要先赋予执行权限，说明见下方。

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **低额度提示：** 新增可选主页设置，在 AI 工具剩余额度低于 50% 时高亮，并在低于 20% 时标记为紧急。（#161）
- **减少动态效果：** 外观中新增「系统／开启／关闭」三态设置。系统跟随操作系统，开启减少动画，关闭保留动画，并统一应用于主窗口与使用仪表板。（#167）

### 改进
- **用量动画：** 实时 Token 总计与明细数值现在会平滑过渡；柱形图、活动热力图、趋势线以及仪表盘的柱形图和 K 线图会呈现数据与周期变化。页面切换仍保持即时。（#163、#166）
- **更新说明：** 提升了更新说明弹窗的对比度和可读性。（#162）

### 修复
- **应用更新：** 已忽略的更新仍可通过手动检查和设置页面操作；下载完成后会显示重启操作，不再被忽略状态隐藏。（#158）
- **Claude 额度：** 未找到 OAuth 凭据时自动回退到 Claude CLI，使已登录的 CLI 会话仍能读取额度。（#159）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.29.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.29.0/Token-Monitor-0.29.0-arm64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.29.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.29.0/Token-Monitor-Setup-0.29.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.29.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.29.0/Token-Monitor-0.29.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.29.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.29.0/Token-Monitor-0.29.0.AppImage)

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 打开 `.dmg`，把 Token Monitor 拖到 Applications。

**Windows：** SmartScreen → 更多信息 → 仍要运行。

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
