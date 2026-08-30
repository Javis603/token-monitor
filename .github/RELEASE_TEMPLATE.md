# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **LM Studio usage:** Add token usage tracking for OpenAI-compatible `/v1/chat/completions` and `/v1/responses` requests recorded in LM Studio server logs. (#546)
- **Cursor Grok Bot quota:** Show the included weekly Grok Bot quota when it is available for the signed-in Cursor account. (#543)
- **Codex gpt-reserve quota:** Show named `gpt-reserve` quota windows in the Limits view when returned by Codex. (#545)

### Improved
- **Cursor limits:** Use the official `Cursor Models` and `Other Models` pools, keep exhausted allowances visible, and show on-demand spend only when a cap or spend exists. (#543)

### Fixed
- **Tokscale 4.15.0:** Fix DSH usage attribution to the model that actually served the response and xAI cost estimates that were too low when long-context prompts reached 200K tokens. (#544)
- **Windows floating widget:** Prevent the always-on-top widget from being hidden behind the taskbar when they overlap. (#541)
- **Trae CN setup:** Correct the account setup steps to copy `Cloud-IDE-Token` from browser Local Storage; Device ID remains optional. (#553)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.50.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.50.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-Setup-0.50.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.50.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.AppImage)

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
- **LM Studio 用量：** 新增 LM Studio Token 用量追踪，涵盖服务器日志中的 OpenAI 兼容 `/v1/chat/completions` 和 `/v1/responses` 请求。（#546）
- **Cursor Grok Bot 额度：** 已登录的 Cursor 账号包含 Grok Bot 额度时，显示其每周额度。（#543）
- **Codex gpt-reserve 额度：** Codex 返回 `gpt-reserve` 时，在“额度”视图中显示对应额度周期。（#545）

### 改进
- **Cursor 额度：** 改用官方 `Cursor Models` 与 `Other Models` 额度池，保留已用尽的额度，并仅在存在上限或实际消费时显示按需消费。（#543）

### 修复
- **Tokscale 4.15.0：** 修正 DSH 用量的实际响应模型归属，以及 xAI 长上下文请求达到 200K Tokens 时成本估算偏低的问题。（#544）
- **Windows 浮动小组件：** 修复小组件与任务栏重叠时，即使启用置顶仍可能被任务栏遮挡的问题。（#541）
- **Trae CN 设置：** 修正账号设置步骤，改为从浏览器 Local Storage 复制 `Cloud-IDE-Token`；Device ID 仍为可选。（#553）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.50.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.50.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-Setup-0.50.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.50.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.49.0...v0.50.0">v0.49.0...v0.50.0</a></summary>

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
- **LM Studio 用量：** 新增 LM Studio Token 用量追蹤，涵蓋伺服器日誌中的 OpenAI 相容 `/v1/chat/completions` 與 `/v1/responses` 請求。（#546）
- **Cursor Grok Bot 額度：** 已登入的 Cursor 帳號包含 Grok Bot 額度時，顯示其每週額度。（#543）
- **Codex gpt-reserve 額度：** Codex 傳回 `gpt-reserve` 時，在「額度」檢視中顯示對應額度週期。（#545）

### 改進
- **Cursor 額度：** 改用官方 `Cursor Models` 與 `Other Models` 額度池、保留已用盡的額度，並只在存在上限或實際消費時顯示隨用隨付消費。（#543）

### 修復
- **Tokscale 4.15.0：** 修正 DSH 用量的實際回應模型歸屬，以及 xAI 長上下文請求達到 200K Tokens 時成本估算偏低的問題。（#544）
- **Windows 浮動小工具：** 修復小工具與工作列重疊時，即使啟用置頂仍可能被工作列遮擋的問題。（#541）
- **Trae CN 設定：** 修正帳號設定步驟，改為從瀏覽器 Local Storage 複製 `Cloud-IDE-Token`；Device ID 仍為選填。（#553）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.50.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.50.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-Setup-0.50.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.50.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **LM Studio 사용량:** LM Studio 서버 로그에 기록된 OpenAI 호환 `/v1/chat/completions` 및 `/v1/responses` 요청의 토큰 사용량을 추적합니다. (#546)
- **Cursor Grok Bot 한도:** 로그인한 Cursor 계정에 Grok Bot 할당량이 포함되어 있으면 주간 한도를 표시합니다. (#543)
- **Codex gpt-reserve 한도:** Codex가 `gpt-reserve`를 반환하면 한도 화면에 해당 한도 기간을 표시합니다. (#545)

### 개선
- **Cursor 한도:** 공식 `Cursor Models` 및 `Other Models` 풀을 사용하고 소진된 할당량을 계속 표시하며, 상한 또는 실제 지출이 있을 때만 온디맨드 지출을 표시합니다. (#543)

### 수정
- **Tokscale 4.15.0:** DSH 사용량을 실제 응답 모델에 귀속하고, xAI 긴 컨텍스트 요청이 200K Tokens에 도달할 때 비용이 낮게 추정되던 문제를 수정했습니다. (#544)
- **Windows 플로팅 위젯:** 항상 위로 설정한 위젯이 작업 표시줄 영역과 겹칠 때 뒤로 숨는 문제를 수정했습니다. (#541)
- **Trae CN 설정:** 계정 설정 절차를 수정해 브라우저 Local Storage에서 `Cloud-IDE-Token`을 복사하도록 안내하며, Device ID는 선택 사항으로 유지됩니다. (#553)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.50.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.50.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-Setup-0.50.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.50.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **LM Studioの使用量：** LM Studioのサーバーログに記録されたOpenAI互換の`/v1/chat/completions`および`/v1/responses`リクエストのトークン使用量を追跡します。（#546）
- **Cursor Grok Botの上限：** サインイン中のCursorアカウントにGrok Botの割り当てが含まれる場合、週次上限を表示します。（#543）
- **Codex gpt-reserveの上限：** Codexから`gpt-reserve`が返された場合、「上限」画面に対象の上限期間を表示します。（#545）

### 改善
- **Cursorの上限：** 公式の`Cursor Models`と`Other Models`のプールを使用し、使い切った割り当ても表示したまま、上限または実際の支出がある場合のみオンデマンド支出を表示します。（#543）

### 修正
- **Tokscale 4.15.0：** DSHの使用量を実際の応答モデルに帰属させ、xAIの長いコンテキストリクエストが200K Tokensに達した際にコストが低く見積もられる問題を修正しました。（#544）
- **Windowsのフローティングウィジェット：** タスクバー領域と重なったとき、常に手前に表示するウィジェットがタスクバーの背後に隠れる問題を修正しました。（#541）
- **Trae CNの設定：** アカウント設定手順を修正し、ブラウザのLocal Storageから`Cloud-IDE-Token`をコピーする案内に変更しました。Device IDは引き続き任意です。（#553）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.50.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.50.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-Setup-0.50.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.50.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.50.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.50.0/Token-Monitor-0.50.0.AppImage)

</details>

</details>
