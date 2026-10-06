# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Additional sync:** Optionally sync session titles, model aliases and grouping, and custom pricing through a Hub or Cloudflare Worker. Disabled by default; title sharing requires server permission. Message bodies are excluded. (#940)
- **MiMo Desktop quotas:** Detects the locally signed-in account and shows Console quotas and Desktop Membership weekly limits. (#824)
- **MiMo Console spending:** Shows Month and All-time spend, plus Today and Week spend tracked locally from setup. (#824)
- **CodeBuddy and WorkBuddy sessions:** Supports session titles and details with prompts, turns, token usage and tools. (#745)
- **Claude Code session titles:** Reads titles assigned in T3 Code. (#942)
- **Cherry Studio chat usage:** Tracks token usage from built-in chats alongside existing Agent usage. (#947)
- **Brazilian Portuguese:** Adds language support to the app, website and macOS widgets. (#936)
- **Chart color:** Customize activity heatmaps and trend charts, and share the color through theme codes. (#946)
- **Text size:** Choose Standard, Larger or Largest for labels and data text, independently of Zoom. (#948)
- **Home quota bars:** Adds an optional progress-bar display for limits; text remains the default. (#951)

### Improved
- **Home plan labels:** Shows account plans alongside quotas and improves spacing. (#951)

### Fixed
- **Claude Code usage:** Corrects duplicate usage and cache-token accounting when sessions are read again; existing cached records update when their source changes. (#947)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.67.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.67.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-Setup-0.67.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.67.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.AppImage)

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

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **额外同步：** 支持通过 Hub 或 Cloudflare Worker 同步会话标题、模型别名与分组、自定义单价。默认关闭；共享标题需服务器允许，不同步消息正文。（#940）
- **MiMo Desktop 额度：** 自动识别本机已登录账号，显示 Console 额度与 Desktop Membership 每周额度。（#824）
- **MiMo Console 费用：** 显示本月和全部费用，以及启用后在本地追踪的今日与本周费用。（#824）
- **CodeBuddy 与 WorkBuddy 会话：** 支持会话标题与详情，可查看提问、回合、Tokens 用量和工具记录。（#745）
- **Claude Code 会话标题：** 支持读取在 T3 Code 中设置的标题。（#942）
- **Cherry Studio 聊天用量：** 在已有 Agent 用量之外，新增内置聊天的 Tokens 用量追踪。（#947）
- **巴西葡萄牙语：** 应用、网站与 macOS 小组件新增语言支持。（#936）
- **图表颜色：** 支持自定义活动热力图与趋势图颜色，并通过主题代码分享。（#946）
- **文字大小：** 支持为标签与数据文字选择“标准”、“较大”或“最大”，独立于缩放设置。（#948）
- **主页额度进度条：** 新增可选的进度条显示模式，默认仍以文字显示。（#951）

### 改进
- **主页套餐标签：** 在额度旁显示账号套餐，并调整间距。（#951）

### 修复
- **Claude Code 用量：** 重新读取会话时修正重复用量与缓存 Tokens 计算；已有缓存记录会在源记录变化后更新。（#947）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.67.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.67.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-Setup-0.67.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.67.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.AppImage)

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

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.66.0...v0.67.0">v0.66.0...v0.67.0</a></summary>

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
- **額外同步：** 支援透過 Hub 或 Cloudflare Worker 同步會話標題、模型別名與分組、自訂單價。預設關閉；分享標題需伺服器允許，不同步訊息內文。（#940）
- **MiMo Desktop 額度：** 自動識別本機已登入帳號，顯示 Console 額度與 Desktop Membership 每週額度。（#824）
- **MiMo Console 費用：** 顯示本月與全部費用，以及啟用後在本機追蹤的今日與本週費用。（#824）
- **CodeBuddy 與 WorkBuddy 會話：** 支援會話標題與詳情，可查看提問、回合、Token 用量與工具記錄。（#745）
- **Claude Code 會話標題：** 支援讀取在 T3 Code 中設定的標題。（#942）
- **Cherry Studio 聊天用量：** 除既有 Agent 用量外，新增內建聊天的 Token 用量追蹤。（#947）
- **巴西葡萄牙語：** 應用程式、網站與 macOS 小工具新增語言支援。（#936）
- **圖表顏色：** 支援自訂活動熱力圖與趨勢圖顏色，並透過主題代碼分享。（#946）
- **文字大小：** 支援為標籤與資料文字選擇「標準」、「較大」或「最大」，獨立於縮放設定。（#948）
- **首頁額度進度條：** 新增可選的進度條顯示模式，預設仍以文字顯示。（#951）

### 改進
- **首頁方案標籤：** 在額度旁顯示帳號方案，並調整間距。（#951）

### 修復
- **Claude Code 用量：** 重新讀取會話時修正重複用量與快取 Token 計算；既有快取記錄會在來源記錄變更後更新。（#947）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.67.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.67.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-Setup-0.67.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.67.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **추가 동기화:** Hub 또는 Cloudflare Worker를 통해 세션 제목, 모델 별칭과 그룹, 사용자 지정 요금을 선택적으로 동기화합니다. 기본값은 꺼짐이며, 제목 공유에는 서버 허용이 필요합니다. 메시지 본문은 동기화하지 않습니다. (#940)
- **MiMo Desktop 한도:** 이 컴퓨터에 로그인한 계정을 자동으로 감지하고 Console 한도와 Desktop Membership 주간 한도를 표시합니다. (#824)
- **MiMo Console 비용:** 월간·전체 비용과 설정 이후 로컬에서 추적한 오늘·이번 주 비용을 표시합니다. (#824)
- **CodeBuddy 및 WorkBuddy 세션:** 세션 제목과 상세 보기를 지원하며 질문, 턴, 토큰 사용량과 도구 기록을 확인할 수 있습니다. (#745)
- **Claude Code 세션 제목:** T3 Code에서 지정한 제목을 읽습니다. (#942)
- **Cherry Studio 채팅 사용량:** 기존 Agent 사용량에 더해 내장 채팅의 토큰 사용량을 추적합니다. (#947)
- **브라질 포르투갈어:** 앱, 웹사이트와 macOS 위젯에서 지원합니다. (#936)
- **차트 색상:** 활동 히트맵과 추세 차트 색상을 지정하고 테마 코드로 공유할 수 있습니다. (#946)
- **텍스트 크기:** 확대/축소와 별도로 레이블과 데이터 텍스트를 ‘표준’, ‘크게’, ‘가장 크게’ 중에서 선택할 수 있습니다. (#948)
- **홈 한도 막대:** 진행 막대 표시 옵션을 추가했습니다. 기본값은 텍스트입니다. (#951)

### 개선
- **홈 요금제 표시:** 한도 옆에 계정 요금제를 표시하고 간격을 조정했습니다. (#951)

### 수정
- **Claude Code 사용량:** 세션을 다시 읽을 때 중복 사용량과 캐시 토큰 계산을 수정했습니다. 기존 캐시 기록은 원본 기록이 변경되면 갱신됩니다. (#947)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.67.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.67.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-Setup-0.67.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.67.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **追加の同期:** Hub または Cloudflare Worker 経由で、セッションタイトル、モデルの別名とグループ、カスタム料金を任意で同期できます。初期設定はオフで、タイトル共有にはサーバー側の許可が必要です。メッセージ本文は同期しません。 (#940)
- **MiMo Desktop の上限:** このコンピューターでログイン中のアカウントを自動検出し、Console の上限と Desktop Membership の週次上限を表示します。 (#824)
- **MiMo Console の費用:** 今月と全期間の費用に加え、設定後にローカルで追跡した今日と今週の費用を表示します。 (#824)
- **CodeBuddy・WorkBuddy のセッション:** タイトルと詳細表示に対応し、質問、ターン、トークン使用量、ツールの記録を確認できます。 (#745)
- **Claude Code のセッションタイトル:** T3 Code で設定したタイトルを読み取ります。 (#942)
- **Cherry Studio のチャット使用量:** 既存の Agent 使用量に加え、内蔵チャットのトークン使用量を追跡します。 (#947)
- **ブラジルポルトガル語:** アプリ、Web サイト、macOS ウィジェットに対応しました。 (#936)
- **グラフの色:** アクティビティのヒートマップとトレンドグラフの色を変更し、テーマコードで共有できます。 (#946)
- **文字サイズ:** ズームとは別に、ラベルとデータの文字を「標準」「大」「最大」から選べます。 (#948)
- **ホームの上限バー:** プログレスバー表示を選べるようになりました。初期設定はテキスト表示です。 (#951)

### 改善
- **ホームのプラン表示:** 上限の横にアカウントのプランを表示し、間隔を調整しました。 (#951)

### 修正
- **Claude Code の使用量:** セッションの再読み込み時に重複使用量とキャッシュトークンの計算を修正しました。既存のキャッシュ記録は元の記録が変わると更新されます。 (#947)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.67.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.67.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-Setup-0.67.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.67.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.67.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.67.0/Token-Monitor-0.67.0.AppImage)

</details>

</details>
