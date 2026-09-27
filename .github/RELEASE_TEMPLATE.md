# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **macOS Liquid Glass:** On macOS 26+, choose Liquid Glass in Appearance → macOS Glass Style for the main window and Dashboard. (#705, #816)
- **Edge Dock glass style:** On macOS 26+, choose a separate glass style for Edge Dock or have it follow the main window. (#825)
- **Cursor conversation titles:** Shows desktop conversation titles in Sessions. (#819)

### Improved
- **Background image opacity:** Adjust the image separately from Glass; the image stays layered over the glass. (#826)
- **Limits account setup:** Checks pasted credentials when saved and enables the selected limits source. (#803)

### Fixed
- **Qoder CN custom-model usage:** Reads measured tokens from newer desktop transcripts; plan-billed built-in models still do not report token counts. (#753)
- **Antigravity IDE usage:** Restores usage from IDE extension sessions. (#821)
- **TypeSafe limits:** Stops treating a Cloudflare challenge as an expired Cookie. (#814)
- **Edge Dock limits:** Shows 0% when an account-level quota is exhausted, even if its session quota remains. (#804)
- **macOS tray popover:** No longer jumps to the left edge of the primary display. (#818)
- **Edge Dock session models:** Labels sessions with multiple models consistently with Sessions. (#799)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.63.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-Setup-0.63.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.63.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.AppImage)

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
- **macOS Liquid Glass：** 在 macOS 26 及以上版本，可于“外观”→“macOS 玻璃样式”选择 Liquid Glass，应用于主窗口和仪表盘。（#705, #816）
- **侧边栏玻璃样式：** 在 macOS 26 及以上版本，可单独选择样式，或跟随主窗口。（#825）
- **Cursor 会话标题：** 在“会话”中显示桌面版对话标题。（#819）

### 改进
- **背景图片透明度：** 可独立于“玻璃”调整，图片叠加显示在玻璃之上。（#826）
- **额度账号设置：** 保存粘贴的凭据时会检查连接，并启用所选额度来源。（#803）

### 修复
- **Qoder CN 自定义模型用量：** 可读取新版桌面端实际记录的 Tokens；按方案计费的内置模型仍未提供 Tokens 数量。（#753）
- **Antigravity IDE 用量：** 修复 IDE 扩展会话的用量漏计。（#821）
- **TypeSafe 额度：** Cloudflare 验证不再被误判为 Cookie 过期。（#814）
- **侧边栏额度：** 账号级额度耗尽时显示 0%，即使会话额度仍有剩余。（#804）
- **macOS 菜单栏弹窗：** 修复弹窗跳到主显示器左边缘的问题。（#818）
- **侧边栏会话模型：** 使用多个模型的会话与“会话”列表显示一致。（#799）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.63.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-Setup-0.63.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.63.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.62.0...v0.63.0">v0.62.0...v0.63.0</a></summary>

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
- **macOS Liquid Glass：** macOS 26 或更新版本可在「外觀」→「macOS 玻璃樣式」選用 Liquid Glass，套用至主視窗和儀表板。（#705, #816）
- **側邊欄玻璃樣式：** macOS 26 或更新版本可獨立選擇樣式，或跟隨主視窗。（#825）
- **Cursor 會話標題：** 在「會話」顯示桌面版對話標題。（#819）

### 改進
- **背景圖片不透明度：** 可獨立於「玻璃」調整，圖片疊在玻璃之上。（#826）
- **額度帳號設定：** 儲存貼上的憑證時會檢查連線，並啟用所選額度來源。（#803）

### 修復
- **Qoder CN 自訂模型用量：** 可讀取新版桌面版實際記錄的 Tokens；按方案計費的內建模型仍未提供 Tokens 數量。（#753）
- **Antigravity IDE 用量：** 修復 IDE 擴充功能會話的用量漏計。（#821）
- **TypeSafe 額度：** Cloudflare 驗證不再被誤判為 Cookie 過期。（#814）
- **側邊欄額度：** 帳號層級額度用盡時顯示 0%，即使會話額度仍有餘額。（#804）
- **macOS 選單列彈窗：** 修復彈窗跳到主要顯示器左側邊緣的問題。（#818）
- **側邊欄會話模型：** 使用多個模型的會話與「會話」清單顯示一致。（#799）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.63.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-Setup-0.63.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.63.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **macOS Liquid Glass:** macOS 26 이상에서 모양 → macOS 글래스 스타일에서 Liquid Glass를 선택하면 기본 창과 대시보드에 적용됩니다. (#705, #816)
- **가장자리 도크 글래스 스타일:** macOS 26 이상에서 별도 스타일을 선택하거나 기본 창과 동일하게 설정할 수 있습니다. (#825)
- **Cursor 대화 제목:** 세션 화면에 데스크톱 대화 제목을 표시합니다. (#819)

### 개선
- **배경 이미지 불투명도:** 글래스와 별도로 조절할 수 있으며 이미지가 글래스 위에 표시됩니다. (#826)
- **한도 계정 설정:** 붙여 넣은 인증 정보를 저장할 때 연결을 확인하고 선택한 한도 제공원을 활성화합니다. (#803)

### 수정
- **Qoder CN 사용자 지정 모델 사용량:** 새 데스크톱 버전의 기록에서 실제 토큰 수를 읽습니다. 요금제에 포함된 기본 모델은 여전히 토큰 수를 기록하지 않습니다. (#753)
- **Antigravity IDE 사용량:** IDE 확장 프로그램 세션의 사용량 누락을 수정했습니다. (#821)
- **TypeSafe 한도:** Cloudflare 확인 절차를 Cookie 만료로 잘못 판단하지 않습니다. (#814)
- **가장자리 도크 한도:** 계정 전체 한도가 소진되면 세션 한도가 남아 있어도 0%를 표시합니다. (#804)
- **macOS 메뉴 막대 팝오버:** 주 디스플레이의 왼쪽 끝으로 이동하던 문제를 수정했습니다. (#818)
- **가장자리 도크 세션 모델:** 여러 모델을 사용한 세션을 세션 목록과 동일하게 표시합니다. (#799)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.63.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-Setup-0.63.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.63.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **macOS Liquid Glass：** macOS 26 以降では、外観 → macOS ガラススタイルから Liquid Glass を選ぶとメインウィンドウとダッシュボードに適用されます。（#705、#816）
- **エッジドックのガラススタイル：** macOS 26 以降では個別に選ぶか、メインウィンドウに合わせられます。（#825）
- **Cursor の会話タイトル：** セッション画面にデスクトップ版の会話タイトルを表示します。（#819）

### 改善
- **背景画像の不透明度：** ガラスとは別に調整でき、画像をガラスの上に重ねて表示します。（#826）
- **上限アカウントの設定：** 貼り付けた認証情報を保存するときに接続を確認し、選択した上限の取得元を有効にします。（#803）

### 修正
- **Qoder CN のカスタムモデル使用量：** 新しいデスクトップ版の記録から実測のトークン数を読み取ります。プラン課金の内蔵モデルは引き続きトークン数を記録しません。（#753）
- **Antigravity IDE の使用量：** IDE 拡張機能のセッションで使用量が計上されない問題を修正しました。（#821）
- **TypeSafe の上限：** Cloudflare の確認画面を Cookie の期限切れと誤判定しなくなりました。（#814）
- **エッジドックの上限：** アカウント全体の上限が尽きた場合、セッション枠が残っていても 0% と表示します。（#804）
- **macOS メニューバーのポップオーバー：** メインディスプレイの左端に飛ぶ問題を修正しました。（#818）
- **エッジドックのセッションモデル：** 複数のモデルを使ったセッションを、セッション一覧と同じ表記で表示します。（#799）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.63.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.63.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-Setup-0.63.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.63.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.63.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.63.0/Token-Monitor-0.63.0.AppImage)

</details>

</details>
