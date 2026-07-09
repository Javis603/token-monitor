# English

**Open-source build.** macOS builds are signed and notarized. Windows signing is still being prepared, so Windows may show SmartScreen on first launch. Linux AppImage downloads may need executable permission — instructions below.

## What's changed

### Improved
- **Account labels:** AI Tool Limits account labels now render with consistent capitalization in provider cards and the Codex account list.
- **Bundled tokscale 4.2.0:** Detects Kiro IDE sessions (the usage watcher now covers them for live refresh), keeps OpenCode's own recorded costs instead of re-pricing them from tokens, and counts Claude Code deep-nested subagent transcripts.

### Fixed
- **GLM / Z.ai legacy quota:** Old GLM Coding Plans with a single 5-hour token quota no longer show it as a "Weekly" window — it renders as the 5-hour session window, and the monthly MCP bucket now shows a Monthly reset instead of a bogus 1-minute window. (#85)

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

### 改进
- **账号标签：** AI 工具额度的账号标签现在在额度卡片和 Codex 账号列表中统一首字母大写显示。
- **内置 tokscale 4.2.0：** 新增 Kiro IDE 会话识别（用量监看现在也覆盖该目录，实现秒级刷新），保留 OpenCode 自身记录的费用、不再按 token 重新计价，并计入 Claude Code 深层子代理会话。

### 修复
- **GLM / Z.ai 旧版额度：** 旧版 GLM Coding Plan 的单一 5 小时 token 额度不再误显示为「Weekly」窗口，而是正确显示为 5 小时会话窗口；按月的 MCP 桶现在显示按月重置，不再出现错误的 1 分钟窗口。（#85）

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
