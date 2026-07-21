# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Device usage details:** Expand a device to see its tool and model usage for Day, Month, and Total, together with its operating system, Widget or Agent version, and last sync time. (#206, #208)

### Improved
- **Credential storage:** GUI-managed credentials are now separated from preferences in a permission-restricted local store, with safer migration and rollback when a save fails. (#200)
- **Footer controls:** Refresh and Settings now share a compact footer control that reveals the other button on hover or keyboard focus; their order can also be swapped under Appearance. (#203)
- **Windows application signing:** The installed application executable is now signed as well as the installer and portable download. (#198)

### Fixed
- **Grok limits:** Unified credit usage now honors standard proxy settings and no longer falls back to the legacy billing endpoint. (#175)
- **Live usage animation:** Totals, row values, and bars no longer restart or jump during unrelated refreshes, and continue smoothly when data changes mid-animation. (#204)
- **Disabled limit accounts:** Disabled providers no longer remain stuck on Checking, and pending checks clear immediately when a provider is turned off. (#205)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.32.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-0.32.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.32.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-0.32.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.32.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-Setup-0.32.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.32.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-0.32.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.32.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-0.32.0.AppImage)

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
- **设备用量明细：** 展开设备即可查看其在今日、本月与总计范围内的工具及模型用量，并显示操作系统、Widget 或 Agent 版本及上次同步时间。（#206、#208）

### 改进
- **凭据存储：** GUI 管理的凭据现已与偏好设置分离，存入权限受限的本地凭据文件，并在迁移或保存失败时更安全地保留原有数据。（#200）
- **底部操作：** 刷新与设置现在共用一个紧凑的底部操作组；将鼠标移到按钮上或用键盘聚焦时会显示另一个按钮，也可在外观设置中交换两者顺序。（#203）
- **Windows 应用签名：** 除安装包与便携版外，安装后的应用程序可执行文件现在也会完成签名。（#198）

### 修复
- **Grok 额度：** 统一额度用量现在会遵循标准代理设置，且不再回退到旧版额度接口。（#175）
- **实时用量动画：** 总计、列表数值与进度条不会再因无关刷新而重新开始或跳动，数据在动画途中变化时也会平滑衔接。（#204）
- **已禁用额度账号：** 提供者停用后不再一直显示“检查中”，尚未完成的检查也会立即清除。（#205）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.32.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-0.32.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.32.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-0.32.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.32.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-Setup-0.32.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.32.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-0.32.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.32.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.32.0/Token-Monitor-0.32.0.AppImage)

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
