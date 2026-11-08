# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Mistral Vibe usage:** Tracks local session token usage. (#1384)
- **Prime Agent usage:** Tracks local sessions, including RLM sub-agents. (#1390)
- **Jcode usage:** Tracks local sessions, including reasoning tokens. (#1390)
- **Mistral quota:** Supports API and Vibe Code subscription allowances and credit balance with manual Cookie setup. (#1387)
- **MiniMax Code quota:** Shows points and plan quotas separately from API billing, with multiple API keys. (#1284)
- **Plugin quotas:** Supports optional plugin modules in the native Limits page, with account setup in AI Tool Limits. (#1391)
- **OpenAI API credits:** Adds an optional plugin for Platform credit balance and expiry, available through plugin discovery. Requires manual Platform session credentials. (#1407, #1409)
- **Copilot CLI usage:** Supports native session-state usage alongside existing sources. (#1400)

### Improved
- **Monthly tray presets:** Adds convenient monthly Tokens, estimated cost, and combined presets for the tray and floating bubble. (#1346)
- **Edge Dock accounts:** Pins a chosen third-party API account on the sidebar while keeping other accounts in the detail card. (#1381)
- **Edge Dock detail size:** Adjusts detail-window size independently of the sidebar. (#1406)
- **Settings dropdowns:** Unifies pickers, with searchable long lists and font previews. (#1410)
- **MiMo accounts:** Separates Console and Desktop headings and makes Gift/Cash balance details clearer. (#1402)

### Fixed
- **Live usage updates:** Keeps pricing downloads from delaying live collection on slow connections. (#1389)
- **Quota history:** Preserves continuous trends across compatible device-source handoffs after failed refreshes. Applies to newly recorded history. (#1392)
- **Cursor accounts:** Hides stale desktop-detected accounts after sign-out, account changes, or expired authorization. (#1348)
- **macOS network errors:** Prevents an Uncaught Exception dialog caused by socket QoS errors. (#1398)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.88.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.88.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-Setup-0.88.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.88.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.AppImage)

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
- **Mistral Vibe 用量：** 支持本地会话的 Tokens 用量统计。 （#1384）
- **Prime Agent 用量：** 支持本地会话及 RLM 子代理用量统计。 （#1390）
- **Jcode 用量：** 支持本地会话用量统计，包含推理 Tokens。 （#1390）
- **Mistral 额度：** 支持 API 与 Vibe Code 订阅额度及余额，需手动配置 Cookie。 （#1387）
- **MiniMax Code 额度：** 分别显示积分、套餐额度和 API 账单，支持配置多个 API 密钥。 （#1284）
- **插件额度：** 支持在原生额度页面显示可选插件模块，并在“AI 工具额度”中配置账户。 （#1391）
- **OpenAI API 余额：** 新增可在插件发现页安装的可选插件，显示 Platform 余额及到期时间，需手动配置 Platform 会话凭据。 （#1407、#1409）
- **Copilot CLI 用量：** 新增原生会话数据支持，可与现有来源一同统计。 （#1400）

### 改进
- **托盘月度预设：** 可直接选择本月 Tokens、估算费用或两者组合，用于托盘和悬浮球。 （#1346）
- **侧边栏账户：** 可固定显示指定第三方 API 账户，详情卡片仍保留其他账户。 （#1381）
- **侧边栏详情大小：** 可独立调整详情窗口大小，不再受侧栏大小限制。 （#1406）
- **设置下拉菜单：** 统一选择控件，长列表支持搜索，字体列表支持预览。 （#1410）
- **MiMo 账户：** 分开显示 Console 与 Desktop 标题，Gift/Cash 余额明细更清晰。 （#1402）

### 修复
- **实时用量更新：** 避免慢速网络下的价格下载拖慢实时采集。 （#1389）
- **额度历史：** 刷新失败后，在兼容的设备来源间切换时保留连续趋势。仅对新记录的历史生效。 （#1392）
- **Cursor 账户：** 桌面端退出登录、更换账户或授权失效后，不再显示过期的自动检测账户。 （#1348）
- **macOS 网络错误：** 修复套接字 QoS 错误可能触发未捕获异常弹窗的问题。 （#1398）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.88.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.88.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-Setup-0.88.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.88.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.87.0...v0.88.0">v0.87.0...v0.88.0</a></summary>

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
- **Mistral Vibe 用量：** 支援本機工作階段的 Token 用量統計。 （#1384）
- **Prime Agent 用量：** 支援本機工作階段及 RLM 子代理用量統計。 （#1390）
- **Jcode 用量：** 支援本機工作階段用量統計，包含推理 Token。 （#1390）
- **Mistral 額度：** 支援 API 與 Vibe Code 訂閱額度及餘額，需手動設定 Cookie。 （#1387）
- **MiniMax Code 額度：** 分別顯示點數、方案額度與 API 帳單，支援設定多個 API 金鑰。 （#1284）
- **外掛額度：** 支援在原生額度頁面顯示選用的外掛模組，並在「AI 工具額度」中設定帳戶。 （#1391）
- **OpenAI API 餘額：** 新增可於外掛探索頁安裝的選用外掛，顯示 Platform 餘額及到期時間，需手動設定 Platform 工作階段憑證。 （#1407、#1409）
- **Copilot CLI 用量：** 新增原生工作階段資料支援，可與既有來源一同統計。 （#1400）

### 改進
- **系統匣月度預設：** 可直接選擇本月 Token、估算費用或兩者組合，用於系統匣與懸浮球。 （#1346）
- **側邊欄帳戶：** 可固定顯示指定的第三方 API 帳戶，詳情卡片仍保留其他帳戶。 （#1381）
- **側邊欄詳情視窗大小：** 可獨立調整詳情視窗大小，不再受側欄大小限制。 （#1406）
- **設定下拉選單：** 統一選擇控制項，長清單支援搜尋，字型清單支援預覽。 （#1410）
- **MiMo 帳戶：** 分開顯示 Console 與 Desktop 標題，Gift/Cash 餘額明細更清晰。 （#1402）

### 修復
- **即時用量更新：** 避免慢速網路下的價格下載拖慢即時收集。 （#1389）
- **額度歷史：** 更新失敗後，在相容的裝置來源間切換時保留連續趨勢。僅對新記錄的歷史生效。 （#1392）
- **Cursor 帳戶：** 桌面端登出、更換帳戶或授權失效後，不再顯示過期的自動偵測帳戶。 （#1348）
- **macOS 網路錯誤：** 修復通訊端 QoS 錯誤可能觸發未捕獲例外彈窗的問題。 （#1398）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.88.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.88.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-Setup-0.88.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.88.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Mistral Vibe 사용량:** 로컬 세션의 토큰 사용량을 집계합니다. (#1384)
- **Prime Agent 사용량:** RLM 하위 에이전트를 포함한 로컬 세션 사용량을 집계합니다. (#1390)
- **Jcode 사용량:** 추론 토큰을 포함한 로컬 세션 사용량을 집계합니다. (#1390)
- **Mistral 할당량:** Cookie를 직접 설정하면 API 및 Vibe Code 구독 한도와 크레딧 잔액을 확인할 수 있습니다. (#1387)
- **MiniMax Code 할당량:** 포인트와 요금제 한도를 API 결제 정보와 구분해 표시하며, 여러 API 키를 지원합니다. (#1284)
- **플러그인 할당량:** 선택한 플러그인 모듈을 기본 한도 페이지에 표시하고 AI 도구 한도에서 계정을 설정할 수 있습니다. (#1391)
- **OpenAI API 크레딧:** 플러그인 탐색에서 설치할 수 있는 선택형 플러그인으로 Platform 잔액과 만료일을 확인합니다. Platform 세션 인증 정보를 직접 입력해야 합니다. (#1407, #1409)
- **Copilot CLI 사용량:** 기존 소스에 더해 네이티브 세션 데이터의 사용량을 지원합니다. (#1400)

### 개선
- **트레이 월간 프리셋:** 이번 달 토큰, 예상 비용 또는 두 값을 함께 표시하는 프리셋을 트레이와 플로팅 버블에서 간편하게 선택합니다. (#1346)
- **Edge Dock 계정:** 특정 타사 API 계정을 사이드바에 고정하고 다른 계정은 상세 카드에 유지할 수 있습니다. (#1381)
- **Edge Dock 상세 창 크기:** 사이드바와 별도로 상세 창 크기를 조절할 수 있습니다. (#1406)
- **설정 드롭다운:** 선택 메뉴를 통일하고 긴 목록 검색과 글꼴 미리보기를 지원합니다. (#1410)
- **MiMo 계정:** Console과 Desktop 제목을 구분하고 Gift/Cash 잔액 내역을 더 명확하게 표시합니다. (#1402)

### 수정
- **실시간 사용량 갱신:** 느린 연결에서 가격 다운로드가 실시간 수집을 지연시키지 않도록 수정했습니다. (#1389)
- **할당량 기록:** 새로고침 실패 후 호환되는 기기 소스로 전환할 때 추세가 끊기지 않도록 수정했습니다. 새로 기록되는 이력에 적용됩니다. (#1392)
- **Cursor 계정:** 데스크톱에서 로그아웃하거나 계정을 바꾸거나 인증이 만료되면 오래된 자동 감지 계정을 숨깁니다. (#1348)
- **macOS 네트워크 오류:** 소켓 QoS 오류로 처리되지 않은 예외 대화상자가 나타나는 문제를 수정했습니다. (#1398)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.88.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.88.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-Setup-0.88.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.88.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Mistral Vibeの使用量:** ローカルセッションのトークン使用量を集計します。 (#1384)
- **Prime Agentの使用量:** RLMサブエージェントを含むローカルセッションの使用量を集計します。 (#1390)
- **Jcodeの使用量:** 推論トークンを含むローカルセッションの使用量を集計します。 (#1390)
- **Mistralの使用量上限:** Cookieを手動で設定すると、APIとVibe Codeのサブスクリプション上限およびクレジット残高を確認できます。 (#1387)
- **MiniMax Codeの使用量上限:** ポイントとプランの上限をAPIの請求情報と分けて表示し、複数のAPIキーに対応します。 (#1284)
- **プラグインの使用量上限:** 任意のプラグインモジュールを標準の制限ページに表示し、AIツール制限でアカウントを設定できます。 (#1391)
- **OpenAI APIクレジット:** プラグインの検索画面から導入できる任意のプラグインで、Platformの残高と有効期限を確認できます。Platformのセッション認証情報を手動で設定する必要があります。 (#1407, #1409)
- **Copilot CLIの使用量:** 既存のソースに加え、ネイティブのセッションデータに対応します。 (#1400)

### 改善
- **トレイの月間プリセット:** 今月のトークン、推定コスト、または両方を表示するプリセットを、トレイとフローティングバブルで手軽に選べます。 (#1346)
- **Edge Dockのアカウント:** 特定のサードパーティAPIアカウントをサイドバーに固定し、ほかのアカウントも詳細カードに残せます。 (#1381)
- **Edge Dockの詳細サイズ:** サイドバーとは別に詳細ウィンドウのサイズを調整できます。 (#1406)
- **設定のドロップダウン:** 選択メニューを統一し、長いリストの検索やフォントのプレビューに対応します。 (#1410)
- **MiMoのアカウント:** ConsoleとDesktopの見出しを分け、Gift/Cashの残高内訳を見やすくしました。 (#1402)

### 修正
- **リアルタイム使用量の更新:** 低速回線で価格データのダウンロードが使用量の収集を遅らせる問題を修正しました。 (#1389)
- **使用量上限の履歴:** 更新失敗後に互換性のあるデバイスのデータソースへ切り替えても、推移が途切れないようにしました。新たに記録される履歴に適用されます。 (#1392)
- **Cursorのアカウント:** デスクトップでのログアウト、アカウント変更、認証切れに伴い、古い自動検出アカウントを非表示にします。 (#1348)
- **macOSのネットワークエラー:** ソケットのQoSエラーで未処理の例外ダイアログが表示される問題を修正しました。 (#1398)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.88.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.88.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-Setup-0.88.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.88.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.88.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.88.0/Token-Monitor-0.88.0.AppImage)

</details>

</details>
