# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **WorkBuddy Credits:** Track Credits from the signed-in WorkBuddy desktop app on macOS and Windows; headless deployments can use the documented environment fallback. (#378)
- **Cherry Studio usage:** Track Cherry Studio token usage in usage views and breakdowns. (#387)

### Improved
- **Tray balance display:** Credits-backed tray items can show the balance-meter percentage, while Balance remains the default. (#470)

### Fixed
- **Codex limits:** OAuth quota and reset-count data are preferred when available, with the managed account's workspace mapping preserved. (#473)
- **Targeted usage refreshes:** Refreshing one or more tools no longer clears unrelated usage when the targeted result is incomplete. (#467)
- **AI Tool Limits refreshes:** Provider process failures now finish cleanly, with supported fallback paths still available where applicable. (#464)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.47.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.47.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-Setup-0.47.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.47.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.AppImage)

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
- **WorkBuddy Credits：** 支持在 macOS 和 Windows 上读取已登录的 WorkBuddy 桌面应用的 Credits；无界面部署可使用文档中的环境变量后备配置。（#378）
- **Cherry Studio 用量：** 新增 Cherry Studio Token 用量追踪，可在用量视图和分解中查看。（#387）

### 改进
- **托盘余额显示：** Credits 项目可选择显示余额或额度条百分比，默认仍显示余额。（#470）

### 修复
- **Codex 额度：** 优先读取 OAuth 账号的额度与重置次数，并保留管理账号的工作区对应关系。（#473）
- **定向用量刷新：** 刷新一个或多个工具时，即使返回结果不完整，也不会清除其他工具的用量。（#467）
- **AI 工具额度刷新：** 提供商进程异常时，额度刷新会正常收尾；支持后备路径的提供商会继续尝试后备方案。（#464）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.47.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.47.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-Setup-0.47.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.47.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.46.0...v0.47.0">v0.46.0...v0.47.0</a></summary>

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
- **WorkBuddy Credits：** 支援在 macOS 與 Windows 上讀取已登入的 WorkBuddy 桌面應用程式 Credits；無介面部署可使用文件中的環境變數後備設定。（#378）
- **Cherry Studio 用量：** 新增 Cherry Studio Token 用量追蹤，可在用量檢視與分解中查看。（#387）

### 改進
- **托盤餘額顯示：** Credits 項目可選擇顯示餘額或額度條百分比，預設仍顯示餘額。（#470）

### 修復
- **Codex 額度：** 優先讀取 OAuth 帳號的額度與重置次數，並保留管理帳號的工作區對應關係。（#473）
- **定向用量重新整理：** 重新整理一個或多個工具時，即使回傳結果不完整，也不會清除其他工具的用量。（#467）
- **AI 工具額度重新整理：** 提供者程序異常時，額度重新整理會正常收尾；支援後備路徑的提供者會繼續嘗試後備方案。（#464）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.47.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.47.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-Setup-0.47.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.47.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **WorkBuddy Credits:** macOS와 Windows에서 로그인된 WorkBuddy 데스크톱 앱의 Credits를 추적합니다. 헤드리스 배포에서는 문서화된 환경 변수 대체 설정을 사용할 수 있습니다. (#378)
- **Cherry Studio 사용량:** Cherry Studio 토큰 사용량을 추적하고 사용량 보기와 내역에서 확인할 수 있습니다. (#387)

### 개선
- **트레이 잔액 표시:** Credits 기반 트레이 항목에서 잔액 또는 미터 백분율을 선택할 수 있으며, 기본값은 잔액입니다. (#470)

### 수정
- **Codex 한도:** OAuth 계정의 한도와 리셋 횟수를 우선 사용하고, 관리 계정의 워크스페이스 연결을 유지합니다. (#473)
- **대상 사용량 새로 고침:** 하나 이상의 도구를 새로 고칠 때 결과가 불완전해도 다른 도구의 사용량을 지우지 않습니다. (#467)
- **AI 도구 한도 새로 고침:** 공급자 프로세스 오류가 발생해도 새로 고침이 정상적으로 마무리되며, 지원되는 경우 대체 경로를 계속 시도합니다. (#464)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.47.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.47.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-Setup-0.47.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.47.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **WorkBuddy Credits：** macOSとWindowsで、ログイン済みのWorkBuddyデスクトップアプリからCreditsを追跡できます。ヘッドレス環境では、ドキュメントに記載された環境変数のフォールバックを利用できます。（#378）
- **Cherry Studioの使用量：** Cherry Studioのトークン使用量を追跡し、使用量ビューと内訳で確認できます。（#387）

### 改善
- **トレイの残高表示：** Credits対応のトレイ項目で残高とメーターの割合を選択でき、初期値は残高です。（#470）

### 修正
- **Codexの制限：** OAuthアカウントの制限とリセット回数を優先して使用し、管理アカウントのワークスペースとの対応関係を維持します。（#473）
- **対象を絞った使用量の更新：** 1つ以上のツールを更新したとき、結果が不完全でも他のツールの使用量を消去しません。（#467）
- **AIツール制限の更新：** プロバイダーのプロセスでエラーが起きても更新を正常に終了し、対応するフォールバック経路がある場合は引き続き試行します。（#464）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.47.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.47.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-Setup-0.47.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.47.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.47.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.47.0/Token-Monitor-0.47.0.AppImage)

</details>

</details>
