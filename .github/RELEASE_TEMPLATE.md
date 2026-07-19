# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Activity heatmap metric:** Color activity by Tokens or Cost on Home and Dashboard; Cost remains the default. (#190)
- **Home account count:** Choose how many accounts (1–12) appear in Home → Limits under Settings → Main. (#195)
- **Provider tray icon badge:** Optionally add a Token Monitor badge to provider icons so they are easier to distinguish from the matching IDE apps. Existing tray appearance remains the default. (#139)

### Improved
- **Windows downloads:** The installer and portable executable are now code-signed under the Token Monitor code signing policy. (#196)
- **Activity animation:** The Home heatmap now enters faster with smoother cell motion.

### Fixed
- **Activity history retention:** With **Preserve deleted session usage** enabled, daily activity already observed by Token Monitor no longer disappears when source transcripts are later cleaned up. (#193)
- **Activity history refresh:** Home and Dashboard now follow the local calendar day, reload history across midnight, and rescan it on manual refresh. (#187)
- **Floating Bubble contrast:** The collapsed bubble now follows the app appearance and keeps text and provider icons readable over light and dark wallpapers. (#189)
- **Session recency:** Time sorting now works for supported tools when project tracking is disabled. (#191)
- **Large sync payloads:** Devices with extensive session history now stay within the Hub upload limit while preserving totals and clearly marking omitted details. (#197)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.31.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.31.0/Token-Monitor-0.31.0-arm64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.31.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.31.0/Token-Monitor-Setup-0.31.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.31.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.31.0/Token-Monitor-0.31.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.31.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.31.0/Token-Monitor-0.31.0.AppImage)

<details>
<summary><strong>First launch and other notes</strong></summary>

### First launch

**macOS:** the app is Developer ID-signed and notarized by Apple. Open the `.dmg`, then drag Token Monitor to Applications.

**Windows:** both executables are signed ([how to verify](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)), but you may still see a brief SmartScreen prompt on the first few releases while the certificate builds reputation with Microsoft — More info → Run anyway.

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
- **活动热力图指标：** 可在主页与仪表板中按 Tokens 或成本为活动数据着色；默认仍为成本。（#190）
- **主页账号数量：** 可在设置 → 主画面 → 主页 → 额度中选择显示 1–12 个账号。（#195）
- **提供者托盘图标徽章：** 可选择为提供者图标添加 Token Monitor 徽章，更容易与对应的 IDE 应用区分；现有托盘外观仍为默认设置。（#139）

### 改进
- **Windows 下载：** 安装版与便携版现已根据 Token Monitor 代码签名政策完成签名。（#196）
- **活动动画：** 主页热力图现在以更快、更流畅的单元格动画显示。

### 修复
- **活动历史保留：** 开启**保留已删除会话用量**后，Token Monitor 已观测到的每日活动不会再因来源 transcript 后续被清理而消失。（#193）
- **活动历史刷新：** 主页与仪表板现在会按本地日期显示数据、跨午夜重新载入历史，并在手动刷新时重新扫描。（#187）
- **悬浮球对比度：** 折叠后的悬浮球现在会跟随应用外观，并让文字与提供者图标在明暗壁纸上都保持清晰可读。（#189）
- **会话时间排序：** 关闭项目追踪时，支持的工具现在也能正常按时间排序。（#191）
- **大型同步数据：** 会话历史较多的设备现在也能保持在 Hub 上传限制内，同时保留总计，并清楚标示省略的明细。（#197）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.31.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.31.0/Token-Monitor-0.31.0-arm64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.31.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.31.0/Token-Monitor-Setup-0.31.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.31.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.31.0/Token-Monitor-0.31.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.31.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.31.0/Token-Monitor-0.31.0.AppImage)

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 应用已使用 Developer ID 签名并通过 Apple 公证。打开 `.dmg`，然后把 Token Monitor 拖到 Applications。

**Windows：** 两个可执行文件均已签名（[查看验证方法](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)），但在证书刚建立信誉的最初几个版本，仍可能短暂出现 SmartScreen 提示 → 更多信息 → 仍要运行。

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
