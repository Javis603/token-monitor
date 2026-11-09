# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Gemini CLI usage:** Tracks local session token usage. (#1413)

### Improved
- **Plugin quotas:** Shows declared quota modules on Home, Edge Dock, Notch Panel, Tray and Floating Bubble using native layouts. (#1419)
- **Session models:** Shows the last-used model for Codex and Claude sessions, including historical Codex conversations. (#1423, #1434)
- **Desktop memory:** Reduces steady-state memory use. (#1421)
- **Plugin dropdowns:** Uses the shared dropdown style by default for eligible controls, with search in long lists. (#1412)
- **Quota history cards:** Smooths transitions when switching accounts or quotas. (#1426)

### Fixed
- **Quota history:** Continues matching verified-account history across local, Hub and iCloud modes, including existing observations stored on this desktop. (#1424, #1427)
- **Usage timezone:** Aligns usage periods and daily graphs with the system timezone. Existing history is not rebuilt; restart headless agents after timezone changes. (#1420)
- **Grok history:** Keeps new quota readings continuous across recognized xAI account token rotations. Older token-based histories are not merged. (#1422)
- **Grok quota:** Finds common CLI installations missing from the desktop launch environment's PATH. (#1415)
- **Startup appearance:** Applies saved appearance before the first reveal, including when opening from the tray. (#1418, #1435)
- **Edge Dock cards:** Prevents the previous card from flashing when reopening a different item. (#1411)
- **Antigravity sync:** Keeps healthy conversations refreshing when deleted conversations are encountered, preserving their cached usage. (#1432, #1433)
- **Plugin catalog:** Corrects repository-relative README links and shows the version selected for installation. (#1429)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.89.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.89.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-Setup-0.89.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.89.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.AppImage)

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
- **Gemini CLI 用量：** 支持本地会话的 Tokens 用量统计。 （#1413）

### 改进
- **插件额度：** 可在主页、侧边栏、刘海面板、托盘和悬浮球中使用原生布局显示插件声明的额度模块。 （#1419）
- **会话模型：** 显示 Codex 与 Claude 会话最后使用的模型，包含 Codex 历史会话。 （#1423、#1434）
- **桌面内存：** 降低稳定运行时的内存占用。 （#1421）
- **插件下拉菜单：** 适用的控件默认采用统一样式，长列表支持搜索。 （#1412）
- **额度历史卡片：** 切换账户或额度时的过渡更流畅。 （#1426）

### 修复
- **额度历史：** 在本地、Hub 与 iCloud 模式间切换时延续匹配的已验证账户历史，包含本机已保存的观测记录。 （#1424、#1427）
- **用量时区：** 用量周期与每日图表按系统时区统计。不会重建已有历史；无界面代理需在更改时区后重启。 （#1420）
- **Grok 历史：** 已识别的 xAI 账户令牌轮换后，新额度记录保持连续。不会合并旧的令牌历史。 （#1422）
- **Grok 额度：** 支持查找桌面启动环境 PATH 中缺失的常见 CLI 安装位置。 （#1415）
- **启动外观：** 窗口首次显示或从托盘打开时，正确应用已保存的外观设置。 （#1418、#1435）
- **侧边栏卡片：** 重新打开其他项目时，不再短暂闪现上一张卡片。 （#1411）
- **Antigravity 同步：** 遇到已删除的会话时仍可刷新正常会话，并保留已删除会话的缓存用量。 （#1432、#1433）
- **插件目录：** 修复 README 仓库相对链接，并显示实际选定的安装版本。 （#1429）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.89.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.89.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-Setup-0.89.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.89.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.88.0...v0.89.0">v0.88.0...v0.89.0</a></summary>

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
- **Gemini CLI 用量：** 支援本機會話的 Token 用量統計。 （#1413）

### 改進
- **外掛額度：** 可在主頁、側邊欄、瀏海面板、系統匣與懸浮球中，以原生版面顯示外掛宣告的額度模組。 （#1419）
- **會話模型：** 顯示 Codex 與 Claude 會話最後使用的模型，包含 Codex 歷史會話。 （#1423、#1434）
- **桌面記憶體：** 降低穩定運行時的記憶體用量。 （#1421）
- **外掛下拉選單：** 適用的控制項預設採用統一樣式，長清單支援搜尋。 （#1412）
- **額度歷史卡片：** 切換帳戶或額度時的過渡更流暢。 （#1426）

### 修復
- **額度歷史：** 在本機、Hub 與 iCloud 模式間切換時延續相符的已驗證帳戶歷史，包含本機已儲存的觀測記錄。 （#1424、#1427）
- **用量時區：** 用量週期與每日圖表依系統時區統計。不會重建既有歷史；無介面代理需在變更時區後重新啟動。 （#1420）
- **Grok 歷史：** 已識別的 xAI 帳戶權杖輪替後，新額度記錄保持連續。不會合併舊的權杖歷史。 （#1422）
- **Grok 額度：** 支援尋找桌面啟動環境 PATH 中缺少的常見 CLI 安裝位置。 （#1415）
- **啟動外觀：** 視窗首次顯示或從系統匣開啟時，正確套用已儲存的外觀設定。 （#1418、#1435）
- **側邊欄卡片：** 重新開啟其他項目時，不再短暫閃現上一張卡片。 （#1411）
- **Antigravity 同步：** 遇到已刪除的會話時仍可更新正常會話，並保留已刪除會話的快取用量。 （#1432、#1433）
- **外掛目錄：** 修復 README 儲存庫相對連結，並顯示實際選定的安裝版本。 （#1429）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.89.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.89.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-Setup-0.89.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.89.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Gemini CLI 사용량:** 로컬 세션의 토큰 사용량을 집계합니다. (#1413)

### 개선
- **플러그인 할당량:** 선언된 할당량 모듈을 홈, 가장자리 도크, 노치 패널, 트레이와 플로팅 버블의 기본 레이아웃에 표시합니다. (#1419)
- **세션 모델:** Codex와 Claude 세션에서 마지막으로 사용한 모델을 표시하며, 과거 Codex 대화도 지원합니다. (#1423, #1434)
- **데스크톱 메모리:** 안정적으로 실행 중일 때의 메모리 사용량을 줄였습니다. (#1421)
- **플러그인 드롭다운:** 지원되는 컨트롤에 공통 스타일을 기본 적용하고 긴 목록에서 검색을 제공합니다. (#1412)
- **할당량 기록 카드:** 계정이나 할당량을 전환할 때 더 부드럽게 표시합니다. (#1426)

### 수정
- **할당량 기록:** 로컬, Hub, iCloud 모드를 바꿔도 동일한 것으로 확인된 계정의 기록이 이어집니다. 이 데스크톱에 저장된 기존 관측 기록도 포함합니다. (#1424, #1427)
- **사용량 시간대:** 사용량 집계 기간과 일별 그래프가 시스템 시간대를 따르도록 수정했습니다. 기존 기록은 다시 계산하지 않습니다. 시간대를 바꾼 뒤에는 헤드리스 에이전트를 다시 시작해야 합니다. (#1420)
- **Grok 기록:** 식별된 xAI 계정의 토큰이 교체되어도 새 할당량 기록이 이어집니다. 이전 토큰별 기록은 합치지 않습니다. (#1422)
- **Grok 할당량:** 데스크톱 실행 환경의 PATH에 없는 일반적인 CLI 설치 경로도 찾습니다. (#1415)
- **시작 화면:** 트레이에서 열 때를 포함해 창이 처음 표시되기 전에 저장된 외관 설정을 적용합니다. (#1418, #1435)
- **Edge Dock 카드:** 다른 항목을 다시 열 때 이전 카드가 잠깐 나타나는 문제를 수정했습니다. (#1411)
- **Antigravity 동기화:** 삭제된 대화가 있어도 정상 대화를 갱신하고, 삭제된 대화의 캐시 사용량은 보존합니다. (#1432, #1433)
- **플러그인 카탈로그:** README의 저장소 상대 링크를 수정하고 실제 설치할 버전을 표시합니다. (#1429)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.89.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.89.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-Setup-0.89.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.89.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Gemini CLIの使用量:** ローカルセッションのトークン使用量に対応しました。 (#1413)

### 改善
- **プラグインの使用量上限:** 宣言された上限モジュールを、ホーム、エッジドック、ノッチパネル、トレイ、フローティングバブルの標準レイアウトに表示できます。 (#1419)
- **セッションのモデル:** CodexとClaudeのセッションで最後に使用したモデルを表示します。過去のCodexの会話にも対応します。 (#1423, #1434)
- **デスクトップのメモリ:** 安定稼働時のメモリ使用量を削減しました。 (#1421)
- **プラグインのドロップダウン:** 対応するコントロールに共通スタイルを標準で適用し、長いリストでは検索できます。 (#1412)
- **使用量上限の履歴カード:** アカウントや上限を切り替える際の動きを滑らかにしました。 (#1426)

### 修正
- **使用量上限の履歴:** ローカル、Hub、iCloudモードを切り替えても、同一と確認されたアカウントの履歴が続くようにしました。このデスクトップに保存済みの観測記録も引き継ぎます。 (#1424, #1427)
- **使用量のタイムゾーン:** 集計期間と日別グラフがシステムのタイムゾーンに従うようにしました。既存の履歴は再計算しません。変更後はヘッドレスエージェントの再起動が必要です。 (#1420)
- **Grokの履歴:** 識別できたxAIアカウントのトークンが更新されても、新しい上限記録が途切れないようにしました。古いトークン別の履歴は統合しません。 (#1422)
- **Grokの使用量上限:** デスクトップの起動環境のPATHにない、一般的なCLIのインストール先も検出します。 (#1415)
- **起動時の外観:** トレイから開く場合も、初めてウィンドウを表示する前に保存済みの外観設定を適用します。 (#1418, #1435)
- **Edge Dockのカード:** 別の項目を開き直した際に、前のカードが一瞬表示される問題を修正しました。 (#1411)
- **Antigravityの同期:** 削除済みの会話があっても正常な会話を更新し、削除済み会話の使用量キャッシュは保持します。 (#1432, #1433)
- **プラグインカタログ:** READMEのリポジトリ相対リンクを修正し、実際にインストールするバージョンを表示します。 (#1429)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.89.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.89.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-Setup-0.89.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.89.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.89.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.89.0/Token-Monitor-0.89.0.AppImage)

</details>

</details>
