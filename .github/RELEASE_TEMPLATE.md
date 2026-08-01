# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Token throughput:** Hover the compact `Σ` title mark or live dot to reveal the current reading, then click to switch between output `tok/s` and total `tok/min`; the choice is remembered. (#296)

### Improved
- **Windows session details:** Claude and Codex transcripts stored in running WSL homes can now open from the Sessions view without blocking the Electron main process. (#297)
- **Home limits:** Home limit rows are more compact and aligned.
- **AI Tool Limits details:** Codex reset counts and Claude prepaid grants now show precise expiry times, including when there is only one entry.

### Fixed
- **Window state:** Maximized windows now restore maximized after restart without losing their normal size; tray popovers and collapsed floating bubbles no longer overwrite normal window bounds. (#300)
- **Manual refresh:** Clicking Refresh now updates Cursor and Antigravity usage with fresh data instead of showing values up to five minutes old. (#290)
- **MiMo and Kimi limits:** When usage exceeds the limit, the remaining percentage now correctly shows **0%** instead of nearly **99%**. (#294)
- **Windows Codex checks:** The app no longer crashes when `taskkill.exe` cannot be resolved. (#291)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.39.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.39.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-Setup-0.39.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.39.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.AppImage)

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
- **Token 吞吐量：** 将鼠标悬停在紧凑 `Σ` 标题标记或实时指示点上即可查看当前读数，点击可在输出 `tok/s` 与总 Token `tok/min` 之间切换，选择会被记住。（#296）

### 改进
- **Windows 会话详情：** 存放在运行中 WSL 主目录的 Claude 与 Codex 会话，现在可以从会话视图打开，且不会阻塞 Electron 主进程。（#297）
- **主页额度：** 主页额度条目现在更紧凑、对齐更整齐。
- **AI 工具额度详情：** Codex 重置次数和 Claude 预付额度现在会显示精确的到期时间，包括只有一条记录时。

### 修复
- **窗口状态：** 窗口最大化后重启会恢复最大化，同时保留原本的普通窗口大小；托盘弹窗和收起的浮动气泡不再覆盖普通窗口大小。（#300）
- **手动刷新：** 点击刷新后，Cursor 与 Antigravity 的用量会更新为最新数据，不再显示最多五分钟的旧数据。（#290）
- **MiMo 与 Kimi 额度：** 使用量超过上限时，剩余比例现在会正确显示为 **0%**，不再错误地显示为接近 **99%**。（#294）
- **Windows Codex 额度检查：** 找不到 `taskkill.exe` 时不再导致应用崩溃。（#291）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.39.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.39.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-Setup-0.39.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.39.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.AppImage)

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
