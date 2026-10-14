# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Token number animation:** A new Digit roll animation applies to token totals, breakdowns and Edge Dock readings. Switch back to the original Count up animation in Appearance settings. (#1014, #1026)
- **CatPaw usage:** Supports local assistant usage tracking for the domestic and overseas editions on macOS and Windows; disabled by default. (#990)
- **MiniMax API balance:** Supports pay-as-you-go keys and displays CNY or USD balances in Limits and Edge Dock. (#1024)

### Improved
- **Session lists:** Loads titles and displays recent sessions more quickly in large histories. (#1006)
- **Appearance settings:** Moves Live Indicator, Tool Icons and Use Title Icon into Advanced customization. (#1015)
- **Antigravity in WSL:** Adds setup guidance for running a headless agent inside WSL when Windows cannot read its usage. (#1032)

### Fixed
- **Codex compressed sessions:** Fixes missing usage and session details for compressed session logs, including archived sessions. (#1019)
- **StepFun Oasis quotas:** Fixes quota updates failing after the access token expires. (#1002)
- **Hermes estimated costs:** Fixes reasoning tokens being charged twice. (#971, #1019)
- **DeepSeek Harness models:** Fixes sessions showing the keepalive placeholder instead of the requested model and its estimated cost. (#1019)
- **Cursor manual sync:** Allows longer usage syncs to finish without the previous short timeout. (#1019)
- **Windows Edge Dock:** Removes extra Dock entries from the taskbar. (#1017)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.70.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.70.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-Setup-0.70.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.70.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.AppImage)

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
- **Token 数字动画：** 全新的逐位滚动动画应用于总量、分解与侧边栏读数，可在外观设置中切回原有的数值递增动画。 （#1014、#1026）
- **CatPaw 用量：** 支持 macOS 与 Windows 上国内版及海外版助手的本地用量追踪，默认关闭。 （#990）
- **MiniMax API 余额：** 支持按量计费密钥，在额度和侧边栏显示人民币或美元余额。 （#1024）

### 改进
- **会话列表：** 大量历史会话下，更快地加载标题和显示近期会话。 （#1006）
- **外观设置：** 将“实时指示器”、“工具图标”和“标题改用图标”移入“高级自定义”。 （#1015）
- **WSL 中的 Antigravity：** Windows 无法读取用量时，提供在 WSL 内运行 headless agent 的设置指引。 （#1032）

### 修复
- **Codex 压缩会话：** 修复压缩会话日志的用量和详情缺失问题，包括已归档会话。 （#1019）
- **StepFun Oasis 额度：** 修复访问令牌过期后额度无法更新的问题。 （#1002）
- **Hermes 预估费用：** 修复推理 Tokens 重复计价的问题。 （#971、#1019）
- **DeepSeek Harness 模型：** 修复会话显示 keepalive 占位值，未能显示所请求模型及其预估费用的问题。 （#1019）
- **Cursor 手动同步：** 允许耗时较长的用量同步完成，避免过早超时。 （#1019）
- **Windows 侧边栏：** 移除任务栏中多余的 Dock 条目。 （#1017）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.70.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.70.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-Setup-0.70.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.70.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.69.0...v0.70.0">v0.69.0...v0.70.0</a></summary>

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
- **Token 數字動畫：** 全新的逐位滾動動畫套用於總量、分解與側邊欄讀數，可在外觀設定中切回原有的數值遞增動畫。 （#1014、#1026）
- **CatPaw 用量：** 支援 macOS 與 Windows 上國內版及海外版助手的本機用量追蹤，預設關閉。 （#990）
- **MiniMax API 餘額：** 支援按量計費金鑰，在額度和側邊欄顯示人民幣或美元餘額。 （#1024）

### 改進
- **會話列表：** 大量歷史會話下，更快地載入標題和顯示近期會話。 （#1006）
- **外觀設定：** 將「即時指示器」、「工具圖示」與「標題改用圖示」移入「進階自訂」。 （#1015）
- **WSL 中的 Antigravity：** Windows 無法讀取用量時，提供在 WSL 內執行 headless agent 的設定指引。 （#1032）

### 修復
- **Codex 壓縮會話：** 修復壓縮會話記錄的用量和詳情缺失問題，包括已封存會話。 （#1019）
- **StepFun Oasis 額度：** 修復存取權杖過期後額度無法更新的問題。 （#1002）
- **Hermes 預估費用：** 修復推理 Token 重複計價的問題。 （#971、#1019）
- **DeepSeek Harness 模型：** 修復會話顯示 keepalive 佔位值，未能顯示所請求模型及其預估費用的問題。 （#1019）
- **Cursor 手動同步：** 允許耗時較長的用量同步完成，避免過早逾時。 （#1019）
- **Windows 側邊欄：** 移除工作列中多餘的 Dock 項目。 （#1017）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.70.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.70.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-Setup-0.70.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.70.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **토큰 숫자 애니메이션:** 토큰 합계, 분석, 가장자리 도크의 숫자에 새로운 자릿수 전환 애니메이션을 적용했습니다. 외관 설정에서 기존 숫자 카운트 애니메이션으로 되돌릴 수 있습니다. (#1014, #1026)
- **CatPaw 사용량:** macOS와 Windows에서 중국 및 해외 버전 어시스턴트의 로컬 사용량 추적을 지원합니다. 기본적으로 꺼져 있습니다. (#990)
- **MiniMax API 잔액:** 종량제 키를 지원하며 한도와 가장자리 도크에 CNY 또는 USD 잔액을 표시합니다. (#1024)

### 개선
- **세션 목록:** 기록이 많을 때 제목을 불러오고 최근 세션을 표시하는 속도를 개선했습니다. (#1006)
- **외관 설정:** 실시간 표시기, 도구 아이콘, 제목 아이콘 사용을 고급 사용자 지정으로 옮겼습니다. (#1015)
- **WSL의 Antigravity:** Windows에서 사용량을 읽을 수 없을 때 WSL 안에서 헤드리스 에이전트를 실행하는 설정 방법을 안내합니다. (#1032)

### 수정
- **Codex 압축 세션:** 보관된 세션을 포함해 압축 로그의 사용량과 세션 상세 정보가 누락되는 문제를 수정했습니다. (#1019)
- **StepFun Oasis 한도:** 액세스 토큰이 만료되면 한도가 갱신되지 않는 문제를 수정했습니다. (#1002)
- **Hermes 예상 비용:** 추론 토큰의 비용이 두 번 계산되는 문제를 수정했습니다. (#971, #1019)
- **DeepSeek Harness 모델:** 요청한 모델과 예상 비용 대신 keepalive가 표시되는 문제를 수정했습니다. (#1019)
- **Cursor 수동 동기화:** 시간이 오래 걸리는 사용량 동기화가 너무 일찍 시간 초과로 중단되지 않도록 했습니다. (#1019)
- **Windows 가장자리 도크:** 작업 표시줄에 나타나던 불필요한 Dock 항목을 제거했습니다. (#1017)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.70.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.70.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-Setup-0.70.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.70.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **トークン数のアニメーション：** 合計、内訳、エッジドックの数値に新しい桁ごとのロールアニメーションを適用しました。外観設定で従来のカウントアップに戻せます。 （#1014、#1026）
- **CatPaw の使用量：** macOS と Windows で中国版・海外版アシスタントのローカル使用量の追跡に対応しました。初期設定では無効です。 （#990）
- **MiniMax API の残高：** 従量課金のキーに対応し、制限とエッジドックに人民元または米ドルの残高を表示します。 （#1024）

### 改善
- **セッション一覧：** 履歴が多い場合のタイトル読み込みと最近のセッションの表示を高速化しました。 （#1006）
- **外観設定：** 「ライブインジケーター」、「ツールアイコン」、「タイトルアイコンを使用」を「詳細カスタマイズ」に移動しました。 （#1015）
- **WSL の Antigravity：** Windows から使用量を読み取れない場合に、WSL 内でヘッドレスエージェントを実行するための設定方法を案内します。 （#1032）

### 修正
- **Codex の圧縮セッション：** アーカイブ済みのセッションを含め、圧縮ログの使用量や詳細が表示されない問題を修正しました。 （#1019）
- **StepFun Oasis の制限：** アクセストークンの期限切れ後に制限が更新されない問題を修正しました。 （#1002）
- **Hermes の推定費用：** 推論トークンの費用が二重に計算される問題を修正しました。 （#971、#1019）
- **DeepSeek Harness のモデル：** 要求したモデルと推定費用の代わりに keepalive が表示される問題を修正しました。 （#1019）
- **Cursor の手動同期：** 時間のかかる使用量の同期が早すぎるタイムアウトで中断されないようにしました。 （#1019）
- **Windows のエッジドック：** タスクバーに表示される余分な Dock 項目を削除しました。 （#1017）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.70.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.70.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-Setup-0.70.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.70.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.70.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.70.0/Token-Monitor-0.70.0.AppImage)

</details>

</details>
