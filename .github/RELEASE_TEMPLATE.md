# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Notion AI credits.** Show reported Standard and Select credit pools, allowances, and resets in Limits and the sidebar. (#1612)
- **MiniMax Code usage.** Add relocated data directories containing `v2/sessions` as custom scan paths. Usage found in both locations is counted once. (#1618)

### Improved
- **Multi-device Sync.** See the sync target, connection status, and devices in one map. Supported Node Hubs are identified as built-in or standalone. (#1624, #1606)
- **Window settings.** Switch directly between display surfaces and adjust their options on a single page. (#1611)
- **Background memory.** Reduce memory use after full scans and while the tray window is hidden. On macOS, tray mode can also release idle display surfaces while the screen is locked, with collection continuing. (#1607, #1608, #1617)
- **Codex archive watching.** Reduce file watcher usage for compressed archives while retaining their usage in scans. (#1626)
- **Quota history.** Rows that open the history card use the same hover highlight as the sidebar. (#1619)

### Fixed
- **Antigravity.** Restore desktop usage sync and grouped quotas, keep the last successful quota reading through temporary refresh failures, and correct cost estimates for known Orchestrator models. (#1597, #1613)
- **Usage trends.** Keep missing dates visible and distinguish them from recorded zero usage. Empty candlestick intervals remain hoverable. (#1534)
- **Home trend line.** Keep the stroke width consistent in wide windows. (#1621)
- **Windows main window.** Fix a blank window that could appear after minimizing and restoring it. (#1589)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.96.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-Setup-0.96.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.96.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.AppImage)

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
- **Notion AI 点数：** 在额度页面和侧边栏显示账号提供的 Standard 与 Select 点数、总额度和重置时间。 （#1612）
- **MiniMax Code 用量：** 可将迁移后包含 `v2/sessions` 的数据目录加入自定义扫描路径。两处共有的记录只计一次。 （#1618）

### 改进
- **多设备同步：** 在一张图中查看同步目标、连接状态和设备。支持识别内置和独立运行的 Node Hub。 （#1624, #1606）
- **窗口设置：** 可直接切换各显示界面，在同一页调整选项。 （#1611）
- **后台内存：** 降低完整扫描后及托盘窗口隐藏时的内存占用。macOS 托盘模式在锁屏时还可释放闲置界面，用量采集继续运行。 （#1607, #1608, #1617）
- **Codex 归档监听：** 减少压缩归档占用的文件监听资源，扫描仍会计入归档用量。 （#1626）
- **额度历史：** 可打开历史卡片的额度行，悬停高亮与侧边栏一致。 （#1619）

### 修复
- **Antigravity：** 恢复桌面版用量同步和分组额度显示，刷新暂时失败时保留上次成功读数，并修正已知 Orchestrator 模型的费用估算。 （#1597, #1613）
- **用量趋势：** 保留缺少记录的日期，与已记录的零用量区分开来。空白 K 线区间也可悬停查看。 （#1534）
- **主页趋势线：** 修复宽窗口下线条粗细不均的问题。 （#1621）
- **Windows 主窗口：** 修复最小化后恢复时可能出现空白的问题。 （#1589）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.96.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-Setup-0.96.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.96.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.95.1...v0.96.0">v0.95.1...v0.96.0</a></summary>

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
- **Notion AI 點數：** 在額度頁面與側邊欄顯示帳號提供的 Standard 和 Select 點數、總額度及重設時間。 （#1612）
- **MiniMax Code 用量：** 可將搬移後含有 `v2/sessions` 的資料目錄加入自訂掃描路徑。兩處重複的紀錄只算一次。 （#1618）

### 改進
- **多裝置同步：** 在同一張圖查看同步目標、連線狀態與裝置，並辨識支援的內建或獨立 Node Hub。 （#1624, #1606）
- **視窗設定：** 可直接切換各顯示介面，在同一頁調整選項。 （#1611）
- **背景記憶體：** 降低完整掃描後及系統匣視窗隱藏時的記憶體用量。macOS 選單列模式在鎖定畫面時也可釋放閒置介面，用量採集會繼續。 （#1607, #1608, #1617）
- **Codex 封存監聽：** 減少壓縮封存佔用的檔案監聽資源，掃描仍會計入封存用量。 （#1626）
- **額度歷史：** 可開啟歷史卡片的額度列，游標停駐效果與側邊欄一致。 （#1619）

### 修復
- **Antigravity：** 恢復桌面版用量同步與分組額度顯示，重新整理暫時失敗時保留上次成功讀數，並修正已知 Orchestrator 模型的費用估算。 （#1597, #1613）
- **用量趨勢：** 保留缺少紀錄的日期，並與已記錄的零用量區分。空白 K 線區間也可停駐查看。 （#1534）
- **主頁趨勢線：** 修復寬視窗下線條粗細不均的問題。 （#1621）
- **Windows 主視窗：** 修復最小化後還原時可能出現空白的問題。 （#1589）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.96.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-Setup-0.96.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.96.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Notion AI 크레딧.** 한도 화면과 사이드바에 계정에서 제공하는 Standard 및 Select 크레딧, 총 한도, 초기화 시간을 표시합니다. (#1612)
- **MiniMax Code 사용량.** 옮긴 데이터 폴더에 `v2/sessions`가 있으면 사용자 지정 스캔 경로로 추가할 수 있습니다. 양쪽에 있는 기록은 한 번만 집계합니다. (#1618)

### 개선
- **다중 기기 동기화.** 동기화 대상, 연결 상태, 기기를 한눈에 볼 수 있습니다. 지원되는 Node Hub는 내장형 또는 독립 실행형으로 표시합니다. (#1624, #1606)
- **창 설정.** 표시 영역을 바로 전환하고 한 페이지에서 옵션을 조정할 수 있습니다. (#1611)
- **백그라운드 메모리.** 전체 스캔 후와 트레이 창을 숨겼을 때 메모리 사용량을 줄였습니다. macOS 메뉴 막대 모드에서는 화면을 잠그면 유휴 UI의 메모리도 줄이며 사용량 수집은 계속됩니다. (#1607, #1608, #1617)
- **Codex 아카이브 감시.** 압축 아카이브에 쓰는 파일 감시 리소스를 줄였습니다. 아카이브 사용량은 스캔에 계속 포함됩니다. (#1626)
- **한도 기록.** 기록 카드를 여는 행에 마우스를 올리면 사이드바와 같은 강조 효과가 나타납니다. (#1619)

### 수정
- **Antigravity.** 데스크톱 사용량 동기화와 그룹별 한도를 복구했습니다. 일시적인 새로고침 오류가 발생하면 마지막으로 읽은 한도를 유지하며, 알려진 Orchestrator 모델의 예상 비용도 바로잡았습니다. (#1597, #1613)
- **사용량 추세.** 기록이 없는 날짜를 남겨 두고 사용량이 0으로 기록된 날짜와 구분합니다. 빈 캔들 구간에도 마우스를 올려 확인할 수 있습니다. (#1534)
- **홈 추세선.** 창이 넓을 때 선 두께가 고르지 않던 문제를 수정했습니다. (#1621)
- **Windows 메인 창.** 최소화한 창을 복원하면 화면이 비어 보일 수 있던 문제를 수정했습니다. (#1589)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.96.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-Setup-0.96.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.96.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Notion AI クレジット。** アカウントから取得できる Standard と Select のクレジット、上限、リセット時刻を制限画面とサイドバーに表示します。 （#1612）
- **MiniMax Code の使用量。** 移動先のデータフォルダーに `v2/sessions` があれば、カスタムスキャンパスに追加できます。両方の場所にある記録は一度だけ集計します。 （#1618）

### 改善
- **マルチデバイス同期。** 同期先、接続状態、端末を一つの図で確認できます。対応する Node Hub は内蔵型とスタンドアロン型を区別して表示します。 （#1624, #1606）
- **ウィンドウ設定。** 表示先を直接切り替え、同じページで設定を調整できます。 （#1611）
- **バックグラウンドのメモリ。** 全体スキャン後やトレイのウィンドウを隠しているときのメモリ使用量を削減しました。macOS のメニューバーモードでは、画面ロック中に使われていない表示領域を解放し、使用量の収集は続けます。 （#1607, #1608, #1617）
- **Codex アーカイブの監視。** 圧縮アーカイブに使うファイル監視リソースを削減しました。スキャンでは引き続きアーカイブの使用量も集計します。 （#1626）
- **上限の履歴。** 履歴カードを開く行にポインターを重ねると、サイドバーと同じ強調表示になります。 （#1619）

### 修正
- **Antigravity。** デスクトップ版の使用量同期とグループ別の制限表示を復旧しました。一時的な更新エラー時は最後に取得した値を保持し、既知の Orchestrator モデルの推定費用も修正しました。 （#1597, #1613）
- **使用量の推移。** 記録がない日も残し、使用量がゼロと記録された日と区別します。空のローソク足区間もポインターを重ねて確認できます。 （#1534）
- **ホームの推移グラフ。** ウィンドウが広いと線の太さが不均一になる問題を修正しました。 （#1621）
- **Windows のメインウィンドウ。** 最小化から戻したときに画面が空白になることがある問題を修正しました。 （#1589）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.96.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.96.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-Setup-0.96.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.96.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.96.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.96.0/Token-Monitor-0.96.0.AppImage)

</details>

</details>
