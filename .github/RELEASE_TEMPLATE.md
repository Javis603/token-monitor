# English

**Open-source build, not paid-signed.** macOS and Windows will ask you to confirm on first launch — instructions below.

## What's changed

### Added
- **Data export:** Settings -> Collection -> Data export can now write CSV / JSON files once or auto-export them to a folder for Excel, Obsidian, scripts, and dashboards. (#61)
- **CodeBuddy and WorkBuddy tracking:** Token Monitor now collects and displays usage from CodeBuddy and WorkBuddy alongside the existing tools.
- **Trends active time:** Trends and history summaries now include Active time when tokscale provides session timing data.

### Improved
- **AI Tool Limits bars:** Settings -> AI Tool Limits now lets quota bars show either Remaining or Used, and the Limits and Home surfaces use the same display mode.

## Which file should I download?

- **macOS (Apple Silicon, M1 and later)** — the `.dmg` file
- **Windows 10/11** — `Token Monitor Setup ….exe` (installer, recommended)
- **Windows portable** — `Token Monitor ….exe` (runs without installing)

Intel Macs and Linux are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

## First-launch unlock

**macOS:** right-click `Token Monitor.app` → Open (once). If you see "Token Monitor" can't be opened or is damaged:

```bash
xattr -dr com.apple.quarantine "/Applications/Token Monitor.app"
```

**Windows:** SmartScreen → More info → Run anyway.

## tokscale dependency

Tokscale is bundled with this app. See **Settings → Tokscale** for the exact version
and the option to download a newer version directly from npm. Tokscale is MIT,
open-source: https://github.com/junhoyeo/tokscale

---

# 中文

**这是开源构建，不是付费签名版本。** macOS 和 Windows 首次启动时会要求你手动确认，操作说明见下方。

## 更新内容

### 新增
- **数据导出：** 设置 -> 采集 -> 数据导出 现在可以一次性写出 CSV / JSON，也可以自动导出到文件夹，方便接入 Excel、Obsidian、自写脚本和仪表盘。（#61）
- **CodeBuddy 和 WorkBuddy 追踪：** Token Monitor 现在会采集并显示 CodeBuddy 与 WorkBuddy 的用量，和现有工具一起统计。
- **趋势活跃时间：** 当 tokscale 提供 session 时间数据时，趋势与历史摘要现在会显示活跃时间。

### 改进
- **AI 工具额度条：** 设置 -> AI 工具额度 现在可以选择额度条显示“剩余”或“已用”，额度页和主页会使用同一显示方式。

## 应该下载哪个文件？

- **macOS（苹果芯片，M1 及之后机型）** — 下载 `.dmg` 安装包
- **Windows 10/11** — 下载 `Token Monitor Setup ….exe`（安装版，推荐）
- **Windows 便携版** — 下载 `Token Monitor ….exe`（无需安装，直接运行）

Intel Mac 和 Linux 暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

## 首次启动放行

**macOS：** 右键 `Token Monitor.app` → 打开（只需要一次）。如果看到「Token Monitor」未开启 或 已损坏：

```bash
xattr -dr com.apple.quarantine "/Applications/Token Monitor.app"
```

**Windows：** SmartScreen → 更多信息 → 仍要运行。

## tokscale 依赖

Tokscale 已随应用内置。你可以在 **设置 → Tokscale** 查看确切版本，
也可以直接从 npm 下载更新版本。Tokscale 是 MIT 开源项目：
https://github.com/junhoyeo/tokscale
