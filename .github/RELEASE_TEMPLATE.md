# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Multiple quota accounts.** More than 25 built-in quota providers support saving multiple accounts and tracking their quotas separately, including DeepSeek, Kimi, Z.ai, and Qoder. In provider settings, add, rename, reorder, or pause accounts and replace their credentials. (#1520, #1532)
- **Quota accounts across devices.** View accounts from other devices and their per-device status in the same list. A compatible Sync Hub keeps readings for multiple accounts separate and syncs account names and order. (#1512, #1532)
- **Alibaba Token Plan.** Read Personal and Team quotas from a locally signed-in Bailian CLI. (#1509)
- **Home activity trend.** Hover or use the keyboard to see the date, token count, and available cost for each plotted day. Choose Compact or Exact under “Trend tooltip tokens” in Activity settings. (#1540, #1547)
- **Codex session titles.** Show titles for sessions collected from additional Codex scan paths. (#1473)

### Improved
- **Collection settings.** The redesigned list puts tracked tools and their switches first, with untracked tools in a collapsible group. (#1548)
- **AI Tool Limits settings.** The redesigned list groups disabled providers together. Expand a provider to manage accounts and check quota sources and status. (#1532, #1548, #1561, #1565)
- **Session context meters.** Keep meters and percentages aligned in narrow rows on Home, Sessions, Edge Dock, and Notch. (#1553)

### Fixed
- **Synced usage totals.** Prevent lifetime tokens and cost from being counted twice when a synced tool is untracked. (#1545)
- **DeepSeek and Factory quotas.** Keep different accounts visible when devices signed in to those accounts sync to the same Hub. (#1518)
- **Live usage collection.** Avoid repeat scans triggered by SQLite reads and unrelated file changes. (#1515, #1517)
- **Quota history.** Keep the selected account when history refreshes in the background. (#1542)
- **Linux X11.** Prevent the pointer from freezing after right-clicking the window's title bar. (#1541)
- **Notch.** Keep running session cards rounded during horizontal swipes. (#1543)
- **macOS desktop widget.** Restore the Gemini model icon. (#1538)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.94.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.94.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-Setup-0.94.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.94.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.AppImage)

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
- **多账号配额：** 超过 25 个内置配额服务商支持保存多个账号并分别追踪配额，包括 DeepSeek、Kimi、Z.ai 和 Qoder。在服务商设置中可添加、重命名、排序或暂停账号，也可更换凭据。 （#1520, #1532）
- **跨设备配额账号：** 在同一列表中查看其他设备的账号及各设备的状态。兼容的同步中心会分开显示各账号的配额，并同步账号名称和顺序。 （#1512, #1532）
- **阿里云 Token Plan：** 支持通过本机已登录的百炼 CLI 读取个人版和团队版配额。 （#1509）
- **首页活动趋势：** 悬停或使用键盘查看图中每日的日期、Token 数和可用费用。可在活动设置的“趋势提示的 Token 数”中选择“简写”或“完整”。 （#1540, #1547）
- **Codex 会话标题：** 显示从额外 Codex 扫描路径采集的会话标题。 （#1473）

### 改进
- **「采集」设置：** 新版列表将已追踪工具和开关置顶，未追踪的工具集中折叠。 （#1548）
- **「AI 工具额度」设置：** 新版列表将已停用的服务商集中折叠。展开服务商即可管理账号、查看配额来源和读取状态。 （#1532, #1548, #1561, #1565）
- **会话上下文进度条：** 首页、会话、Edge Dock 和 Notch 的窄行也能对齐进度条和百分比。 （#1553）

### 修复
- **同步用量合计：** 停止追踪已同步的工具时，累计 Token 数和费用不会重复计算。 （#1545）
- **DeepSeek 和 Factory 配额：** 不同设备使用不同账号并同步到同一个 Hub 时，各账号可分别显示。 （#1518）
- **实时用量采集：** 避免读取 SQLite 或无关文件变动触发重复扫描。 （#1515, #1517）
- **配额历史：** 后台刷新时保留已选账号。 （#1542）
- **Linux X11：** 修复右键单击窗口标题栏后鼠标指针可能卡住的问题。 （#1541）
- **Notch：** 横向滑动时保留运行中会话卡片的圆角。 （#1543）
- **macOS 桌面小组件：** 恢复 Gemini 模型图标。 （#1538）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.94.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.94.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-Setup-0.94.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.94.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.93.1...v0.94.0">v0.93.1...v0.94.0</a></summary>

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
- **多帳號配額：** 超過 25 個內建配額服務商支援儲存多個帳號，並分別追蹤配額，包括 DeepSeek、Kimi、Z.ai 與 Qoder。在服務商設定中可新增、改名、排序或暫停帳號，也可更換憑證。 （#1520, #1532）
- **跨裝置配額帳號：** 在同一份清單查看其他裝置的帳號及各裝置的狀態。相容的同步中心會分開顯示各帳號的配額，並同步帳號名稱與順序。 （#1512, #1532）
- **阿里雲 Token Plan：** 支援透過本機已登入的百鍊 CLI 讀取個人版與團隊版配額。 （#1509）
- **首頁活動趨勢：** 將游標移到圖上或用鍵盤選取日期，即可查看當天的 Token 數與可用費用。可在活動設定的「趨勢提示的 Token 數」中選擇「簡寫」或「完整」。 （#1540, #1547）
- **Codex 工作階段標題：** 顯示從額外 Codex 掃描路徑收集的工作階段標題。 （#1473）

### 改進
- **「採集」設定：** 新版清單將已追蹤的工具與開關排在前面，未追蹤工具集中收合。 （#1548）
- **「AI 工具額度」設定：** 新版清單將已停用的服務商集中收合。展開服務商即可管理帳號、查看額度來源與讀取狀態。 （#1532, #1548, #1561, #1565）
- **工作階段上下文用量：** 首頁、工作階段、Edge Dock 與 Notch 的欄位較窄時，用量條與百分比仍會對齊。 （#1553）

### 修復
- **同步用量總計：** 停止追蹤已同步的工具時，累計 Token 數與費用不會重複計算。 （#1545）
- **DeepSeek 與 Factory 配額：** 不同裝置使用不同帳號並同步至同一個 Hub 時，各帳號會分開顯示。 （#1518）
- **即時用量收集：** 避免 SQLite 讀取與無關檔案變動觸發重複掃描。 （#1515, #1517）
- **配額歷史：** 背景重新整理時保留所選帳號。 （#1542）
- **Linux X11：** 修復在視窗標題列按右鍵後游標可能卡住的問題。 （#1541）
- **Notch：** 左右滑動時保留執行中工作階段卡片的圓角。 （#1543）
- **macOS 桌面小工具：** 恢復 Gemini 模型圖示。 （#1538）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.94.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.94.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-Setup-0.94.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.94.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **여러 계정의 할당량.** DeepSeek, Kimi, Z.ai, Qoder을 비롯한 25개가 넘는 기본 제공업체에서 여러 계정을 저장하고 할당량을 각각 추적할 수 있습니다. 제공업체 설정에서 계정을 추가하고, 이름이나 순서를 바꾸고, 일시 중지하거나 인증 정보를 교체할 수 있습니다. (#1520, #1532)
- **여러 기기의 할당량 계정.** 같은 목록에서 다른 기기의 계정과 기기별 상태를 확인할 수 있습니다. 호환되는 Sync Hub는 계정별 할당량을 구분하고 계정 이름과 순서를 동기화합니다. (#1512, #1532)
- **Alibaba Token Plan.** 이 컴퓨터에서 로그인한 Bailian CLI로 개인 및 팀 요금제의 할당량을 확인할 수 있습니다. (#1509)
- **홈 활동 추세.** 그래프에 마우스를 올리거나 키보드로 날짜를 선택하면 토큰 수와 확인 가능한 비용이 표시됩니다. 활동 설정의 ‘추세 툴팁 토큰 수’에서 ‘축약’ 또는 ‘전체’를 선택할 수 있습니다. (#1540, #1547)
- **Codex 세션 제목.** 추가 스캔 경로에서 수집한 Codex 세션의 제목을 표시합니다. (#1473)

### 개선
- **수집 설정.** 새 목록은 추적 중인 도구와 스위치를 먼저 표시하고, 추적하지 않는 도구는 접을 수 있게 묶었습니다. (#1548)
- **AI 도구 한도 설정.** 새 목록은 비활성 제공업체를 접을 수 있게 묶었습니다. 제공업체를 펼치면 계정을 관리하고 조회 소스와 상태를 확인할 수 있습니다. (#1532, #1548, #1561, #1565)
- **세션 컨텍스트 표시.** 홈, 세션, Edge Dock, Notch의 좁은 행에서도 사용량 막대와 백분율이 정렬됩니다. (#1553)

### 수정
- **동기화된 사용량 합계.** 동기화된 도구의 추적을 끌 때 누적 토큰 수와 비용이 두 번 집계되는 문제를 수정했습니다. (#1545)
- **DeepSeek 및 Factory 할당량.** 같은 Hub에 동기화하는 기기에서 서로 다른 계정을 사용하면 각각 표시합니다. (#1518)
- **실시간 사용량 수집.** SQLite 읽기와 무관한 파일 변경으로 스캔이 반복되는 문제를 수정했습니다. (#1515, #1517)
- **할당량 기록.** 백그라운드에서 새로고침해도 선택한 계정을 유지합니다. (#1542)
- **Linux X11.** 창 제목 표시줄을 마우스 오른쪽 버튼으로 클릭한 후 포인터가 멈추는 문제를 수정했습니다. (#1541)
- **Notch.** 가로로 스와이프할 때 실행 중인 세션 카드의 둥근 모서리가 유지됩니다. (#1543)
- **macOS 데스크톱 위젯.** Gemini 모델 아이콘이 다시 정상적으로 표시됩니다. (#1538)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.94.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.94.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-Setup-0.94.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.94.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **複数アカウントの使用枠。** DeepSeek、Kimi、Z.ai、Qoder など、25 を超える組み込みプロバイダーで複数のアカウントを保存し、使用枠を個別に追跡できます。プロバイダー設定で追加、名前や順序の変更、一時停止、認証情報の差し替えができます。 （#1520, #1532）
- **端末をまたいだ使用枠アカウント。** 他の端末のアカウントと端末ごとの状態を同じ一覧で確認できます。対応する Sync Hub は使用枠をアカウントごとに区別し、名前と表示順を同期します。 （#1512, #1532）
- **Alibaba Token Plan。** この端末でログイン済みの Bailian CLI から、個人プランとチームプランの使用枠を取得できます。 （#1509）
- **ホームのアクティビティ推移。** グラフにカーソルを合わせるかキーボードで日付を選ぶと、その日のトークン数と取得できた費用が表示されます。アクティビティ設定の「トレンドのトークン表示」で「短縮」と「正確」を切り替えられます。 （#1540, #1547）
- **Codex セッションのタイトル。** 追加のスキャン先から収集したセッションにもタイトルを表示します。 （#1473）

### 改善
- **「収集」の設定。** 新しい一覧では追跡中のツールとスイッチを上に表示し、未追跡のツールは折りたたんで表示します。 （#1548）
- **「AIツール制限」の設定。** 新しい一覧では無効なプロバイダーを折りたたんで表示します。行を展開するとアカウントを管理し、取得元と取得状況を確認できます。 （#1532, #1548, #1561, #1565）
- **セッションのコンテキスト使用量。** ホーム、セッション、Edge Dock、Notch の幅が狭い行でも、メーターとパーセント表示が揃います。 （#1553）

### 修正
- **同期した使用量の合計。** 同期済みツールの追跡を解除したときに、累計トークン数と費用が二重に計上される問題を修正しました。 （#1545）
- **DeepSeek と Factory の使用枠。** 同じ Hub に同期する端末が異なるアカウントを使用している場合、アカウントごとに表示します。 （#1518）
- **リアルタイム使用量の収集。** SQLite の読み取りや無関係なファイルの変更によってスキャンが繰り返される問題を修正しました。 （#1515, #1517）
- **使用枠の履歴。** バックグラウンドで更新されても、選択したアカウントを維持します。 （#1542）
- **Linux X11。** ウィンドウのタイトルバーを右クリックしたあと、ポインターが動かなくなる問題を修正しました。 （#1541）
- **Notch。** 横にスワイプしている間も、実行中のセッションカードの角が丸く表示されます。 （#1543）
- **macOS デスクトップウィジェット。** Gemini のモデルアイコンが再び表示されます。 （#1538）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.94.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.94.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-Setup-0.94.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.94.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.94.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.94.0/Token-Monitor-0.94.0.AppImage)

</details>

</details>
