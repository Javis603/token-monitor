# English

## What's changed

<!-- app-update-notes:en:start -->
### Changed
- **OpenCode local quota fallback:** AI Tool Limits now exposes a per-device `Use local DB fallback` setting; it is disabled by default and uses OpenCode's local database only when Web quota data is unavailable, avoiding cross-device account conflicts. (#361)

### Improved
- **Startup statistics:** Home shows the totals from the last completed local scan immediately instead of showing zeros while the first full scan runs. (#339)
- **Model display:** Hunyuan models such as `hy3` now use the Hunyuan icon and color. (#370)

### Fixed
- **App updates:** A failed or never-started installer now restores usable quit/retry behavior and explains when a restart or `View release` is required. (#356, #357)
- **Quitting:** Closing the app no longer hangs while watchers or the embedded Hub shut down. (#337)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.43.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.43.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-Setup-0.43.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.43.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.AppImage)

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
### 变更
- **OpenCode 本地额度后备预测：**“AI 工具额度”现在提供按设备设置的“使用本地 DB 预测”选项；默认关闭，仅在 Web 额度数据不可用时使用 OpenCode 本地数据库，以避免多设备间的账号冲突。（#361）

### 改进
- **启动统计：** 启动时，主页会立即显示上次完成本地扫描后的统计，不再在首次完整扫描期间显示 0。（#339）
- **模型显示：** Hunyuan 模型（例如 `hy3`）现在会使用 Hunyuan 图标和颜色。（#370）

### 修复
- **应用更新：** 安装程序失败或未启动时，会恢复可用的退出/重试操作，并说明何时需要重启或“查看 release”。（#356、#357）
- **退出应用：** 关闭应用时，不会再因为监视器或内置 Hub 的关闭而卡住。（#337）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.43.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.43.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-Setup-0.43.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.43.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.AppImage)

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

**Full Changelog:** [v0.42.1...v0.43.0](https://github.com/Javis603/token-monitor/compare/v0.42.1...v0.43.0)

<details>
<summary>繁體中文 · 한국어 · 日本語</summary>

<details>
<summary><strong>繁體中文</strong></summary>

## 繁體中文

## 更新內容

<!-- app-update-notes:zh-TW:start -->
### 變更
- **OpenCode 本機額度後備預測：**「AI 工具額度」現在提供按裝置設定的「使用本機 DB 後備預測」選項；預設關閉，只有在 Web 額度資料不可用時才使用 OpenCode 本機資料庫，以避免多裝置間的帳號衝突。（#361）

### 改進
- **啟動統計：** 啟動時，主頁會立即顯示上次完成本機掃描後的統計，不再在首次完整掃描期間顯示 0。（#339）
- **模型顯示：** Hunyuan 模型（例如 `hy3`）現在會使用 Hunyuan 圖示和顏色。（#370）

### 修復
- **應用程式更新：** 安裝程式失敗或未啟動時，會恢復可用的結束/重試操作，並說明何時需要重新啟動或「查看 release」。（#356、#357）
- **結束 App：** 關閉 App 時，不會再因監看器或內嵌 Hub 關閉而卡住。（#337）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.43.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.43.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-Setup-0.43.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.43.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 변경
- **OpenCode 로컬 한도 대체 추정:** `AI 도구 한도`에 기기별 `로컬 DB 추정 사용` 설정이 제공됩니다. 기본적으로 꺼져 있으며 웹 할당량을 사용할 수 없을 때만 OpenCode 로컬 데이터베이스를 사용해 여러 기기에서의 계정 충돌을 피합니다. (#361)

### 개선
- **시작 통계:** 시작할 때 첫 전체 스캔이 진행되는 동안 0으로 보이지 않고, 홈에 마지막으로 완료된 로컬 스캔의 통계가 즉시 표시됩니다. (#339)
- **모델 표시:** `hy3` 같은 Hunyuan 모델에 이제 Hunyuan 아이콘과 색상이 표시됩니다. (#370)

### 수정
- **앱 업데이트:** 설치 프로그램이 실패하거나 시작되지 않아도 종료/재시도 동작을 계속 사용할 수 있으며, 재시작 또는 `릴리즈 보기`가 필요한 경우를 안내합니다. (#356, #357)
- **앱 종료:** 감시기 또는 내장 Hub가 종료되기를 기다리며 앱이 멈추지 않습니다. (#337)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.43.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.43.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-Setup-0.43.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.43.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 変更
- **OpenCode ローカル上限フォールバック:**「AIツール制限」でデバイスごとに「ローカル DB 推定を使用」を設定できます。初期状態ではオフで、Web の上限を取得できない場合にのみ OpenCode のローカルデータベースを使い、複数デバイスでのアカウント衝突を避けます。（#361）

### 改善
- **起動時の統計：** 起動時、最初の完全スキャン中に 0 を表示する代わりに、ホームに最後に完了したローカルスキャンの統計をすぐ表示します。（#339）
- **モデル表示：** `hy3` などの Hunyuan モデルに Hunyuan のアイコンとカラーを表示します。（#370）

### 修正
- **アプリのアップデート：** インストーラーが失敗した場合や起動しなかった場合でも、終了と再試行を使える状態に戻し、再起動または「リリースを表示」が必要な場合を案内します。（#356、#357）
- **アプリ終了：** 監視処理や組み込み Hub の終了待ちでアプリが固まらなくなりました。（#337）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.43.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.43.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-Setup-0.43.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.43.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.43.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.43.0/Token-Monitor-0.43.0.AppImage)

</details>

</details>
