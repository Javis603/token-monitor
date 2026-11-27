# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Antigravity turn status.** See when a turn starts and finishes in Antigravity Desktop and CLI. In T3 Code, active Antigravity ACP sessions can stay marked as running between token updates and appear before their first tokens are recorded. (#1689, #1693, #1695)
- **Kiro sessions in T3 Code.** Group related runs and delegated sessions under their T3 Code threads. (#1675)

### Changed
- **Local Codex Work settings.** The experimental Dots switches are now named “Collect local Codex Work usage” and “Show local Codex Work usage”. They apply to local Work tasks without a session log. (#1683)

### Improved
- **Antigravity session names and groups in T3 Code.** Show the T3 Code sidebar title when available, recover missing project names, and group related runs and delegated sessions. (#1679, #1675)
- **Idle memory.** Token Monitor releases unused memory sooner when none of its windows is focused. (#1688)

### Fixed
- **Local Codex Work usage.** Record eligible Work tasks started on the web and run on this computer when experimental local collection is enabled. (#1673)
- **Synced date ranges.** Keep Sessions and Projects visible while data refreshes for Yesterday, This week, Last 7 days, and Last 30 days. A device with confirmed zero usage no longer hides details from other devices. (#1685)
- **Large Hub uploads.** Preserve session details and the activity calendar for large usage histories when both the desktop app and Hub support the updated sync. (#1682)
- **Rapid relaunch on Windows.** Reuse the existing main window when Token Monitor is launched twice in quick succession, preventing overlapping windows and flicker. (#1676)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.99.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.99.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-Setup-0.99.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.99.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.AppImage)

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
- **Antigravity 回合状态。** 可查看 Antigravity 桌面版和 CLI 的回合开始与结束状态。T3 Code 中的 Antigravity ACP 会话可在产生首批 Tokens 前显示，两次用量更新之间仍能显示运行状态。 （#1689，#1693，#1695）
- **T3 Code 中的 Kiro 会话。** 同一会话的多次运行和委派会话可按 T3 Code 线程归组。 （#1675）

### 变更
- **本机 Codex Work 设置。** 实验性 Dots 开关改名为“收集本机 Codex Work 用量”和“显示本机 Codex Work 用量”，适用于没有会话记录的本机 Work 任务。 （#1683）

### 改进
- **T3 Code 中的 Antigravity 会话名称与分组。** 优先显示 T3 Code 侧边栏标题，补齐缺少的项目名称，并对同一会话的多次运行和委派会话进行归组。 （#1679，#1675）
- **空闲内存占用。** 应用窗口均未获得焦点时，更快释放闲置内存。 （#1688）

### 修复
- **本机 Codex Work 用量。** 开启实验性本机收集后，可记录从网页发起、在本机执行且符合条件的 Work 任务。 （#1673）
- **同步范围明细。** “昨天”、“本周”、“最近 7 天”和“最近 30 天”刷新时继续显示会话和项目。已确认没有用量的设备也不会隐藏其他设备的明细。 （#1685）
- **大批量 Hub 上传。** 桌面应用和 Hub 均支持新版同步时，可保留大量历史用量中的会话明细和活动日历。 （#1682）
- **Windows 连续启动。** 短时间内启动两次时复用主窗口，避免窗口重叠闪烁。 （#1676）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.99.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.99.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-Setup-0.99.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.99.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.98.0...v0.99.0">v0.98.0...v0.99.0</a></summary>

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
- **Antigravity 回合狀態。** 可查看 Antigravity 桌面版及 CLI 的回合開始與結束狀態。T3 Code 的 Antigravity ACP 會話可在首批 tokens 入帳前顯示，兩次用量更新之間仍會標示執行狀態。 （#1689、#1693、#1695）
- **T3 Code 的 Kiro 會話。** 同一會話的多次執行與委派會話可依 T3 Code 執行緒分組。 （#1675）

### 變更
- **本機 Codex Work 設定。** 實驗性的 Dots 開關改名為「收集本機 Codex Work 用量」及「顯示本機 Codex Work 用量」，適用於沒有會話記錄的本機 Work 任務。 （#1683）

### 改進
- **T3 Code 的 Antigravity 會話名稱與分組。** 優先顯示 T3 Code 側邊欄的標題，補上缺少的專案名稱，並將同一會話的多次執行與委派會話分組。 （#1679、#1675）
- **閒置時的記憶體用量。** 應用程式的視窗皆未取得焦點時，會更快釋放閒置記憶體。 （#1688）

### 修復
- **本機 Codex Work 用量。** 開啟實驗性本機收集後，可記錄從網頁發起、由本機執行且符合條件的 Work 任務。 （#1673）
- **同步範圍明細。** 「昨日」、「本星期」、「最近 7 日」及「最近 30 日」更新時，會話與專案明細會繼續顯示。確認沒有用量的裝置也不會隱藏其他裝置的明細。 （#1685）
- **大量 Hub 上傳。** 桌面應用程式與 Hub 皆支援新版同步時，可保留大量歷史用量中的會話明細與活動日曆。 （#1682）
- **Windows 連續啟動。** 短時間內啟動兩次時會沿用主視窗，避免視窗重疊閃爍。 （#1676）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.99.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.99.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-Setup-0.99.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.99.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Antigravity 턴 상태.** Antigravity 데스크톱과 CLI에서 턴의 시작과 종료를 확인할 수 있습니다. T3 Code의 Antigravity ACP 세션은 첫 토큰이 기록되기 전부터 표시되며, 사용량 갱신 사이에도 실행 상태를 확인할 수 있습니다. (#1689, #1693, #1695)
- **T3 Code의 Kiro 세션.** 관련 실행과 위임된 세션을 T3 Code 스레드별로 묶어 표시합니다. (#1675)

### 변경
- **로컬 Codex Work 설정.** 실험 기능인 Dots 설정의 이름이 ‘로컬 Codex Work 사용량 수집’과 ‘로컬 Codex Work 사용량 표시’로 바뀌었습니다. 세션 로그가 없는 로컬 Work 작업에 적용됩니다. (#1683)

### 개선
- **T3 Code의 Antigravity 세션 제목과 그룹.** T3 Code 사이드바 제목을 우선 표시하고, 누락된 프로젝트 이름을 채우며, 관련 실행과 위임된 세션을 함께 묶습니다. (#1679, #1675)
- **유휴 상태의 메모리 사용량.** 앱 창에 포커스가 없을 때 사용하지 않는 메모리를 더 빨리 반환합니다. (#1688)

### 수정
- **로컬 Codex Work 사용량.** 실험용 로컬 수집을 켜면 웹에서 시작해 이 컴퓨터에서 실행된 Work 작업 중 수집 조건을 충족하는 작업의 사용량이 기록됩니다. (#1673)
- **동기화된 날짜 범위.** ‘어제’, ‘이번 주’, ‘최근 7일’, ‘최근 30일’을 갱신하는 동안에도 세션과 프로젝트 내역이 계속 표시됩니다. 사용량이 없는 것으로 확인된 기기 때문에 다른 기기의 내역이 사라지는 문제도 수정했습니다. (#1685)
- **대용량 Hub 업로드.** 데스크톱 앱과 Hub가 모두 새 동기화를 지원하면 사용량 기록이 많아도 세션 내역과 활동 캘린더를 보존합니다. (#1682)
- **Windows에서 연속 실행.** 짧은 간격으로 두 번 실행해도 기존 기본 창을 사용하므로 창이 겹치거나 깜박이지 않습니다. (#1676)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.99.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.99.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-Setup-0.99.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.99.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Antigravity のターン状態。** デスクトップ版と CLI でターンの開始と終了を確認できます。T3 Code の Antigravity ACP セッションは最初のトークンが記録される前から表示され、使用量の更新を待たずに実行状態を確認できます。 （#1689、#1693、#1695）
- **T3 Code の Kiro セッション。** 関連する実行や委任先のセッションを T3 Code のスレッドごとにまとめて表示します。 （#1675）

### 変更
- **ローカルの Codex Work 設定。** 実験機能の Dots 設定を「ローカルの Codex Work 使用量を収集」「ローカルの Codex Work 使用量を表示」に変更しました。セッションログのないローカル Work タスクが対象です。 （#1683）

### 改善
- **T3 Code の Antigravity セッション名とグループ。** サイドバーのタイトルを優先して表示し、不足しているプロジェクト名を補います。関連する実行と委任先のセッションもまとめて表示します。 （#1679、#1675）
- **待機時のメモリ使用量。** アプリのウィンドウにフォーカスがないとき、未使用のメモリをより早く解放します。 （#1688）

### 修正
- **ローカルの Codex Work 使用量。** 実験的なローカル収集をオンにすると、ウェブから開始してこの端末で実行した対象の Work タスクも記録されます。 （#1673）
- **同期した日付範囲。** 「昨日」「今週」「過去7日間」「過去30日間」の更新中も、セッションとプロジェクトの内訳が表示され続けます。使用量がゼロと確認された端末のために、ほかの端末の内訳が表示されなくなる問題も修正しました。 （#1685）
- **Hub への大容量アップロード。** デスクトップアプリと Hub が両方とも新しい同期方式に対応していれば、使用履歴が多い場合もセッションの内訳とアクティビティカレンダーを保持します。 （#1682）
- **Windows での連続起動。** 短い間隔で2回起動しても既存のメインウィンドウが開き、ウィンドウの重なりやちらつきを防ぎます。 （#1676）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.99.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.99.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-Setup-0.99.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.99.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.99.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.99.0/Token-Monitor-0.99.0.AppImage)

</details>

</details>
