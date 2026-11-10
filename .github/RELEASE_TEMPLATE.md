# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Hark quotas:** Supports account quotas, with desktop session detection on macOS or a manually pasted session cookie. (#1431)
- **Spanish:** Adds translations for the desktop app and native macOS widget. (#1286)

### Changed
- **WSL scanning:** Disabled by default; explicitly saved choices are preserved. Enable scanning to include tools in running WSL distributions. (#1438)

### Improved
- **Edge Dock speed:** Shows a trend of up to 60 recent readings from the past five minutes. (#1441)
- **Inkling models:** Identifies Thinking Machines in usage charts and the macOS widget. (#1416)

### Fixed
- **Cursor sync:** Keeps local usage updating during background imports. (#1318)
- **Qoder quotas:** Shows personal Credits and the member's Team credits separately, omitting zero-limit allowances. (#1301)
- **Active days:** Counts lifetime activity across devices when contributing history is complete; otherwise shows the last 12 months. (#241)
- **WSL startup:** Prevents background collection from waking stopped distributions. (#1438)
- **Windows quota history:** Keeps the glass background inside the card. (#1439)
- **Card captures:** Removes excess empty space around sidebar cards and macOS quota-history previews in system window captures and pickers. (#1440)
- **Linux window position:** Restores saved positions in Wayland sessions by using XWayland when available, unless a display backend is explicitly selected. (#1328)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.90.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.90.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-Setup-0.90.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.90.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.AppImage)

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
- **Hark 额度：** 支持账号额度，可在 macOS 检测桌面登录状态，或手动粘贴会话 cookie。 （#1431）
- **西班牙语：** 新增桌面应用与 macOS 原生小组件翻译。 （#1286）

### 变更
- **WSL 扫描：** 改为默认关闭，保留已明确保存的选择。启用后可统计正在运行的 WSL 发行版中的工具用量。 （#1438）

### 改进
- **侧边栏速度：** 显示最近五分钟内最多 60 次读数的趋势。 （#1441）
- **Inkling 模型：** 在用量图表与 macOS 小组件中识别 Thinking Machines。 （#1416）

### 修复
- **Cursor 同步：** 后台导入期间，本地用量仍可持续更新。 （#1318）
- **Qoder 额度：** 分别显示个人 Credits 与成员的 Team credits，不再显示上限为零的额度。 （#1301）
- **活跃天数：** 参与统计的历史完整时，跨设备统计全部时间的活跃天数；否则显示近 12 个月的统计。 （#241）
- **WSL 启动：** 后台采集不再唤醒已停止的发行版。 （#1438）
- **Windows 额度历史：** 玻璃背景不再溢出卡片。 （#1439）
- **卡片截图：** 系统窗口截图与窗口选择器不再为侧边栏卡片及 macOS 额度历史预览保留大块空白。 （#1440）
- **Linux 窗口位置：** Wayland 环境中可恢复已保存的位置；在可用时采用 XWayland，尊重手动指定的显示后端。 （#1328）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.90.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.90.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-Setup-0.90.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.90.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.89.0...v0.90.0">v0.89.0...v0.90.0</a></summary>

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
- **Hark 額度：** 支援帳號額度，可在 macOS 偵測桌面登入狀態，或手動貼上工作階段 cookie。 （#1431）
- **西班牙文：** 新增桌面應用程式與 macOS 原生小工具翻譯。 （#1286）

### 變更
- **WSL 掃描：** 改為預設關閉，保留已明確儲存的選擇。啟用後可統計正在執行的 WSL 發行版中的工具用量。 （#1438）

### 改進
- **側邊欄速度：** 顯示最近五分鐘內最多 60 次讀數的趨勢。 （#1441）
- **Inkling 模型：** 在用量圖表與 macOS 小工具中識別 Thinking Machines。 （#1416）

### 修復
- **Cursor 同步：** 背景匯入期間，本機用量仍可持續更新。 （#1318）
- **Qoder 額度：** 分別顯示個人 Credits 與成員的 Team credits，不再顯示上限為零的額度。 （#1301）
- **活躍天數：** 參與統計的歷史完整時，跨裝置統計全部時間的活躍天數；否則顯示近 12 個月的統計。 （#241）
- **WSL 啟動：** 背景採集不再喚醒已停止的發行版。 （#1438）
- **Windows 額度歷史：** 玻璃背景不再溢出卡片。 （#1439）
- **卡片截圖：** 系統視窗截圖與視窗選擇器不再為側邊欄卡片及 macOS 額度歷史預覽保留大片空白。 （#1440）
- **Linux 視窗位置：** Wayland 環境中可還原已儲存的位置；在可用時採用 XWayland，尊重手動指定的顯示後端。 （#1328）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.90.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.90.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-Setup-0.90.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.90.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Hark 할당량:** 계정 할당량을 지원합니다. macOS에서는 데스크톱 로그인 세션을 감지하며, 세션 쿠키를 직접 붙여넣을 수도 있습니다. (#1431)
- **스페인어:** 데스크톱 앱과 macOS 기본 위젯에 번역을 추가했습니다. (#1286)

### 변경
- **WSL 스캔:** 기본값을 끄기로 변경했습니다. 명시적으로 저장한 선택은 유지되며, 켜면 실행 중인 WSL 배포판의 도구 사용량을 집계합니다. (#1438)

### 개선
- **Edge Dock 속도:** 최근 5분 동안의 측정값을 최대 60개까지 추세 그래프로 표시합니다. (#1441)
- **Inkling 모델:** 사용량 차트와 macOS 위젯에서 Thinking Machines를 식별합니다. (#1416)

### 수정
- **Cursor 동기화:** 백그라운드 가져오기 중에도 로컬 사용량을 계속 갱신합니다. (#1318)
- **Qoder 할당량:** 개인 Credits와 구성원의 Team credits를 따로 표시하고, 한도가 0인 항목은 숨깁니다. (#1301)
- **활성 일수:** 집계 대상 기록이 완전하면 기기 간 전체 기간의 활성 일수를 계산하고, 그렇지 않으면 최근 12개월을 표시합니다. (#241)
- **WSL 시작:** 백그라운드 수집이 중지된 배포판을 깨우지 않도록 수정했습니다. (#1438)
- **Windows 할당량 기록:** 유리 배경이 카드 밖으로 넘치지 않도록 수정했습니다. (#1439)
- **카드 캡처:** 시스템 창 캡처와 창 선택기에서 사이드바 카드 및 macOS 할당량 기록 미리보기 주변의 과도한 빈 공간을 제거했습니다. (#1440)
- **Linux 창 위치:** Wayland에서 사용 가능한 경우 XWayland를 사용해 저장된 위치를 복원합니다. 직접 지정한 디스플레이 백엔드는 그대로 따릅니다. (#1328)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.90.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.90.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-Setup-0.90.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.90.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Harkの使用量上限:** アカウントの上限表示に対応しました。macOSではデスクトップのログイン状態を検出でき、セッションCookieの手動入力も利用できます。 (#1431)
- **スペイン語:** デスクトップアプリとmacOS標準ウィジェットに翻訳を追加しました。 (#1286)

### 変更
- **WSLスキャン:** 既定でオフに変更しました。明示的に保存した設定は維持され、オンにすると実行中のWSLディストリビューション内のツール使用量を集計します。 (#1438)

### 改善
- **エッジドックの速度:** 過去5分間の測定値を最大60件まで推移グラフで表示します。 (#1441)
- **Inklingモデル:** 使用量グラフとmacOSウィジェットでThinking Machinesを識別します。 (#1416)

### 修正
- **Cursorの同期:** バックグラウンドでの取り込み中もローカル使用量を更新できるようにしました。 (#1318)
- **Qoderの使用量上限:** 個人のCreditsとメンバーのTeam creditsを分けて表示し、上限がゼロの項目は非表示にしました。 (#1301)
- **アクティブ日数:** 集計対象の履歴が揃っていれば端末をまたぐ全期間の日数を集計し、揃っていない場合は過去12ヶ月を表示します。 (#241)
- **WSLの起動:** バックグラウンド収集が停止中のディストリビューションを起動しないようにしました。 (#1438)
- **Windowsの上限履歴:** ガラス背景がカードの外にはみ出す問題を修正しました。 (#1439)
- **カードのキャプチャ:** システムのウィンドウキャプチャと選択画面で、サイドバーのカードとmacOSの上限履歴プレビューの周囲に広い空白が入る問題を修正しました。 (#1440)
- **Linuxのウィンドウ位置:** Waylandで利用可能な場合はXWaylandを使い、保存した位置を復元します。表示バックエンドを明示した場合はその指定を優先します。 (#1328)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.90.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.90.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-Setup-0.90.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.90.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.90.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.90.0/Token-Monitor-0.90.0.AppImage)

</details>

</details>
