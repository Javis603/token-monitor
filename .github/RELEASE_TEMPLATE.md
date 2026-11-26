# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Usage range buttons.** Choose and reorder three to six ranges for direct access at the top of the widget. (#1668)
- **Yesterday and range details.** Select Yesterday to view the previous day's usage. Yesterday, This week, Last 7 days and Last 30 days can show session and project details from scans. (#1655, #1659)
- **Cross-device range details.** Hub and iCloud sync can show scanned totals and session and project details for those four ranges. Synced weeks begin on Monday in each device's time zone. When a matching scan is missing, History can supply totals. (#1667)
- **Antigravity usage in T3 Code.** Automatically find and count Antigravity ACP sessions when Antigravity tracking is enabled. (#1658)

### Changed
- **Home limits layout.** The new Default layout gives each visible limit window its own row with a reading and reset countdown. Upgrading switches existing layouts to Default once. Text and Progress bars are still selectable. (#1466)
- **Home colours.** Usage breakdowns use a neutral palette by default. Turn on Vendor colours on Home to bring back provider colours. (#1466)
- **Home session display.** Recent sessions use one line each in Compact. Choose Detailed to see model and activity information for every session. (#1644)

### Improved
- **Archived session usage.** This week, Last 7 days and Last 30 days can include previously recorded usage after a session's source files are deleted. (#1660)
- **Usage refresh.** Full refreshes scan faster, and live Codex updates use less memory. (#1651, #1665)
- **Live watching on Windows and Linux.** Usage updates can pick up file size changes while the file is still open. (#1444)
- **Remote sessions.** Home, Edge Dock and Notch Panel show the device for sessions confirmed to come from another device. (#1654)
- **Untitled sessions.** With session titles enabled, the Sessions list uses the project name for an untitled standalone session when available. (#1678)

### Fixed
- **Dashboard backdrop on Windows.** Dashboard follows the widget's selected material. Turning off Glass Backdrop makes it transparent. (#1642)
- **Accent Blur on Windows 10.** Remove tinted patches at the corners of the widget when Accent Blur is active. (#1669)
- **Account reordering.** Third-party API accounts stay in the chosen order, and paused accounts keep their names after a drag. (#1645)
- **WSL usage.** Detect running distributions and collect their usage when WSL returns its distribution list in UTF-8. (#1666)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.98.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.98.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-Setup-0.98.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.98.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.AppImage)

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

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → General → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **统计范围按钮。** 可选择 3 至 6 个范围并调整顺序，直接在小组件顶部切换。 （#1668）
- **昨天与范围明细。** 可选择“昨天”查看前一天的用量。“昨天”、“本周”、“最近 7 天”和“最近 30 天”可显示扫描所得的会话和项目明细。 （#1655，#1659）
- **跨设备用量明细。** 通过 Hub 或 iCloud 同步时，上述四个范围可显示扫描所得的总量、会话和项目明细。同步时按各设备的时区从周一开始计算本周。缺少对应的扫描结果时，可由历史记录提供总量。 （#1667）
- **T3 Code 中的 Antigravity 用量。** 启用 Antigravity 跟踪后，自动发现 ACP 会话并统计用量。 （#1658）

### 变更
- **主页额度布局。** 新的“默认”布局逐行显示各个可见的额度周期、当前数值和重置倒计时。升级时会切换到“默认”一次，之后仍可选择“文字”或“进度条”。 （#1466）
- **主页配色。** 用量分布默认采用中性色，可开启“主页使用厂商颜色”恢复原有的配色。 （#1466）
- **主页会话显示。** “精简”模式下，最近会话各占一行。选择“详细”可查看每个会话的模型和活动信息。 （#1644）

### 改进
- **归档会话用量。** 删除会话源文件后，“本周”、“最近 7 天”和“最近 30 天”仍可计入已记录的用量。 （#1660）
- **用量刷新。** 全量刷新扫描更快，Codex 实时更新占用的内存更少。 （#1651，#1665）
- **Windows 和 Linux 实时监测。** 文件仍处于打开状态时，也可检测其大小变化并更新用量。 （#1444）
- **远程会话。** 对于已确认来自其他设备的会话，主界面、侧边栏和刘海面板会显示来源设备。 （#1654）
- **无标题会话。** 开启会话标题显示后，没有标题的独立会话会在列表中显示项目名称（如有）。 （#1678）

### 修复
- **Windows 仪表盘背景。** 仪表盘跟随小组件所选的背景材质。关闭“玻璃背景”时，仪表盘背景会变为透明。 （#1642）
- **Windows 10 模糊效果。** 修复启用 Accent Blur 时小组件四角出现色块的问题。 （#1669）
- **账号排序。** 第三方 API 账号可正确保留拖动后的顺序，暂停的账号也会保留名称。 （#1645）
- **WSL 用量。** WSL 以 UTF-8 返回发行版列表时，也能识别正在运行的发行版并收集用量。 （#1666）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.98.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.98.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-Setup-0.98.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.98.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.AppImage)

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

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 常规 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.97.0...v0.98.0">v0.97.0...v0.98.0</a></summary>

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
- **統計範圍按鈕。** 可選擇 3 至 6 個範圍並調整順序，直接在小工具頂端切換。 （#1668）
- **昨日與範圍明細。** 可選擇「昨日」查看前一天的用量。「昨日」、「本星期」、「最近 7 日」及「最近 30 日」可顯示掃描取得的會話與專案明細。 （#1655、#1659）
- **跨裝置用量明細。** 透過 Hub 或 iCloud 同步時，上述四個範圍可顯示各裝置掃描取得的總量、會話與專案明細。同步時依各裝置的時區從週一開始計算本星期。缺少相符的掃描資料時，可由歷史記錄提供總量。 （#1667）
- **T3 Code 的 Antigravity 用量。** 啟用 Antigravity 追蹤後，會自動發現 ACP 會話並統計用量。 （#1658）

### 變更
- **主頁額度版面。** 新的「預設」版面逐列顯示各個可見的額度週期、目前數值與重設倒數。升級時會切換到「預設」一次，之後仍可選擇「文字」或「進度條」。 （#1466）
- **主頁配色。** 用量分布預設採用中性色。開啟「主頁使用廠商顏色」即可恢復原有配色。 （#1466）
- **主頁會話顯示。** 「精簡」模式下，最近的會話各佔一行。選擇「詳細」即可查看每個會話的模型與活動資訊。 （#1644）

### 改進
- **已封存的會話用量。** 刪除會話來源檔案後，「本星期」、「最近 7 日」及「最近 30 日」仍可計入先前記錄的用量。 （#1660）
- **用量更新。** 完整掃描所需時間縮短，Codex 即時更新亦減少記憶體用量。 （#1651、#1665）
- **Windows 與 Linux 即時監測。** 檔案仍開啟時，也可偵測大小變化並更新用量。 （#1444）
- **遠端會話。** 主畫面、側邊欄與瀏海面板會標示已確認來自其他裝置的會話來源。 （#1654）
- **未命名會話。** 開啟會話標題顯示後，未命名的獨立會話若有專案名稱，列表會顯示該名稱。 （#1678）

### 修復
- **Windows 儀表板背景。** 儀表板會跟隨小工具所選的背景材質。關閉「玻璃背景」時，背景會切換為透明。 （#1642）
- **Windows 10 模糊效果。** 修復開啟 Accent Blur 時小工具四角出現色塊的問題。 （#1669）
- **帳戶排序。** 第三方 API 帳戶會正確保留拖曳後的順序，已暫停的帳戶也會保留名稱。 （#1645）
- **WSL 用量。** WSL 以 UTF-8 傳回發行版清單時，也能辨識執行中的發行版並收集用量。 （#1666）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.98.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.98.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-Setup-0.98.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.98.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **통계 범위 버튼.** 위젯 상단에 표시할 범위를 3~6개 선택하고 원하는 순서로 배치할 수 있습니다. (#1668)
- **어제 사용량과 범위별 상세 내역.** ‘어제’를 선택해 전날 사용량을 볼 수 있습니다. ‘어제’, ‘이번 주’, ‘최근 7일’, ‘최근 30일’에서 수집된 세션과 프로젝트 내역을 확인할 수 있습니다. (#1655, #1659)
- **기기 간 사용량 상세 내역.** Hub 또는 iCloud로 동기화하면 위 네 범위의 사용량 합계와 세션·프로젝트 내역을 볼 수 있습니다. 동기화 시 이번 주는 각 기기의 시간대를 기준으로 월요일부터 계산합니다. 해당 범위의 수집 데이터가 없으면 기록에서 합계를 표시할 수 있습니다. (#1667)
- **T3 Code의 Antigravity 사용량.** Antigravity 추적을 켜면 ACP 세션을 자동으로 찾아 사용량을 집계합니다. (#1658)

### 변경
- **홈의 한도 레이아웃.** 새 ‘기본값’ 레이아웃은 표시 대상인 한도를 각각 한 줄에 배치하고 수치와 초기화까지 남은 시간을 보여 줍니다. 업데이트하면 한 번 ‘기본값’으로 바뀌며, 이후 ‘텍스트’나 ‘진행 막대’를 선택할 수 있습니다. (#1466)
- **홈 색상.** 사용량 분포에는 기본적으로 중립적인 색상을 사용합니다. ‘홈에서 제공업체 색상 사용’을 켜면 기존 색상으로 돌아갑니다. (#1466)
- **홈의 세션 표시.** ‘간결하게’에서는 최근 세션이 한 줄씩 표시됩니다. ‘자세히’를 선택하면 각 세션의 모델과 활동 정보를 볼 수 있습니다. (#1644)

### 개선
- **보관된 세션 사용량.** 세션의 원본 파일을 삭제한 뒤에도 ‘이번 주’, ‘최근 7일’, ‘최근 30일’에 이전에 기록한 사용량을 포함할 수 있습니다. (#1660)
- **사용량 갱신.** 전체 스캔이 빨라졌으며 Codex 실시간 업데이트에 필요한 메모리가 줄었습니다. (#1651, #1665)
- **Windows와 Linux의 실시간 감시.** 파일이 열린 상태에서 크기가 바뀌어도 변경을 감지해 사용량을 갱신할 수 있습니다. (#1444)
- **원격 세션.** 홈, 가장자리 도크, 노치에서 다른 기기의 세션으로 확인된 항목에 출처 기기를 표시합니다. (#1654)
- **제목 없는 세션.** 세션 제목 표시를 켜면 제목이 없는 단독 세션에 프로젝트 이름이 있을 때 목록에 해당 이름을 표시합니다. (#1678)

### 수정
- **Windows 대시보드 배경.** 위젯에서 선택한 배경 효과를 따르며, ‘글래스 배경’을 끄면 투명해집니다. (#1642)
- **Windows 10 흐림 효과.** Accent Blur를 켰을 때 위젯 모서리에 색이 비치던 문제를 수정했습니다. (#1669)
- **계정 순서.** 드래그해 바꾼 타사 API 계정의 순서를 저장하고, 일시 중지된 계정의 이름을 유지합니다. (#1645)
- **WSL 사용량.** 배포판 목록이 UTF-8로 반환될 때도 실행 중인 배포판을 찾아 사용량을 수집합니다. (#1666)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.98.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.98.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-Setup-0.98.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.98.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **集計範囲ボタン。** ウィジェット上部に表示する範囲を3〜6個選び、好きな順に並べられます。 （#1668）
- **昨日の使用量と範囲別の内訳。** 「昨日」を選んで前日の使用量を確認できます。「昨日」「今週」「過去7日間」「過去30日間」では、スキャンで取得したセッションとプロジェクトの内訳を表示できます。 （#1655、#1659）
- **端末間の使用量の内訳。** Hub または iCloud で同期すると、上記4つの範囲でスキャン済みの合計とセッション・プロジェクトの内訳を確認できます。同期時の「今週」は各端末のタイムゾーンで月曜始まりです。該当範囲のスキャン結果がない場合は、履歴から合計を表示できます。 （#1667）
- **T3 Code の Antigravity 使用量。** Antigravity の追跡を有効にすると、ACP セッションを自動で見つけて使用量を集計します。 （#1658）

### 変更
- **ホームの上限表示。** 新しい「デフォルト」では、表示対象の上限ごとに数値とリセットまでの時間を1行にまとめます。更新時に一度だけ「デフォルト」に切り替わり、その後は「テキスト」や「プログレスバー」も選べます。 （#1466）
- **ホームの配色。** 使用量の内訳は標準で落ち着いた配色になります。「ホームでプロバイダーの色を使う」をオンにすると従来の配色に戻せます。 （#1466）
- **ホームのセッション表示。** 「コンパクト」では最近のセッションを1行ずつ表示します。「詳細」を選ぶと、各セッションのモデルやアクティビティを確認できます。 （#1644）

### 改善
- **アーカイブ済みセッションの使用量。** 元のファイルを削除した後も、「今週」「過去7日間」「過去30日間」に記録済みの使用量を含められます。 （#1660）
- **使用量の更新。** 全体のスキャンが速くなり、Codex のリアルタイム更新に必要なメモリが減りました。 （#1651、#1665）
- **Windows と Linux のリアルタイム監視。** ファイルを開いたままサイズが変わった場合も、変更を検出して使用量を更新できます。 （#1444）
- **リモートセッション。** ホーム、エッジドック、ノッチで、別の端末のセッションと確認できた項目に端末を表示します。 （#1654）
- **タイトルのないセッション。** セッションタイトルの表示がオンの場合、タイトルのない単独セッションには、プロジェクト名があれば一覧に表示します。 （#1678）

### 修正
- **Windows のダッシュボード背景。** ウィジェットで選択した背景効果に連動し、「ガラス背景」をオフにすると透明になります。 （#1642）
- **Windows 10 のぼかし効果。** Accent Blur をオンにした際、ウィジェットの四隅に色がはみ出す問題を修正しました。 （#1669）
- **アカウントの並べ替え。** ドラッグで変更したサードパーティ API アカウントの順序が保存され、一時停止中のアカウント名も保持されます。 （#1645）
- **WSL の使用量。** ディストリビューションの一覧が UTF-8 で返る場合も、実行中のディストリビューションを検出して使用量を収集します。 （#1666）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.98.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.98.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-Setup-0.98.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.98.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.98.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.98.0/Token-Monitor-0.98.0.AppImage)

</details>

</details>
