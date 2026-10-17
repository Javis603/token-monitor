# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Oh My Pi session details:** View prompts, per-reply token usage and tool records in Sessions. (#1067)
- **Claude Desktop usage:** Supports locally retained Chat, Code and Cowork usage under Claude. (#1079)
- **Goose on Windows:** Supports usage tracking from the default data location. (#1079)

### Improved
- **Prompt previews:** Long text scrolls at a consistent pace on hover. (#1078)
- **Update history:** Shows release notes for intermediate versions when updating across multiple releases. (#1070)

### Fixed
- **Oh My Pi titles:** Hides unsupported leading icons in session titles. (#1068)
- **Cursor quotas:** Corrects Included usage percentages and avoids using monthly figures for weekly plans. (#1073)
- **Estimated generation speed:** Corrects estimates for partially timed sessions and reduces Codex tool-wait distortion when request timing is available. (#972)
- **Session usage:** Corrected usage, including zero values, no longer reverts to older session totals. (#1071)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.73.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.73.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-Setup-0.73.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.73.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.AppImage)

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
- **Oh My Pi 会话详情：** 支持在“会话”中查看提问、每回合 Tokens 用量和工具记录。 （#1067）
- **Claude Desktop 用量：** 支持统计本机保留的 Chat、Code 和 Cowork 用量，归入 Claude。 （#1079）
- **Windows 上的 Goose：** 支持从默认数据位置追踪用量。 （#1079）

### 改进
- **提问预览：** 悬停查看长文本时，滚动速度保持一致。 （#1078）
- **更新历史：** 跨版本更新时，可查看中间版本的更新内容。 （#1070）

### 修复
- **Oh My Pi 标题：** 隐藏会话标题开头无法正常显示的图标。 （#1068）
- **Cursor 额度：** 修正 Included 用量比例，避免每周方案误用月度数据。 （#1073）
- **估算生成速度：** 修正仅部分回复有计时数据时的估算；有请求计时数据时，减少 Codex 工具等待造成的偏差。 （#972）
- **会话用量：** 修正后的用量（包括零值）不再被旧会话总量覆盖。 （#1071）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.73.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.73.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-Setup-0.73.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.73.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.72.0...v0.73.0">v0.72.0...v0.73.0</a></summary>

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
- **Oh My Pi 會話詳情：** 支援在「會話」中查看提問、每回合 Token 用量與工具記錄。 （#1067）
- **Claude Desktop 用量：** 支援統計本機保留的 Chat、Code 與 Cowork 用量，歸入 Claude。 （#1079）
- **Windows 上的 Goose：** 支援從預設資料位置追蹤用量。 （#1079）

### 改進
- **提問預覽：** 懸停查看長文字時，捲動速度保持一致。 （#1078）
- **更新歷史：** 跨版本更新時，可查看中間版本的更新內容。 （#1070）

### 修復
- **Oh My Pi 標題：** 隱藏會話標題開頭無法正常顯示的圖示。 （#1068）
- **Cursor 額度：** 修正 Included 用量比例，避免每週方案誤用月度資料。 （#1073）
- **估算生成速度：** 修正僅部分回覆有計時資料時的估算；有請求計時資料時，減少 Codex 工具等待造成的偏差。 （#972）
- **會話用量：** 修正後的用量（包括零值）不再被舊會話總量覆蓋。 （#1071）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.73.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.73.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-Setup-0.73.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.73.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Oh My Pi 세션 상세:** ‘세션’에서 프롬프트, 응답별 토큰 사용량과 도구 기록을 확인할 수 있습니다. (#1067)
- **Claude Desktop 사용량:** 이 컴퓨터에 남아 있는 Chat, Code, Cowork 사용량을 Claude에 합산합니다. (#1079)
- **Windows의 Goose:** 기본 데이터 위치에서 사용량을 추적할 수 있습니다. (#1079)

### 개선
- **프롬프트 미리보기:** 마우스를 올리면 긴 텍스트가 일정한 속도로 스크롤됩니다. (#1078)
- **업데이트 기록:** 여러 버전을 건너뛰어 업데이트할 때 중간 버전의 업데이트 내용도 확인할 수 있습니다. (#1070)

### 수정
- **Oh My Pi 제목:** 세션 제목 앞에 제대로 표시되지 않는 아이콘을 숨깁니다. (#1068)
- **Cursor 한도:** Included 사용률을 바로잡고, 주간 요금제에 월간 수치가 적용되는 문제를 수정했습니다. (#1073)
- **예상 생성 속도:** 일부 응답에만 시간 정보가 있을 때의 추정치를 바로잡았습니다. 요청 시간 정보가 있으면 Codex의 도구 대기로 인한 오차도 줄어듭니다. (#972)
- **세션 사용량:** 0으로 수정된 경우를 포함해, 수정한 사용량이 이전 세션 합계로 되돌아가는 문제를 해결했습니다. (#1071)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.73.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.73.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-Setup-0.73.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.73.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Oh My Pi のセッション詳細:** 「セッション」でプロンプト、応答ごとのトークン使用量、ツールの記録を確認できます。 (#1067)
- **Claude Desktop の使用量:** このコンピューターに残っている Chat、Code、Cowork の使用量を Claude に集計します。 (#1079)
- **Windows の Goose:** 既定のデータ保存先から使用量を追跡できるようになりました。 (#1079)

### 改善
- **プロンプトのプレビュー:** マウスを重ねたとき、長いテキストが一定の速度でスクロールします。 (#1078)
- **更新履歴:** 複数のバージョンをまたいで更新するとき、途中のバージョンの更新内容も確認できます。 (#1070)

### 修正
- **Oh My Pi のタイトル:** セッションタイトルの先頭で正しく表示されないアイコンを非表示にしました。 (#1068)
- **Cursor の利用枠:** Included の使用率を修正し、週単位のプランに月単位の数値が使われる問題を解消しました。 (#1073)
- **推定生成速度:** 一部の応答にしか時間情報がない場合の推定値を修正しました。リクエストの時間情報があれば、Codex のツール待機によるずれも抑えます。 (#972)
- **セッションの使用量:** 0 への修正を含め、修正した使用量が以前のセッション合計に戻る問題を解消しました。 (#1071)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.73.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.73.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-Setup-0.73.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.73.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.73.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.73.0/Token-Monitor-0.73.0.AppImage)

</details>

</details>
