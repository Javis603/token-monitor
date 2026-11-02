# English

## What's changed

<!-- app-update-notes:en:start -->
### Improved
- **Edge Dock:** Detail cards move and fade smoothly when switching selections. (#1309)
- **Notch sessions:** Removes repeated tool names to leave more room for model, reasoning effort and time. (#1325)
- **Cursor setup:** Clarifies how to return from Grok sign-in redirects and find the correct Cookie. (#1303)

### Fixed
- **Windows updates:** Updates started from this version keep the current installation directory even when installation records are missing. (#1277)
- **Kiro quota:** Restores quota readings when the CLI defaults to the v3 engine, avoiding a billed model prompt on refresh. (#1320)
- **Notch month:** Shows the current month by default and the selected day's month on hover or keyboard focus. (#1316)
- **Cursor dashboard:** Restores the account setup button's browser launch. (#1312)
- **Copilot quota:** Removes extra space below Chat when no reset time is shown. (#1313)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.84.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-Setup-0.84.1.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.84.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.AppImage)

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
### 改进
- **侧边栏：** 切换详情卡片时，位置与内容平滑过渡。 （#1309）
- **刘海会话：** 不再重复显示工具名，为模型、推理强度和时间留出更多空间。 （#1325）
- **Cursor 设置：** 补充登录跳转到 Grok 后返回 Cursor、获取正确 Cookie 的指引。 （#1303）

### 修复
- **Windows 更新：** 从此版本发起更新时，即使安装记录缺失，也会保留当前安装目录。 （#1277）
- **Kiro 额度：** 修复 CLI 默认使用 v3 引擎时无法读取额度的问题，避免刷新触发付费模型请求。 （#1320）
- **刘海月份：** 默认显示当前月份，悬停或通过键盘聚焦某一天时显示该日期的月份。 （#1316）
- **Cursor 控制台：** 修复账号设置中的按钮无法打开浏览器的问题。 （#1312）
- **Copilot 额度：** 移除 Chat 未显示重置时间时下方的多余空白。 （#1313）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.84.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-Setup-0.84.1.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.84.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.84.0...v0.84.1">v0.84.0...v0.84.1</a></summary>

<!-- github-generated-release-notes -->

</details>

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 改進
- **側邊欄：** 切換詳細卡片時，位置與內容平滑過渡。 （#1309）
- **瀏海工作階段：** 不再重複顯示工具名稱，為模型、推理強度與時間留出更多空間。 （#1325）
- **Cursor 設定：** 補充登入轉到 Grok 後返回 Cursor、取得正確 Cookie 的指引。 （#1303）

### 修復
- **Windows 更新：** 從此版本發起更新時，即使安裝記錄遺失，也會保留目前的安裝目錄。 （#1277）
- **Kiro 額度：** 修復 CLI 預設使用 v3 引擎時無法讀取額度的問題，避免重新整理觸發付費模型請求。 （#1320）
- **瀏海月份：** 預設顯示目前月份，游標停留或透過鍵盤聚焦某一天時顯示該日期的月份。 （#1316）
- **Cursor 控制台：** 修復帳號設定中的按鈕無法開啟瀏覽器的問題。 （#1312）
- **Copilot 額度：** 移除 Chat 未顯示重設時間時下方的多餘空白。 （#1313）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.84.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-Setup-0.84.1.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.84.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 개선
- **가장자리 도크:** 세부 카드를 전환할 때 위치와 내용이 부드럽게 바뀝니다. (#1309)
- **노치 세션:** 도구 이름의 중복 표시를 없애 모델, 추론 강도와 시간을 보여줄 공간을 확보했습니다. (#1325)
- **Cursor 설정:** Grok 로그인으로 이동한 뒤 Cursor로 돌아와 올바른 Cookie를 찾는 방법을 안내합니다. (#1303)

### 수정
- **Windows 업데이트:** 이 버전에서 업데이트하면 설치 기록이 없어도 현재 설치 폴더를 유지합니다. (#1277)
- **Kiro 할당량:** CLI 기본 엔진이 v3일 때 할당량을 읽지 못하던 문제를 수정하고, 새로고침 시 유료 모델 요청이 발생하지 않도록 했습니다. (#1320)
- **노치 월 표시:** 기본적으로 현재 월을 표시하고, 날짜에 마우스를 올리거나 키보드로 포커스하면 해당 날짜의 월을 표시합니다. (#1316)
- **Cursor 대시보드:** 계정 설정 버튼으로 브라우저가 열리지 않던 문제를 수정했습니다. (#1312)
- **Copilot 할당량:** Chat에 초기화 시간이 표시되지 않을 때 아래에 남던 빈 공간을 제거했습니다. (#1313)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.84.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-Setup-0.84.1.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.84.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 改善
- **エッジドック:** 詳細カードの切り替え時に、位置と内容が滑らかに変化します。 (#1309)
- **ノッチのセッション:** ツール名の重複表示をなくし、モデル、推論強度、時間を表示するスペースを広げました。 (#1325)
- **Cursorの設定:** ログイン後にGrokへ転送された場合、Cursorに戻って正しいCookieを取得する手順を案内します。 (#1303)

### 修正
- **Windowsの更新:** このバージョンから更新する際は、インストール情報が失われていても現在のインストール先を維持します。 (#1277)
- **Kiroの利用枠:** CLIの既定エンジンがv3の場合に利用枠を取得できない問題を修正し、更新のたびに有料のモデルリクエストが発生するのを防ぎます。 (#1320)
- **ノッチの月表示:** 通常は現在の月を表示し、日付にカーソルを合わせるかキーボードで選択すると、その日付の月を表示します。 (#1316)
- **Cursorダッシュボード:** アカウント設定のボタンでブラウザが開かない問題を修正。 (#1312)
- **Copilotの利用枠:** Chatにリセット時刻が表示されない場合の余分な下余白を削除しました。 (#1313)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.84.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-Setup-0.84.1.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.84.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.84.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.1/Token-Monitor-0.84.1.AppImage)

</details>

</details>
