# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Redesigned Usage Dashboard.** See live usage, quotas, and active sessions at a glance. Follow activity with Live Flow or explore usage history in interactive 3D. (#1694, #1712)
- **Automatic Amp sync.** Amp usage updates automatically when tracking is enabled and you’re signed in to the Amp CLI. (#1707)
- **Antigravity context usage.** See context usage for supported T3 Code ACP and Antigravity CLI sessions. Standalone CLI sessions require status-line setup. (#1697)
- **Antigravity quota groups.** Choose which model group Edge Dock shows. (#1711)
- **Compact detail tokens.** Turn on this setting to show compact token counts in breakdowns and session details. (#1650)

### Changed
- **Reasonix sessions.** Session records are loaded on demand. Reasonix usage is still counted in overall totals, but its sessions no longer contribute to project breakdowns. (#1661)

### Improved
- **Desktop Hub sync.** Remote Hub connections now follow the desktop app’s proxy settings. (#1616)
- **Antigravity usage scans.** Faster repeat scans when conversations haven’t changed. (#1698)
- **Tray memory usage.** Provider icons use less memory. (#1687)

### Fixed
- **Quota warnings.** Home and the Usage Dashboard use distinct colors for low and exhausted quotas. (#1716)
- **Local Codex Work.** New usage records show the configured model when the turn’s model is unavailable. (#1701)
- **Antigravity sign-in on macOS.** Google sign-in supports installations named Antigravity IDE. (#1708)
- **Narrow Settings windows.** Section titles stay readable at smaller window widths. (#1703)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.100.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-Setup-0.100.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.100.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.AppImage)

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
- **全新设计的使用仪表板。** 一览实时用量、额度和活跃会话，通过实时流向查看当前活动，也可用交互式 3D 视图查看用量历史。 （#1694、#1712）
- **Amp 自动同步。** 启用 Amp 追踪并登录 Amp CLI 后，用量会自动更新。 （#1707）
- **Antigravity 上下文用量。** 支持在 T3 Code ACP 和 Antigravity CLI 会话中查看上下文用量。独立 CLI 需要配置状态栏。 （#1697）
- **Antigravity 额度分组。** 可选择侧边栏显示哪个模型分组的额度。 （#1711）
- **明细页使用简写单位。** 开启后，明细页和会话详情将以简写单位显示 Token 数量。 （#1650）

### 变更
- **Reasonix 会话。** 按需加载会话记录。Reasonix 用量仍计入总体统计，会话数据不再纳入项目明细。 （#1661）

### 改进
- **桌面端 Hub 同步。** 连接远程 Hub 时使用桌面应用的代理设置。 （#1616）
- **Antigravity 用量扫描。** 会话未变化时，重复扫描更快。 （#1698）
- **托盘内存占用。** 减少提供者图标的内存占用。 （#1687）

### 修复
- **额度警告。** 首页和使用仪表板用不同颜色区分额度偏低和额度耗尽。 （#1716）
- **本机 Codex Work。** 新采集的用量缺少回合模型时，按配置的模型归类。 （#1701）
- **macOS 上的 Antigravity 登录。** 应用名为 Antigravity IDE 时也支持 Google 登录。 （#1708）
- **窄窗口中的设置。** 缩小窗口时，分区标题更易阅读。 （#1703）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.100.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-Setup-0.100.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.100.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.99.0...v0.100.0">v0.99.0...v0.100.0</a></summary>

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
- **全新設計的使用儀表板。** 一覽即時用量、額度與活躍會話，透過即時流向查看當前活動，也能用互動式 3D 視圖探索歷史用量。 （#1694、#1712）
- **Amp 自動同步。** 啟用 Amp 追蹤並登入 Amp CLI 後，用量會自動更新。 （#1707）
- **Antigravity 上下文用量。** 支援在 T3 Code ACP 與 Antigravity CLI 會話中查看上下文用量。獨立 CLI 需設定狀態列。 （#1697）
- **Antigravity 額度分組。** 可選擇側邊欄要顯示哪個模型分組的額度。 （#1711）
- **明細頁使用簡寫單位。** 開啟後，明細頁和會話詳情會以簡寫單位顯示 Token 數量。 （#1650）

### 變更
- **Reasonix 會話。** 按需載入會話記錄。Reasonix 用量仍會計入整體統計，會話資料不再納入專案明細。 （#1661）

### 改進
- **桌面版 Hub 同步。** 連線至遠端 Hub 時會採用桌面應用程式的代理設定。 （#1616）
- **Antigravity 用量掃描。** 會話沒有變更時，再次掃描會更快。 （#1698）
- **系統匣記憶體用量。** 降低提供者圖示的記憶體用量。 （#1687）

### 修復
- **額度警告。** 首頁與使用儀表板以不同顏色區分額度偏低及額度耗盡。 （#1716）
- **本機 Codex Work。** 新採集的用量缺少回合模型時，會依設定的模型歸類。 （#1701）
- **macOS 上的 Antigravity 登入。** 應用程式名稱為 Antigravity IDE 時也支援 Google 登入。 （#1708）
- **窄視窗中的設定。** 縮小視窗時，區段標題更容易閱讀。 （#1703）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.100.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-Setup-0.100.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.100.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **새롭게 디자인한 사용 대시보드.** 실시간 사용량, 한도, 활성 세션을 한눈에 볼 수 있습니다. 실시간 흐름으로 현재 활동을 살펴보거나 인터랙티브 3D 보기로 사용 기록을 확인하세요. (#1694, #1712)
- **Amp 자동 동기화.** Amp 추적을 켜고 Amp CLI에 로그인하면 사용량이 자동으로 갱신됩니다. (#1707)
- **Antigravity 컨텍스트 사용량.** 지원되는 T3 Code ACP 및 Antigravity CLI 세션에서 컨텍스트 사용량을 볼 수 있습니다. 독립 실행형 CLI에는 상태 줄 설정이 필요합니다. (#1697)
- **Antigravity 한도 그룹.** 가장자리 도크에 표시할 모델 그룹을 선택할 수 있습니다. (#1711)
- **상세 보기 토큰 축약 표시.** 켜면 세부 내역과 세션 상세의 토큰 수를 축약해서 표시합니다. (#1650)

### 변경
- **Reasonix 세션.** 필요할 때 세션 기록을 불러옵니다. Reasonix 사용량은 전체 집계에 계속 포함되며, 세션 데이터는 프로젝트 내역에서 제외됩니다. (#1661)

### 개선
- **데스크톱 Hub 동기화.** 원격 Hub에 연결할 때 데스크톱 앱의 프록시 설정을 적용합니다. (#1616)
- **Antigravity 사용량 스캔.** 대화에 변경이 없으면 다시 스캔하는 속도가 빨라집니다. (#1698)
- **트레이 메모리 사용량.** 제공자 아이콘의 메모리 사용량이 줄었습니다. (#1687)

### 수정
- **한도 경고.** 홈과 사용 대시보드에서 한도 부족과 소진을 서로 다른 색으로 표시합니다. (#1716)
- **로컬 Codex Work.** 새로 수집한 사용량에 턴 모델 정보가 없으면 설정된 모델로 집계합니다. (#1701)
- **macOS의 Antigravity 로그인.** 앱 이름이 Antigravity IDE인 경우에도 Google 로그인을 지원합니다. (#1708)
- **좁은 설정 창.** 창을 줄여도 섹션 제목을 읽기 쉬워졌습니다. (#1703)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.100.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-Setup-0.100.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.100.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **使用状況ダッシュボードを刷新。** リアルタイムの使用量、上限、アクティブなセッションをまとめて確認できます。現在の動きはライブフローで、使用履歴は操作できる 3D ビューで確認できます。 （#1694、#1712）
- **Amp の自動同期。** Amp の追跡を有効にし、Amp CLI にログインすると、使用量が自動で更新されます。 （#1707）
- **Antigravity のコンテキスト使用量。** 対応する T3 Code ACP と Antigravity CLI のセッションで確認できます。CLI を単独で使う場合はステータスラインの設定が必要です。 （#1697）
- **Antigravity の上限グループ。** エッジドックに表示するモデルグループを選べます。 （#1711）
- **詳細ページのトークンを短縮表示。** 有効にすると、内訳やセッション詳細のトークン数を短縮表示します。 （#1650）

### 変更
- **Reasonix セッション。** 必要なときにセッション記録を読み込みます。Reasonix の使用量は全体の集計に引き続き含まれ、セッションデータはプロジェクトの内訳から外れます。 （#1661）

### 改善
- **デスクトップの Hub 同期。** リモート Hub への接続にデスクトップアプリのプロキシ設定が適用されます。 （#1616）
- **Antigravity の使用量スキャン。** 会話に変更がない場合、再スキャンが速くなります。 （#1698）
- **トレイのメモリ使用量。** プロバイダーアイコンのメモリ使用量を削減しました。 （#1687）

### 修正
- **上限の警告。** ホームと使用状況ダッシュボードで、残量が少ない場合と使い切った場合を別の色で表示します。 （#1716）
- **ローカルの Codex Work。** 新たに収集した使用量にターンのモデル情報がない場合、設定されたモデルで集計します。 （#1701）
- **macOS の Antigravity ログイン。** アプリ名が Antigravity IDE の場合も Google ログインに対応します。 （#1708）
- **幅の狭い設定ウィンドウ。** ウィンドウを狭めてもセクション名が読みやすくなりました。 （#1703）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.100.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.100.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-Setup-0.100.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.100.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.100.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.100.0/Token-Monitor-0.100.0.AppImage)

</details>

</details>
