# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Claude Code and Codex waiting states:** Shows when a session is waiting for a reply or approval in Home, Sessions and Edge Dock, including before token usage arrives. (#977)
- **Codex subagents:** Groups subagents under their parent in Sessions, with combined usage and individual session details. (#997)
- **T3 Code sessions:** Groups continuations and delegated agents with their main conversation across Home, Sessions and Edge Dock. (#1001)
- **Cursor Grok Bot:** Groups activity records in Sessions with usage totals and a list of individual records. (#987)
- **Antigravity session titles:** Shows conversation titles and keeps them up to date after renaming. (#978)
- **Antigravity generation speed:** Supports native generation-speed readings. (#957)

### Improved
- **Cursor usage refresh:** Refreshes cloud usage in response to desktop activity. (#966)
- **Cursor running indicator:** Stops the running indicator more promptly when a turn finishes or is cancelled. (#985)

### Fixed
- **Antigravity quotas in Home:** Shows both 5-hour and Weekly quotas when only one model group is visible. (#973)
- **Antigravity token totals:** Includes reasoning tokens in usage totals and history. (#957)
- **Device names:** Uses consistent names in Devices, sync settings and live token-rate details. (#969)
- **Windows Edge Dock:** Fixes the dock falling behind other windows after waking from sleep. (#994)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.69.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.69.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-Setup-0.69.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.69.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.AppImage)

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
- **Claude Code 与 Codex 等待状态：** 在主页、会话和侧边栏显示等待回复或批准的状态，尚未产生 Token 用量的会话也可显示。 （#977）
- **Codex 子代理：** 在会话中按主会话分组，显示合计用量，并可查看各个会话的详情。 （#997）
- **T3 Code 会话：** 在主页、会话和侧边栏将续接会话与委派的子代理归入主对话。 （#1001）
- **Cursor Grok Bot：** 在会话中集中显示活动记录、合计用量，并可展开查看各条记录。 （#987）
- **Antigravity 会话标题：** 支持显示对话标题，并跟随重命名更新。 （#978）
- **Antigravity 生成速度：** 支持显示原生生成速度。 （#957）

### 改进
- **Cursor 用量刷新：** 根据桌面端活动刷新云端用量。 （#966）
- **Cursor 运行指示：** 回合结束或取消后，更及时地停止运行指示。 （#985）

### 修复
- **主页 Antigravity 额度：** 仅显示一个模型组时，同时显示 5-hour 和 Weekly 额度。 （#973）
- **Antigravity Token 总量：** 用量总计与历史数据计入推理 Tokens。 （#957）
- **设备名称：** 统一设备、同步设置与实时 Token 速率详情中的名称。 （#969）
- **Windows 侧边栏：** 修复睡眠唤醒后被其他窗口遮挡的问题。 （#994）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.69.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.69.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-Setup-0.69.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.69.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.68.0...v0.69.0">v0.68.0...v0.69.0</a></summary>

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
- **Claude Code 與 Codex 等候狀態：** 在主頁、會話和側邊欄顯示等待回覆或批准的狀態，尚未產生 Token 用量的會話也可顯示。 （#977）
- **Codex 子代理：** 在會話中依主會話分組，顯示合計用量，並可查看各個會話的詳情。 （#997）
- **T3 Code 會話：** 在主頁、會話和側邊欄將接續會話與委派的子代理歸入主對話。 （#1001）
- **Cursor Grok Bot：** 在會話中集中顯示活動記錄、合計用量，並可展開查看各筆記錄。 （#987）
- **Antigravity 會話標題：** 支援顯示對話標題，並隨重新命名更新。 （#978）
- **Antigravity 生成速度：** 支援顯示原生生成速度。 （#957）

### 改進
- **Cursor 用量重新整理：** 依桌面端活動重新整理雲端用量。 （#966）
- **Cursor 執行指示：** 回合結束或取消後，更及時地停止執行指示。 （#985）

### 修復
- **主頁 Antigravity 額度：** 僅顯示一個模型組時，同時顯示 5-hour 和 Weekly 額度。 （#973）
- **Antigravity Token 總量：** 用量總計與歷史資料計入推理 Token。 （#957）
- **裝置名稱：** 統一裝置、同步設定與即時 Token 速率詳情中的名稱。 （#969）
- **Windows 側邊欄：** 修復睡眠喚醒後被其他視窗遮擋的問題。 （#994）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.69.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.69.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-Setup-0.69.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.69.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Claude Code와 Codex 응답 대기 상태:** 홈, 세션, 가장자리 도크에 응답이나 승인을 기다리는 상태를 표시합니다. 토큰 사용량이 아직 없는 세션도 표시됩니다. (#977)
- **Codex 하위 에이전트:** 세션에서 상위 세션 아래로 묶어 총사용량과 개별 세션 상세 내용을 확인할 수 있습니다. (#997)
- **T3 Code 세션:** 홈, 세션, 가장자리 도크에서 이어진 세션과 위임한 하위 에이전트를 메인 대화로 묶습니다. (#1001)
- **Cursor Grok Bot:** 세션에서 활동 기록과 총사용량을 모아 표시하고, 개별 기록을 펼쳐 볼 수 있습니다. (#987)
- **Antigravity 세션 제목:** 대화 제목을 표시하고 이름 변경을 반영합니다. (#978)
- **Antigravity 생성 속도:** 자체 생성 속도 측정값 표시를 지원합니다. (#957)

### 개선
- **Cursor 사용량 갱신:** 데스크톱 활동에 맞춰 클라우드 사용량을 갱신합니다. (#966)
- **Cursor 실행 표시:** 턴이 끝나거나 취소되면 실행 중 표시를 더 빠르게 종료합니다. (#985)

### 수정
- **홈의 Antigravity 한도:** 모델 그룹이 하나만 표시될 때 5-hour와 Weekly 한도를 함께 표시합니다. (#973)
- **Antigravity 토큰 합계:** 사용량 합계와 기록에 추론 토큰을 포함합니다. (#957)
- **기기 이름:** 기기, 동기화 설정, 실시간 토큰 속도 상세 정보에 같은 이름을 표시합니다. (#969)
- **Windows 가장자리 도크:** 절전 모드에서 깨어난 뒤 다른 창 뒤에 가려지는 문제를 수정했습니다. (#994)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.69.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.69.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-Setup-0.69.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.69.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Claude Code と Codex の応答待ち表示：** ホーム、セッション、エッジドックに応答や承認を待っている状態を表示します。トークン使用量がまだないセッションも表示できます。 （#977）
- **Codex サブエージェント：** セッションで親セッションの下にまとめ、合計使用量と個々のセッションの詳細を確認できます。 （#997）
- **T3 Code のセッション：** ホーム、セッション、エッジドックで継続セッションと委任したサブエージェントをメインの会話にまとめます。 （#1001）
- **Cursor Grok Bot：** セッションにアクティビティ記録と合計使用量をまとめて表示し、個々の記録を開けます。 （#987）
- **Antigravity のセッションタイトル：** 会話のタイトルを表示し、名前の変更を反映します。 （#978）
- **Antigravity の生成速度：** ネイティブの生成速度の表示に対応しました。 （#957）

### 改善
- **Cursor の使用量更新：** デスクトップでのアクティビティに応じてクラウド使用量を更新します。 （#966）
- **Cursor の実行中表示：** ターンの終了やキャンセル後、実行中表示をより速やかに終了します。 （#985）

### 修正
- **ホームの Antigravity 上限：** モデルグループが1つだけ表示される場合、5-hour と Weekly の両方を表示します。 （#973）
- **Antigravity のトークン合計：** 使用量の合計と履歴に推論トークンを含めます。 （#957）
- **デバイス名：** デバイス、同期設定、ライブトークンレートの詳細で同じ名前を表示します。 （#969）
- **Windows のエッジドック：** スリープからの復帰後にほかのウィンドウに隠れる問題を修正しました。 （#994）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.69.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.69.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-Setup-0.69.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.69.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.69.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.69.0/Token-Monitor-0.69.0.AppImage)

</details>

</details>
