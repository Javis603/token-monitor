# English

**Open-source build.** macOS builds are signed and notarized. Windows signing is still being prepared, so Windows may show SmartScreen on first launch. Linux AppImage downloads may need executable permission — instructions below.

## What's changed

### Added
- **MiMo account tracking:** AI Tool Limits now supports MiMo (Xiaomi), with cookie-based sign-in and multi-account tracking for balance and Token Plan quota. (#97)
- **Kimi Code account tracking:** AI Tool Limits now supports Kimi Code, with API-key-based quota checks. (#91)

### Fixed
- **Codex quota refreshes:** Session and weekly percentages no longer flicker to empty or incorrect values during transient refresh failures (rate limiting, temporary unavailability); the last known-good values are kept until a real update lands. (#116)
- **Multi-device sync payloads:** Oversized usage payloads are now rejected with a clear error instead of failing unpredictably, and synced data drops the unbounded all-time session history while keeping all totals and breakdowns intact. (#121)
- **Total tokens display:** Long total-token numbers now scale to fit the available width instead of clipping. (#117)

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
- **MiMo 账号追踪：** AI 工具额度现已支持 MiMo（小米），通过 Cookie 登录并支持多账号追踪余额与 Token Plan 额度。（#97）
- **Kimi Code 账号追踪：** AI 工具额度现已支持 Kimi Code，通过 API 密钥查询额度。（#91）

### 修复
- **Codex 额度刷新：** 在额度刷新出现暂时性失败（限流、暂不可用）时，单次与每周百分比不再闪烁为空白或错误数值，会保留最近一次的正确数据，直到下一次真正更新。（#116）
- **多设备同步负载：** 超大用量负载现在会返回明确的错误，而不是不可预期地失败；同步数据不再包含无上限增长的全部时间会话记录，但仍保留全部汇总与明细。（#121）
- **总 Token 显示：** 较长的总 Token 数字现在会自动缩放以适应显示宽度，不再被裁切。（#117）

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
