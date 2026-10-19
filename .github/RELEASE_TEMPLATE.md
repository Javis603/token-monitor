# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Liquid Glass (Clear):** Adds a clear glass style on macOS 26+, with separate tint controls for Regular and Clear. (#1098)
- **Project breakdowns:** Expand a project to switch between Tools and Models token shares. (#1086)
- **Kilo Code on macOS and Windows:** Supports usage tracking for the native VS Code extension. (#1101)
- **Top Notch on macOS:** Adds an experimental entry, still in development and off by default. (#998)

### Improved
- **Edge Dock glass previews:** Preview opacity, depth and tint changes while dragging the sliders. (#1098)

### Fixed
- **Grok usage:** Includes reasoning tokens in output and total usage. (#1091)
- **Tool token breakdowns:** Fully classified usage no longer appears as Unclassified in weekly, 7-day and 30-day ranges. (#1095)
- **macOS Edge Dock:** Avoids stealing focus and raising the main window when clicked. (#1097)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.74.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.74.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-Setup-0.74.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.74.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.AppImage)

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
- **Liquid Glass（通透）：** 新增 macOS 26+ 通透玻璃样式，标准与通透样式可分别调整染色强度。 （#1098）
- **项目分解：** 展开项目后，可切换“工具”和“模型”的 Tokens 占比。 （#1086）
- **macOS 与 Windows 的 Kilo Code：** 新增原生 VS Code 扩展的用量追踪支持。 （#1101）
- **macOS 顶部刘海：** 新增实验性入口，仍在开发中，默认关闭。 （#998）

### 改进
- **侧边栏玻璃预览：** 拖动滑块时，即时预览不透明度、深度与染色变化。 （#1098）

### 修复
- **Grok 用量：** 将推理 Tokens 计入输出与总用量。 （#1091）
- **工具用量分类：** 修复本周、最近 7 天和最近 30 天将已分类用量显示为未分类的问题。 （#1095）
- **macOS 侧边栏：** 修复点击时抢占焦点、可能弹出主窗口的问题。 （#1097）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.74.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.74.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-Setup-0.74.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.74.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.73.0...v0.74.0">v0.73.0...v0.74.0</a></summary>

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
- **Liquid Glass（通透）：** 新增 macOS 26+ 通透玻璃樣式，標準與通透樣式可分別調整染色強度。 （#1098）
- **專案分解：** 展開專案後，可切換「工具」與「模型」的 Token 佔比。 （#1086）
- **macOS 與 Windows 的 Kilo Code：** 新增原生 VS Code 擴充功能的用量追蹤支援。 （#1101）
- **macOS 頂部瀏海：** 新增實驗性入口，仍在開發中，預設關閉。 （#998）

### 改進
- **側邊欄玻璃預覽：** 拖曳滑桿時，即時預覽不透明度、深度與染色變化。 （#1098）

### 修復
- **Grok 用量：** 將推理 Token 計入輸出與總用量。 （#1091）
- **工具用量分類：** 修復本週、最近 7 日與最近 30 日將已分類用量顯示為未分類的問題。 （#1095）
- **macOS 側邊欄：** 修復點擊時搶佔焦點、可能彈出主視窗的問題。 （#1097）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.74.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.74.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-Setup-0.74.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.74.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Liquid Glass (투명):** macOS 26 이상에서 투명 유리 스타일을 지원하며, 기본 스타일과 투명 스타일의 색조 강도를 각각 조절할 수 있습니다. (#1098)
- **프로젝트 분석:** 프로젝트를 펼치면 ‘도구’와 ‘모델’별 토큰 비중을 전환할 수 있습니다. (#1086)
- **macOS 및 Windows의 Kilo Code:** 네이티브 VS Code 확장 프로그램의 사용량을 추적할 수 있습니다. (#1101)
- **macOS 상단 노치:** 개발 중인 실험적 기능으로 추가했으며, 기본적으로 꺼져 있습니다. (#998)

### 개선
- **가장자리 도크의 유리 효과 미리보기:** 슬라이더를 드래그하는 동안 불투명도, 깊이, 색조 변화를 바로 확인할 수 있습니다. (#1098)

### 수정
- **Grok 사용량:** 추론 토큰을 출력 및 전체 사용량에 포함합니다. (#1091)
- **도구 토큰 분류:** 이번 주, 최근 7일, 최근 30일 범위에서 이미 분류된 사용량이 미분류로 표시되는 문제를 수정했습니다. (#1095)
- **macOS 가장자리 도크:** 클릭할 때 포커스를 빼앗거나 메인 창이 앞으로 나오는 문제를 수정했습니다. (#1097)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.74.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.74.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-Setup-0.74.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.74.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Liquid Glass（クリア）:** macOS 26 以降でクリアなガラススタイルに対応。標準とクリアの色合いの強さを個別に調整できます。 (#1098)
- **プロジェクトの内訳:** プロジェクトを展開すると、トークン比率を「ツール」別と「モデル」別で切り替えられます。 (#1086)
- **macOS・Windows の Kilo Code:** ネイティブの VS Code 拡張機能の使用量追跡に対応しました。 (#1101)
- **macOS の上部ノッチ:** 開発中の実験的機能として追加しました。初期状態ではオフです。 (#998)

### 改善
- **エッジドックのガラス効果プレビュー:** スライダーを動かしながら、不透明度、深さ、色合いの変化を確認できます。 (#1098)

### 修正
- **Grok の使用量:** 推論トークンを出力と合計使用量に含めるよう修正しました。 (#1091)
- **ツールのトークン分類:** 今週・過去 7 日・過去 30 日の範囲で、分類済みの使用量が未分類と表示される問題を修正しました。 (#1095)
- **macOS のエッジドック:** クリック時にフォーカスを奪ったり、メインウィンドウが前面に出たりする問題を修正しました。 (#1097)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.74.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.74.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-Setup-0.74.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.74.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.74.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.74.0/Token-Monitor-0.74.0.AppImage)

</details>

</details>
