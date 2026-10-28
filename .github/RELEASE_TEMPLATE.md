# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Claude Web accounts:** Manage multiple Web accounts alongside the automatically detected Claude Code account, with per-account login renewal, enable switches and removal. (#1220)
- **Muse Code quota:** Supports session and weekly subscription limits from Muse Code 1.4.13+ after signing in with `muse login`. Existing installs can enable it under Settings → AI Tool Limits. (#1209)
- **Ollama API keys:** Supports API-key authentication as an alternative to Cookie credentials. (#1188)
- **Ollama credits:** Supports monthly included credits and purchased credit balances through API-key or Cookie credentials. (#1205)

### Improved
- **Notch Panel session summary:** In “Session activity only” mode, groups client icons and shows separate counts for running and waiting sessions. (#1217)
- **Notch Panel spacing:** Reduces the gap beside the camera housing for a more compact collapsed summary. (#1218)

### Fixed
- **Notch Panel hover:** Prevents transparent corners and unfinished hover animations from triggering expansion or capturing input outside the visible outline. (#1215)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.80.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.80.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-Setup-0.80.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.80.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.AppImage)

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
- **Claude Web 账号：** 支持管理多个 Web 账号，与自动检测的 Claude Code 账号同时显示，并可分别更新登录、启用、停用或移除。 （#1220）
- **Muse Code 额度：** 支持读取 Muse Code 1.4.13+ 的会话及每周订阅额度，需先通过 `muse login` 登录；已有安装可在“设置 → AI 工具额度”中启用。 （#1209）
- **Ollama API 密钥：** 支持使用 API 密钥作为 Cookie 之外的认证方式。 （#1188）
- **Ollama 点数：** 支持通过 API 密钥或 Cookie 显示每月包含点数及购买点数余额。 （#1205）

### 改进
- **刘海面板会话摘要：** 在“仅会话活动”模式下合并显示工具图标，并分别显示运行中及等待中的会话数量。 （#1217）
- **刘海面板间距：** 缩小摄像头两侧的留白，让收起摘要更紧凑。 （#1218）

### 修复
- **刘海面板悬停：** 修复透明圆角和未完成的悬停动画导致面板提前展开或在可见轮廓外拦截输入的问题。 （#1215）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.80.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.80.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-Setup-0.80.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.80.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.79.0...v0.80.0">v0.79.0...v0.80.0</a></summary>

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
- **Claude Web 帳號：** 支援管理多個 Web 帳號，與自動偵測的 Claude Code 帳號同時顯示，並可分別更新登入、啟用、停用或移除。 （#1220）
- **Muse Code 額度：** 支援讀取 Muse Code 1.4.13+ 的會話及每週訂閱額度，需先透過 `muse login` 登入；既有安裝可在「設定 → AI 工具額度」中啟用。 （#1209）
- **Ollama API 金鑰：** 支援使用 API 金鑰作為 Cookie 以外的驗證方式。 （#1188）
- **Ollama 點數：** 支援透過 API 金鑰或 Cookie 顯示每月內含點數及購買點數餘額。 （#1205）

### 改進
- **瀏海面板會話摘要：** 在「僅會話活動」模式下合併顯示工具圖示，並分別顯示進行中及等待中的會話數量。 （#1217）
- **瀏海面板間距：** 縮小相機兩側的留白，讓收合摘要更緊湊。 （#1218）

### 修復
- **瀏海面板懸停：** 修復透明圓角和未完成的懸停動畫導致面板提早展開或在可見輪廓外攔截輸入的問題。 （#1215）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.80.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.80.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-Setup-0.80.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.80.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Claude Web 계정:** 자동으로 감지한 Claude Code 계정과 함께 여러 Web 계정을 관리할 수 있습니다. 계정별로 로그인을 갱신하거나 사용 여부를 바꾸고 삭제할 수 있습니다. (#1220)
- **Muse Code 한도:** Muse Code 1.4.13+에서 `muse login`으로 로그인하면 세션 및 주간 구독 한도를 확인할 수 있습니다. 기존 설치에서는 '설정 → AI 도구 한도'에서 켤 수 있습니다. (#1209)
- **Ollama API 키:** 쿠키 대신 API 키로 인증할 수 있습니다. (#1188)
- **Ollama 크레딧:** API 키 또는 쿠키로 월간 포함 크레딧과 구매한 크레딧 잔액을 확인할 수 있습니다. (#1205)

### 개선
- **노치 패널 세션 요약:** '세션 활동만' 모드에서 도구 아이콘을 모아 표시하고, 실행 중인 세션과 입력을 기다리는 세션 수를 구분해 보여 줍니다. (#1217)
- **노치 패널 간격:** 카메라 양옆의 여백을 줄여 접힌 요약이 차지하는 공간을 줄였습니다. (#1218)

### 수정
- **노치 패널 마우스 오버:** 투명한 모서리나 진행 중인 확대 애니메이션 때문에 패널이 미리 열리거나 보이는 윤곽 밖에서 입력을 가로채는 문제를 해결했습니다. (#1215)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.80.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.80.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-Setup-0.80.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.80.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Claude Web アカウント:** 自動検出した Claude Code アカウントと併せて、複数の Web アカウントを管理できます。アカウントごとにログインの更新、有効・無効の切り替え、削除ができます。 (#1220)
- **Muse Code のクォータ:** Muse Code 1.4.13+ で `muse login` を使ってログインすると、セッションと週間のサブスクリプション上限を確認できます。既存のインストールでは「設定 → AIツール制限」で有効にできます。 (#1209)
- **Ollama API キー:** Cookie に加え、API キーでの認証に対応しました。 (#1188)
- **Ollama クレジット:** API キーまたは Cookie を使って、月間の付与クレジットと購入済みクレジットの残高を確認できます。 (#1205)

### 改善
- **ノッチパネルのセッション概要:** 「セッション活動のみ」モードでツールのアイコンをまとめ、実行中と入力待ちのセッション数を分けて表示します。 (#1217)
- **ノッチパネルの余白:** カメラの両側の余白を減らし、折りたたんだ概要をコンパクトにしました。 (#1218)

### 修正
- **ノッチパネルのホバー:** 透明な角や拡大途中のアニメーションによって、見える輪郭の外側でパネルが開いたり入力を奪ったりする問題を修正しました。 (#1215)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.80.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.80.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-Setup-0.80.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.80.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.80.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.80.0/Token-Monitor-0.80.0.AppImage)

</details>

</details>
