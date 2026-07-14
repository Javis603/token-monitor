# English

**Open-source build.** macOS is signed and notarized; Windows is unsigned (SmartScreen may appear); Linux AppImages need executable permission — see notes below.

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Projects view:** Disabled by default; enable it under **Settings → Main Screen → Enable project tracking** to track Claude Code, Codex, and OpenCode token usage and costs by workspace, with cross-device rollups and no raw workspace paths sent to the hub. (#122, #138, #144)
- **Shareable theme codes:** Copy or import a `TM1` theme code to share appearance settings. (#130)
- **Windows app updates:** Windows installer builds can now download and install updates from inside Token Monitor; portable builds continue to update manually. (#136)

### Improved
- **Codex reset counts:** Upcoming reset expirations now appear as a timeline, and a lone quota window expands to the full card width. (#135)
- **Appearance settings:** Vendor Colors now have their own section for easier customization.

### Fixed
- **Session details:** The `TOTAL` session view is available again in sync and host modes. (#131)
- **AI Tool Limits:** Tray limit bars now fall back to weekly windows when a provider has no session window, and MiMo no longer shows Token Plan for inactive or free accounts. (#137, #142)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.27.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.27.0/Token-Monitor-0.27.0-arm64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.27.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.27.0/Token-Monitor-Setup-0.27.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.27.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.27.0/Token-Monitor-0.27.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.27.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.27.0/Token-Monitor-0.27.0.AppImage)

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
- **项目视图：** 此功能默认关闭，可前往 **设置 → 主界面 → 启用项目追踪** 开启，按工作区追踪 Claude Code、Codex 与 OpenCode 的 Token 用量和费用；支持跨设备汇总，且不会向 Hub 发送原始工作区路径。（#122、#138、#144）
- **主题分享码：** 可复制或导入 `TM1` 主题码，分享外观设置。（#130）
- **Windows 应用更新：** Windows 安装版现可在 Token Monitor 内下载并安装更新；便携版仍需手动更新。（#136）

### 改进
- **Codex 重置次数：** 即将到期的重置次数现以时间线显示；仅有一个额度窗口时也会扩展至卡片全宽。（#135）
- **外观设置：** 厂商色现有独立设置区，更方便自定义。

### 修复
- **会话明细：** 同步与主机模式现已恢复 `TOTAL` 会话视图。（#131）
- **AI 工具额度：** 当服务商没有会话窗口时，托盘额度条现会改用每周窗口；MiMo 的未订阅或免费账号也不再误显示 Token Plan。（#137、#142）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.27.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.27.0/Token-Monitor-0.27.0-arm64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.27.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.27.0/Token-Monitor-Setup-0.27.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.27.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.27.0/Token-Monitor-0.27.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.27.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.27.0/Token-Monitor-0.27.0.AppImage)

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
