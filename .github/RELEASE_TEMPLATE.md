# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Edge Dock glass on Windows:** Adds a System glass style that follows the dock's curves on Windows 11; Windows 10 keeps the tinted style. (#1165)
- **Edge Dock and Notch Panel glass on macOS:** Adds Transparent to the Edge Dock's glass style, and the dock and notch styles now apply even when the widget's glass is off. (#1187)
- **ZCode session titles:** Shows saved ZCode titles in Sessions and groups subagent sessions under their parent. (#1183)

### Fixed
- **Hover tooltips:** Removes system tooltips that could linger over other apps, including the Edge Dock's. (#1176)
- **Edge Dock on Windows:** Revealing a card no longer leaves the rail behind other windows. (#1186)
- **Claude quota checks:** Run in a private app folder instead of the shared temporary directory. (#1161)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.78.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.78.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-Setup-0.78.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.78.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.AppImage)

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
- **Windows 侧边栏玻璃：** 新增“系统”玻璃样式，在 Windows 11 上贴合侧边栏的弧形轮廓；Windows 10 沿用着色样式。 （#1165）
- **macOS 侧边栏与刘海面板玻璃：** 侧边栏玻璃样式新增“透明”，侧边栏和刘海面板的样式在主窗口关闭玻璃时同样生效。 （#1187）
- **ZCode 会话标题：** 在“会话”中显示 ZCode 已保存的标题，并将子代理会话归入其父会话。 （#1183）

### 修复
- **悬停提示：** 移除可能滞留在其他应用上方的系统悬停提示，包括侧边栏的提示。 （#1176）
- **Windows 侧边栏：** 展开卡片时，侧边栏不再被其他窗口遮挡。 （#1186）
- **Claude 额度检查：** 改在应用私有目录中运行，不再使用共享临时目录。 （#1161）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.78.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.78.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-Setup-0.78.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.78.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.77.0...v0.78.0">v0.77.0...v0.78.0</a></summary>

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
- **Windows 側邊欄玻璃：** 新增「系統」玻璃樣式，在 Windows 11 上貼合側邊欄的弧形輪廓；Windows 10 沿用著色樣式。 （#1165）
- **macOS 側邊欄與瀏海面板玻璃：** 側邊欄玻璃樣式新增「透明」，側邊欄與瀏海面板的樣式在主視窗關閉玻璃時同樣生效。 （#1187）
- **ZCode 會話標題：** 在「會話」中顯示 ZCode 已儲存的標題，並將子代理會話歸入其父會話。 （#1183）

### 修復
- **懸停提示：** 移除可能滯留在其他應用程式上方的系統懸停提示，包括側邊欄的提示。 （#1176）
- **Windows 側邊欄：** 展開卡片時，側邊欄不再被其他視窗遮住。 （#1186）
- **Claude 額度檢查：** 改在應用程式私有目錄中執行，不再使用共用暫存目錄。 （#1161）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.78.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.78.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-Setup-0.78.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.78.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Windows 가장자리 도크 글래스:** Windows 11에서 도크의 곡선 윤곽에 맞는 '시스템' 글래스 스타일을 추가했습니다. Windows 10은 기존 틴트 스타일을 유지합니다. (#1165)
- **macOS 가장자리 도크·노치 패널 글래스:** 가장자리 도크의 글래스 스타일에 '투명'을 추가했고, 위젯의 글래스를 꺼도 도크와 노치 패널의 스타일이 적용됩니다. (#1187)
- **ZCode 세션 제목:** '세션'에 ZCode에 저장된 제목을 표시하고, 서브에이전트 세션을 상위 세션 아래로 묶어 보여줍니다. (#1183)

### 수정
- **마우스 오버 툴팁:** 다른 앱 위에 남아 있을 수 있던 시스템 툴팁(가장자리 도크 포함)을 제거했습니다. (#1176)
- **Windows 가장자리 도크:** 카드를 펼칠 때 도크가 다른 창 뒤에 가려지지 않습니다. (#1186)
- **Claude 한도 확인:** 공용 임시 디렉터리 대신 앱 전용 폴더에서 실행합니다. (#1161)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.78.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.78.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-Setup-0.78.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.78.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Windows エッジドックのガラス:** Windows 11 でドックの曲線に沿う「システム」ガラススタイルを追加しました。Windows 10 では従来のティントスタイルを維持します。 (#1165)
- **macOS エッジドックとノッチパネルのガラス:** エッジドックのガラススタイルに「透明」を追加し、ウィジェットのガラスをオフにしてもドックとノッチパネルのスタイルが適用されます。 (#1187)
- **ZCode のセッションタイトル:** 「セッション」に保存済みの ZCode タイトルを表示し、サブエージェントのセッションを親セッションの下にまとめます。 (#1183)

### 修正
- **ホバーツールチップ:** ほかのアプリの上に残ることがあったシステムツールチップ（エッジドックのものを含む）を削除しました。 (#1176)
- **Windows エッジドック:** カードを表示した際に、ドックがほかのウィンドウの背面に残らないようにしました。 (#1186)
- **Claude の上限チェック:** 共有の一時ディレクトリではなく、アプリ専用フォルダーで実行します。 (#1161)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.78.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.78.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-Setup-0.78.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.78.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.78.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.78.0/Token-Monitor-0.78.0.AppImage)

</details>

</details>
