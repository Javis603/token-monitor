# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Quota history:** Hover over an account to see remaining quota trends and the last 14 days of observed daily quota usage. History cards can be turned off in settings. Records start accumulating on this computer with the first successful quota reading. (#1352)
- **Claude quota:** Adds “Allow Claude CLI fallback”, enabled by default. Turn it off to prevent quota checks from launching the local Claude CLI on this device. (#1362)

### Improved
- **Windows appearance:** Changing window materials preserves the open interface, scroll position and unfinished input. (#1351)
- **Usage Dashboard:** Reopening an existing window preserves the selected view instead of reloading it. (#1351)

### Fixed
- **Edge Dock balance:** Shows the available balance instead of `--` when no metered quota is available, without inventing a percentage. (#1356)
- **Service status:** Uses configured proxies for status checks, fixing failed checks when a provider’s status page requires a proxy. (#1353)
- **DeepSeek status:** Fixes outages incorrectly appearing as healthy by using current incidents from the official status page. (#1343)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.86.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.86.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-Setup-0.86.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.86.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.AppImage)

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
- **额度历史：** 悬停账户即可查看剩余额度走势与最近 14 天观测到的每日额度用量，也可在设置中关闭历史卡片。记录从首次成功读取额度后开始在本机积累。 （#1352）
- **Claude 额度：** 新增“允许 Claude CLI 备用查询”开关，默认开启。关闭后，此设备的额度查询不再启动本机 Claude CLI。 （#1362）

### 改进
- **Windows 外观：** 切换窗口材质时保留已打开的界面、滚动位置与未完成的输入。 （#1351）
- **使用仪表板：** 重新打开已有窗口时保留当前视图，不再重新加载。 （#1351）

### 修复
- **Edge Dock 余额：** 没有可显示的计量额度时，以可用余额取代 `--`，不推算百分比。 （#1356）
- **服务状态：** 检查时使用已配置的代理，修复服务状态页面需要代理时检查失败的问题。 （#1353）
- **DeepSeek 状态：** 根据官方状态页面的最新事件显示服务状态，修复故障期间仍可能显示正常的问题。 （#1343）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.86.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.86.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-Setup-0.86.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.86.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.85.0...v0.86.0">v0.85.0...v0.86.0</a></summary>

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
- **額度歷史：** 將游標停留在帳戶上，即可查看剩餘額度走勢與最近 14 日觀測到的每日額度用量，也可在設定中關閉歷史卡片。記錄從首次成功讀取額度後開始在本機累積。 （#1352）
- **Claude 額度：** 新增「允許 Claude CLI 備援」開關，預設開啟。關閉後，此裝置的額度查詢不再啟動本機 Claude CLI。 （#1362）

### 改進
- **Windows 外觀：** 切換視窗材質時保留已開啟的介面、捲動位置與未完成的輸入。 （#1351）
- **使用儀表板：** 重新開啟既有視窗時保留目前檢視，不再重新載入。 （#1351）

### 修復
- **Edge Dock 餘額：** 沒有可顯示的計量額度時，以可用餘額取代 `--`，不推算百分比。 （#1356）
- **服務狀態：** 檢查時使用已設定的代理，修復服務狀態頁面需要代理時檢查失敗的問題。 （#1353）
- **DeepSeek 狀態：** 根據官方狀態頁面的最新事件顯示服務狀態，修復故障期間仍可能顯示正常的問題。 （#1343）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.86.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.86.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-Setup-0.86.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.86.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **할당량 기록:** 계정에 마우스를 올리면 남은 할당량 추이와 최근 14일간 관측된 일일 할당량 사용량을 확인할 수 있습니다. 설정에서 기록 카드를 끌 수 있습니다. 기록은 할당량을 처음 조회한 시점부터 이 컴퓨터에 쌓입니다. (#1352)
- **Claude 할당량:** 기본으로 켜져 있는 “Claude CLI 대체 조회 허용” 설정을 추가했습니다. 끄면 이 기기의 할당량 조회 시 로컬 Claude CLI를 실행하지 않습니다. (#1362)

### 개선
- **Windows 외관:** 창 재질을 바꿔도 열린 화면, 스크롤 위치, 작성 중인 입력을 유지합니다. (#1351)
- **사용 대시보드:** 기존 창을 다시 열 때 새로고침하지 않고 선택한 보기를 유지합니다. (#1351)

### 수정
- **Edge Dock 잔액:** 표시할 수 있는 할당량 비율이 없으면 `--` 대신 잔액을 표시하며, 비율을 임의로 계산하지 않습니다. (#1356)
- **서비스 상태:** 설정된 프록시를 사용해 상태 페이지에 프록시가 필요할 때 조회가 실패하던 문제를 수정했습니다. (#1353)
- **DeepSeek 상태:** 공식 상태 페이지의 최신 장애 정보를 반영해, 장애 중에도 정상으로 표시될 수 있던 문제를 수정했습니다. (#1343)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.86.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.86.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-Setup-0.86.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.86.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **割り当て履歴:** アカウントにカーソルを合わせると、残りの割り当ての推移と直近14日間に観測された日別使用量を確認できます。履歴カードは設定でオフにできます。記録は割り当ての取得に初めて成功した時点から、このコンピューターに蓄積されます。 (#1352)
- **Claudeの使用量上限:** 初期状態でオンの「Claude CLI フォールバックを許可」を追加しました。オフにすると、このデバイスで使用量上限を確認する際にローカルのClaude CLIを起動しません。 (#1362)

### 改善
- **Windowsの外観:** ウィンドウのマテリアルを切り替えても、開いている画面、スクロール位置、入力途中の内容を保持します。 (#1351)
- **使用状況ダッシュボード:** 既存のウィンドウを再表示する際、再読み込みせず選択中のビューを保持します。 (#1351)

### 修正
- **Edge Dockの残高:** 割合を表示できる割り当てがない場合、`--`の代わりに残高を表示します。割合の推定は行いません。 (#1356)
- **サービス状態:** 設定済みのプロキシを使用し、状態ページへの接続にプロキシが必要な場合に確認が失敗する問題を修正しました。 (#1353)
- **DeepSeekの状態:** 公式ステータスページの最新の障害情報を反映し、障害中でも正常と表示されることがある問題を修正しました。 (#1343)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.86.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.86.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-Setup-0.86.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.86.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.86.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.86.0/Token-Monitor-0.86.0.AppImage)

</details>

</details>
