# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Live token rate:** Adds an opt-in footer readout for generation speed (tok/s) or token burn (TPM); Hub modes can switch between all devices and this device. (#648)
- **ZCode limits:** Automatically detects the locally signed-in ZCode account and shows its Coding Plan or Start/Weekend quota in the existing GLM row. (#630)
- **Z.ai balance:** Shows the console-key cash balance with Today, Week, Month, and all-time spend. (#630)
- **Kilo usage:** Tracks Kilo CLI and Kilo Code together under Kilo, including live refresh and WSL discovery; existing Kilo Code settings and history migrate automatically. (#635)

### Improved
- **Quota reset motion:** Animates a quota meter from its last value to the refilled state when a reset is detected, while respecting reduced motion. (#644)

### Fixed
- **Limits view motion:** Restores meter entrance motion when returning to the cached Limits view. (#651)
- **Claude CLI limits:** Prevents background probes from opening the login flow, supports Windows `.cmd` installs, and keeps session and weekly values paired with the correct reset times. (#612)
- **WorkBuddy Personal balance:** Corrects the balance by using the same eligible package range as the desktop client. (#643)
- **Kiro limits:** Restores quota details when the default v2 output contains only a plan summary. (#641)
- **OpenClaw live tracking:** Avoids excessive memory use in large runtime and workspace trees by limiting live tracking to usage sources. (#632)
- **Codex limits:** Restores quota collection with Codex CLI 0.149.0 and later when OAuth falls back to app-server. (#631)
- **AI Tool Limits toggles:** Fixes provider toggles flickering back to their previous state while settings are being saved. (#589)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.55.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.55.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-Setup-0.55.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.55.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.AppImage)

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
- **实时 Token 速率：** 新增可选底栏读数，可在生成速度（tok/s）与 Token 消耗（TPM）之间切换；Hub 模式可选择所有设备或本机。（#648）
- **ZCode 额度：** 自动检测本机已登录的 ZCode 账号，并在现有 GLM 行显示 Coding Plan 或 Start/Weekend 额度。（#630）
- **Z.ai 余额：** 显示控制台密钥的现金余额及今天、本周、本月和累计支出。（#630）
- **Kilo 用量：** 将 Kilo CLI 与 Kilo Code 统一归入 Kilo 追踪，支持实时更新与 WSL，并自动迁移现有 Kilo Code 设置和历史。（#635）

### 改进
- **额度重置动画：** 检测到重置时，从上次显示值平滑补满，并遵循减少动态效果设置。（#644）

### 修复
- **额度页面动画：** 修复返回已缓存的额度页面时，额度条入场动画不再播放的问题。（#651）
- **Claude CLI 额度：** 修复后台探测可能打开登录流程、Windows `.cmd` 安装无法运行，以及会话、周额度与各自重置时间错配的问题。（#612）
- **WorkBuddy Personal 余额：** 按桌面客户端相同的可用套餐范围修正余额。（#643）
- **Kiro 额度：** 修复默认 v2 输出仅包含套餐摘要时无法显示额度详情的问题。（#641）
- **OpenClaw 实时追踪：** 仅实时监控用量来源，避免大型运行目录与工作区造成过高内存占用。（#632）
- **Codex 额度：** 修复 Codex CLI 0.149.0 及更高版本进入 app-server 后备路径时无法收集额度的问题。（#631）
- **AI 工具额度开关：** 修复保存设置时，提供商开关因短暂恢复旧状态而闪烁的问题。（#589）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.55.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.55.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-Setup-0.55.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.55.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.54.0...v0.55.0">v0.54.0...v0.55.0</a></summary>

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
- **即時 Token 速率：** 新增可選的底欄讀數，可在生成速度（tok/s）與 Token 消耗（TPM）之間切換；Hub 模式可選擇所有裝置或此裝置。（#648）
- **ZCode 額度：** 自動偵測本機已登入的 ZCode 帳號，並在現有 GLM 列顯示 Coding Plan 或 Start/Weekend 額度。（#630）
- **Z.ai 餘額：** 顯示控制台金鑰的現金餘額，以及今日、本週、本月與累計支出。（#630）
- **Kilo 用量：** 將 Kilo CLI 與 Kilo Code 統一歸入 Kilo 追蹤，支援即時更新與 WSL，並自動遷移現有 Kilo Code 設定與歷史。（#635）

### 改進
- **額度重置動畫：** 偵測到重置時，從上次顯示值平滑補滿，並遵循減少動態效果設定。（#644）

### 修復
- **額度頁面動畫：** 修復返回已快取的額度頁面時，額度列入場動畫不再播放的問題。（#651）
- **Claude CLI 額度：** 修復背景探測可能開啟登入流程、Windows `.cmd` 安裝無法執行，以及工作階段、每週額度與各自重置時間錯配的問題。（#612）
- **WorkBuddy Personal 餘額：** 依照桌面應用程式相同的可用套件範圍修正餘額。（#643）
- **Kiro 額度：** 修復預設 v2 輸出僅包含方案摘要時無法顯示額度詳情的問題。（#641）
- **OpenClaw 即時追蹤：** 僅即時監控用量來源，避免大型執行目錄與工作區造成過高記憶體用量。（#632）
- **Codex 額度：** 修復 Codex CLI 0.149.0 及更新版本進入 app-server 後備路徑時無法收集額度的問題。（#631）
- **AI 工具額度開關：** 修復儲存設定時，提供者開關因短暫回復舊狀態而閃爍的問題。（#589）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.55.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.55.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-Setup-0.55.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.55.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **실시간 토큰 속도:** 생성 속도(tok/s) 또는 토큰 소모량(TPM)을 바닥글에 표시하는 옵션을 추가했습니다. Hub 모드에서는 모든 기기와 이 기기 사이를 전환할 수 있습니다. (#648)
- **ZCode 할당량:** 이 컴퓨터에 로그인된 ZCode 계정을 자동으로 감지하고 기존 GLM 행에 Coding Plan 또는 Start/Weekend 할당량을 표시합니다. (#630)
- **Z.ai 잔액:** 콘솔 키의 현금 잔액과 오늘, 이번 주, 이번 달 및 누적 지출을 표시합니다. (#630)
- **Kilo 사용량:** Kilo CLI와 Kilo Code를 Kilo로 통합해 추적하며 실시간 갱신과 WSL 검색을 지원합니다. 기존 Kilo Code 설정과 기록은 자동으로 이전됩니다. (#635)

### 개선
- **할당량 리셋 모션:** 리셋을 감지하면 마지막 표시 값에서 충전된 값까지 부드럽게 애니메이션하며 동작 줄이기 설정을 따릅니다. (#644)

### 수정
- **할당량 보기 모션:** 캐시된 할당량 보기로 돌아왔을 때 막대 진입 애니메이션이 재생되지 않던 문제를 수정했습니다. (#651)
- **Claude CLI 할당량:** 백그라운드 확인이 로그인 절차를 열 수 있던 문제와 Windows `.cmd` 설치 실행 문제를 수정하고, 세션 및 주간 값이 올바른 리셋 시간과 연결되도록 했습니다. (#612)
- **WorkBuddy Personal 잔액:** 데스크톱 클라이언트와 동일한 사용 가능 패키지 범위를 적용해 잔액을 수정했습니다. (#643)
- **Kiro 할당량:** 기본 v2 출력에 플랜 요약만 포함될 때 할당량 상세 정보가 표시되지 않던 문제를 수정했습니다. (#641)
- **OpenClaw 실시간 추적:** 실시간 추적을 사용량 소스로 제한해 대규모 런타임 및 작업 공간 트리에서 과도한 메모리 사용을 방지합니다. (#632)
- **Codex 할당량:** Codex CLI 0.149.0 이상에서 OAuth가 app-server로 대체될 때 할당량 수집이 실패하던 문제를 수정했습니다. (#631)
- **AI 도구 할당량 토글:** 설정을 저장하는 동안 제공자 토글이 이전 상태로 잠시 되돌아가며 깜박이던 문제를 수정했습니다. (#589)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.55.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.55.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-Setup-0.55.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.55.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **ライブ Token レート：** 生成速度（tok/s）または Token 消費量（TPM）を表示するオプションのフッター表示を追加しました。Hub モードでは、すべてのデバイスとこのデバイスを切り替えられます。（#648）
- **ZCodeのクォータ：** このコンピューターでログイン中の ZCode アカウントを自動検出し、既存の GLM 行に Coding Plan または Start/Weekend のクォータを表示します。（#630）
- **Z.aiの残高：** コンソールキーの現金残高と、今日・今週・今月・累計の支出を表示します。（#630）
- **Kiloの使用量：** Kilo CLI と Kilo Code を Kilo としてまとめて追跡し、ライブ更新と WSL 検出に対応しました。既存の Kilo Code 設定と履歴は自動的に移行されます。（#635）

### 改善
- **クォータリセットのモーション：** リセットを検出すると、直前の表示値から補充後の値まで滑らかにアニメーションし、モーションを減らす設定にも対応します。（#644）

### 修正
- **クォータ画面のモーション：** キャッシュ済みのクォータ画面に戻った際、メーターの表示アニメーションが再生されない問題を修正しました。（#651）
- **Claude CLIのクォータ：** バックグラウンド確認でログイン画面が開く場合がある問題、Windows の `.cmd` インストールを実行できない問題、セッションと週次の値が誤ったリセット時刻に結び付く問題を修正しました。（#612）
- **WorkBuddy Personalの残高：** デスクトップクライアントと同じ利用可能パッケージ範囲を適用し、残高を修正しました。（#643）
- **Kiroのクォータ：** 既定の v2 出力にプラン概要しか含まれない場合、クォータの詳細が表示されない問題を修正しました。（#641）
- **OpenClawのライブ追跡：** ライブ追跡を使用量ソースに限定し、大規模なランタイムやワークスペースでの過剰なメモリ使用を防ぎます。（#632）
- **Codexのクォータ：** Codex CLI 0.149.0 以降で OAuth が app-server にフォールバックした際、クォータを収集できない問題を修正しました。（#631）
- **AI ツールのクォータ切り替え：** 設定の保存中にプロバイダーの切り替えが一時的に以前の状態へ戻ってちらつく問題を修正しました。（#589）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.55.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.55.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-Setup-0.55.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.55.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.55.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.55.0/Token-Monitor-0.55.0.AppImage)

</details>

</details>
