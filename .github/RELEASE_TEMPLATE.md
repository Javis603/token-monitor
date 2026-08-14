# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Reasonix usage:** Track Reasonix alongside other tools, including local `Sessions` and `Projects` views for native session and project activity. Large Reasonix telemetry snapshots no longer block usage reads while valid cumulative usage stays visible. (#365, #384)
- **Usage ranges:** Clicking Home's `MONTH` tab opens a menu with `This week`, `Last 7 days`, and `Last 30 days`. After switching, `Tools`, `Models`, and `Devices` show token-component and cost details for the selected period; usage whose components cannot be reconstructed is grouped under `Unclassified`. (#393, #398)
- **Hub deployment status:** `Connect to a hub` now reports whether the remote `Hub`, `Node Hub`, or `Worker` is up to date, needs redeployment, was deployed by a newer version of Token Monitor, or has unrecognized build information. (#399)
- **Tray activity source:** Tray icons and `Tokens`/`Cost` items can now follow the `Most recently active tool`, while their values continue to use the selected period aggregates. (#397)

### Improved
- **Tray cost display:** Each tray cost item can use `Cost format` (`Compact` or `Full number`) and `Decimal places` (`Automatic` or 0–4). New cost items default to compact two-decimal display; existing layouts keep their previous full-number presentation. (#396)
- **Windows installer:** The installer now lets users choose the installation directory. (#390)

### Fixed
- **Codex limits:** Fresh plan metadata now overrides stale saved labels when available, and the standard 30-day window appears as `Monthly` instead of falling through to an incorrect long-window category. (#379)
- **Proma usage:** Assistant messages with incomplete IDs are still counted instead of disappearing from usage totals. (#392)
- **Kiro live updates:** Kiro session and CLI activity refresh live without large IDE data slowing live collection. (#381)
- **Tray composer:** Open picker menus stay attached to the active composer item during live updates, so an in-progress selection is not lost. (#395)
- **macOS compatibility:** The host app now supports macOS 12+, with matching minimum-version metadata in the update feed. (#394)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.44.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.44.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-Setup-0.44.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.44.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.AppImage)

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
- **Reasonix 用量：** Token Monitor 现在会像其他工具一样追踪 Reasonix，并提供本机的“会话”和“项目”视图，用于查看原生会话与项目活动。较大的 Reasonix 遥测快照不会阻塞用量读取，同时保留有效的累计用量。（#365、#384）
- **用量范围：** 在主页顶部点击 `MONTH` 标签，会打开期间菜单，可切换到“本周”“最近 7 天”和“最近 30 天”。切换后，可按所选期间查看“工具”、“模型”和“设备”的 Token 组成及成本明细；无法还原组成的用量会归入“未分类”。（#393、#398）
- **Hub 部署状态：** “连接到 Hub”现在会显示远程 `Hub`、`Node Hub` 或 `Worker` 是否已是最新版本、需要重新部署、由较新的 Token Monitor 版本部署，或部署版本无法识别。（#399）
- **托盘活动来源：** 托盘图标以及“今日 Tokens”/“今日成本”等项目现在可以跟随“最近有活动的工具”，显示数值仍使用所选期间的聚合数据。（#397）

### 改进
- **托盘费用显示：** 每个托盘费用项目都可通过“费用格式”选择“缩写”或“完整数字”，并通过“小数位数”选择“自动”或 0–4 位。新费用项目默认使用两位小数的缩写显示；现有布局保留之前的完整数字显示。（#396）
- **Windows 安装版：** 安装时现在可以选择安装目录。（#390）

### 修复
- **Codex 额度：** 有新计划数据时会优先使用最新数据，标准 30 天窗口会显示为 `Monthly`，不再落入错误的长期窗口分类。（#379）
- **Proma 用量：** ID 信息不完整的助手消息现在也会计入用量，不再从统计总量中消失。（#392）
- **Kiro 实时更新：** Kiro 的会话和 CLI 活动现在会实时刷新，不会因 IDE 的大型数据而拖慢实时采集。（#381）
- **托盘编辑器：** 实时更新期间，打开的选择菜单会继续附着在当前编辑项目上，不会丢失正在进行的选择。（#395）
- **macOS 兼容性：** 主应用现在支持 macOS 12 及以上版本，更新源也会携带匹配的最低版本要求。（#394）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.44.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.44.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-Setup-0.44.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.44.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.43.0...v0.44.0">v0.43.0...v0.44.0</a></summary>

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
- **Reasonix 用量：** Token Monitor 現在會像其他工具一樣追蹤 Reasonix，並提供本機的「會話」與「專案」檢視，用來查看原生會話與專案活動。較大的 Reasonix 遙測快照不會阻塞用量讀取，同時保留有效的累計用量。（#365、#384）
- **用量範圍：** 在主頁頂部點擊 `MONTH` 分頁，會開啟期間選單，可切換到「本星期」「最近 7 日」與「最近 30 日」。切換後，可按所選期間查看「工具」、「模型」與「裝置」的 Token 組成及成本明細；無法還原組成的用量會歸入「未分類」。（#393、#398）
- **Hub 部署狀態：** 「連接到 Hub」現在會顯示遠端 `Hub`、`Node Hub` 或 `Worker` 是否已是最新版本、需要重新部署、由較新的 Token Monitor 版本部署，或部署版本無法識別。（#399）
- **托盤活動來源：** 托盤圖示以及「今日 Tokens」/「今日成本」等項目現在可以跟隨「最近有活動的工具」，顯示數值仍使用所選期間的聚合資料。（#397）

### 改進
- **托盤成本顯示：** 每個托盤成本項目都可透過「成本格式」選擇「縮寫」或「完整數字」，並透過「小數位數」選擇「自動」或 0–4 位。新成本項目預設使用兩位小數的縮寫顯示；現有布局保留之前的完整數字顯示。（#396）
- **Windows 安裝程式：** 安裝時現在可以選擇安裝目錄。（#390）

### 修復
- **Codex 額度：** 有新計畫資料時會優先使用最新資料，標準 30 天視窗會顯示為 `Monthly`，不再落入錯誤的長期視窗分類。（#379）
- **Proma 用量：** ID 資訊不完整的助理訊息現在也會計入用量，不再從統計總量中消失。（#392）
- **Kiro 即時更新：** Kiro 的會話與 CLI 活動現在會即時刷新，不會因 IDE 的大型資料而拖慢即時採集。（#381）
- **托盤編輯器：** 即時更新期間，開啟的選單會繼續附著在目前編輯項目上，不會遺失正在進行的選擇。（#395）
- **macOS 相容性：** 主 App 現在支援 macOS 12 及以上版本，更新來源也會攜帶相符的最低版本要求。（#394）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.44.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.44.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-Setup-0.44.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.44.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Reasonix 사용량:** Token Monitor가 다른 도구와 함께 Reasonix 사용량을 추적하고, 네이티브 세션 및 프로젝트 활동을 확인할 수 있는 로컬 `세션` 및 `프로젝트` 보기를 제공합니다. 큰 Reasonix 텔레메트리 스냅샷도 사용량 읽기를 막지 않으면서 유효한 누적 사용량을 표시합니다. (#365, #384)
- **사용량 기간:** 홈 상단의 `MONTH` 탭을 클릭하면 기간 메뉴가 열리고 `이번 주`, `최근 7일`, `최근 30일`로 전환할 수 있습니다. 전환 후 선택한 기간의 토큰 구성과 비용 내역을 `도구`, `모델`, `기기`에서 확인할 수 있으며, 구성을 복원할 수 없는 사용량은 `미분류`로 집계됩니다. (#393, #398)
- **Hub 배포 상태:** `Hub에 연결`에서 원격 `Hub`, `Node Hub` 또는 `Worker`가 최신인지, 재배포가 필요한지, 더 최신 Token Monitor에서 배포되었는지, 빌드 정보를 인식할 수 없는지 보여줍니다. (#399)
- **트레이 활동 소스:** 트레이 아이콘과 `오늘 토큰`/`오늘 비용` 같은 항목이 이제 `최근 활동한 도구`를 따를 수 있으며, 표시 값은 선택한 기간 집계를 계속 사용합니다. (#397)

### 개선
- **트레이 비용 표시:** 각 트레이 비용 항목에서 `비용 형식`을 `축약` 또는 `전체 숫자`로, `소수 자릿수`를 `자동` 또는 0–4로 설정할 수 있습니다. 새 비용 항목은 소수 둘째 자리의 축약 표시를 기본값으로 사용하고 기존 레이아웃은 이전 전체 숫자 표시를 유지합니다. (#396)
- **Windows 설치 프로그램:** 설치 시 설치 디렉터리를 선택할 수 있습니다. (#390)

### 수정
- **Codex 한도:** 새 플랜 메타데이터가 있으면 저장된 오래된 레이블보다 우선하며, 표준 30일 창은 잘못된 장기 창 분류 대신 `Monthly`로 표시됩니다. (#379)
- **Proma 사용량:** ID 정보가 불완전한 어시스턴트 메시지도 사용량에 포함되어 통계에서 사라지지 않습니다. (#392)
- **Kiro 실시간 업데이트:** Kiro 세션과 CLI 활동은 실시간으로 갱신되며, IDE의 대용량 데이터가 실시간 수집을 느리게 하지 않습니다. (#381)
- **트레이 편집기:** 실시간 업데이트 중에도 열린 선택 메뉴가 현재 편집 항목에 유지되어 진행 중인 선택이 사라지지 않습니다. (#395)
- **macOS 호환성:** 호스트 앱은 이제 macOS 12 이상을 지원하며, 업데이트 피드에도 일치하는 최소 요구 사항이 포함됩니다. (#394)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.44.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.44.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-Setup-0.44.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.44.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Reasonix 使用量:** Token Monitorで他のツールと同様にReasonixの使用量を追跡し、ネイティブのセッションとプロジェクト活動を確認できるローカル「セッション」「プロジェクト」ビューを提供します。大きなReasonixテレメトリースナップショットも使用量の読み込みをブロックせず、有効な累計使用量を表示します。（#365、#384）
- **使用期間:** ホーム上部の`MONTH`タブをクリックすると期間メニューが開き、「今週」「過去7日間」「過去30日間」に切り替えられます。切り替え後は、選択した期間のトークン構成とコストの詳細を「ツール」「モデル」「デバイス」で確認できます。構成を復元できない使用量は「未分類」に集計されます。（#393、#398）
- **Hubデプロイ状態:** 「Hubに接続」で、リモートの`Hub`、`Node Hub`または`Worker`が最新か、再デプロイが必要か、より新しいToken Monitorでデプロイされたか、ビルド情報を認識できないかを表示します。（#399）
- **トレイのアクティブソース:** トレイアイコンと「今日のトークン」/「今日のコスト」などの項目で「最近使用したツール」に追従できるようになり、表示値は選択した期間の集計を引き続き使用します。（#397）

### 改善
- **トレイのコスト表示:** 各トレイのコスト項目で「コスト形式」を「省略」または「完全な数値」に、「小数点以下の桁数」を「自動」または0～4に設定できます。新しいコスト項目は小数第2位の省略表示が初期値で、既存のレイアウトは以前の完全な数値表示を維持します。（#396）
- **Windowsインストーラー:** インストール時にインストール先のディレクトリを選択できるようになりました。（#390）

### 修正
- **Codexの制限:** 新しいプランメタデータがある場合は保存済みの古いラベルより優先され、標準の30日ウィンドウは誤った長期ウィンドウ分類ではなく`Monthly`として表示されます。（#379）
- **Promaの使用量:** ID情報が不完全なアシスタントメッセージも使用量に含まれ、統計から消えなくなりました。（#392）
- **Kiroのリアルタイム更新:** KiroのセッションとCLIアクティビティはリアルタイムで更新され、IDEの大容量データがリアルタイム収集を遅くしません。（#381）
- **トレイエディター:** ライブ更新中も開いた選択メニューが現在の編集項目に保持され、進行中の選択が失われません。（#395）
- **macOS互換性:** ホストアプリはmacOS 12以降をサポートし、アップデートフィードにも一致する最低要件が含まれます。（#394）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.44.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.44.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-Setup-0.44.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.44.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.44.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.44.0/Token-Monitor-0.44.0.AppImage)

</details>

</details>
