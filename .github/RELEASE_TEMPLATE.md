# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Manus credits:** Supports the signed-in desktop account on macOS and Windows, or a manually supplied web session. (#1178)
- **Muse web quota:** Shows weekly allowance and additional balance with a manually supplied muse.ai Cookie, separately from Muse Code CLI limits. (#1305)
- **Edge Dock:** Drag away from a screen edge to float as a capsule; drag back to either side to dock again. (#1293)
- **Plugin data:** Exposes live token rates and measurement coverage to plugins. (#1292)

### Improved
- **Windows Edge Dock:** Follows the cursor more smoothly while dragging. (#1298)

### Fixed
- **Codex output rates:** Empty completions no longer lower live readings or historical averages. (#1294)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.84.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-Setup-0.84.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.84.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.AppImage)

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
- **Manus 积分：** 支持读取 macOS、Windows 桌面端已登录账号的积分，或手动填写网页会话。 （#1178）
- **Muse 网页额度：** 手动填写 muse.ai Cookie 后，可查看每周额度与额外余额，与 Muse Code CLI 额度分开展示。 （#1305）
- **侧边栏：** 拖离屏幕边缘即可变为悬浮胶囊，拖回左右边缘可重新停靠。 （#1293）
- **插件数据：** 向插件开放实时 Token 速率与测量覆盖信息。 （#1292）

### 改进
- **Windows 侧边栏：** 拖动时更流畅地跟随鼠标。 （#1298）

### 修复
- **Codex 输出速率：** 空回复不再拉低实时读数或历史平均值。 （#1294）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.84.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-Setup-0.84.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.84.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.83.0...v0.84.0">v0.83.0...v0.84.0</a></summary>

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
- **Manus 積分：** 支援讀取 macOS、Windows 桌面端已登入帳號的積分，或手動填入網頁工作階段。 （#1178）
- **Muse 網頁額度：** 手動填入 muse.ai Cookie 後，可查看每週額度與額外餘額，與 Muse Code CLI 額度分開顯示。 （#1305）
- **側邊欄：** 拖離螢幕邊緣即可變成浮動膠囊，拖回左右邊緣可重新停靠。 （#1293）
- **外掛資料：** 向外掛開放即時 Token 速率與量測涵蓋資訊。 （#1292）

### 改進
- **Windows 側邊欄：** 拖曳時更流暢地跟隨滑鼠。 （#1298）

### 修復
- **Codex 輸出速率：** 空回覆不再拉低即時讀數或歷史平均值。 （#1294）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.84.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-Setup-0.84.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.84.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Manus 크레딧:** macOS와 Windows에서 로그인된 데스크톱 계정을 지원하며, 웹 세션을 직접 입력할 수 있습니다. (#1178)
- **Muse 웹 할당량:** muse.ai Cookie를 직접 입력하면 주간 할당량과 추가 잔액을 Muse Code CLI 한도와 별도로 표시합니다. (#1305)
- **가장자리 도크:** 화면 가장자리에서 끌어내면 캡슐로 띄울 수 있으며, 좌우 가장자리로 끌면 다시 고정됩니다. (#1293)
- **플러그인 데이터:** 플러그인에 실시간 토큰 속도와 측정 범위 정보를 제공합니다. (#1292)

### 개선
- **Windows 가장자리 도크:** 드래그할 때 커서를 더 부드럽게 따라갑니다. (#1298)

### 수정
- **Codex 출력 속도:** 빈 응답으로 실시간 속도와 과거 평균이 낮아지던 문제를 수정했습니다. (#1294)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.84.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-Setup-0.84.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.84.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Manus クレジット:** macOS・Windowsのデスクトップ版でログイン中のアカウントに対応。Webセッションを手動で入力できます。 (#1178)
- **Muse Webの利用枠:** muse.aiのCookieを手動で入力すると、週間利用枠と追加残高をMuse Code CLIの利用枠とは別に表示します。 (#1305)
- **エッジドック:** 画面端からドラッグするとカプセルとして自由に配置でき、左右の端に戻すと再び固定できます。 (#1293)
- **プラグインデータ:** リアルタイムのトークン速度と計測範囲の情報をプラグインに提供します。 (#1292)

### 改善
- **Windowsのエッジドック:** ドラッグ中にカーソルをより滑らかに追従します。 (#1298)

### 修正
- **Codexの出力速度:** 空の応答によってリアルタイム値や過去の平均が低下する問題を修正。 (#1294)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.84.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.84.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-Setup-0.84.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.84.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.84.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.84.0/Token-Monitor-0.84.0.AppImage)

</details>

</details>
