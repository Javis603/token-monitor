# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **OpenDesign quota:** Supports five-hour and weekly subscription quotas for the current workspace, with manual Cookie setup. (#1366)
- **Service status:** Adds OpenCode, Factory Droid, Kimi, Copilot, Zed, Devin, and separate MiniMax China and International status pages. (#1370)

### Improved
- **Multi-device sync:** Reduces repeated uploads of unchanged usage. Update both the sending device and Hub for delta uploads. (#1374)
- **Quota history placement:** Opens cards toward the display interior when space permits. (#1368)

### Fixed
- **Windows quota history:** Fixes cards failing to open when hovering over or clicking an account. (#1368)
- **Windows history appearance:** Follows the main window’s Acrylic/Accent Blur and Glass Backdrop settings. (#1368)
- **Codex usage in Dots:** Avoids restoring idle historical threads merely to collect usage. (#1377)
- **Service status refresh:** Re-enabling a provider checks its status immediately, including in Manual mode. (#1379)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.87.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.87.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-Setup-0.87.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.87.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.AppImage)

<details>
<summary><strong>First launch and other notes</strong></summary>

### First launch

**macOS:** the app is Developer ID-signed and notarized by Apple. Open the `.dmg`, then drag Token Monitor to Applications.

**Windows:** both executables are signed ([how to verify](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)).

**Linux:** mark the AppImage executable, then run it:

```bash
chmod +x Token-Monitor-*.AppImage
./Token-Monitor-*.AppImage
```

### Other notes

Other platforms are not pre-built — run from source per the [README](https://github.com/Javis603/token-monitor#readme). The macOS `.zip` is the same app repackaged; ignore it unless you specifically need it.

### tokscale dependency

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **OpenDesign 额度：** 支持当前工作区的五小时和每周订阅额度，需手动配置 Cookie。 （#1366）
- **服务状态：** 新增 OpenCode、Factory Droid、Kimi、Copilot、Zed、Devin，以及 MiniMax 国内和国际站的独立状态页面。 （#1370）

### 改进
- **多设备同步：** 减少未变化用量的重复上传。增量上传需同时更新发送设备与 Hub。 （#1374）
- **额度历史位置：** 空间允许时，卡片朝屏幕内侧展开。 （#1368）

### 修复
- **Windows 额度历史：** 修复悬停或点击账户时卡片可能无法打开的问题。 （#1368）
- **Windows 历史卡片外观：** 跟随主窗口的 Acrylic/Accent Blur 和“玻璃背景”设置。 （#1368）
- **Dots 中的 Codex 用量：** 不再仅为采集用量而恢复空闲的历史线程。 （#1377）
- **服务状态刷新：** 重新启用服务商后立即检查状态，手动刷新模式下也会生效。 （#1379）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.87.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.87.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-Setup-0.87.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.87.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.AppImage)

<details>
<summary><strong>首次启动与其他说明</strong></summary>

### 首次启动

**macOS：** 应用已使用 Developer ID 签名并通过 Apple 公证。打开 `.dmg`，然后把 Token Monitor 拖到 Applications。

**Windows：** 两个可执行文件均已签名（[查看验证方法](https://github.com/Javis603/token-monitor/blob/main/docs/code-signing.md#verify-a-download)）。

**Linux：** 先给 AppImage 执行权限，然后运行：

```bash
chmod +x Token-Monitor-*.AppImage
./Token-Monitor-*.AppImage
```

### 其他说明

其他平台暂不提供预构建版本，请参考 [README](https://github.com/Javis603/token-monitor#readme) 从源码运行。macOS 的 `.zip` 只是同一个 app 的重新打包版本，除非你明确需要，否则可以忽略。

### tokscale 依赖

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.86.0...v0.87.0">v0.86.0...v0.87.0</a></summary>

<!-- github-generated-release-notes -->

</details>

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 新增
- **OpenDesign 額度：** 支援目前工作區的五小時及每週訂閱額度，需手動設定 Cookie。 （#1366）
- **服務狀態：** 新增 OpenCode、Factory Droid、Kimi、Copilot、Zed、Devin，以及 MiniMax 中國站與國際站的獨立狀態頁面。 （#1370）

### 改進
- **多裝置同步：** 減少未變動用量的重複上傳。增量上傳需同時更新傳送裝置與 Hub。 （#1374）
- **額度歷史位置：** 空間允許時，卡片朝螢幕內側展開。 （#1368）

### 修復
- **Windows 額度歷史：** 修復將游標停留在帳戶上或點擊帳戶時，卡片可能無法開啟的問題。 （#1368）
- **Windows 歷史卡片外觀：** 跟隨主視窗的 Acrylic/Accent Blur 與「玻璃背景」設定。 （#1368）
- **Dots 中的 Codex 用量：** 不再僅為收集用量而恢復閒置的歷史執行緒。 （#1377）
- **服務狀態更新：** 重新啟用服務商後立即檢查狀態，手動更新模式下亦會生效。 （#1379）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.87.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.87.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-Setup-0.87.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.87.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **OpenDesign 할당량:** Cookie를 직접 설정하면 현재 워크스페이스의 5시간 및 주간 구독 할당량을 확인할 수 있습니다. (#1366)
- **서비스 상태:** OpenCode, Factory Droid, Kimi, Copilot, Zed, Devin과 MiniMax 중국·국제 서비스의 개별 상태 페이지를 지원합니다. (#1370)

### 개선
- **다중 기기 동기화:** 변경되지 않은 사용량의 반복 업로드를 줄였습니다. 변경분만 업로드하려면 전송 기기와 Hub를 모두 업데이트해야 합니다. (#1374)
- **할당량 기록 위치:** 공간이 있으면 카드가 화면 안쪽으로 열립니다. (#1368)

### 수정
- **Windows 할당량 기록:** 계정에 마우스를 올리거나 클릭해도 카드가 열리지 않던 문제를 수정했습니다. (#1368)
- **Windows 기록 카드 외관:** 기본 창의 Acrylic/Accent Blur 및 글래스 배경 설정을 따릅니다. (#1368)
- **Dots의 Codex 사용량:** 사용량 수집만을 위해 대기 중인 과거 스레드를 복원하지 않습니다. (#1377)
- **서비스 상태 새로고침:** 제공업체를 다시 표시하면 수동 모드에서도 즉시 상태를 확인합니다. (#1379)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.87.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.87.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-Setup-0.87.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.87.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **OpenDesignの使用量上限:** Cookieを手動で設定すると、現在のワークスペースの5時間枠と週間のサブスクリプション上限を確認できます。 (#1366)
- **サービス状態:** OpenCode、Factory Droid、Kimi、Copilot、Zed、Devinに加え、MiniMaxの中国向け・国際向けサービスを個別に確認できます。 (#1370)

### 改善
- **複数デバイスの同期:** 変更のない使用量の重複アップロードを削減しました。差分アップロードには送信側のデバイスとHubの両方の更新が必要です。 (#1374)
- **割り当て履歴の位置:** スペースがある場合、カードが画面の内側に向かって開きます。 (#1368)

### 修正
- **Windowsの割り当て履歴:** アカウントにカーソルを合わせたりクリックしたりしてもカードが開かない問題を修正しました。 (#1368)
- **Windowsの履歴カードの外観:** メインウィンドウのAcrylic/Accent Blurと「ガラス背景」の設定を反映します。 (#1368)
- **DotsのCodex使用量:** 使用量の収集だけを目的に、待機中の過去のスレッドを復元しなくなりました。 (#1377)
- **サービス状態の更新:** 非表示のサービスを再表示すると、手動モードでもすぐに状態を確認します。 (#1379)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.87.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.87.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-Setup-0.87.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.87.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.87.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.87.0/Token-Monitor-0.87.0.AppImage)

</details>

</details>
