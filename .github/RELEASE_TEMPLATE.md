# English

## What's changed

<!-- app-update-notes:en:start -->
### Improved
- **Workspace tools.** Live Flow and Workspaces show tool icons ordered by usage. The Workspaces list shows each displayed tool’s share of tokens. (#1723)
- **Live Velocity.** Scroll to see more than three active models. The list stays the same height as models start or stop. (#1720)
- **Live Flow animations.** Reduce animation overhead when connections scroll out of view. (#1721)

### Fixed
- **Empty dashboard cards.** Cards keep their layout when there’s no data to show. Attribution only reports no usage history when zero usage is confirmed. (#1720)
- **Device scope.** Hide the device selector in local mode, where there’s only one device. (#1720)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.100.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-Setup-0.100.1.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.100.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.AppImage)

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
### 改进
- **工作区工具。** 实时流向和工作区列表按用量显示工具图标，列表还会显示各图标对应的 Token 占比。 （#1723）
- **实时速率。** 活跃模型超过三个时可滚动查看，模型开始或停止运行时列表高度保持稳定。 （#1720）
- **实时流向动画。** 减少连线滚出可见区域后的动画开销。 （#1721）

### 修复
- **仪表板空白卡片。** 无数据可显示时保留卡片布局。归因分析仅在确认用量为零时提示暂无用量历史。 （#1720）
- **设备范围。** 仅查看本机数据时隐藏设备选择器。 （#1720）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.100.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-Setup-0.100.1.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.100.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.100.0...v0.100.1">v0.100.0...v0.100.1</a></summary>

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
- **工作區工具。** 即時流向和工作區清單依用量排列工具圖示，清單也會顯示各圖示對應的 Token 佔比。 （#1723）
- **即時速度。** 活躍模型超過三個時可捲動查看，模型開始或停止執行時清單高度維持穩定。 （#1720）
- **即時流向動畫。** 減少連線捲出可見範圍後的動畫負擔。 （#1721）

### 修復
- **儀表板空白卡片。** 沒有資料可顯示時保留卡片版面。歸因分析只會在確認用量為零時提示尚無歷史用量。 （#1720）
- **裝置範圍。** 僅查看本機資料時隱藏裝置選擇器。 （#1720）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.100.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-Setup-0.100.1.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.100.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 개선
- **워크스페이스 도구.** 실시간 흐름과 워크스페이스 목록에 사용량 순으로 도구 아이콘을 표시합니다. 목록에서는 표시된 도구별 토큰 비중도 확인할 수 있습니다. (#1723)
- **실시간 속도.** 활성 모델이 세 개를 넘으면 스크롤해서 볼 수 있습니다. 모델이 시작하거나 멈춰도 목록 높이는 일정합니다. (#1720)
- **실시간 흐름 애니메이션.** 연결선이 스크롤 영역 밖으로 벗어나면 애니메이션 처리 부하를 줄입니다. (#1721)

### 수정
- **빈 대시보드 카드.** 표시할 데이터가 없어도 카드의 레이아웃을 유지합니다. 사용량이 0으로 확인된 경우에만 세부 내역에 사용 기록이 없다고 표시합니다. (#1720)
- **기기 범위.** 로컬 기기만 볼 때는 기기 선택 메뉴를 숨깁니다. (#1720)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.100.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-Setup-0.100.1.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.100.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 改善
- **ワークスペースのツール。** ライブフローとワークスペース一覧で、ツールを使用量順にアイコンで表示します。一覧では表示されたツールごとのトークンの割合も確認できます。 （#1723）
- **ライブ速度。** アクティブなモデルが 4 つ以上ある場合は、スクロールして確認できます。モデルの稼働状況が変わっても一覧の高さは一定です。 （#1720）
- **ライブフローのアニメーション。** スクロールで接続線が表示範囲の外に出たときのアニメーション処理を減らしました。 （#1721）

### 修正
- **ダッシュボードの空のカード。** 表示するデータがないときもカードのレイアウトを保ちます。内訳分析で使用履歴がないと表示するのは、使用量がゼロと確認できた場合だけです。 （#1720）
- **デバイスの絞り込み。** ローカルデバイスだけを表示している場合は、デバイスの選択メニューを非表示にします。 （#1720）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.100.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-Setup-0.100.1.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.100.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.100.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.1/Token-Monitor-0.100.1.AppImage)

</details>

</details>
