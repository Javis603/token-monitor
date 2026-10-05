# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **MiniMax Code usage:** Adds token usage tracking for local CLI and desktop sessions. (#939)
- **MiniMax API region:** Choose Auto, China or International for quota checks. (#883, #865)
- **Custom cache-write pricing:** Supports regular and 1-hour cache-write rates. (#938)

### Improved
- **Multi-device Sync settings:** Shows connection health, upload times and device details, with connection editing and offline-device removal in one place. (#931)

### Fixed
- **Custom model pricing:** Applies custom rates over reported costs and refreshes matching historical costs after price changes. (#938, #933)
- **Claude Code costs:** Uses the 1-hour cache-write rate for 1-hour cache writes. (#933)
- **Codex session titles:** Reads titles from T3 Code V2. (#937)
- **Large session details:** Prevents crashes while loading large Codex, Claude Code and DeepSeek Harness transcripts. (#930, #932)
- **JSON data exports:** Keeps session titles and other session text out of exported usage data. (#925)
- **First launch:** Opens fresh installations on Home. (#922)

### Changed
- **Tokscale updates:** Updates the bundled build through Token Monitor releases and removes the separate in-app updater. (#923)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.66.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.66.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-Setup-0.66.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.66.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.AppImage)

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
- **MiniMax Code 用量：** 新增本地 CLI 与桌面会话的 Tokens 用量追踪支持。（#939）
- **MiniMax API 地区：** 支持选择“自动”、“中国区”或“国际版”查询额度。（#883、#865）
- **自定义缓存写入单价：** 支持设置常规和 1 小时缓存写入单价。（#938）

### 改进
- **多设备同步设置：** 显示连接状态、上传时间和设备详情，并集中提供连接编辑与离线设备移除操作。（#931）

### 修复
- **自定义模型单价：** 优先使用自定义单价计算费用，修改后更新对应的历史费用。（#938、#933）
- **Claude Code 费用：** 1 小时缓存写入按对应单价计费。（#933）
- **Codex 会话标题：** 正确读取 T3 Code V2 中的标题。（#937）
- **大型会话详情：** 修复加载大型 Codex、Claude Code 和 DeepSeek Harness 对话记录时可能崩溃的问题。（#930、#932）
- **JSON 数据导出：** 导出的用量数据不再包含会话标题等会话文本。（#925）
- **首次启动：** 全新安装默认打开主页。（#922）

### 变更
- **Tokscale 更新：** 内置构建随 Token Monitor 版本更新，移除应用内独立更新功能。（#923）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.66.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.66.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-Setup-0.66.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.66.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.65.0...v0.66.0">v0.65.0...v0.66.0</a></summary>

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
- **MiniMax Code 用量：** 新增本機 CLI 與桌面會話的 Tokens 用量追蹤支援。（#939）
- **MiniMax API 地區：** 支援選擇「自動」、「中國區」或「國際版」查詢額度。（#883、#865）
- **自訂快取寫入單價：** 支援設定一般與 1 小時快取寫入單價。（#938）

### 改進
- **多裝置同步設定：** 顯示連線狀態、上傳時間與裝置詳情，並集中提供連線編輯與離線裝置移除操作。（#931）

### 修復
- **自訂模型單價：** 優先使用自訂單價計算費用，修改後更新對應的歷史費用。（#938、#933）
- **Claude Code 費用：** 1 小時快取寫入按對應單價計費。（#933）
- **Codex 會話標題：** 正確讀取 T3 Code V2 中的標題。（#937）
- **大型會話詳情：** 修復載入大型 Codex、Claude Code 與 DeepSeek Harness 對話記錄時可能崩潰的問題。（#930、#932）
- **JSON 資料匯出：** 匯出的用量資料不再包含會話標題等會話文字。（#925）
- **首次啟動：** 全新安裝預設開啟主頁。（#922）

### 變更
- **Tokscale 更新：** 內建版本隨 Token Monitor 版本更新，移除應用程式內的獨立更新功能。（#923）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.66.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.66.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-Setup-0.66.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.66.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **MiniMax Code 사용량:** 로컬 CLI 및 데스크톱 세션의 토큰 사용량 추적을 지원합니다. (#939)
- **MiniMax API 지역:** 한도 조회에 자동, 중국 또는 국제 지역을 선택할 수 있습니다. (#883, #865)
- **사용자 지정 캐시 쓰기 가격:** 일반 및 1시간 캐시 쓰기 단가를 설정할 수 있습니다. (#938)

### 개선
- **다중 기기 동기화 설정:** 연결 상태, 업로드 시각과 기기 정보를 표시하고, 연결 편집과 오프라인 기기 제거를 한곳에서 제공합니다. (#931)

### 수정
- **사용자 지정 모델 가격:** 보고된 비용보다 사용자 지정 단가를 우선 적용하고, 가격 변경 후 해당 과거 비용을 갱신합니다. (#938, #933)
- **Claude Code 비용:** 1시간 캐시 쓰기에 해당 단가를 적용합니다. (#933)
- **Codex 세션 제목:** T3 Code V2의 제목을 올바르게 읽습니다. (#937)
- **대용량 세션 상세:** 큰 Codex, Claude Code 및 DeepSeek Harness 대화 기록을 불러올 때 발생할 수 있던 충돌을 수정했습니다. (#930, #932)
- **JSON 데이터 내보내기:** 내보낸 사용량 데이터에서 세션 제목 등 세션 텍스트를 제외합니다. (#925)
- **첫 실행:** 새로 설치하면 홈 화면을 엽니다. (#922)

### 변경
- **Tokscale 업데이트:** 내장 빌드는 Token Monitor 릴리스를 통해 업데이트하며, 별도의 앱 내 업데이트 기능을 제거했습니다. (#923)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.66.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.66.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-Setup-0.66.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.66.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **MiniMax Code 使用量：** ローカルの CLI・デスクトップセッションのトークン使用量追跡に対応しました。 (#939)
- **MiniMax API リージョン：** クォータの取得先を自動・中国・国際から選べます。 (#883, #865)
- **カスタムキャッシュ書き込み単価：** 通常と1時間のキャッシュ書き込み単価を設定できます。 (#938)

### 改善
- **マルチデバイス同期設定：** 接続状態、アップロード時刻、デバイス情報を表示し、接続の編集とオフラインデバイスの削除を一か所にまとめました。 (#931)

### 修正
- **カスタムモデル単価：** 報告された費用よりカスタム単価を優先し、単価の変更後に該当する過去の費用を更新します。 (#938, #933)
- **Claude Code の費用：** 1時間のキャッシュ書き込みに対応する単価を適用します。 (#933)
- **Codex セッションタイトル：** T3 Code V2 のタイトルを正しく読み取ります。 (#937)
- **大容量セッションの詳細：** 大きな Codex、Claude Code、DeepSeek Harness の会話記録を読み込む際にクラッシュする問題を修正しました。 (#930, #932)
- **JSON データエクスポート：** 出力する使用量データからセッションタイトルなどの会話テキストを除外します。 (#925)
- **初回起動：** 新規インストール時にホームを開きます。 (#922)

### 変更
- **Tokscale の更新：** 内蔵ビルドは Token Monitor のリリースで更新し、アプリ内の独立した更新機能を廃止しました。 (#923)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.66.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.66.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-Setup-0.66.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.66.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.66.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.66.0/Token-Monitor-0.66.0.AppImage)

</details>

</details>
