# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Session activity:** Shows live running and finished states for Codex, DeepSeek Harness, OpenCode, and Claude Code, plus context used/remaining gauges for Codex and DeepSeek Harness. (#728)
- **Edge Dock sessions:** Adds a Sessions item for every tracked tool, with a single timeline or groups by tool, running-only filtering, and configurable rail summaries. (#742)

### Improved
- **Edge Dock limits:** Shows the same quota, balance, freshness, and account details as the Limits view, including OpenCode Zen balances and Command Code monthly grants. (#737)
- **Edge Dock motion:** Animates the rail reveal, handle retreat, and running marks. (#754)

### Fixed
- **ZCode accounts:** Keeps Coding Plan and Start/Weekend quota tied to live ZCode credentials on fresh installs and after account switches. (#725)
- **Antigravity usage:** No longer splits Antigravity CLI usage into duplicate tool rows or chart series. (#723)
- **Antigravity quota:** Improves CLI Hub detection for custom ports and avoids unauthenticated quota connections. (#723)
- **Provider icons:** Adds icon presentation for Qmodel, Nemotron, and StepFun. (#755)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.60.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.60.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-Setup-0.60.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.60.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.AppImage)

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
- **会话活动：** 显示 Codex、DeepSeek Harness、OpenCode 与 Claude Code 会话的运行中及已完成状态；Codex 与 DeepSeek Harness 还可显示上下文已用或剩余比例。（#728）
- **侧边栏会话：** 新增“会话”项目，可汇总所有追踪工具，按单一时间线或工具分组显示，并支持仅显示运行中会话及自定义侧边栏摘要。（#742）

### 改进
- **侧边栏额度：** 显示与“额度”视图一致的额度窗口、余额、更新时间与账号信息，包括 OpenCode Zen 余额和 Command Code 月度赠额。（#737）
- **侧边栏动效：** 为侧边栏展开、拉手收起及运行中标记加入动效。（#754）

### 修复
- **ZCode 账号：** 全新安装或切换账号后，Coding Plan 与 Start/Weekend 额度会继续使用当前 ZCode 凭据。（#725）
- **Antigravity 用量：** 不再把 Antigravity CLI 用量拆成重复的工具行或图表序列。（#723）
- **Antigravity 额度：** 改进自定义端口下的 CLI Hub 检测，并避免连接未通过身份验证的额度服务。（#723）
- **供应商图标：** 新增 Qmodel、Nemotron 与 StepFun 的图标显示。（#755）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.60.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.60.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-Setup-0.60.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.60.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.59.0...v0.60.0">v0.59.0...v0.60.0</a></summary>

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
- **會話活動：** 顯示 Codex、DeepSeek Harness、OpenCode 與 Claude Code 會話的執行中及已完成狀態；Codex 與 DeepSeek Harness 亦可顯示上下文已用或剩餘比例。（#728）
- **側邊欄會話：** 新增「會話」項目，可彙整所有追蹤工具，按單一時間軸或工具分組顯示，並支援只顯示執行中會話及自訂側邊欄摘要。（#742）

### 改進
- **側邊欄額度：** 顯示與「額度」視圖一致的額度窗口、餘額、更新時間與帳號資訊，包括 OpenCode Zen 餘額和 Command Code 每月贈額。（#737）
- **側邊欄動效：** 為側邊欄展開、把手收起及執行中標記加入動效。（#754）

### 修復
- **ZCode 帳號：** 全新安裝或切換帳號後，Coding Plan 與 Start/Weekend 額度會繼續使用目前的 ZCode 憑證。（#725）
- **Antigravity 用量：** 不再把 Antigravity CLI 用量拆成重複的工具列或圖表序列。（#723）
- **Antigravity 額度：** 改進自訂連接埠下的 CLI Hub 偵測，並避免連接未通過身分驗證的額度服務。（#723）
- **供應商圖示：** 新增 Qmodel、Nemotron 與 StepFun 的圖示顯示。（#755）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.60.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.60.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-Setup-0.60.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.60.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **세션 활동:** Codex, DeepSeek Harness, OpenCode, Claude Code 세션의 실행 중 및 완료 상태를 표시하며, Codex와 DeepSeek Harness에는 컨텍스트 사용량 또는 남은 비율도 표시합니다. (#728)
- **가장자리 도크 세션:** 추적 중인 모든 도구의 세션을 단일 타임라인이나 도구별 그룹으로 모아 보는 세션 항목을 추가합니다. 실행 중인 세션만 표시하거나 레일 요약을 구성할 수도 있습니다. (#742)

### 개선
- **가장자리 도크 한도:** 한도 화면과 같은 할당량 창, 잔액, 업데이트 시각, 계정 정보를 표시하며 OpenCode Zen 잔액과 Command Code 월간 지급량도 포함합니다. (#737)
- **가장자리 도크 모션:** 레일 표시, 핸들 숨김, 실행 중 표시를 애니메이션으로 표현합니다. (#754)

### 수정
- **ZCode 계정:** 새로 설치하거나 계정을 전환한 뒤에도 Coding Plan과 Start/Weekend 할당량이 현재 ZCode 자격 증명을 사용합니다. (#725)
- **Antigravity 사용량:** Antigravity CLI 사용량이 중복된 도구 행이나 차트 시리즈로 나뉘지 않습니다. (#723)
- **Antigravity 할당량:** 사용자 지정 포트의 CLI Hub 감지를 개선하고 인증되지 않은 할당량 서비스 연결을 방지합니다. (#723)
- **공급자 아이콘:** Qmodel, Nemotron, StepFun 아이콘 표시를 추가합니다. (#755)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.60.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.60.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-Setup-0.60.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.60.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **セッションのアクティビティ：** Codex、DeepSeek Harness、OpenCode、Claude Code のセッションに実行中／完了の状態を表示します。Codex と DeepSeek Harness ではコンテキストの使用済み／残りの割合も表示します。（#728）
- **エッジドックのセッション：** 追跡中のすべてのツールを単一のタイムラインまたはツール別グループで表示するセッション項目を追加します。実行中のみの表示とレールの要約も設定できます。（#742）

### 改善
- **エッジドックの上限：** 「上限」画面と同じクォータ枠、残高、更新時刻、アカウント情報を表示し、OpenCode Zen の残高と Command Code の月間付与分にも対応します。（#737）
- **エッジドックのモーション：** レールの表示、ハンドルの退避、実行中マークをアニメーション化します。（#754）

### 修正
- **ZCode アカウント：** 新規インストール時やアカウント切り替え後も、Coding Plan と Start/Weekend のクォータに現在の ZCode 認証情報を使用します。（#725）
- **Antigravity の使用量：** Antigravity CLI の使用量が重複したツール行やグラフ系列に分かれなくなりました。（#723）
- **Antigravity のクォータ：** カスタムポートでの CLI Hub 検出を改善し、認証されていないクォータサービスへの接続を防ぎます。（#723）
- **プロバイダーアイコン：** Qmodel、Nemotron、StepFun のアイコン表示を追加します。（#755）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.60.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.60.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-Setup-0.60.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.60.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.60.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.60.0/Token-Monitor-0.60.0.AppImage)

</details>

</details>
