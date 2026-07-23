# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Windows Accent Blur:** Windows users can choose the experimental Accent Blur style under **Settings → Appearance → Windows Glass Style**. It keeps the background translucent and blurred when the window is unfocused, with an automatic Acrylic fallback on unsupported systems. (#229)

### Improved
- **Usage and limits resilience:** Token usage and AI Tool Limits now refresh independently. Slow or failing providers use bounded concurrency and retries without blocking usage or other limits updates. (#225, #227)
- **Glass appearance:** Custom glass tint and opacity now render without decorative color shifts, while very low opacity in macOS transparent mode avoids Chromium compositing artifacts. (#231)
- **WSL usage collection:** Every requested tool can now be scanned in each detected WSL home without duplicating usage from the native Windows host.

### Fixed
- **Large session lists:** Hub-backed Month and Total session lists remain responsive during live updates and keep stable scroll geometry as rows appear. (#235)
- **Custom model pricing:** Pricing rows once again keep model details readable and the edit and remove actions correctly aligned. (#236)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.34.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-0.34.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.34.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-0.34.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.34.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-Setup-0.34.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.34.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-0.34.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.34.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-0.34.0.AppImage)

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
- **Windows Accent Blur：** Windows 用户现在可以在 **设置 → 外观 → Windows 玻璃样式** 中选择实验性的 Accent Blur；窗口失去焦点时背景仍保持半透明和模糊，不支持时会自动回退到 Acrylic。（#229）

### 改进
- **用量与额度刷新韧性：** Token 用量与 AI 工具额度现在独立刷新；缓慢或失败的提供商会通过有限并发与重试处理，不再阻塞用量或其他额度更新。（#225、#227）
- **玻璃效果呈现：** 自定义玻璃色调与透明度不再受装饰性叠色影响；macOS 透明模式在极低透明度下也能避免 Chromium 合成异常。（#231）
- **WSL 用量采集：** 每个检测到的 WSL 主目录现在都能扫描所有指定工具，同时避免重复计入 Windows 主机上的原生用量。

### 修复
- **大型会话列表：** 通过 Hub 加载的月度与总计会话列表在实时更新时保持流畅，并在新增行时维持稳定的滚动位置。（#235）
- **自定义模型定价：** 定价行现在会正确显示模型详情，并恢复编辑与移除操作的对齐布局。（#236）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.34.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-0.34.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.34.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-0.34.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.34.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-Setup-0.34.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.34.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-0.34.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.34.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.34.0/Token-Monitor-0.34.0.AppImage)

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
