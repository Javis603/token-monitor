# English

**Open-source build.** macOS builds are signed and notarized. Windows signing is still being prepared, so Windows may show SmartScreen on first launch. Linux AppImage downloads may need executable permission — instructions below.

## What's changed

### Added
- **Compact total tokens:** Appearance now offers **Show compact total tokens** for an abbreviated total-token display. (#114)
- **Tray quota percentages:** Choose **Limits: session limits for the first two tools** as the tray content to see their session-limit percentages at a glance. (#102)
- **Codex email masking:** AI Tool Limits can now mask Codex account email addresses.

### Improved
- **Codex account sign-in:** The browser sign-in flow now exposes an openable/copyable login link, tries available Codex installations, and supports the Codex CLI bundled with the ChatGPT macOS app. (#110, #113)

### Fixed
- **Codex account badge:** The local-account checkmark no longer appears for a single Codex account; it is shown only to distinguish accounts in a multi-account group.
- **Synced limits:** Fresh provider data now takes precedence over stale device records in multi-device sync. (#111)
- **Antigravity CLI usage:** Antigravity CLI usage is now counted under Antigravity, including CLI-only WSL homes. (#107)
- **Tray limit indicators:** Stale quota-bar icons and empty icon spacing no longer linger in the system tray. (#89)

## Which file should I download?

- **macOS (Apple Silicon, M1 and later)** — the `.dmg` file
- **Windows 10/11** — `Token Monitor Setup ….exe` (installer, recommended)
- **Windows portable** — `Token Monitor ….exe` (runs without installing)
- **Linux x64** — the `.AppImage` file

Other platforms are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

## First launch

**macOS:** open the `.dmg`, drag Token Monitor to Applications, then launch normally.

**Windows:** SmartScreen → More info → Run anyway.

**Linux:** mark the AppImage executable, then run it:

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

## tokscale dependency

Tokscale is bundled with this app. See **Settings → Tokscale** for the exact version
and the option to download a newer version directly from npm. Tokscale is MIT,
open-source: https://github.com/junhoyeo/tokscale

---

# 中文

**这是开源构建。** macOS 构建已签名并 notarize。Windows 签名还在准备中，所以 Windows 首次启动时可能会显示 SmartScreen；Linux AppImage 下载后可能需要先赋予执行权限，操作说明见下方。

## 更新内容

### 新增
- **简写总 Token：** 外观设置新增「显示简写总 Token」，可将总 Token 显示为简写形式。（#114）
- **托盘额度百分比：** 托盘内容可选择「额度：前两个工具的单次额度」，一眼查看前两个工具的单次额度百分比。（#102）
- **Codex 邮箱遮罩：** AI 工具额度现在可以遮罩 Codex 账号邮箱地址。

### 改进
- **Codex 账号登录：** 浏览器登录流程现在会显示可打开或复制的登录链接、尝试可用的 Codex 安装，并支持 macOS ChatGPT app 内置的 Codex CLI。（#110、#113）

### 修复
- **Codex 账号标记：** 只有一个 Codex 账号时，本机账号的 ✓ 不再错误显示；仅在多账号列表中用于区分账号。
- **同步额度：** 多设备同步时，最新的 provider 数据现在会优先于过期设备记录。（#111）
- **Antigravity CLI 用量：** Antigravity CLI 用量现在会计入 Antigravity，且支持仅有 CLI 数据的 WSL 主目录。（#107）
- **托盘额度指示器：** 系统托盘不再残留过期的额度条图标或空白图标间距。（#89）

## 应该下载哪个文件？

- **macOS（苹果芯片，M1 及之后机型）** — 下载 `.dmg` 安装包
- **Windows 10/11** — 下载 `Token Monitor Setup ….exe`（安装版，推荐）
- **Windows 便携版** — 下载 `Token Monitor ….exe`（无需安装，直接运行）
- **Linux x64** — 下载 `.AppImage` 文件

其他平台暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

## 首次启动

**macOS：** 打开 `.dmg`，把 Token Monitor 拖到 Applications，然后正常启动即可。

**Windows：** SmartScreen → 更多信息 → 仍要运行。

**Linux：** 先给 AppImage 执行权限，然后运行：

```bash
chmod +x "Token Monitor"*.AppImage
./"Token Monitor"*.AppImage
```

## tokscale 依赖

Tokscale 已随应用内置。你可以在 **设置 → Tokscale** 查看确切版本，
也可以直接从 npm 下载更新版本。Tokscale 是 MIT 开源项目：
https://github.com/junhoyeo/tokscale
