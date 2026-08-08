# English

## What's changed

<!-- app-update-notes:en:start -->
### Improved
- **Custom model pricing:** Enter `0` for free models, and invalid values are rejected as a complete row instead of silently applying a partial override. (#355)
- **Model recognition and pricing:** Coverage now includes updated Claude aliases, Copilot Claude Opus 4.1 handling, router-label pricing safeguards, and Cursor Composer free cache-creation pricing. (#355)

### Fixed
- **Live usage updates:** Fixed OpenCode usage updates getting stuck, and reduced delayed or redundant live refreshes for MiMo Code and other supported tools. (#350, #352, #353)
- **GLM Coding Plan quota:** Valid `CREDIT_LIMIT` windows now appear as token quota data instead of leaving the account unavailable. (#351)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.42.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.42.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-Setup-0.42.1.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.42.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.AppImage)

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
### 改进
- **自定义模型单价：** 免费模型可填 `0`，无效值会整行拒绝，不再悄悄套用部分覆盖。（#355）
- **模型识别与计价：** 现在涵盖更新后的 Claude 别名、Copilot Claude Opus 4.1 处理、路由标签计价保护，以及 Cursor Composer 免费缓存创建计价。（#355）

### 修复
- **实时用量更新：** 修复 OpenCode 用量更新卡住的问题，并减少 MiMo Code 及其他支持工具的实时更新延迟和重复刷新。（#350、#352、#353）
- **GLM Coding Plan 额度：** 有效的 `CREDIT_LIMIT` 窗口现在会显示为 `Tokens` 额度数据，不再让账号显示为不可用。（#351）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.42.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.42.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-Setup-0.42.1.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.42.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.AppImage)

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

**Full Changelog:** [v0.42.0...v0.42.1](https://github.com/Javis603/token-monitor/compare/v0.42.0...v0.42.1)

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 改進
- **自訂模型單價：** 免費模型可填 `0`，無效值會整列拒絕，不再悄悄套用部分覆寫。（#355）
- **模型識別與計價：** 現在涵蓋更新後的 Claude 別名、Copilot Claude Opus 4.1 處理、路由標籤計價保護，以及 Cursor Composer 免費快取建立計價。（#355）

### 修復
- **即時用量更新：** 修復 OpenCode 用量更新卡住的問題，並減少 MiMo Code 及其他支援工具的即時更新延遲和重複重新整理。（#350、#352、#353）
- **GLM Coding Plan 額度：** 有效的 `CREDIT_LIMIT` 視窗現在會顯示為 `Tokens` 額度資料，不再讓帳號顯示為不可用。（#351）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.42.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.42.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-Setup-0.42.1.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.42.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 개선
- **사용자 지정 모델 가격:** 무료 모델에는 `0`을 입력할 수 있으며, 유효하지 않은 값은 일부만 적용하지 않고 행 전체가 거부됩니다. (#355)
- **모델 인식 및 가격:** 업데이트된 Claude 별칭, Copilot Claude Opus 4.1 처리, 라우터 레이블 가격 보호, Cursor Composer의 무료 캐시 생성 비용 처리를 지원합니다. (#355)

### 수정
- **실시간 사용량 업데이트:** OpenCode 사용량 업데이트가 멈추던 문제를 수정하고, MiMo Code 및 기타 지원 도구의 실시간 업데이트 지연과 불필요한 새로 고침을 줄였습니다. (#350, #352, #353)
- **GLM Coding Plan 할당량:** 유효한 `CREDIT_LIMIT` 창이 이제 토큰 할당량 데이터로 표시되어 계정이 더 이상 사용할 수 없음으로 표시되지 않습니다. (#351)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.42.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.42.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-Setup-0.42.1.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.42.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 改善
- **カスタムモデル価格：** 無料モデルには `0` を入力でき、無効な値は一部だけ適用せず行全体を拒否します。（#355）
- **モデル認識と価格：** 更新された Claude のエイリアス、Copilot Claude Opus 4.1 の処理、ルーターラベルの価格保護、Cursor Composer の無料キャッシュ作成の価格処理に対応します。（#355）

### 修正
- **リアルタイム使用量の更新：** OpenCode の使用量更新が停止する問題を修正し、MiMo Code など対応ツールのリアルタイム更新の遅延と不要な更新も減らしました。（#350、#352、#353）
- **GLM Coding Plan の割り当て：** 有効な `CREDIT_LIMIT` ウィンドウがトークン割り当てデータとして表示され、アカウントが利用不可として表示されなくなりました。（#351）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.42.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.42.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-Setup-0.42.1.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.42.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.42.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.42.1/Token-Monitor-0.42.1.AppImage)

</details>

</details>
