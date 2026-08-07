# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Per-tool health details:** Settings > Tools now shows expandable details for each tracked AI tool, including its Source, Collection status, recent output, and counted Usage. You can re-scan a tool or show its source in the file manager when investigating missing or stale data. (#328, #331)

### Improved
- **Antigravity usage:** Live tracking now refreshes Antigravity usage when its source data changes, including IDE-only installations, instead of waiting for the next scheduled collection. (#319)
- **Tracked tools:** Drag-to-reorder is smoother: the entire tracked-tool row is now the reorder target, while Track and Show controls retain their existing actions. (#327)

### Fixed
- **Trends (DAY):** The DAY preview now keeps the latest seven local calendar dates, including zero-use dates, and places today's live total on today's date instead of shifting it onto the last recorded day. (#335)
- **Grok Build usage:** Grok session files with usage data no longer appear as zero or lose their token breakdown; input, output, cached-read, and reasoning tokens are now collected correctly. (#333)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.41.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.41.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-Setup-0.41.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.41.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.AppImage)

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

Tokscale is bundled with this app. See **Settings → Tokscale** for the exact version
and the option to download a newer version directly from npm. Tokscale is MIT,
open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **逐工具健康详情：** 「设置 > 工具」现在可展开查看每个已追踪 AI 工具的「来源」「采集」状态、最近产出和已计入的「用量」。遇到缺失或过旧的数据时，还可以重新扫描工具，或在文件管理器中显示其数据位置。（#328、#331）

### 改进
- **Antigravity 用量：** 支持实时追踪 Antigravity 的源数据，包括仅安装 IDE 的情况；用量会在活动发生后更新，不必等到下一次定时采集。（#319）
- **工具列表：** 优化拖动排序体验：现在可以拖动整个工具行重新排序，同时保留「追踪」和「显示」控件原有的操作。（#327）

### 修复
- **趋势（DAY）：** DAY 预览现在会保留最近七个本地日历日期，包括用量为零的日期，并将今天的实时总量显示在今天，而不是移到最后一个有记录的日期。（#335）
- **Grok Build 用量：** 已修复含有用量数据的 Grok 会话文件显示为 0 或缺少 Tokens 明细的问题；现在可以正确采集输入、输出、缓存命中和推理 Tokens。（#333）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.41.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.41.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-Setup-0.41.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.41.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.AppImage)

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

Tokscale 已随应用内置。你可以在 **设置 → Tokscale** 查看确切版本，
也可以直接从 npm 下载更新版本。Tokscale 是 MIT 开源项目：
https://github.com/junhoyeo/tokscale

</details>

---

**Full Changelog:** [v0.40.0...v0.41.0](https://github.com/Javis603/token-monitor/compare/v0.40.0...v0.41.0)

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 新增
- **逐工具健康詳情：** 「設定 > 工具」現在可展開查看每個已追蹤 AI 工具的「來源」「採集」狀態、最後產出和已計入的「用量」。遇到缺失或過舊的資料時，還可以重新掃描工具，或在檔案管理員中顯示其資料位置。（#328、#331）

### 改進
- **Antigravity 用量：** 支援即時追蹤 Antigravity 的來源資料，包括僅安裝 IDE 的情況；用量會在活動發生後更新，不必等到下一次定時採集。（#319）
- **工具列表：** 優化拖曳排序體驗：現在可以拖曳整個工具列重新排序，同時保留「追蹤」和「顯示」控制項原有的操作。（#327）

### 修復
- **趨勢（DAY）：** DAY 預覽現在會保留最近七個本地日曆日期，包括用量為零的日期，並將今天的即時總量顯示在今天，而不是移到最後一個有紀錄的日期。（#335）
- **Grok Build 用量：** 已修正含有用量資料的 Grok 會話檔案顯示為 0 或缺少 Tokens 明細的問題；現在可以正確採集輸入、輸出、快取命中和推理 Tokens。（#333）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.41.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.41.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-Setup-0.41.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.41.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **도구별 상태 세부 정보:** 「설정 > 도구」에서 추적 중인 각 AI 도구의 「소스」, 「수집」 상태, 마지막 출력 및 집계된 「사용량」을 펼쳐 볼 수 있습니다. 데이터가 없거나 오래된 경우 도구를 다시 검사하거나 파일 관리자에서 데이터 위치를 볼 수 있습니다. (#328, #331)

### 개선
- **Antigravity 사용량:** 이제 Antigravity 소스 데이터를 실시간으로 추적하며, IDE만 설치된 경우도 포함됩니다. 사용량이 다음 예약 수집까지 기다리지 않고 활동 후 업데이트됩니다. (#319)
- **도구 목록:** 드래그하여 순서를 바꾸는 방식을 개선했습니다. 이제 도구 행 자체를 드래그할 수 있으며 「추적」 및 「표시」 컨트롤은 기존 동작을 유지합니다. (#327)

### 수정
- **추이 (DAY):** DAY 미리보기가 사용량이 0인 날짜를 포함한 최근 7개의 현지 달력 날짜를 유지하고, 오늘의 실시간 합계를 마지막 기록 날짜가 아닌 오늘 날짜에 표시합니다. (#335)
- **Grok Build 사용량:** 사용량 데이터가 있는 Grok 세션 파일이 0으로 표시되거나 토큰 내역이 누락되던 문제가 수정되어, 입력, 출력, 캐시 적중 및 추론 토큰이 이제 정상적으로 수집됩니다. (#333)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.41.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.41.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-Setup-0.41.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.41.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **ツールごとの状態詳細：** 「設定 > ツール」で追跡中の各 AI ツールについて、「ソース」「収集」状態、最終出力、集計された「使用量」を展開して確認できます。データがない、または古い場合は、ツールを再スキャンしたり、ファイルマネージャでデータの場所を表示したりできます。（#328、#331）

### 改善
- **Antigravity の使用量：** Antigravity のソースデータをリアルタイムで追跡できるようになり、IDE だけがインストールされている場合にも対応します。使用量は次の定期収集を待たず、アクティビティ後に更新されます。（#319）
- **ツールリスト：** ドラッグによる並び替えを改善し、ツールの行自体をドラッグできるようになりました。「追跡」と「表示」コントロールの既存の操作も維持されます。（#327）

### 修正
- **トレンド（DAY）：** DAY プレビューが使用量ゼロの日を含む直近7つのローカルカレンダー日を保持し、今日のリアルタイム合計を最後に記録された日ではなく今日の日付に表示します。（#335）
- **Grok Build の使用量：** 使用量データを含む Grok セッションファイルが 0 と表示されたりトークン内訳が欠落したりする問題を修正し、入力、出力、キャッシュヒット、推論トークンを正しく収集できるようになりました。（#333）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.41.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.41.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-Setup-0.41.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.41.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.41.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.41.0/Token-Monitor-0.41.0.AppImage)

</details>

</details>
