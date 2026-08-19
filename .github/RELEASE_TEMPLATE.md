# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **DeepSeek Harness usage:** Added DeepSeek Harness usage tracking, with token usage available in usage views and breakdowns. (#408)
- **DeepSeek Harness Session Detail:** View prompts, turns, per-turn token usage, and tools for DeepSeek Harness sessions in `Sessions`. (#427)

### Improved
- **Collection sources:** The `Source` list in `Settings → Collection` stays available before tool status loads, including for tools not yet tracked. (#435)
- **Windows tray icons:** Tray icons better match Windows notification-area sizing and no longer appear undersized. (#345, #444)

### Fixed
- **Usage breakdowns:** Zero-token, zero-cost `Unclassified` residual rows no longer appear in usage views. (#439)
- **Claude Code paths:** `CLAUDE_CONFIG_DIR` applies to both Claude usage timestamps and Session Detail; `~/.claude` remains the fallback when unset. (#455)
- **Home activity:** Hover and glow effects at the edges of the `Token Activity` heatmap are no longer clipped. (#452)
- **Windows startup:** A recent Windows startup regression no longer prevents the app from starting. (#447)
- **Hub drafts:** Changing `Sync upload frequency` no longer overwrites unsaved Hub URL, secret, device ID, or port edits. (#433)
- **Antigravity on Windows:** Quoted CLI and language-server paths no longer prevent Antigravity detection. (#440, #442)
- **AI Tool Limits requests:** Provider responses that stop sending data end within the request timeout instead of waiting for a longer outer deadline. (#434)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.46.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.46.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-Setup-0.46.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.46.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.AppImage)

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
- **DeepSeek Harness 用量：** 新增 DeepSeek Harness 用量追踪支持，可在用量视图和分解中查看其 Token 用量。（#408）
- **DeepSeek Harness 会话明细：** 支持在“会话”中查看 DeepSeek Harness 的提问、回合、每回合 Token 用量和工具记录。（#427）

### 改进
- **采集来源：** “设置 → 采集”中的“来源”列表会在工具状态载入前保持完整，包括尚未追踪的工具。（#435）
- **Windows 托盘图标：** 调整托盘图标尺寸，使其更贴合 Windows 通知区域并避免显示过小。（#345、#444）

### 修复
- **用量分解：** 不再显示 Token 和成本均为零的“未分类”残余列。（#439）
- **Claude Code 路径：** `CLAUDE_CONFIG_DIR` 现在会同时应用于 Claude 用量时间戳和会话明细；未设置时仍使用 `~/.claude`。（#455）
- **主页活动：** 修复“Token 活动”热图边缘的悬停和发光效果被裁切的问题。（#452）
- **Windows 启动：** 修复近期版本在 Windows 上可能无法正常启动的问题。（#447）
- **Hub 草稿：** 修改“同步上传频率”时，不再覆盖尚未保存的 Hub URL、密钥、设备 ID 或端口编辑。（#433）
- **Antigravity Windows 检测：** 修复 Windows 为 CLI 或语言服务器可执行路径加引号时无法正确检测 Antigravity 的问题。（#440、#442）
- **AI 工具额度请求：** 提供商停止传输响应内容时，会在请求超时内结束，不再等待更长的外层探测期限。（#434）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.46.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.46.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-Setup-0.46.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.46.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.45.0...v0.46.0">v0.45.0...v0.46.0</a></summary>

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
- **DeepSeek Harness 用量：** 新增 DeepSeek Harness 用量追蹤支援，可在用量檢視與分解中查看其 Token 用量。（#408）
- **DeepSeek Harness 會話明細：** 支援在「會話」中查看 DeepSeek Harness 的提問、回合、每回合 Token 用量與工具記錄。（#427）

### 改進
- **採集來源：** 「設定 → 採集」中的「來源」列表會在工具狀態載入前保持完整，包括尚未追蹤的工具。（#435）
- **Windows 托盤圖示：** 調整托盤圖示尺寸，使其更貼合 Windows 通知區域並避免顯示過小。（#345、#444）

### 修復
- **用量分解：** 不再顯示 Token 與成本均為零的「未分類」殘餘列。（#439）
- **Claude Code 路徑：** `CLAUDE_CONFIG_DIR` 現在會同時套用於 Claude 用量時間戳與會話明細；未設定時仍使用 `~/.claude`。（#455）
- **主頁活動：** 修正「Token 活動」熱圖邊緣的懸停與發光效果被裁切的問題。（#452）
- **Windows 啟動：** 修正近期版本在 Windows 上可能無法正常啟動的問題。（#447）
- **Hub 草稿：** 修改「同步上傳頻率」時，不再覆蓋尚未儲存的 Hub URL、密鑰、裝置 ID 或連接埠編輯。（#433）
- **Antigravity Windows 偵測：** 修正 Windows 為 CLI 或語言伺服器可執行路徑加上引號時無法正確偵測 Antigravity 的問題。（#440、#442）
- **AI 工具額度請求：** 提供者停止傳送回應內容時，會在請求逾時內結束，不再等待更長的外層探測期限。（#434）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.46.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.46.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-Setup-0.46.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.46.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **DeepSeek Harness 사용량:** DeepSeek Harness 사용량 추적을 추가해 사용량 보기와 내역에서 토큰 사용량을 확인할 수 있습니다. (#408)
- **DeepSeek Harness 세션 상세:** `세션`에서 DeepSeek Harness의 프롬프트, 턴, 턴별 토큰 사용량과 도구 기록을 확인할 수 있습니다. (#427)

### 개선
- **수집 소스:** 도구 상태가 로드되기 전에도 `설정 → 수집`의 `소스` 목록을 확인할 수 있으며, 아직 추적하지 않는 도구도 포함됩니다. (#435)
- **Windows 트레이 아이콘:** 트레이 아이콘 크기를 조정해 Windows 알림 영역에 더 잘 맞고 작게 보이지 않습니다. (#345, #444)

### 수정
- **사용량 내역:** 토큰과 비용이 모두 0인 `미분류` 잔여 행은 더 이상 사용량 보기에 표시되지 않습니다. (#439)
- **Claude Code 경로:** `CLAUDE_CONFIG_DIR`이 Claude 사용량 타임스탬프와 세션 상세에 모두 적용되며, 설정하지 않으면 `~/.claude`를 사용합니다. (#455)
- **홈 활동:** `토큰 활동` 히트맵 가장자리의 호버와 발광 효과가 더 이상 잘리지 않습니다. (#452)
- **Windows 시작:** 최근 버전의 Windows 시작 회귀로 앱이 실행되지 않는 문제가 해결되었습니다. (#447)
- **Hub 초안:** `동기화 업로드 빈도`를 바꿔도 저장하지 않은 Hub URL, 시크릿, 기기 ID 또는 포트 입력이 덮어써지지 않습니다. (#433)
- **Windows Antigravity 감지:** Windows가 CLI 또는 language server 실행 경로를 따옴표로 감싸도 Antigravity를 올바르게 감지합니다. (#440, #442)
- **AI 도구 한도 요청:** 공급자 응답이 중간에 멈추면 더 긴 외부 기한을 기다리지 않고 요청 시간 초과 안에 종료됩니다. (#434)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.46.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.46.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-Setup-0.46.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.46.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **DeepSeek Harness の使用量:** DeepSeek Harness の使用量追跡に対応し、使用量ビューと内訳でトークン使用量を確認できます。（#408）
- **DeepSeek Harness のセッション詳細:** `セッション`でDeepSeek Harnessのプロンプト、ターン、ターンごとのトークン使用量、ツール記録を確認できます。（#427）

### 改善
- **収集ソース：** ツールの状態が読み込まれる前でも、`設定 → 収集`の`ソース`一覧を確認できます。未追跡のツールも含まれます。（#435）
- **Windowsのトレイアイコン：** トレイアイコンのサイズを調整し、Windowsの通知領域により自然に収まり、小さく見えなくなりました。（#345、#444）

### 修正
- **使用量の内訳：** トークン数とコストがともに0の`未分類`残余行を使用量ビューに表示しません。（#439）
- **Claude Codeのパス：** `CLAUDE_CONFIG_DIR`をClaudeの使用量タイムスタンプとセッション詳細の両方に適用し、未設定時は`~/.claude`を使用します。（#455）
- **ホームのアクティビティ：** `トークンアクティビティ`ヒートマップの端でホバーと発光エフェクトが切れなくなりました。（#452）
- **Windowsの起動：** 最近のバージョンで発生していたWindowsの起動問題を修正しました。（#447）
- **Hubの下書き：** `同期アップロード頻度`を変更しても、保存前のHub URL、シークレット、デバイスID、ポートが上書きされません。（#433）
- **WindowsでのAntigravity検出：** CLIまたはlanguage serverの実行パスをWindowsが引用符で囲んでも、Antigravityを正しく検出できます。（#440、#442）
- **AIツール制限のリクエスト：** プロバイダーの応答が途中で止まっても、より長い外側の期限を待たず、リクエストのタイムアウト内に終了します。（#434）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.46.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.46.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-Setup-0.46.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.46.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.46.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.46.0/Token-Monitor-0.46.0.AppImage)

</details>

</details>
