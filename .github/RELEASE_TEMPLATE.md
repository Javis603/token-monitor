# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Devin usage:** Adds usage tracking for Devin CLI and Devin Desktop. (#757)
- **Devin limits:** Shows daily and weekly quotas and extra usage balance after connecting a Devin account. (#776)
- **ClinePass limits:** Shows five-hour, weekly, and monthly quotas and the credit balance from a local Cline sign-in or API key. (#764)
- **Xiaomi MiMo Desktop usage:** Tracks MiMo Desktop alongside MiMo Code. New installs track Xiaomi MiMo by default. (#772)
- **GitHub Copilot CLI usage:** Tracks local Copilot CLI tokens. (#772)
- **Claude Code context:** Shows session context usage with a best-effort window size. (#767)
- **Edge Dock models:** Switch usage cards between tool and model breakdowns. (#769)
- **Edge Dock haptics:** Adds optional trackpad feedback on supported Macs. (#762)

### Improved
- **Edge Dock breakdowns:** Scroll through tools and models beyond the first six rows. (#769)

### Fixed
- **Windows Floating Bubble:** Fixes duplicate bubbles and crashes when closing the window. (#712)
- **Linux Floating Bubble:** Expands again after being collapsed. (#756)
- **Subscription comparison:** Shows the month's usage cost for plans whose tool and limits provider have different names. (#766)
- **DeepSeek in Edge Dock:** Shows DeepSeek Harness usage and cost on the DeepSeek card. (#765)
- **ZCode billing:** No longer shows an unattributed fallback balance when the current account is known but its billing credential is unavailable. (#761)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.61.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.61.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-Setup-0.61.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.61.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.AppImage)

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
- **Devin 用量：** 支持追踪 Devin CLI 和 Devin Desktop 用量。（#757）
- **Devin 额度：** 连接 Devin 账号后可查看每日、每周额度及额外用量余额。（#776）
- **ClinePass 额度：** 通过本机 Cline 登录或 API 密钥查看五小时、每周、每月额度及余额。（#764）
- **Xiaomi MiMo Desktop 用量：** 与 MiMo Code 一并追踪 Desktop 用量。全新安装默认追踪 Xiaomi MiMo。（#772）
- **GitHub Copilot CLI 用量：** 支持追踪本机 Copilot CLI 的 Token 用量。（#772）
- **Claude Code 上下文：** 在会话中显示上下文使用比例；窗口大小为估算值。（#767）
- **侧边栏模型：** 用量卡片可切换查看“工具”或“模型”分解。（#769）
- **侧边栏触觉反馈：** 在支持的 Mac 上可开启触控板触觉反馈。（#762）

### 改进
- **侧边栏用量分解：** 可滚动查看超过六行的工具或模型。（#769）

### 修复
- **Windows 悬浮球：** 修复重复显示及关闭窗口时可能崩溃的问题。（#712）
- **Linux 悬浮球：** 修复收起后无法重新展开的问题。（#756）
- **订阅费用对比：** 修复工具与额度供应商名称不同时，无法显示当月用量费用的问题。（#766）
- **侧边栏 DeepSeek：** DeepSeek 卡片可显示 DeepSeek Harness 的用量与费用。（#765）
- **ZCode 账单余额：** 已识别当前账号但无法读取账单凭证时，不再显示无法归属该账号的备用余额。（#761）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.61.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.61.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-Setup-0.61.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.61.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.60.0...v0.61.0">v0.60.0...v0.61.0</a></summary>

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
- **Devin 用量：** 支援追蹤 Devin CLI 和 Devin Desktop 用量。（#757）
- **Devin 額度：** 連接 Devin 帳號後可查看每日、每週額度及額外用量餘額。（#776）
- **ClinePass 額度：** 透過本機 Cline 登入或 API 金鑰查看五小時、每週、每月額度及餘額。（#764）
- **Xiaomi MiMo Desktop 用量：** 與 MiMo Code 一併追蹤 Desktop 用量。全新安裝預設追蹤 Xiaomi MiMo。（#772）
- **GitHub Copilot CLI 用量：** 支援追蹤本機 Copilot CLI 的 Token 用量。（#772）
- **Claude Code 上下文：** 在會話中顯示上下文使用比例；視窗大小為估算值。（#767）
- **側邊欄模型：** 用量卡片可切換查看「工具」或「模型」分解。（#769）
- **側邊欄觸覺回饋：** 在支援的 Mac 上可開啟觸控板觸覺回饋。（#762）

### 改進
- **側邊欄用量分解：** 可捲動查看超過六列的工具或模型。（#769）

### 修復
- **Windows 浮動泡泡：** 修復重複顯示及關閉視窗時可能當機的問題。（#712）
- **Linux 浮動泡泡：** 修復收起後無法重新展開的問題。（#756）
- **訂閱費用比較：** 修復工具與額度供應商名稱不同時，無法顯示當月用量費用的問題。（#766）
- **側邊欄 DeepSeek：** DeepSeek 卡片可顯示 DeepSeek Harness 的用量與費用。（#765）
- **ZCode 帳單餘額：** 已識別目前帳號但無法讀取帳單憑證時，不再顯示無法歸屬該帳號的備用餘額。（#761）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.61.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.61.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-Setup-0.61.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.61.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Devin 사용량:** Devin CLI와 Devin Desktop 사용량 추적을 지원합니다. (#757)
- **Devin 한도:** Devin 계정을 연결하면 일간·주간 할당량과 추가 사용 잔액을 표시합니다. (#776)
- **ClinePass 한도:** 로컬 Cline 로그인 또는 API 키로 5시간·주간·월간 할당량과 크레딧 잔액을 표시합니다. (#764)
- **Xiaomi MiMo Desktop 사용량:** MiMo Code와 함께 Desktop 사용량을 추적합니다. 새 설치에서는 Xiaomi MiMo를 기본 추적합니다. (#772)
- **GitHub Copilot CLI 사용량:** 로컬 Copilot CLI의 토큰 사용량을 추적합니다. (#772)
- **Claude Code 컨텍스트:** 추정한 컨텍스트 창 크기를 기준으로 세션 사용 비율을 표시합니다. (#767)
- **가장자리 도크 모델:** 사용량 카드에서 도구별 보기와 모델별 보기를 전환할 수 있습니다. (#769)
- **가장자리 도크 햅틱:** 지원되는 Mac에서 트랙패드 햅틱 피드백을 켤 수 있습니다. (#762)

### 개선
- **가장자리 도크 사용량 분류:** 여섯 줄을 넘는 도구와 모델도 스크롤하여 볼 수 있습니다. (#769)

### 수정
- **Windows 플로팅 버블:** 버블이 중복 표시되거나 창을 닫을 때 충돌하는 문제를 수정했습니다. (#712)
- **Linux 플로팅 버블:** 접은 뒤 다시 펼쳐지지 않는 문제를 수정했습니다. (#756)
- **구독 비용 비교:** 도구와 한도 공급자의 이름이 다를 때 월간 사용 비용이 빠지는 문제를 수정했습니다. (#766)
- **가장자리 도크의 DeepSeek:** DeepSeek 카드에 DeepSeek Harness 사용량과 비용을 표시합니다. (#765)
- **ZCode 결제 잔액:** 현재 계정은 확인했지만 결제 자격 증명을 읽을 수 없을 때, 계정에 귀속할 수 없는 대체 잔액을 표시하지 않습니다. (#761)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.61.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.61.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-Setup-0.61.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.61.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Devin の使用量：** Devin CLI と Devin Desktop の使用量追跡に対応します。（#757）
- **Devin の上限：** Devin アカウントを接続すると、日間・週間のクォータと追加使用残高を表示します。（#776）
- **ClinePass の上限：** ローカルの Cline ログインまたは API キーから、5時間・週間・月間のクォータとクレジット残高を表示します。（#764）
- **Xiaomi MiMo Desktop の使用量：** MiMo Code とあわせて Desktop の使用量を追跡します。新規インストールでは Xiaomi MiMo が標準で追跡されます。（#772）
- **GitHub Copilot CLI の使用量：** ローカルの Copilot CLI のトークン使用量を追跡します。（#772）
- **Claude Code のコンテキスト：** 推定したコンテキストウィンドウのサイズを基に、セッションの使用率を表示します。（#767）
- **エッジドックのモデル：** 使用量カードでツール別とモデル別の内訳を切り替えられます。（#769）
- **エッジドックの触覚フィードバック：** 対応する Mac でトラックパッドの触覚フィードバックを有効にできます。（#762）

### 改善
- **エッジドックの使用量内訳：** 6行を超えるツールやモデルもスクロールして確認できます。（#769）

### 修正
- **Windows のフローティングバブル：** バブルの重複表示と、ウィンドウを閉じた際のクラッシュを修正しました。（#712）
- **Linux のフローティングバブル：** 折りたたんだ後に再展開できない問題を修正しました。（#756）
- **サブスクリプションの費用比較：** ツールと上限プロバイダーの名前が異なる場合に、月間使用コストが表示されない問題を修正しました。（#766）
- **エッジドックの DeepSeek：** DeepSeek カードに DeepSeek Harness の使用量と費用を表示します。（#765）
- **ZCode の請求残高：** 現在のアカウントは判明していても請求用の認証情報を読めない場合、アカウントに紐付かない代替残高を表示しません。（#761）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.61.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.61.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-Setup-0.61.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.61.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.61.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.61.0/Token-Monitor-0.61.0.AppImage)

</details>

</details>
