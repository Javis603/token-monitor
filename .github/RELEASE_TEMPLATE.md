# English

## What's changed

<!-- app-update-notes:en:start -->
### Improved
- **Background usage scans:** Shortens main-window pauses during full scans. (#843, #846)
- **Hub client mode:** Reduces recurring window stutter while syncing multiple devices, especially when scrolling long histories. (#828, #832, #849)

### Fixed
- **Custom scan paths:** Month and Total include newly added paths after the setting changes. (#831)
- **Antigravity usage:** Stops repeated refreshes while conversations are idle. (#834)
- **ZCode and OpenCode usage:** New scans include reasoning tokens in totals and token rates. (#829)
- **Cursor Auto usage:** Shows one Auto model across usage and History, including older records, instead of splitting it into Auto and default. (#847)
- **Edge Dock peek handle:** Removes the extra macOS Liquid Glass highlight and pointed ends.
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.63.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-Setup-0.63.1.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.63.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.AppImage)

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
### 改进
- **后台用量扫描：** 缩短全量扫描时主窗口的停顿。（#843、#846）
- **Hub 客户端模式：** 减少多设备同步时反复出现的窗口卡顿，滚动较长的用量记录时更流畅。（#828、#832、#849）

### 修复
- **自定义扫描路径：** 修改路径后，“本月”和“总计”会计入新添加的路径。（#831）
- **Antigravity 用量：** 修复会话闲置时反复刷新的问题。（#834）
- **ZCode 与 OpenCode 用量：** 新扫描的总量和 Tokens 速率会计入推理 Tokens。（#829）
- **Cursor Auto 用量：** 用量和历史中的 Auto 模型不再分散为 Auto 与 default，旧记录也会合并显示。（#847）
- **侧边栏收起把手：** 去除 macOS Liquid Glass 下多余的高光和尖角。
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.63.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-Setup-0.63.1.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.63.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.AppImage)

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

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.63.0...v0.63.1">v0.63.0...v0.63.1</a></summary>

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
- **背景用量掃描：** 縮短完整掃描時主視窗的停頓。（#843、#846）
- **Hub 用戶端模式：** 減少多部裝置同步時反覆出現的視窗卡頓，捲動較長的用量紀錄時更順暢。（#828、#832、#849）

### 修復
- **自訂掃描路徑：** 修改路徑後，「本月」和「總計」會計入新加入的路徑。（#831）
- **Antigravity 用量：** 修復會話閒置時反覆重新整理的問題。（#834）
- **ZCode 與 OpenCode 用量：** 新掃描的總量與 Tokens 速率會計入推理 Tokens。（#829）
- **Cursor Auto 用量：** 用量和歷史中的 Auto 模型不再分散為 Auto 與 default，舊紀錄也會合併顯示。（#847）
- **側邊欄收合把手：** 去除 macOS Liquid Glass 下多餘的亮邊與尖角。
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.63.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-Setup-0.63.1.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.63.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 개선
- **백그라운드 사용량 스캔:** 전체 스캔 중 기본 창이 멈추는 시간을 줄였습니다. (#843, #846)
- **Hub 클라이언트 모드:** 여러 기기를 동기화할 때 반복되던 창의 끊김을 줄여 긴 사용량 기록도 더 부드럽게 스크롤할 수 있습니다. (#828, #832, #849)

### 수정
- **사용자 지정 스캔 경로:** 경로를 변경하면 새로 추가한 경로의 사용량이 이번 달과 전체 합계에 반영됩니다. (#831)
- **Antigravity 사용량:** 대화가 유휴 상태일 때 반복해서 새로고침되는 문제를 수정했습니다. (#834)
- **ZCode 및 OpenCode 사용량:** 새로 스캔한 추론 토큰을 합계와 토큰 속도에 포함합니다. (#829)
- **Cursor Auto 사용량:** 사용량과 기록에서 Auto 모델이 Auto와 default로 나뉘지 않고 하나로 표시됩니다. 이전 기록에도 적용됩니다. (#847)
- **가장자리 도크 접힌 손잡이:** macOS Liquid Glass에서 중복으로 보이던 강조선과 뾰족한 끝을 없앴습니다.
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.63.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-Setup-0.63.1.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.63.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 改善
- **バックグラウンドでの使用量スキャン：** 全量スキャン中にメインウィンドウが止まる時間を短縮しました。（#843、#846）
- **Hub クライアントモード：** 複数デバイスの同期中に繰り返し起きる画面の引っかかりを減らし、長い使用量履歴もスクロールしやすくしました。（#828、#832、#849）

### 修正
- **カスタムスキャンパス：** パスの変更後、新しく追加したパスの使用量が「今月」と「合計」に反映されます。（#831）
- **Antigravity の使用量：** 会話が更新されていない間も繰り返し再読み込みする問題を修正しました。（#834）
- **ZCode と OpenCode の使用量：** 新しいスキャンでは推論トークンを合計とトークン速度に含めます。（#829）
- **Cursor Auto の使用量：** 使用量と履歴で Auto モデルが Auto と default に分かれず、過去の記録も含めて一つにまとまります。（#847）
- **エッジドックの収納時のハンドル：** macOS Liquid Glass で重なって見えるハイライトと尖った端をなくしました。
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.63.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-Setup-0.63.1.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.63.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.63.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.1/Token-Monitor-0.63.1.AppImage)

</details>

</details>
