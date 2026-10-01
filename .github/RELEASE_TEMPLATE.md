# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **iCloud Drive sync:** Adds optional sync of usage, limits, history, devices and subscriptions between Macs using the same Apple ID, without a Hub. Updates may take time to arrive. (#629)
- **StepFun limits:** Supports Coding Plan 5-hour and weekly quotas, and Token Plan credit usage. (#881)
- **Muse Code usage:** Adds token usage tracking. (#860)
- **Home sessions:** Shows recent conversations and running sessions on Home by default. (#851)
- **Edge Dock fullscreen mode:** Adds “Fullscreen auto-hide” on macOS and Windows, keeping the dock expanded until an app fills its display. (#859)
- **Edge Dock quota windows:** Lets you choose which quota window each provider shows on the rail. (#882)
- **Edge Dock tool pins:** Lets you pin enabled tools even when quota data is unavailable. (#845)

### Improved
- **Grok Build sessions:** Shows matching sessions in Sessions and Edge Dock, with titles and project grouping. (#866)
- **Codex Pro plans:** Updates plan labels to Pro, Pro More and Pro Max. (#880)
- **Claude Web organizations:** Lets you choose the organization to monitor when an account has several eligible organizations. (#879)

### Fixed
- **OpenRouter key limits:** Corrects usage shown for resetting limits, including BYOK spend when it counts toward the cap. (#852)
- **Usage collection:** Fixes macOS collection stopping with many watched files and reduces watch overhead for large custom scan paths. (#862, #875)
- **Live usage updates:** Fixes usage updates being delayed until the next scheduled collection while sessions keep generating content. (#521)
- **Codex CLI detection:** Finds the CLI bundled with the current macOS ChatGPT app. (#838)
- **Codex reset forecasts:** Shows active strong reset watches even when no probability is provided.
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.64.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.64.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-Setup-0.64.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.64.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.AppImage)

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
- **iCloud 云盘同步：** 可选用相同 Apple ID 在 Mac 之间同步用量、限额、历史、设备和订阅，无需 Hub；跨设备更新可能延迟。（#629）
- **StepFun 限额：** 支持 Coding Plan 的 5 小时和每周额度，以及 Token Plan 的点数用量。（#881）
- **Muse Code 用量：** 新增 Tokens 用量追踪支持。（#860）
- **主页会话：** 默认显示最近会话和运行中的会话。（#851）
- **侧边栏全屏模式：** macOS 和 Windows 新增“全屏自动隐藏”，平时保持展开，同一屏幕有全屏应用时收起。（#859）
- **侧边栏额度窗口：** 支持选择各服务在侧边栏显示的额度窗口。（#882）
- **侧边栏工具固定：** 已启用的工具即使暂无额度数据，也可手动固定。（#845）

### 改进
- **Grok Build 会话：** 在“会话”和侧边栏中显示匹配的会话，并补充标题与项目分组。（#866）
- **Codex Pro 方案：** 更新方案标签为 Pro、Pro More 和 Pro Max。（#880）
- **Claude Web 组织：** 账号有多个可用组织时，可选择要监控的组织。（#879）

### 修复
- **OpenRouter 密钥限额：** 修正定期重置限额的用量显示，并计入应纳入限额的 BYOK 消耗。（#852）
- **用量采集：** 修复 macOS 监听大量文件后停止采集的问题，并降低大型自定义扫描路径的监听开销。（#862、#875）
- **实时用量更新：** 修复会话持续生成内容时，用量更新可能延迟至下一次定时采集的问题。（#521）
- **Codex CLI 检测：** 修复无法找到新版 macOS ChatGPT 应用内置 CLI 的问题。（#838）
- **Codex 重置预测：** 强重置观察未提供概率时，也能显示为活跃状态。
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.64.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.64.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-Setup-0.64.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.64.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.63.1...v0.64.0">v0.63.1...v0.64.0</a></summary>

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
- **iCloud Drive 同步：** 可選用相同 Apple ID 在 Mac 之間同步用量、限額、歷史、裝置與訂閱，無需 Hub；跨裝置更新可能延遲。（#629）
- **StepFun 限額：** 支援 Coding Plan 的 5 小時與每週額度，以及 Token Plan 的點數用量。（#881）
- **Muse Code 用量：** 新增 Tokens 用量追蹤支援。（#860）
- **首頁會話：** 預設顯示最近會話與執行中的會話。（#851）
- **側邊欄全螢幕模式：** macOS 與 Windows 新增「全螢幕自動隱藏」，平時保持展開，同一螢幕有全螢幕應用程式時收合。（#859）
- **側邊欄額度窗口：** 支援選擇各服務在側邊欄顯示的額度窗口。（#882）
- **側邊欄工具固定：** 已啟用的工具即使暫無額度資料，也可手動固定。（#845）

### 改進
- **Grok Build 會話：** 在「會話」與側邊欄中顯示符合的會話，並補上標題與專案分組。（#866）
- **Codex Pro 方案：** 更新方案標籤為 Pro、Pro More 與 Pro Max。（#880）
- **Claude Web 組織：** 帳號有多個可用組織時，可選擇要監控的組織。（#879）

### 修復
- **OpenRouter 金鑰限額：** 修正定期重置限額的用量顯示，並計入應納入限額的 BYOK 消耗。（#852）
- **用量採集：** 修復 macOS 監聽大量檔案後停止採集的問題，並降低大型自訂掃描路徑的監聽開銷。（#862、#875）
- **即時用量更新：** 修復會話持續生成內容時，用量更新可能延遲至下一次定時採集的問題。（#521）
- **Codex CLI 偵測：** 修復無法找到新版 macOS ChatGPT 應用程式內建 CLI 的問題。（#838）
- **Codex 重置預測：** 強重置觀察未提供機率時，也能顯示為活躍狀態。
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.64.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.64.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-Setup-0.64.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.64.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **iCloud Drive 동기화:** 같은 Apple ID를 사용하는 Mac끼리 사용량, 한도, 기록, 기기와 구독을 Hub 없이 동기화하는 옵션을 추가했습니다. 기기 간 반영에는 시간이 걸릴 수 있습니다. (#629)
- **StepFun 한도:** Coding Plan의 5시간 및 주간 한도와 Token Plan의 크레딧 사용량을 지원합니다. (#881)
- **Muse Code 사용량:** 토큰 사용량 추적을 지원합니다. (#860)
- **홈 세션:** 최근 대화와 실행 중인 세션을 홈에 기본으로 표시합니다. (#851)
- **가장자리 도크 전체 화면 모드:** macOS와 Windows에 ‘전체 화면 자동 숨김’을 추가했습니다. 평소에는 펼쳐 두고 같은 화면에 전체 화면 앱이 있으면 접습니다. (#859)
- **가장자리 도크 한도 기간:** 각 서비스의 도크에 표시할 한도 기간을 선택할 수 있습니다. (#882)
- **가장자리 도크 도구 고정:** 한도 데이터가 없어도 활성화된 도구를 직접 고정할 수 있습니다. (#845)

### 개선
- **Grok Build 세션:** 일치하는 세션을 세션 목록과 가장자리 도크에 표시하고 제목과 프로젝트별 그룹을 제공합니다. (#866)
- **Codex Pro 요금제:** 요금제 이름을 Pro, Pro More, Pro Max로 업데이트했습니다. (#880)
- **Claude Web 조직:** 계정에 사용 가능한 조직이 여러 개 있으면 확인할 조직을 선택할 수 있습니다. (#879)

### 수정
- **OpenRouter 키 한도:** 주기적으로 초기화되는 한도의 사용량을 수정하고, 한도에 포함되는 BYOK 사용액도 반영합니다. (#852)
- **사용량 수집:** macOS에서 많은 파일을 감시할 때 수집이 멈추는 문제를 수정하고, 대규모 사용자 지정 스캔 경로의 감시 부담을 줄였습니다. (#862, #875)
- **실시간 사용량 업데이트:** 세션이 계속 내용을 생성할 때 사용량 업데이트가 다음 정기 수집까지 늦어질 수 있는 문제를 수정했습니다. (#521)
- **Codex CLI 감지:** 최신 macOS ChatGPT 앱에 포함된 CLI를 찾지 못하는 문제를 수정했습니다. (#838)
- **Codex 초기화 예측:** 확률이 제공되지 않아도 강한 초기화 관측을 활성 상태로 표시합니다.
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.64.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.64.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-Setup-0.64.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.64.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **iCloud Drive 同期：** 同じ Apple ID の Mac 間で使用量、制限、履歴、デバイス、サブスクリプションを Hub なしで同期するオプションを追加しました。反映には時間がかかる場合があります。（#629）
- **StepFun の制限：** Coding Plan の5時間・週間制限と、Token Plan のクレジット使用量に対応しました。（#881）
- **Muse Code の使用量：** トークン使用量の追跡に対応しました。（#860）
- **ホームのセッション：** 最近の会話と実行中のセッションを標準で表示します。（#851）
- **エッジドックの全画面モード：** macOS と Windows に「全画面時に自動非表示」を追加しました。通常は展開したまま、同じ画面に全画面アプリがあると収納します。（#859）
- **エッジドックの制限期間：** 各サービスのドックに表示する制限期間を選べます。（#882）
- **エッジドックのツール固定：** 制限データがなくても、有効なツールを手動で固定できます。（#845）

### 改善
- **Grok Build のセッション：** 一致するセッションをセッション一覧とエッジドックに表示し、タイトルとプロジェクト別のグループを追加しました。（#866）
- **Codex Pro プラン：** プラン名を Pro、Pro More、Pro Max に更新しました。（#880）
- **Claude Web の組織：** アカウントに利用可能な組織が複数ある場合、確認する組織を選べます。（#879）

### 修正
- **OpenRouter のキー制限：** 定期リセットされる制限の使用量を修正し、制限対象の BYOK 利用額も反映します。（#852）
- **使用量収集：** macOS で多数のファイルを監視すると収集が止まる問題を修正し、大規模なカスタムスキャンパスの監視負荷を軽減しました。（#862、#875）
- **リアルタイム使用量の更新：** セッションが内容を生成し続けると、使用量の更新が次の定期収集まで遅れることがある問題を修正しました。（#521）
- **Codex CLI の検出：** 最新の macOS ChatGPT アプリに同梱された CLI が見つからない問題を修正しました。（#838）
- **Codex リセット予測：** 確率が提供されていない強いリセット監視も有効な状態として表示します。
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.64.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.64.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-Setup-0.64.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.64.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.64.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.64.0/Token-Monitor-0.64.0.AppImage)

</details>

</details>
