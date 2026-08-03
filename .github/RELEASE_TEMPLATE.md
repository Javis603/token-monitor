# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Token throughput:** Hover the compact `Σ` title mark or live dot to reveal the current reading, then click to switch between output `tok/s` and total `tok/min`; the choice is remembered. (#296)

### Improved
- **Windows session details:** Claude and Codex transcripts stored in running WSL homes can now open from the Sessions view without blocking the Electron main process. (#297)
- **Home limits:** Home limit rows are more compact and aligned.
- **AI Tool Limits details:** Codex reset counts and Claude prepaid grants now show precise expiry times, including when there is only one entry.

### Fixed
- **Window state:** Maximized windows now restore maximized after restart without losing their normal size; tray popovers and collapsed floating bubbles no longer overwrite normal window bounds. (#300)
- **Manual refresh:** Clicking Refresh now updates Cursor and Antigravity usage with fresh data instead of showing values up to five minutes old. (#290)
- **MiMo and Kimi limits:** When usage exceeds the limit, the remaining percentage now correctly shows **0%** instead of nearly **99%**. (#294)
- **Windows Codex checks:** The app no longer crashes when `taskkill.exe` cannot be resolved. (#291)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.39.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.39.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-Setup-0.39.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.39.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.AppImage)

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
- **Token 吞吐量：** 将鼠标悬停在紧凑 `Σ` 标题标记或实时指示点上即可查看当前读数，点击可在输出 `tok/s` 与总 Token `tok/min` 之间切换，选择会被记住。（#296）

### 改进
- **Windows 会话详情：** 存放在运行中 WSL 主目录的 Claude 与 Codex 会话，现在可以从会话视图打开，且不会阻塞 Electron 主进程。（#297）
- **主页额度：** 主页额度条目现在更紧凑、对齐更整齐。
- **AI 工具额度详情：** Codex 重置次数和 Claude 预付额度现在会显示精确的到期时间，包括只有一条记录时。

### 修复
- **窗口状态：** 窗口最大化后重启会恢复最大化，同时保留原本的普通窗口大小；托盘弹窗和收起的浮动气泡不再覆盖普通窗口大小。（#300）
- **手动刷新：** 点击刷新后，Cursor 与 Antigravity 的用量会更新为最新数据，不再显示最多五分钟的旧数据。（#290）
- **MiMo 与 Kimi 额度：** 使用量超过上限时，剩余比例现在会正确显示为 **0%**，不再错误地显示为接近 **99%**。（#294）
- **Windows Codex 额度检查：** 找不到 `taskkill.exe` 时不再导致应用崩溃。（#291）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.39.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.39.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-Setup-0.39.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.39.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.AppImage)

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

**Full Changelog:** [v0.38.0...v0.39.0](https://github.com/Javis603/token-monitor/compare/v0.38.0...v0.39.0)

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 新增
- **Token 吞吐量：** 將滑鼠移到精簡 `Σ` 標題標記或即時指示點，即可查看目前讀數；點擊可在輸出 `tok/s` 與總 Token `tok/min` 之間切換，選擇會被記住。（#296）

### 改進
- **Windows 會話詳細資訊：** 儲存在執行中 WSL 主目錄的 Claude 與 Codex 會話，現在可以從會話檢視開啟，而且不會阻塞 Electron 主程序。（#297）
- **主頁額度：** 主頁額度列現在更精簡、對齊更整齊。
- **AI 工具額度詳細資訊：** Codex 重設次數與 Claude 預付額度現在會顯示精確的到期時間，即使只有一筆記錄也會顯示。

### 修復
- **視窗狀態：** 視窗最大化後重新啟動會恢復最大化，同時保留原本的一般視窗大小；系統匣彈出視窗和收起的浮動氣泡不再覆蓋一般視窗大小。（#300）
- **手動重新整理：** 點擊重新整理後，Cursor 與 Antigravity 的用量會更新為最新資料，不再顯示最多五分鐘的舊資料。（#290）
- **MiMo 與 Kimi 額度：** 使用量超過上限時，剩餘比例現在會正確顯示為 **0%**，不再錯誤地顯示為接近 **99%**。（#294）
- **Windows Codex 額度檢查：** 找不到 `taskkill.exe` 時不再導致應用程式崩潰。（#291）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.39.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.39.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-Setup-0.39.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.39.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **토큰 처리량:** 컴팩트한 `Σ` 제목 표시나 실시간 점에 마우스를 올리면 현재 수치를 확인할 수 있고, 클릭하면 출력 `tok/s`와 전체 Token `tok/min` 사이를 전환할 수 있습니다. 선택은 저장됩니다. (#296)

### 개선
- **Windows 세션 상세 정보:** 실행 중인 WSL 홈에 저장된 Claude 및 Codex 대화를 이제 세션 보기에서 열 수 있으며 Electron 메인 프로세스를 차단하지 않습니다. (#297)
- **홈 한도:** 홈 한도 행이 더 간결해지고 정렬이 맞습니다.
- **AI 도구 한도 상세 정보:** Codex 재설정 횟수와 Claude 선불 크레딧에 항목이 하나만 있어도 정확한 만료 시간이 표시됩니다.

### 수정
- **창 상태:** 최대화된 창은 다시 시작한 뒤에도 최대화 상태로 복원되며, 원래 일반 창 크기도 유지됩니다. 트레이 팝오버와 접힌 플로팅 버블이 더 이상 일반 창 크기를 덮어쓰지 않습니다. (#300)
- **수동 새로 고침:** 새로 고침을 클릭하면 Cursor 및 Antigravity 사용량이 최신 데이터로 업데이트되어 최대 5분 전 값이 표시되지 않습니다. (#290)
- **MiMo 및 Kimi 한도:** 사용량이 한도를 초과하면 남은 비율이 거의 **99%**가 아니라 **0%**로 정확히 표시됩니다. (#294)
- **Windows Codex 확인:** `taskkill.exe`를 찾을 수 없어도 앱이 더 이상 충돌하지 않습니다. (#291)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.39.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.39.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-Setup-0.39.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.39.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **トークン スループット：** コンパクトな `Σ` タイトルマークまたはライブドットにカーソルを合わせると現在の値を確認でき、クリックすると出力 `tok/s` と合計 Token `tok/min` を切り替えられます。選択は記憶されます。 (#296)

### 改善
- **Windows セッション詳細：** 実行中の WSL ホームに保存された Claude と Codex の会話を、セッションビューから開けるようになり、Electron のメインプロセスもブロックしません。 (#297)
- **ホームの制限：** ホームの制限行がよりコンパクトになり、整列されます。
- **AI ツール制限の詳細：** Codex のリセット回数と Claude の前払いクレジットに、記録が1件だけの場合も含めて正確な有効期限が表示されます。

### 修正
- **ウィンドウ状態：** 最大化したウィンドウは再起動後も最大化された状態に戻り、通常のウィンドウサイズも保持されます。トレイポップオーバーと折りたたんだフローティングバブルが通常のウィンドウサイズを上書きしなくなりました。 (#300)
- **手動更新：** 更新をクリックすると、Cursor と Antigravity の使用量が最新データに更新され、最大5分前の値が表示されなくなります。 (#290)
- **MiMo と Kimi の制限：** 使用量が上限を超えた場合、残りの割合がほぼ **99%** ではなく **0%** と正しく表示されます。 (#294)
- **Windows Codex の確認：** `taskkill.exe` を解決できない場合でもアプリがクラッシュしなくなりました。 (#291)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.39.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.39.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-Setup-0.39.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.39.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.39.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.39.0/Token-Monitor-0.39.0.AppImage)

</details>

</details>
