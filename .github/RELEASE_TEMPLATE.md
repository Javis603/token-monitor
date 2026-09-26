# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Oh My Pi usage:** Tracks Oh My Pi separately from Pi, including on existing installs that tracked Pi. (#701)
- **TypeSafe limits:** Shows credit balance, plan, expiring credits, and token usage after connecting a TypeSafe account with a Cookie. (#794)
- **Background image:** Choose a local image in Appearance and adjust its opacity with Glass. (#785)
- **Claude reset counts:** Shows available usage-limit resets and their details when the account has grants. (#780)
- **Kimi Code session titles:** Shows generated or custom titles in Sessions. (#726)

### Improved
- **Edge Dock usage cards:** Shows the exact headline token count, with compact figures in session, period, and breakdown rows. (#784, #787)

### Fixed
- **Alibaba Bailian Personal quota:** Shows the monthly quota when the plan no longer reports weekly limits. (#791)
- **Devin plan:** Shows the subscription plan on the Limits card when available. (#788)
- **WorkBuddy sign-in:** Identifies app-encrypted credentials instead of asking you to sign in again. (#738)
- **macOS tray popover:** Opens on the display whose menu bar icon you clicked. (#714)
- **Kimi Code projects:** Restores project attribution for newer sessions. (#726)
- **Kimi K3 models:** Recognizes K3 model IDs in usage views. (#726)
- **Compact money figures:** Follows the selected number-unit setting in Edge Dock balances and costs. (#787)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.62.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.62.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-Setup-0.62.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.62.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.AppImage)

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
- **Oh My Pi 用量：** 与 Pi 分开追踪；此前追踪 Pi 的安装也会加入 Oh My Pi。（#701）
- **TypeSafe 额度：** 使用 Cookie 连接账号后，显示余额、方案、即将到期的额度及 Tokens 用量。（#794）
- **背景图片：** 可在“外观”中选择本机图片，并通过“玻璃”调整透明度。（#785）
- **Claude 重置次数：** 账号有可用重置次数时，显示次数及详情。（#780）
- **Kimi Code 会话标题：** 在“会话”中显示自动生成或自定义的标题。（#726）

### 改进
- **侧边栏用量卡片：** 主数字显示精确 Tokens 数量；会话、时段和分解行使用简写数字。（#784, #787）

### 修复
- **阿里云百炼个人版额度：** 不再提供每周额度的方案可正确显示每月额度。（#791）
- **Devin 方案：** 可读取订阅方案时，在额度卡片显示方案名称。（#788）
- **WorkBuddy 登录：** 凭据被应用加密时显示对应状态，不再误提示重新登录。（#738）
- **macOS 托盘弹窗：** 从哪个显示器的菜单栏图标打开，就显示在哪个显示器。（#714）
- **Kimi Code 项目归属：** 修复新版本会话无法归入项目的问题。（#726）
- **Kimi K3 模型：** 用量视图可识别 K3 模型编号。（#726）
- **侧边栏金额：** 余额与费用简写遵循所选数字单位。（#787）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.62.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.62.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-Setup-0.62.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.62.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.61.0...v0.62.0">v0.61.0...v0.62.0</a></summary>

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
- **Oh My Pi 用量：** 與 Pi 分開追蹤；原本追蹤 Pi 的安裝也會加入 Oh My Pi。（#701）
- **TypeSafe 額度：** 使用 Cookie 連接帳號後，顯示餘額、方案、即將到期的額度及 Tokens 用量。（#794）
- **背景圖片：** 可在「外觀」選擇本機圖片，並透過「玻璃」調整透明度。（#785）
- **Claude 重置次數：** 帳號有可用重置次數時，顯示次數及詳情。（#780）
- **Kimi Code 會話標題：** 在「會話」中顯示自動產生或自訂的標題。（#726）

### 改進
- **側邊欄用量卡片：** 主數字顯示精確 Tokens 數量；會話、時段和分解列使用簡寫數字。（#784, #787）

### 修復
- **阿里雲百煉個人版額度：** 不再提供每週額度的方案可正確顯示每月額度。（#791）
- **Devin 方案：** 可讀取訂閱方案時，在額度卡片顯示方案名稱。（#788）
- **WorkBuddy 登入：** 憑證被應用程式加密時顯示對應狀態，不再誤提示重新登入。（#738）
- **macOS 選單列彈窗：** 從哪個顯示器的圖示開啟，就顯示在哪個顯示器。（#714）
- **Kimi Code 專案歸屬：** 修復新版會話無法歸入專案的問題。（#726）
- **Kimi K3 模型：** 用量畫面可識別 K3 模型 ID。（#726）
- **側邊欄金額：** 餘額與費用簡寫遵循所選數字單位。（#787）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.62.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.62.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-Setup-0.62.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.62.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Oh My Pi 사용량:** Pi와 분리해 추적합니다. 기존에 Pi를 추적하던 설치에도 Oh My Pi가 추가됩니다. (#701)
- **TypeSafe 한도:** Cookie로 계정을 연결하면 잔액, 요금제, 만료 예정 크레딧과 토큰 사용량을 표시합니다. (#794)
- **배경 이미지:** 모양 설정에서 로컬 이미지를 선택하고 글래스로 투명도를 조절할 수 있습니다. (#785)
- **Claude 재설정 횟수:** 계정에 사용 가능한 재설정 혜택이 있으면 남은 횟수와 세부 정보를 표시합니다. (#780)
- **Kimi Code 세션 제목:** 세션 화면에서 자동 생성 또는 사용자 지정 제목을 표시합니다. (#726)

### 개선
- **가장자리 도크 사용량 카드:** 주요 토큰 수는 정확히 표시하고 세션, 기간, 분류 행은 축약해 표시합니다. (#784, #787)

### 수정
- **Alibaba Bailian Personal 한도:** 주간 한도를 더 이상 제공하지 않는 요금제의 월간 한도를 표시합니다. (#791)
- **Devin 요금제:** 구독 정보를 읽을 수 있으면 한도 카드에 요금제 이름을 표시합니다. (#788)
- **WorkBuddy 로그인:** 앱에서 자격 증명을 암호화한 경우 다시 로그인하라는 안내 대신 해당 상태를 표시합니다. (#738)
- **macOS 메뉴 막대 팝오버:** 클릭한 메뉴 막대 아이콘이 있는 디스플레이에서 열립니다. (#714)
- **Kimi Code 프로젝트 연결:** 최신 세션이 프로젝트에 연결되지 않던 문제를 수정했습니다. (#726)
- **Kimi K3 모델:** 사용량 화면에서 K3 모델 ID를 인식합니다. (#726)
- **가장자리 도크 금액:** 잔액과 비용의 축약 표기에 선택한 숫자 단위를 적용합니다. (#787)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.62.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.62.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-Setup-0.62.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.62.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Oh My Pi の使用量：** Pi と分けて追跡します。従来 Pi を追跡していた環境にも Oh My Pi が追加されます。（#701）
- **TypeSafe の上限：** Cookie でアカウントを接続すると、残高、プラン、期限が近いクレジット、トークン使用量を表示します。（#794）
- **背景画像：** 外観設定でローカル画像を選び、ガラスで透明度を調整できます。（#785）
- **Claude のリセット回数：** 利用可能なリセット特典がある場合、残り回数と詳細を表示します。（#780）
- **Kimi Code のセッションタイトル：** セッション画面に自動生成またはカスタムのタイトルを表示します。（#726）

### 改善
- **エッジドックの使用量カード：** メインのトークン数は正確に表示し、セッション、期間、内訳の行は短縮表記にします。（#784、#787）

### 修正
- **Alibaba Bailian Personal の上限：** 週次上限が廃止されたプランでも月次上限を表示します。（#791）
- **Devin のプラン：** サブスクリプション情報を取得できる場合、上限カードにプラン名を表示します。（#788）
- **WorkBuddy のログイン：** 認証情報がアプリで暗号化されている場合、再ログインを促さず状態を表示します。（#738）
- **macOS メニューバーのポップオーバー：** クリックしたアイコンがあるディスプレイで開きます。（#714）
- **Kimi Code のプロジェクト：** 新しい形式のセッションがプロジェクトに紐付かない問題を修正しました。（#726）
- **Kimi K3 モデル：** 使用量画面で K3 モデル ID を認識します。（#726）
- **エッジドックの金額：** 残高と費用の短縮表記に選択した数値単位を適用します。（#787）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.62.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.62.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-Setup-0.62.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.62.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.62.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.62.0/Token-Monitor-0.62.0.AppImage)

</details>

</details>
