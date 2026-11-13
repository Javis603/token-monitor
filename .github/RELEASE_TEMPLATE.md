# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Copilot accounts:** Supports multiple GitHub Copilot accounts, each with its own quota reading and enable, refresh and remove actions. (#1478)
- **Plugin auto-updates:** Featured plugins update to stable releases automatically, with a global switch and a per-plugin switch. Plugins from other sources are not updated automatically. (#1459)
- **Quota refresh:** Quota rows in the Limits view and on the Edge Dock card have a refresh button and show a spinner while refreshing. Where a provider supports it, the button refreshes only that account. (#1456)
- **DeepSeek fees:** An optional console token adds this month's Search and Fetch fees to the Spend tooltip. (#1442)

### Improved
- **Plugin updates:** Featured plugins update in one step from the installed list, while plugins from other sources go to a single “Trust and update” review. Release notes show inside the card, and those other sources are labeled “Third-party”. (#1459)
- **Startup usage:** In local mode, the last-known Today, Month and Total, quota rows and archived History appear right at launch instead of zeros and “No usage history yet” while the first scan runs. (#1469, #1475)
- **Live refresh:** Usage refreshes no longer interrupt keyboard focus, open tooltips or scroll position. (#1468)
- **Cursor usage:** Fresh totals appear sooner after a restart when Cursor data has not changed. (#1470)

### Fixed
- **Large histories:** Collection no longer aborts when the All time scan takes longer than two minutes. That scan now has a five-minute limit. (#1479)
- **Hub live updates:** An idle device on a slow connection no longer downloads the full stats snapshot over and over. Self-hosted Workers get the fix after redeploying. (#1483)
- **macOS Dashboard:** Turning the glass backdrop back on or changing its material no longer leaves the Dashboard opaque. (#1460)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.92.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.92.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-Setup-0.92.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.92.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.AppImage)

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
- **Copilot 账号：** 支持多个 GitHub Copilot 账号，每个账号单独显示额度，并可分别启用、刷新和移除。 （#1478）
- **插件自动更新：** 精选插件可自动更新到稳定版，提供全局开关和单个插件开关；其他来源的插件不会自动更新。 （#1459）
- **额度刷新：** 额度页面和侧边栏卡片中的额度行新增刷新按钮，刷新期间会显示转圈。服务商支持时，只刷新该行所属账号。 （#1456）
- **DeepSeek 费用：** 可选的控制台令牌可将本月 Search 与 Fetch 费用加入 Spend 提示。 （#1442）

### 改进
- **插件更新：** 精选插件可在已安装列表中一步更新，其他来源的插件直接进入一次“信任并更新”审核。更新说明显示在卡片内，这些来源标为“第三方”。 （#1459）
- **启动用量：** 本机模式下，启动后立即显示上次的今日、本月与总计用量、额度行及已归档的历史，首次扫描期间不再显示 0 与“暂无使用历史”。 （#1469、#1475）
- **实时刷新：** 用量刷新时不再打断键盘焦点、已打开的提示和滚动位置。 （#1468）
- **Cursor 用量：** Cursor 数据未变化时，重启后更快获得最新合计。 （#1470）

### 修复
- **大型历史：** “全部时间”扫描超过两分钟时，不再中止采集；该扫描现有五分钟上限。 （#1479）
- **Hub 实时更新：** 空闲设备在网络较慢时，不再反复下载完整统计快照。自托管 Worker 重新部署后生效。 （#1483）
- **macOS 仪表板：** 重新开启玻璃背景或更换其材质后，仪表板不再保持不透明。 （#1460）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.92.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.92.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-Setup-0.92.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.92.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.91.0...v0.92.0">v0.91.0...v0.92.0</a></summary>

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
- **Copilot 帳號：** 支援多個 GitHub Copilot 帳號，每個帳號各自顯示額度，並可分別啟用、重新整理與移除。 （#1478）
- **外掛自動更新：** 精選外掛可自動更新至穩定版，提供全域開關與單一外掛開關；其他來源的外掛不會自動更新。 （#1459）
- **額度重新整理：** 額度頁面與側邊欄卡片中的額度列新增重新整理按鈕，更新期間會顯示轉圈。供應商支援時，只更新該列所屬帳號。 （#1456）
- **DeepSeek 費用：** 選填的控制台權杖可將本月 Search 與 Fetch 費用加入 Spend 提示。 （#1442）

### 改進
- **外掛更新：** 精選外掛可在已安裝清單中一步更新，其他來源的外掛直接進入一次「信任並更新」審核。更新說明顯示在卡片內，這些來源標示為「第三方」。 （#1459）
- **啟動用量：** 本機模式下，啟動後立即顯示上次的今日、本月與總計用量、額度列及已封存的歷史，首次掃描期間不再顯示 0 與「尚無使用歷史」。 （#1469、#1475）
- **即時重新整理：** 用量重新整理時不再打斷鍵盤焦點、已開啟的提示與捲動位置。 （#1468）
- **Cursor 用量：** Cursor 資料未變動時，重啟後更快取得最新合計。 （#1470）

### 修復
- **大型歷史：** 「全部時間」掃描超過兩分鐘時，不再中止收集；該掃描現有五分鐘上限。 （#1479）
- **Hub 即時更新：** 閒置裝置在連線緩慢時，不再反覆下載完整統計快照。自架 Worker 重新部署後生效。 （#1483）
- **macOS 儀表板：** 重新開啟玻璃背景或更換其材質後，儀表板不再維持不透明。 （#1460）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.92.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.92.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-Setup-0.92.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.92.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Copilot 계정:** 여러 GitHub Copilot 계정을 지원합니다. 계정마다 할당량을 따로 표시하며 활성화, 새로 고침, 제거를 개별로 할 수 있습니다. (#1478)
- **플러그인 자동 업데이트:** 추천 플러그인이 안정 버전으로 자동 업데이트되며, 전체 스위치와 플러그인별 스위치를 제공합니다. 다른 출처의 플러그인은 자동 업데이트되지 않습니다. (#1459)
- **한도 새로 고침:** 한도 보기와 Edge Dock 카드의 한도 행에 새로 고침 버튼이 생겼고, 새로 고치는 동안 회전 표시가 나타납니다. 지원하는 제공업체에서는 해당 계정만 갱신합니다. (#1456)
- **DeepSeek 비용:** 선택 사항인 콘솔 토큰으로 이번 달 Search 및 Fetch 비용을 Spend 툴팁에 추가할 수 있습니다. (#1442)

### 개선
- **플러그인 업데이트:** 추천 플러그인은 설치 목록에서 한 번에 업데이트하고, 다른 출처의 플러그인은 한 번의 “신뢰하고 업데이트” 검토로 진행합니다. 릴리스 노트가 카드 안에 표시되며 해당 출처는 “서드파티”로 표시됩니다. (#1459)
- **시작 시 사용량:** 로컬 모드에서 첫 스캔이 진행되는 동안에도 0과 “아직 사용 기록이 없습니다” 대신, 마지막으로 확인한 오늘·이번 달·전체 사용량, 한도 행, 보관된 기록이 실행 직후 표시됩니다. (#1469, #1475)
- **실시간 새로 고침:** 사용량을 새로 고쳐도 키보드 포커스, 열려 있는 툴팁, 스크롤 위치가 끊기지 않습니다. (#1468)
- **Cursor 사용량:** Cursor 데이터가 바뀌지 않았다면 재시작 후 최신 합계를 더 빨리 확인할 수 있습니다. (#1470)

### 수정
- **대용량 기록:** 전체 기간 스캔이 2분을 넘겨도 수집이 중단되지 않습니다. 이 스캔의 제한 시간은 5분입니다. (#1479)
- **Hub 실시간 업데이트:** 느린 연결의 유휴 기기가 전체 통계 스냅샷을 계속 반복해서 내려받던 문제를 수정했습니다. 자체 호스팅 Worker는 다시 배포하면 적용됩니다. (#1483)
- **macOS 대시보드:** 글래스 배경을 다시 켜거나 재질을 바꾼 뒤에도 대시보드가 불투명하게 남던 문제를 수정했습니다. (#1460)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.92.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.92.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-Setup-0.92.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.92.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Copilotアカウント:** 複数のGitHub Copilotアカウントに対応しました。アカウントごとに使用量上限を表示し、有効化、更新、削除を個別に行えます。 (#1478)
- **プラグインの自動更新:** おすすめプラグインが安定版へ自動更新されます。全体のスイッチとプラグインごとのスイッチがあります。他のソースのプラグインは自動更新されません。 (#1459)
- **上限の更新:** 制限ビューとエッジドックのカードの上限の行に更新ボタンを追加し、更新中は回転表示になります。対応するプロバイダーでは、そのアカウントだけを更新します。 (#1456)
- **DeepSeekの費用:** 任意のコンソールトークンで、今月のSearchとFetchの費用をSpendのツールチップに追加できます。 (#1442)

### 改善
- **プラグインの更新:** おすすめプラグインはインストール済み一覧から1ステップで更新でき、他のソースのプラグインは1回の「信頼して更新」確認に進みます。リリースノートがカード内に表示され、それらのソースは「サードパーティ」と表示されます。 (#1459)
- **起動時の使用量:** ローカルモードで、最初のスキャン中も0や「まだ使用履歴がありません」の代わりに、前回の今日・今月・合計の使用量、上限の行、保存済みの履歴が起動直後に表示されます。 (#1469, #1475)
- **ライブ更新:** 使用量の更新で、キーボードフォーカス、開いているツールチップ、スクロール位置が途切れなくなりました。 (#1468)
- **Cursorの使用量:** Cursorのデータが変わっていなければ、再起動後に最新の合計をより早く取得できます。 (#1470)

### 修正
- **大規模な履歴:** 全期間のスキャンが2分を超えても収集が中断されなくなりました。このスキャンの制限時間は5分です。 (#1479)
- **Hubのライブ更新:** 低速な接続のアイドル端末が、完全な統計スナップショットを繰り返しダウンロードし続ける問題を修正しました。セルフホストのWorkerは再デプロイすると反映されます。 (#1483)
- **macOSのダッシュボード:** ガラス背景を再びオンにした後や素材を変更した後も、ダッシュボードが不透明のままになる問題を修正しました。 (#1460)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.92.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.92.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-Setup-0.92.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.92.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.92.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.92.0/Token-Monitor-0.92.0.AppImage)

</details>

</details>
