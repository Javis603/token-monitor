# English

## What's changed

<!-- app-update-notes:en:start -->
### Improved
- **New API account setup:** Identifies retired access tokens and missing permissions, and warns when a saved token can read the balance but not period spend. (#1506)

### Fixed
- **Muse quota:** Restores web-cookie quota readings after changes to the Muse website. (#1507)
- **OpenClaw usage:** Includes usage found only in archived transcripts, without double-counting copies in live sessions or transcript files. (#1508)
- **Git worktree projects:** Newly collected usage from linked worktree roots is grouped under the parent repository instead of separate projects. (#1505)
- **Live animations:** Running and waiting indicators and hover effects no longer jump or stop during updates; session activity glows replay on new activity. (#1511)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.93.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-Setup-0.93.1.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.93.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.AppImage)

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
### 改进
- **New API 账号设置：** 明确提示访问令牌已停用或缺少权限，并在保存的令牌只能读取余额、无法读取时段支出时显示警告。 （#1506）

### 修复
- **Muse 额度：** 修复网站变更后，使用 Cookie 读取额度时显示不可用的问题。 （#1507）
- **OpenClaw 用量：** 补计仅存在于归档会话记录中的用量，且不会重复计算实时会话或会话文件中的副本。 （#1508）
- **Git worktree 项目：** 从关联 worktree 根目录新采集的用量归入所属仓库，不再拆分为独立项目。 （#1505）
- **实时动画：** 更新时，运行与等待指示器及悬停效果不再跳动或中断；会话有新活动时会重新播放发光效果。 （#1511）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.93.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-Setup-0.93.1.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.93.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.93.0...v0.93.1">v0.93.0...v0.93.1</a></summary>

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
- **New API 帳戶設定：** 明確提示存取權杖已停用或缺少權限，並在儲存的權杖只能讀取餘額、無法讀取時段支出時顯示警告。 （#1506）

### 修復
- **Muse 額度：** 修復網站變更後，使用 Cookie 讀取額度時顯示無法使用的問題。 （#1507）
- **OpenClaw 用量：** 補計僅存在於封存對話紀錄中的用量，且不會重複計算即時工作階段或對話檔案中的副本。 （#1508）
- **Git worktree 專案：** 從關聯 worktree 根目錄新收集的用量歸入所屬儲存庫，不再拆分為獨立專案。 （#1505）
- **即時動畫：** 更新時，執行與等待指示器及懸停效果不再跳動或中斷；工作階段有新活動時會重新播放發光效果。 （#1511）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.93.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-Setup-0.93.1.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.93.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 개선
- **New API 계정 설정:** 사용이 종료된 액세스 토큰과 권한 부족을 구분해 안내하고, 저장한 토큰으로 잔액만 조회할 수 있고 기간별 지출은 조회할 수 없으면 경고를 표시합니다. (#1506)

### 수정
- **Muse 할당량:** 웹사이트 변경 후 쿠키로 조회한 할당량이 사용 불가로 표시되는 문제를 수정했습니다. (#1507)
- **OpenClaw 사용량:** 보관된 대화 기록에만 남은 사용량도 집계하며, 실시간 세션이나 대화 파일에 같은 기록이 있어도 중복 계산하지 않습니다. (#1508)
- **Git worktree 프로젝트:** 연결된 worktree의 루트 디렉터리에서 새로 수집한 사용량을 별도 프로젝트로 나누지 않고 원래 저장소에 합산합니다. (#1505)
- **실시간 애니메이션:** 업데이트 중 실행·대기 표시와 호버 효과가 튀거나 끊기지 않으며, 세션에 새 활동이 생기면 발광 효과가 다시 재생됩니다. (#1511)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.93.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-Setup-0.93.1.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.93.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 改善
- **New API アカウント設定：** 廃止されたアクセストークンと権限不足を区別して案内し、保存したトークンで残高のみ取得でき、期間別の支出を取得できない場合は警告を表示します。 (#1506)

### 修正
- **Muse クォータ：** ウェブサイトの変更後、Cookie によるクォータ取得が利用不可になる問題を修正しました。 (#1507)
- **OpenClaw 使用量：** アーカイブされた会話記録にのみ残る使用量も集計し、実行中のセッションや会話ファイルに同じ記録があっても重複計上しません。 (#1508)
- **Git worktree のプロジェクト：** リンクされた worktree のルートディレクトリで新たに収集した使用量を、個別のプロジェクトに分けず元のリポジトリにまとめます。 (#1505)
- **リアルタイムのアニメーション：** 更新時に実行・待機インジケーターやホバー効果が飛んだり途切れたりする問題を修正し、セッションで新しい活動があると発光効果を再生します。 (#1511)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.93.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.93.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-Setup-0.93.1.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.93.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.93.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.93.1/Token-Monitor-0.93.1.AppImage)

</details>

</details>
