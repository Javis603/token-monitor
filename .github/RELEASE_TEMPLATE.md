# English

**Open-source build.** macOS is signed and notarized; Windows is unsigned (SmartScreen may appear); Linux AppImages need executable permission — see notes below.

## What's changed

### Added
- **Ollama Cloud account tracking:** AI Tool Limits now supports Ollama Cloud, with cookie-based usage and quota tracking. (#98)
- **Proma usage tracking:** Local Proma token usage, model breakdowns, and costs are now tracked across desktop and WSL environments. (#108)
- **Session history:** Deleted or cleared sessions now keep their token totals by default; pause preservation or clear retained data anytime. (#119)

### Improved
- **Client secret entry:** Multi-device Sync now includes a paste button for the client-side secret field. (#129)

### Fixed
- **Usage history:** Trends now retain history from offline devices, and an open Usage Dashboard refreshes when history changes. (#127)
- **Codex account status:** The active-account indicator now follows the local Codex login in multi-device setups, and account bars remain available through collector restarts and transient refresh failures. (#126, #128)

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.26.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.26.0/Token-Monitor-0.26.0-arm64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.26.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.26.0/Token-Monitor-Setup-0.26.0.exe)
- **Windows Portable** — [Token-Monitor-0.26.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.26.0/Token-Monitor-0.26.0.exe)
- **Linux x64** — [Token-Monitor-0.26.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.26.0/Token-Monitor-0.26.0.AppImage)

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

### 新增
- **Ollama Cloud 账号追踪：** AI 工具额度现已支持 Ollama Cloud，通过 Cookie 追踪用量与额度。（#98）
- **Proma 用量追踪：** 现已支持追踪桌面与 WSL 环境中的 Proma 本地 Token 用量、模型明细与费用。（#108）
- **会话记录：** 来源工具删除或清除会话后，默认仍会保留其 Token 用量，可随时暂停保留或清除已保留的数据。（#119）

### 改进
- **客户端密钥输入：** 多设备同步的客户端密钥输入框现已加入粘贴按钮。（#129）

### 修复
- **用量历史：** 趋势现会保留离线设备的历史记录，用量仪表板打开时也会随历史变化刷新。（#127）
- **Codex 账号状态：** 多设备同步时，当前账号标记现会正确跟随本机 Codex 登录；收集器重启或暂时刷新失败时，账号额度条也会继续保留。（#126、#128）

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.26.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.26.0/Token-Monitor-0.26.0-arm64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.26.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.26.0/Token-Monitor-Setup-0.26.0.exe)
- **Windows 便携版** — [Token-Monitor-0.26.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.26.0/Token-Monitor-0.26.0.exe)
- **Linux x64** — [Token-Monitor-0.26.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.26.0/Token-Monitor-0.26.0.AppImage)

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
