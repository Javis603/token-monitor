# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Antigravity subagents:** Groups child conversations under their parent in Sessions and Edge Dock. (#1113)
- **DeepSeek Harness projects:** Adds project usage breakdowns when project tracking is enabled. (#1115)
- **macOS Notch Panel:** Adds Home, Limits, Sessions and Breakdown pages; still experimental and off by default. (#1114)

### Improved
- **Windows usage scans:** Briefly lowers scan priority to reduce competition with foreground apps. (#1083)

### Fixed
- **Grok Bot activity:** Recent usage alone no longer marks sessions as running. (#1110)
- **Claude Code history:** Quota checks no longer add saved local conversations. (#1112)
- **Claude Code activity:** Quota checks no longer appear as sessions waiting for input. (#1118)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.75.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.75.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-Setup-0.75.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.75.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.AppImage)

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
- **Antigravity 子代理：** 在“会话”和“侧边栏”中，将子会话归入对应的主会话。 （#1113）
- **DeepSeek Harness 项目用量：** 新增项目用量分解支持，开启项目追踪后可查看。 （#1115）
- **macOS 刘海面板：** 新增“主页”、“额度”、“会话”和“分项”页面，仍为实验性功能，默认关闭。 （#1114）

### 改进
- **Windows 用量扫描：** 短暂降低扫描优先级，减少对前台应用的干扰。 （#1083）

### 修复
- **Grok Bot 活动状态：** 不再仅凭近期用量将会话标记为运行中。 （#1110）
- **Claude Code 历史记录：** 额度检查不再新增已保存的本地会话。 （#1112）
- **Claude Code 活动状态：** 额度检查不再显示为等待输入的会话。 （#1118）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.75.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.75.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-Setup-0.75.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.75.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.74.0...v0.75.0">v0.74.0...v0.75.0</a></summary>

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
- **Antigravity 子代理：** 在「會話」與「側邊欄」中，將子會話歸入對應的主會話。 （#1113）
- **DeepSeek Harness 專案用量：** 新增專案用量分解支援，開啟專案追蹤後即可查看。 （#1115）
- **macOS 瀏海面板：** 新增「主頁」、「額度」、「會話」與「分項」頁面，仍屬實驗性功能，預設關閉。 （#1114）

### 改進
- **Windows 用量掃描：** 短暫降低掃描優先權，減少對前景應用程式的干擾。 （#1083）

### 修復
- **Grok Bot 活動狀態：** 不再僅憑近期用量將會話標記為執行中。 （#1110）
- **Claude Code 歷史紀錄：** 額度檢查不再新增已儲存的本機會話。 （#1112）
- **Claude Code 活動狀態：** 額度檢查不再顯示為等待輸入的會話。 （#1118）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.75.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.75.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-Setup-0.75.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.75.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Antigravity 하위 에이전트:** 세션과 가장자리 도크에서 하위 대화를 메인 대화 아래로 묶어 표시합니다. (#1113)
- **DeepSeek Harness 프로젝트 사용량:** 프로젝트별 사용량 분석을 지원합니다. 프로젝트 추적을 켜면 확인할 수 있습니다. (#1115)
- **macOS 노치 패널:** 홈, 한도, 세션, 세부 페이지를 추가했습니다. 아직 실험적 기능이며 기본적으로 꺼져 있습니다. (#1114)

### 개선
- **Windows 사용량 스캔:** 스캔 우선순위를 잠시 낮춰 전경 앱과의 CPU 경합을 줄였습니다. (#1083)

### 수정
- **Grok Bot 활동 상태:** 최근 사용량만으로 세션을 실행 중으로 표시하지 않습니다. (#1110)
- **Claude Code 기록:** 한도 확인 시 로컬에 저장되는 대화가 추가되지 않습니다. (#1112)
- **Claude Code 활동 상태:** 한도 확인이 입력 대기 중인 세션으로 표시되지 않습니다. (#1118)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.75.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.75.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-Setup-0.75.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.75.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Antigravity のサブエージェント:** セッションとエッジドックで、子の会話をメインの会話にまとめて表示します。 (#1113)
- **DeepSeek Harness のプロジェクト使用量:** プロジェクト別の使用量の内訳に対応しました。プロジェクト追跡を有効にすると確認できます。 (#1115)
- **macOS のノッチパネル:** ホーム・上限・セッション・内訳の各ページを追加しました。引き続き実験的機能で、初期状態ではオフです。 (#1114)

### 改善
- **Windows の使用量スキャン:** スキャンの優先度を一時的に下げ、手前のアプリとの CPU の競合を抑えます。 (#1083)

### 修正
- **Grok Bot の活動状態:** 最近の使用量だけでセッションを実行中と表示しなくなりました。 (#1110)
- **Claude Code の履歴:** 上限の確認時に、保存済みのローカル会話が増えなくなりました。 (#1112)
- **Claude Code の活動状態:** 上限の確認が、入力待ちのセッションとして表示されなくなりました。 (#1118)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.75.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.75.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-Setup-0.75.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.75.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.75.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.75.0/Token-Monitor-0.75.0.AppImage)

</details>

</details>
