# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Session filter:** Filter the Sessions list by tool. (#1335)
- **Remote sessions:** Shows the source device's name and icon when its origin can be identified. (#1338)
- **Device icons:** Choose a hardware icon for each synced device, with choices saved for this app and connection. (#1338)

### Improved
- **Floating menus:** Blurs content behind translucent menus, popovers and dialogs to make text easier to read. (#1332)
- **Senpi usage:** Includes usage from more project subtasks and memory conversations; some of these sessions do not support Session Detail. (#1331)
- **Notch sessions:** Shows the cache hit rate instead of elapsed time when session data is available. (#1327)

### Fixed
- **Copilot usage:** Includes VS Code chats opened without a workspace. (#1331)
- **Claude session titles:** Restores missing Remote Control titles when a matching Claude Desktop title is available. (#1333)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.85.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.85.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-Setup-0.85.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.85.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.AppImage)

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
- **会话筛选：** 支持在“会话”中按工具筛选对话。 （#1335）
- **远程会话：** 来源可确认时，显示所在设备的名称与图标。 （#1338）
- **设备图标：** 支持为同步设备选择硬件图标，选择仅用于当前应用与连接。 （#1338）

### 改进
- **浮动菜单：** 为半透明菜单、弹出面板与对话框增加背景模糊，让文字更易阅读。 （#1332）
- **Senpi 用量：** 纳入更多项目子任务与记忆对话的用量，部分会话暂不支持查看详情。 （#1331）
- **刘海会话：** 有可用数据时显示缓存命中率，取代运行时长。 （#1327）

### 修复
- **Copilot 用量：** 纳入未打开工作区时创建的 VS Code 对话。 （#1331）
- **Claude 会话标题：** 有匹配的 Claude Desktop 标题时，恢复 Remote Control 会话缺失的标题。 （#1333）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.85.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.85.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-Setup-0.85.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.85.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.84.1...v0.85.0">v0.84.1...v0.85.0</a></summary>

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
- **會話篩選：** 支援在「會話」中依工具篩選對話。 （#1335）
- **遠端會話：** 來源可確認時，顯示所在裝置的名稱與圖示。 （#1338）
- **裝置圖示：** 支援為同步裝置選擇硬體圖示，選擇僅套用於目前的應用程式與連線。 （#1338）

### 改進
- **浮動選單：** 為半透明選單、彈出面板與對話框加入背景模糊，讓文字更易閱讀。 （#1332）
- **Senpi 用量：** 納入更多專案子任務與記憶對話的用量，部分會話暫不支援查看詳細資料。 （#1331）
- **瀏海會話：** 有可用資料時顯示快取命中率，取代執行時間。 （#1327）

### 修復
- **Copilot 用量：** 納入未開啟工作區時建立的 VS Code 對話。 （#1331）
- **Claude 會話標題：** 有相符的 Claude Desktop 標題時，恢復 Remote Control 會話缺失的標題。 （#1333）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.85.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.85.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-Setup-0.85.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.85.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **세션 필터:** 세션 목록을 도구별로 필터링할 수 있습니다. (#1335)
- **원격 세션:** 출처를 확인할 수 있는 대화에 기기 이름과 아이콘을 표시합니다. (#1338)
- **기기 아이콘:** 동기화된 기기마다 하드웨어 아이콘을 선택할 수 있습니다. 선택은 현재 앱과 연결에만 적용됩니다. (#1338)

### 개선
- **팝업 메뉴:** 반투명 메뉴, 팝오버, 대화상자 뒤의 내용을 흐리게 해 글자를 읽기 쉽게 했습니다. (#1332)
- **Senpi 사용량:** 더 많은 프로젝트 하위 작업과 메모리 대화의 사용량을 집계합니다. 일부 세션은 상세 보기를 지원하지 않습니다. (#1331)
- **노치 세션:** 세션 데이터가 있으면 실행 시간 대신 캐시 적중률을 표시합니다. (#1327)

### 수정
- **Copilot 사용량:** 작업 영역을 열지 않은 VS Code 창에서 만든 대화도 집계합니다. (#1331)
- **Claude 세션 제목:** 일치하는 Claude Desktop 제목이 있으면 Remote Control 세션의 누락된 제목을 표시합니다. (#1333)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.85.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.85.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-Setup-0.85.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.85.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **セッションの絞り込み:** 「セッション」の会話一覧をツール別に絞り込めます。 (#1335)
- **リモートセッション:** 実行元を特定できる会話に、デバイス名とアイコンを表示します。 (#1338)
- **デバイスアイコン:** 同期中のデバイスごとにハードウェアのアイコンを選べます。選択は現在のアプリと接続にのみ適用されます。 (#1338)

### 改善
- **ポップアップメニュー:** 半透明のメニューやポップオーバー、ダイアログの背景をぼかし、文字を読みやすくしました。 (#1332)
- **Senpiの使用量:** より多くのプロジェクトの子タスクとメモリの会話を使用量に含めます。一部のセッションは詳細表示に対応していません。 (#1331)
- **ノッチのセッション:** セッションのデータがある場合、実行時間の代わりにキャッシュヒット率を表示します。 (#1327)

### 修正
- **Copilotの使用量:** ワークスペースを開いていないVS Codeウィンドウで作成した会話も集計します。 (#1331)
- **Claudeのセッション名:** 一致するClaude Desktopのタイトルがある場合、Remote Controlセッションで欠けていたタイトルを表示します。 (#1333)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.85.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.85.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-Setup-0.85.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.85.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.85.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.85.0/Token-Monitor-0.85.0.AppImage)

</details>

</details>
