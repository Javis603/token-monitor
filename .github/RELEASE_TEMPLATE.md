# English

**Open-source build.** macOS is signed and notarized; Windows is unsigned (SmartScreen may appear); Linux AppImages need executable permission — see notes below.

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Sync upload frequency:** Choose Live or every 10, 20, or 30 minutes under Multi-device Sync. Interval modes send the latest snapshot on the selected schedule. (#148)

### Improved
- **All-new Settings:** A complete visual and interaction redesign brings Settings in line with the modernized main interface, with one continuous card, clearer title-left/control-right rows, iOS-style switches, compact inline options, refined sliders, and cleaner shortcut and status controls. (#172)
- **Default window:** The main window now opens narrower and taller to better fit the interface.

### Fixed
- **Settings navigation:** Clicked section headers now stay in place while accordion sections collapse. (#168)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.30.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.30.0/Token-Monitor-0.30.0-arm64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.30.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.30.0/Token-Monitor-Setup-0.30.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.30.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.30.0/Token-Monitor-0.30.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.30.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.30.0/Token-Monitor-0.30.0.AppImage)

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
- **同步上传频率：** 可在多设备同步中选择实时，或每 10、20、30 分钟上传；定时模式会按所选频率发送最新快照。（#148）

### 改进
- **全新设置：** 设置面板迎来完整的视觉与交互设计升级，与现代化主界面保持一致；采用一体式卡片、清晰的左侧标题／右侧控件布局、iOS 风格开关、紧凑的行内选项、精致滑杆，以及更简洁的快捷键与状态控件。（#172）
- **默认窗口：** 主窗口现在以更窄、更高的比例打开，更贴合界面内容。

### 修复
- **设置导航：** 折叠分区时，已点击的标题现在会保持在原位。（#168）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.30.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.30.0/Token-Monitor-0.30.0-arm64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.30.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.30.0/Token-Monitor-Setup-0.30.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.30.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.30.0/Token-Monitor-0.30.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.30.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.30.0/Token-Monitor-0.30.0.AppImage)

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
