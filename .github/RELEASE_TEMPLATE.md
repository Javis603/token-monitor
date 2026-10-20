# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Home list counts:** Choose 1–50 items independently for Tools, Models, Sessions and Devices. (#1136)
- **macOS Notch gestures:** Swipe to open or close the panel and hide or restore its summary in “Grow” mode. (#1124)
- **Antigravity quota:** Adds a separate Gemini 4 Argon allowance. (#1074)

### Changed
- **macOS Notch menu-bar overlap:** Removes menu-bar avoidance; wide custom summaries can overlap menu-bar items. (#1124)

### Improved
- **macOS Notch and Edge Dock animations:** Reduces processing overhead during animations. (#1130)
- **View and settings icons:** Aligns icon proportions, sizes and spacing. (#1129)

### Fixed
- **Windows Edge Dock:** Fixes the dock staying behind other windows after unlocking the screen or revealing it again. (#1123)
- **Antigravity quota readings:** Missing readings no longer appear as exhausted quota. (#1074)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.76.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.76.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-Setup-0.76.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.76.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.AppImage)

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
- **主页列表数量：** 可分别为“工具”、“模型”、“会话”和“设备”设置 1–50 个显示项目。 （#1136）
- **macOS 刘海手势：** 在“轻微放大”模式下，支持滑动展开或收起面板、隐藏或恢复摘要。 （#1124）
- **Antigravity 额度：** 新增 Gemini 4 Argon 独立额度显示。 （#1074）

### 变更
- **macOS 刘海与菜单栏：** 移除菜单栏避让，较宽的自定义摘要可能覆盖菜单栏项目。 （#1124）

### 改进
- **macOS 刘海与侧边栏动画：** 减少动画过程中的处理开销。 （#1130）
- **视图与设置图标：** 统一图标比例、尺寸与间距。 （#1129）

### 修复
- **Windows 侧边栏：** 修复屏幕解锁或重新显示后被其他窗口遮挡的问题。 （#1123）
- **Antigravity 额度读数：** 缺失的读数不再显示为额度耗尽。 （#1074）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.76.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.76.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-Setup-0.76.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.76.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.75.0...v0.76.0">v0.75.0...v0.76.0</a></summary>

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
- **主頁列表數量：** 可分別為「工具」、「模型」、「會話」與「裝置」設定 1–50 個顯示項目。 （#1136）
- **macOS 瀏海手勢：** 在「輕微放大」模式下，可滑動展開或收起面板、隱藏或恢復摘要。 （#1124）
- **Antigravity 額度：** 新增 Gemini 4 Argon 獨立額度顯示。 （#1074）

### 變更
- **macOS 瀏海與選單列：** 移除選單列避讓，較寬的自訂摘要可能覆蓋選單列項目。 （#1124）

### 改進
- **macOS 瀏海與側邊欄動畫：** 減少動畫過程中的處理負擔。 （#1130）
- **視圖與設定圖示：** 統一圖示比例、尺寸與間距。 （#1129）

### 修復
- **Windows 側邊欄：** 修復螢幕解鎖或重新顯示後被其他視窗遮擋的問題。 （#1123）
- **Antigravity 額度讀數：** 缺失的讀數不再顯示為額度耗盡。 （#1074）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.76.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.76.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-Setup-0.76.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.76.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **홈 목록 표시 개수:** 도구, 모델, 세션, 기기별로 표시할 항목 수를 1~50개로 설정할 수 있습니다. (#1136)
- **macOS 노치 제스처:** ‘살짝 확대’ 모드에서 스와이프로 패널을 열고 닫거나 요약을 숨기고 다시 표시할 수 있습니다. (#1124)
- **Antigravity 한도:** Gemini 4 Argon 한도를 별도로 표시합니다. (#1074)

### 변경
- **macOS 노치와 메뉴 막대:** 메뉴 막대 피하기 기능을 제거했습니다. 너비가 넓은 사용자 지정 요약은 메뉴 막대 항목과 겹칠 수 있습니다. (#1124)

### 개선
- **macOS 노치와 가장자리 도크 애니메이션:** 애니메이션 중 처리 부담을 줄였습니다. (#1130)
- **뷰 및 설정 아이콘:** 아이콘의 비율, 크기, 간격을 통일했습니다. (#1129)

### 수정
- **Windows 가장자리 도크:** 화면 잠금을 해제하거나 도크를 다시 표시한 뒤 다른 창 뒤에 가려지던 문제를 수정했습니다. (#1123)
- **Antigravity 한도 수치:** 수치가 없을 때 한도를 모두 소진한 것으로 표시하지 않습니다. (#1074)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.76.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.76.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-Setup-0.76.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.76.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **ホームのリスト表示件数:** ツール、モデル、セッション、デバイスごとに、表示件数を1〜50件に設定できます。 (#1136)
- **macOS のノッチジェスチャ:** 「少し拡大」モードで、スワイプによるパネルの開閉や概要の非表示・再表示に対応しました。 (#1124)
- **Antigravity の上限:** Gemini 4 Argon の上限を個別に表示します。 (#1074)

### 変更
- **macOS のノッチとメニューバー:** メニューバーを避ける機能を削除しました。幅の広いカスタム概要は、メニューバーの項目と重なる場合があります。 (#1124)

### 改善
- **macOS のノッチとエッジドックのアニメーション:** アニメーション中の処理負荷を軽減しました。 (#1130)
- **ビューと設定のアイコン:** アイコンの比率、サイズ、間隔を統一しました。 (#1129)

### 修正
- **Windows のエッジドック:** 画面のロック解除後や再表示時に、ほかのウィンドウに隠れたままになる問題を修正しました。 (#1123)
- **Antigravity の上限値:** 値を取得できない場合に、上限を使い切ったと表示しなくなりました。 (#1074)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.76.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.76.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-Setup-0.76.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.76.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.76.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.76.0/Token-Monitor-0.76.0.AppImage)

</details>

</details>
