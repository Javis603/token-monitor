# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Junie and OpenCodeReview.** Track token usage from local sessions and refresh as their logs change. New profiles track both by default. In existing profiles, check your selections under Collection. (#1579)
- **Session context meters.** See context usage and remaining capacity for recent Grok Build, WorkBuddy, and CatPaw sessions when the data is available. (#1552)

### Changed
- **Main settings.** Use the sidebar to configure each view, reorder visible views, and restore hidden ones. (#1570, #1572)
- **Settings layout.** General, Appearance, Collection, and AI Tool Limits use grouped cards. Appearance has a color picker with live preview. (#1577, #1580, #1582)

### Improved
- **Edge Dock colors.** Quota rings and running tool icons keep their vendor colors in light and dark themes. (#1573)
- **Usage updates.** Reduce the work needed to refresh usage, especially when the current month has many sessions. (#1567)
- **Session list.** Refresh rows more efficiently as usage and activity change. (#1568)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.95.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-Setup-0.95.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.95.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.AppImage)

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
- **Junie 和 OpenCodeReview：** 支持追踪本地会话的 Token 用量，日志更新时自动刷新。新配置默认追踪这两个工具，已有配置可在“采集”中查看所选工具。 （#1579）
- **会话上下文用量：** 在数据可用时，显示 Grok Build、WorkBuddy 和 CatPaw 近期会话的上下文用量和剩余容量。 （#1552）

### 变更
- **主画面设置：** 在侧栏配置各个视图、调整可见视图的顺序，或恢复隐藏视图。 （#1570, #1572）
- **设置布局：** 常规、外观、采集和 AI 工具额度改用分组卡片。外观加入可实时预览的取色器。 （#1577, #1580, #1582）

### 改进
- **Edge Dock 配色：** 额度圆环和运行中的工具图标在浅色和深色主题下均保留服务商配色。 （#1573）
- **用量刷新：** 降低刷新用量的处理开销，尤其是当月会话较多时。 （#1567）
- **会话列表：** 用量和活动变化时，更高效地刷新列表。 （#1568）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.95.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-Setup-0.95.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.95.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.94.0...v0.95.0">v0.94.0...v0.95.0</a></summary>

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
- **Junie 與 OpenCodeReview：** 支援追蹤本機會話的 Token 用量，並在記錄更新時自動重新整理。新設定預設追蹤這兩個工具，已有設定可在「採集」查看已選工具。 （#1579）
- **會話上下文用量：** 資料可用時，顯示 Grok Build、WorkBuddy 與 CatPaw 近期會話的上下文用量與剩餘容量。 （#1552）

### 變更
- **主畫面設定：** 從側欄設定各個檢視、調整顯示順序，或恢復隱藏的檢視。 （#1570, #1572）
- **設定版面：** 一般、外觀、採集與 AI 工具額度改用分組卡片。外觀加入可即時預覽的選色器。 （#1577, #1580, #1582）

### 改進
- **Edge Dock 配色：** 額度圓環與執行中的工具圖示在淺色及深色主題下都會保留服務商配色。 （#1573）
- **用量重新整理：** 減少更新用量所需的處理工作，尤其是當月會話較多時。 （#1567）
- **會話清單：** 用量與活動變動時，更有效率地更新清單。 （#1568）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.95.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-Setup-0.95.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.95.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Junie 및 OpenCodeReview.** 로컬 세션의 토큰 사용량을 추적하고 로그가 바뀌면 갱신합니다. 새 프로필에는 두 도구가 기본으로 포함되며, 기존 프로필의 선택은 ‘수집’에서 확인할 수 있습니다. (#1579)
- **세션 컨텍스트 표시.** 데이터가 있는 최근 Grok Build, WorkBuddy, CatPaw 세션에서 컨텍스트 사용량과 남은 용량을 확인할 수 있습니다. (#1552)

### 변경
- **메인 화면 설정.** 사이드바에서 보기를 설정하고, 표시 순서를 바꾸거나 숨긴 보기를 복원할 수 있습니다. (#1570, #1572)
- **설정 화면 구성.** 일반, 외관, 수집, AI 도구 한도 설정을 카드로 정리했습니다. 외관의 색상 선택기에서 색상을 실시간으로 미리 볼 수 있습니다. (#1577, #1580, #1582)

### 개선
- **Edge Dock 색상.** 밝은 테마와 어두운 테마에서 한도 링과 실행 중인 도구 아이콘이 제공업체 색상을 유지합니다. (#1573)
- **사용량 갱신.** 사용량을 갱신할 때 처리 부담을 줄였습니다. 특히 이번 달 세션이 많을 때 효과가 있습니다. (#1567)
- **세션 목록.** 사용량과 활동 상태가 바뀔 때 목록을 더 효율적으로 갱신합니다. (#1568)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.95.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-Setup-0.95.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.95.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Junie と OpenCodeReview。** ローカルセッションのトークン使用量を追跡し、ログの変更に合わせて更新します。新規プロファイルでは両方が既定で有効です。既存のプロファイルでは「収集」で選択を確認できます。 （#1579）
- **セッションのコンテキスト表示。** データを取得できる場合、Grok Build、WorkBuddy、CatPaw の最近のセッションでコンテキストの使用量と残り容量を確認できます。 （#1552）

### 変更
- **メイン画面の設定。** サイドバーでビューの設定や並べ替え、非表示のビューの復元ができます。 （#1570, #1572）
- **設定画面の構成。** 一般、外観、収集、AIツール制限の設定をカードで整理しました。外観のカラーピッカーでは、色を選びながらプレビューできます。 （#1577, #1580, #1582）

### 改善
- **Edge Dock の配色。** ライトテーマでもダークテーマでも、利用枠のリングと実行中のツールのアイコンにプロバイダーの色が使われます。 （#1573）
- **使用量の更新。** 今月のセッションが多いときなどに、使用量の更新負荷を軽減しました。 （#1567）
- **セッション一覧。** 使用量やアクティビティが変わったときに、一覧をより効率よく更新します。 （#1568）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.95.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-Setup-0.95.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.95.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.95.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.0/Token-Monitor-0.95.0.AppImage)

</details>

</details>
