# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Antigravity accounts:** Sign in with multiple Google accounts and refresh quotas while Antigravity is closed. (#564)
- **Tool details:** Expand a tool to reveal the new “Tokens / Models” switch and choose between token details and per-model usage. (#554)
- **Codex reset forecast:** Shows when quotas are predicted to reset. In Settings → AI Tool Limits, expand Codex and enable “Reset forecast” (off by default). (#555)
- **Windows taskbar:** Adds an experimental option to restore the floating widget above an overlapping taskbar after switching apps. Disabled by default; brief flickering may occur. (#548)

### Improved
- **Background performance:** Reduces rendering work while windows are hidden or minimized and views are inactive. (#386)
- **Codex quota label:** Displays `gpt-reserve` as `Luna Reserve`. (#556)

### Fixed
- **Antigravity usage refresh:** Detects stale sync locks that block updates and offers a repair-and-rescan action. (#568)
- **Floating bubble:** Fixes blurry graphics and Settings previews on high-density displays. (#559)
- **Qoder CN Discord status:** Restores the missing Rich Presence icon when Qoder CN is the most-used tool.
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.51.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.51.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-Setup-0.51.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.51.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.AppImage)

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
- **Antigravity 账号：** 支持登录多个 Google 账号，关闭 Antigravity 后仍可刷新额度。（#564）
- **工具明细：** 展开工具后，可通过新增的“Tokens／模型”切换查看 Token 明细或各模型用量。（#554）
- **Codex 重置预测：** 支持查看额度的预计重置时间。在“设置 → AI 工具额度”中展开 Codex，开启“重置预测”（默认关闭）。（#555）
- **Windows 任务栏：** 新增实验性选项，在切换应用后将与任务栏重叠的浮动小组件移回上方。默认关闭，可能出现短暂闪烁。（#548）

### 改进
- **后台性能：** 减少窗口隐藏、最小化及视图未使用时的渲染开销。（#386）
- **Codex 额度名称：** 将 `gpt-reserve` 显示为 `Luna Reserve`。（#556）

### 修复
- **Antigravity 用量刷新：** 检测阻碍更新的残留同步锁，并提供修复后重新扫描的操作。（#568）
- **悬浮小窗：** 修复高像素密度屏幕上图像及设置预览模糊的问题。（#559）
- **Qoder CN Discord 状态：** 修复 Qoder CN 为用量最高的工具时，Rich Presence 缺少图标的问题。
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.51.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.51.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-Setup-0.51.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.51.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.50.0...v0.51.0">v0.50.0...v0.51.0</a></summary>

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
- **Antigravity 帳號：** 支援登入多個 Google 帳號，關閉 Antigravity 後仍可重新整理額度。（#564）
- **工具明細：** 展開工具後，可透過新增的「Tokens／模型」切換查看 Token 明細或各模型用量。（#554）
- **Codex 重置預測：** 支援查看額度的預計重置時間。在「設定 → AI 工具額度」中展開 Codex，開啟「重置預測」（預設關閉）。（#555）
- **Windows 工作列：** 新增實驗性選項，在切換應用程式後將與工作列重疊的浮動小工具移回上方。預設關閉，可能出現短暫閃爍。（#548）

### 改進
- **背景效能：** 減少視窗隱藏、最小化及檢視未使用時的繪製負擔。（#386）
- **Codex 額度名稱：** 將 `gpt-reserve` 顯示為 `Luna Reserve`。（#556）

### 修復
- **Antigravity 用量更新：** 偵測阻礙更新的殘留同步鎖，並提供修復後重新掃描的操作。（#568）
- **懸浮小窗：** 修復高像素密度螢幕上圖像及設定預覽模糊的問題。（#559）
- **Qoder CN Discord 狀態：** 修復 Qoder CN 為用量最高的工具時，Rich Presence 缺少圖示的問題。
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.51.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.51.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-Setup-0.51.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.51.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Antigravity 계정:** 여러 Google 계정으로 로그인하고 Antigravity를 닫은 상태에서도 한도를 새로고침할 수 있습니다. (#564)
- **도구 상세 내역:** 도구를 펼치면 새로 추가된 ‘토큰 / 모델’ 전환 버튼으로 토큰 상세 내역과 모델별 사용량을 선택해 볼 수 있습니다. (#554)
- **Codex 리셋 예측:** 한도가 초기화될 것으로 예상되는 시점을 확인할 수 있습니다. 설정 → AI 도구 한도에서 Codex를 펼친 뒤 ‘리셋 예측’을 켜면 사용할 수 있습니다. 기본적으로 꺼져 있습니다. (#555)
- **Windows 작업 표시줄:** 앱 전환 후 작업 표시줄과 겹친 플로팅 위젯을 다시 위로 올리는 실험적 옵션을 추가했습니다. 기본적으로 꺼져 있으며 잠시 깜박일 수 있습니다. (#548)

### 개선
- **백그라운드 성능:** 창이 숨겨지거나 최소화된 동안, 또는 화면을 사용하지 않을 때 렌더링 부담을 줄였습니다. (#386)
- **Codex 한도 이름:** `gpt-reserve`를 `Luna Reserve`로 표시합니다. (#556)

### 수정
- **Antigravity 사용량 갱신:** 업데이트를 막는 오래된 동기화 잠금을 감지하고 복구 후 다시 스캔할 수 있도록 했습니다. (#568)
- **플로팅 버블:** 고밀도 디스플레이에서 이미지와 설정 미리보기가 흐릿하게 보이던 문제를 수정했습니다. (#559)
- **Qoder CN Discord 상태:** Qoder CN이 가장 많이 사용한 도구일 때 Rich Presence 아이콘이 표시되지 않던 문제를 수정했습니다.
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.51.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.51.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-Setup-0.51.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.51.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Antigravityアカウント：** 複数のGoogleアカウントでログインし、Antigravityを閉じたまま上限情報を更新できます。（#564）
- **ツールの詳細：** ツールを展開すると、新しい「トークン／モデル」の切り替えが表示され、トークンの詳細とモデル別の使用量を選んで確認できます。（#554）
- **Codexリセット予測：** 利用枠のリセット予想時刻を確認できます。「設定 → AIツール制限」でCodexを展開し、「リセット予測」をオンにすると利用できます。初期設定ではオフです。（#555）
- **Windowsタスクバー：** アプリ切り替え後、タスクバーと重なったフローティングウィジェットを前面に戻す試験的なオプションを追加しました。初期設定ではオフで、一時的にちらつく場合があります。（#548）

### 改善
- **バックグラウンドの動作：** ウィンドウの非表示・最小化中や、使用していない画面の描画負荷を軽減しました。（#386）
- **Codexの上限名：** `gpt-reserve`を`Luna Reserve`と表示します。（#556）

### 修正
- **Antigravityの使用量更新：** 更新を妨げる古い同期ロックを検出し、修復して再スキャンできるようにしました。（#568）
- **フローティングバブル：** 高密度ディスプレイで画像や設定のプレビューがぼやける問題を修正しました。（#559）
- **Qoder CNのDiscordステータス：** Qoder CNが最も使用したツールの場合に、Rich Presenceのアイコンが表示されない問題を修正しました。
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.51.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.51.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-Setup-0.51.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.51.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.51.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.51.0/Token-Monitor-0.51.0.AppImage)

</details>

</details>
