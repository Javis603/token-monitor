# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Unsloth Studio usage:** Adds tracking for Unsloth Studio to the usage views and breakdowns. (#606)
- **Alibaba Cloud Token Plan limits:** Adds quota tracking for Team and Personal plans on the mainland and international consoles. (#604)

### Improved
- **Codex reset forecasts:** Shows the latest reset type as Regular reset or Banked reset when available. (#610)

### Fixed
- **Settings overlay:** Fixes the main view and live stats pausing while Settings is open. (#609)
- **Titlebar controls:** Fixes hover controls overlapping the period tabs or staying open after pointer actions. (#608)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.54.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.54.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-Setup-0.54.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.54.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.AppImage)

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
- **Unsloth Studio 用量：** 新增追踪支持，可在用量视图和明细中查看。（#606）
- **Alibaba Cloud Token Plan 额度：** 新增中国站与国际站的团队版与个人版额度追踪。（#604）

### 改进
- **Codex 重置预测：** 有可用信息时，显示最近一次重置的类型为 Regular reset 或 Banked reset。（#610）

### 修复
- **设置面板：** 修复打开设置后主界面暂停更新的问题。（#609）
- **标题栏控件：** 修复悬停控件遮挡时间范围标签，或在鼠标操作后仍保持打开的问题。（#608）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.54.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.54.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-Setup-0.54.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.54.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.AppImage)

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

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.53.0...v0.54.0">v0.53.0...v0.54.0</a></summary>

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
- **Unsloth Studio 用量：** 新增追蹤支援，可在用量檢視與明細中查看。（#606）
- **Alibaba Cloud Token Plan 額度：** 新增中國站與國際站的團隊版與個人版額度追蹤。（#604）

### 改進
- **Codex 重置預測：** 有可用資訊時，顯示最近一次重置的類型為 Regular reset 或 Banked reset。（#610）

### 修復
- **設定面板：** 修復開啟設定後主畫面暫停更新的問題。（#609）
- **標題列控制項：** 修復懸停控制項遮住時間範圍分頁，或在滑鼠操作後仍保持開啟的問題。（#608）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.54.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.54.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-Setup-0.54.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.54.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Unsloth Studio 사용량:** 사용량 보기와 상세 내역에서 확인할 수 있도록 추적을 지원합니다. (#606)
- **Alibaba Cloud Token Plan 할당량:** 중국 사이트와 글로벌 사이트의 팀 및 개인 플랜 할당량 추적을 지원합니다. (#604)

### 개선
- **Codex 리셋 예측:** 가능한 경우 최근 리셋 유형을 Regular reset 또는 Banked reset으로 표시합니다. (#610)

### 수정
- **설정 오버레이:** 설정을 열어 둔 동안 메인 화면과 실시간 사용량 업데이트가 멈추던 문제를 수정했습니다. (#609)
- **제목 표시줄 컨트롤:** 기간 탭을 가리거나 포인터 조작 후에도 열린 상태로 남던 문제를 수정했습니다. (#608)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.54.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.54.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-Setup-0.54.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.54.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Unsloth Studioの使用量：** 使用量ビューと内訳で確認できるよう追跡に対応しました。（#606）
- **Alibaba Cloud Token Planのクォータ：** 中国サイトと国際サイトのチーム・個人プランのクォータ追跡に対応しました。（#604）

### 改善
- **Codexリセット予測：** 情報が利用できる場合、最新のリセット種別をRegular resetまたはBanked resetとして表示します。（#610）

### 修正
- **設定オーバーレイ：** 設定を開いている間、メイン画面とリアルタイムの使用量の更新が止まる問題を修正しました。（#609）
- **タイトルバーのコントロール：** ホバー時のコントロールが期間タブに重なったり、ポインター操作後も開いたままになったりする問題を修正しました。（#608）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.54.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.54.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-Setup-0.54.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.54.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.54.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.54.0/Token-Monitor-0.54.0.AppImage)

</details>

</details>
