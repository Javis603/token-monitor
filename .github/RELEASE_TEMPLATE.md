# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Qoder international usage:** Tracks the international Qoder edition alongside Qoder CN. Both appear in one Qoder row, with an option to show the versions separately. (#1464)
- **Saved Hubs:** Saves several Hubs, each with its own name, URL, secret and Device ID, and switches between them from the sync status card without retyping. (#1496)
- **Mica backdrops:** Windows Glass Style adds Mica and Mica Alt for the widget and quota history windows on Windows 11 22H2 or later. Older Windows builds keep using Acrylic. (#1497, #1500)

### Changed
- **Qoder CN usage:** Usage that exists only in the legacy local database is no longer counted. Project transcripts remain the source. (#1464)

### Improved
- **Limits diagnostics:** The diagnostics report names the stage and cause of a quota failure, such as a timeout, a challenge page or an HTTP error. (#1492)

### Fixed
- **Windows main window:** Reopening the window no longer flashes an empty backdrop or an opaque grey Acrylic background. (#1488)
- **Hub connection:** A Hub that showed Connected while usage and quota stopped updating, for example after a Worker redeploy, now recovers on its own. (#1486)
- **Multi-device quota history:** Accounts watched from several devices no longer show a broken trend line or usage that is “Not allocated to time buckets”. (#1490)
- **Qoder quota history:** History stays on one timeline when the Qoder cookie refreshes or the account signs in again. (#1474)
- **OMP totals:** Month and all-time totals no longer double-count OMP forks recorded before the Pi and OMP split. (#1493)
- **Project ranking:** Projects are ranked by token usage instead of cost, matching the totals and bars shown. (#1501)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.93.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-Setup-0.93.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.93.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.AppImage)

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
- **Qoder 国际版用量：** 支持追踪 Qoder 国际版，与 Qoder CN 合并显示为一个 Qoder 行，也可选择分开显示版本。 （#1464）
- **多个 Hub：** 可保存多个 Hub，各自拥有名称、URL、密钥和设备 ID，并在同步状态卡片中一键切换，无需重新输入。 （#1496）
- **Mica 背景：** Windows 玻璃样式新增 Mica 与 Mica Alt，适用于小组件和额度历史窗口，需要 Windows 11 22H2 或更高版本；较旧的 Windows 继续使用 Acrylic。 （#1497、#1500）

### 变更
- **Qoder CN 用量：** 仅存在于旧版本地数据库中的用量不再计入，项目会话记录仍是统计来源。 （#1464）

### 改进
- **额度诊断：** 诊断报告会指出额度失败所处的阶段和原因，例如超时、验证页面或 HTTP 错误。 （#1492）

### 修复
- **Windows 主窗口：** 重新打开窗口时，不再闪现空白背景或不透明的灰色 Acrylic 背景。 （#1488）
- **Hub 连接：** Hub 显示“已连接”但用量和额度停止更新的问题（例如 Worker 重新部署之后）现在会自动恢复。 （#1486）
- **多设备额度历史：** 从多台设备监看同一账号时，不再出现中断的趋势线或“未能分配至时段”的用量。 （#1490）
- **Qoder 额度历史：** Qoder Cookie 刷新或账号重新登录后，历史仍保持在同一条时间线上。 （#1474）
- **OMP 合计：** 本月与总计用量不再重复计算在 Pi 与 OMP 拆分之前记录的 OMP 分支会话。 （#1493）
- **项目排序：** 项目改为按 Token 用量排序而非费用，与显示的合计和条形图一致。 （#1501）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.93.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-Setup-0.93.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.93.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.92.0...v0.93.0">v0.92.0...v0.93.0</a></summary>

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
- **Qoder 國際版用量：** 支援追蹤 Qoder 國際版，與 Qoder CN 合併顯示為單一 Qoder 列，也可選擇分開顯示版本。 （#1464）
- **多個 Hub：** 可儲存多個 Hub，各自擁有名稱、URL、金鑰與裝置 ID，並在同步狀態卡片中一鍵切換，無需重新輸入。 （#1496）
- **Mica 背景：** Windows 玻璃樣式新增 Mica 與 Mica Alt，適用於小工具與額度歷史視窗，需要 Windows 11 22H2 或更新版本；較舊的 Windows 繼續使用 Acrylic。 （#1497、#1500）

### 變更
- **Qoder CN 用量：** 僅存在於舊版本機資料庫中的用量不再計入，專案對話紀錄仍是統計來源。 （#1464）

### 改進
- **額度診斷：** 診斷報告會指出額度失敗所處的階段與原因，例如逾時、驗證頁面或 HTTP 錯誤。 （#1492）

### 修復
- **Windows 主視窗：** 重新開啟視窗時，不再閃現空白背景或不透明的灰色 Acrylic 背景。 （#1488）
- **Hub 連線：** Hub 顯示「已連線」但用量與額度停止更新的問題（例如 Worker 重新部署之後）現在會自動恢復。 （#1486）
- **多裝置額度歷史：** 從多台裝置監看同一帳號時，不再出現中斷的趨勢線或「未能分配至時段」的用量。 （#1490）
- **Qoder 額度歷史：** Qoder Cookie 更新或帳號重新登入後，歷史仍維持在同一條時間線上。 （#1474）
- **OMP 合計：** 本月與總計用量不再重複計算在 Pi 與 OMP 拆分之前記錄的 OMP 分支工作階段。 （#1493）
- **專案排序：** 專案改為依 Token 用量排序而非費用，與顯示的合計和長條圖一致。 （#1501）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.93.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-Setup-0.93.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.93.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Qoder 국제 버전 사용량:** Qoder 국제 버전을 Qoder CN과 함께 추적합니다. 두 버전은 하나의 Qoder 행으로 표시되며, 버전별로 나누어 표시할 수도 있습니다. (#1464)
- **여러 Hub 저장:** 이름, URL, 시크릿, 기기 ID가 각각 있는 Hub를 여러 개 저장하고, 동기화 상태 카드에서 다시 입력하지 않고 바로 전환할 수 있습니다. (#1496)
- **Mica 배경:** Windows 글래스 스타일에 Mica와 Mica Alt가 추가되어 위젯과 한도 기록 창에 적용할 수 있습니다. Windows 11 22H2 이상이 필요하며, 이전 Windows에서는 계속 Acrylic을 사용합니다. (#1497, #1500)

### 변경
- **Qoder CN 사용량:** 예전 로컬 데이터베이스에만 있는 사용량은 더 이상 집계되지 않으며, 프로젝트 대화 기록이 집계 기준으로 유지됩니다. (#1464)

### 개선
- **한도 진단:** 진단 보고서가 시간 초과, 인증 확인 페이지, HTTP 오류 등 할당량 조회 실패의 단계와 원인을 알려 줍니다. (#1492)

### 수정
- **Windows 메인 창:** 창을 다시 열 때 빈 배경이 깜빡이거나 Acrylic 배경이 불투명한 회색으로 보이던 문제를 수정했습니다. (#1488)
- **Hub 연결:** Hub가 연결됨으로 표시되는데 사용량과 한도가 갱신되지 않던 문제(예: Worker 재배포 이후)가 이제 자동으로 복구됩니다. (#1486)
- **여러 기기의 한도 기록:** 여러 기기에서 같은 계정을 볼 때 추세선이 끊기거나 “시간 구간에 배분되지 않은 양”이 나타나던 문제를 수정했습니다. (#1490)
- **Qoder 한도 기록:** Qoder 쿠키가 갱신되거나 계정에 다시 로그인해도 기록이 하나의 타임라인으로 유지됩니다. (#1474)
- **OMP 합계:** Pi와 OMP가 분리되기 전에 기록된 OMP 포크가 이번 달과 전체 합계에 중복 집계되던 문제를 수정했습니다. (#1493)
- **프로젝트 정렬:** 프로젝트를 비용이 아닌 토큰 사용량 순으로 정렬해, 표시되는 합계와 막대와 일치합니다. (#1501)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.93.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-Setup-0.93.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.93.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Qoder国際版の使用量:** Qoder国際版をQoder CNと並べて追跡します。両方が1つのQoder行に表示され、バージョン別に分けて表示することもできます。 (#1464)
- **複数Hubの保存:** 名前、URL、シークレット、デバイスIDを持つHubを複数保存し、同期ステータスカードから入力し直さずに切り替えられます。 (#1496)
- **Mica背景:** WindowsガラススタイルにMicaとMica Altを追加しました。ウィジェットと上限履歴のウィンドウで使え、Windows 11 22H2以降が必要です。それより前のWindowsでは引き続きAcrylicを使用します。 (#1497, #1500)

### 変更
- **Qoder CNの使用量:** 旧ローカルデータベースにしかない使用量は集計されなくなりました。集計元はプロジェクトの会話記録です。 (#1464)

### 改善
- **上限の診断:** 診断レポートに、タイムアウト、確認ページ、HTTPエラーなど、上限取得の失敗が起きた段階と原因が表示されます。 (#1492)

### 修正
- **Windowsのメインウィンドウ:** ウィンドウを開き直したときに、空の背景が一瞬表示されたり、Acrylic背景が不透明なグレーになったりする問題を修正しました。 (#1488)
- **Hub接続:** Hubが接続済みと表示されているのに使用量と上限が更新されなくなる問題（Workerの再デプロイ後など）から、自動で回復するようになりました。 (#1486)
- **複数端末の上限履歴:** 複数の端末から同じアカウントを監視しても、推移の線が途切れたり、「時間帯に配分できない変化」が表示されたりしなくなりました。 (#1490)
- **Qoderの上限履歴:** QoderのCookieが更新されたりアカウントに再ログインしたりしても、履歴が1本のタイムラインにまとまったままになります。 (#1474)
- **OMPの合計:** PiとOMPの分離前に記録されたOMPのフォークが、今月と合計で二重に集計される問題を修正しました。 (#1493)
- **プロジェクトの並び順:** プロジェクトをコストではなくトークン使用量の順に並べ、表示される合計やバーと一致するようにしました。 (#1501)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.93.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-Setup-0.93.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.93.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.93.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.0/Token-Monitor-0.93.0.AppImage)

</details>

</details>
