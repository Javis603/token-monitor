# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Network proxy:** Adds a proxy URL and bypass list in Settings → General → Advanced for supported quota and account requests. (#1049)

### Changed
- **Claude plans:** Displays Max and Ultra in place of the former Max 5x and Max 20x names. (#1288)

### Improved
- **Codex archive scanning:** Reduces peak memory use when skipping oversized compressed session archives. (#1285)
- **Large session histories:** Reduces processing overhead during usage updates. (#1287)

### Fixed
- **Trae CN credits:** Supports a manually supplied browser Cookie when IDE credentials are rejected. (#1282)
- **Claude CLI quota:** Accepts weekly-only quota output instead of reporting it as unavailable. (#1288)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.83.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.83.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-Setup-0.83.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.83.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.AppImage)

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
- **网络代理：** 可在“设置 → 常规 → 高级”中配置代理地址和绕过列表，用于支持的额度与账号请求。 （#1049）

### 变更
- **Claude 套餐：** 原 Max 5x 和 Max 20x 分别显示为 Max 和 Ultra。 （#1288）

### 改进
- **Codex 历史扫描：** 降低跳过超大压缩会话文件时的内存峰值。 （#1285）
- **大量会话记录：** 减少用量更新时的处理开销。 （#1287）

### 修复
- **Trae CN 积分：** IDE 凭证被拒绝时，可改用手动填写的浏览器 Cookie。 （#1282）
- **Claude CLI 额度：** 仅返回每周额度时也可正常显示，不再误报为不可用。 （#1288）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.83.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.83.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-Setup-0.83.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.83.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.82.0...v0.83.0">v0.82.0...v0.83.0</a></summary>

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
- **網路代理：** 可在「設定 → 一般 → 進階」中配置代理位址與繞過清單，用於支援的額度與帳號請求。 （#1049）

### 變更
- **Claude 方案：** 原 Max 5x 與 Max 20x 分別顯示為 Max 與 Ultra。 （#1288）

### 改進
- **Codex 歷史掃描：** 降低跳過超大壓縮會話檔案時的記憶體峰值。 （#1285）
- **大量會話紀錄：** 減少用量更新時的處理負擔。 （#1287）

### 修復
- **Trae CN 點數：** IDE 憑證遭拒時，可改用手動填入的瀏覽器 Cookie。 （#1282）
- **Claude CLI 額度：** 僅傳回每週額度時也可正常顯示，不再誤報為無法使用。 （#1288）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.83.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.83.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-Setup-0.83.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.83.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **네트워크 프록시:** 설정 → 일반 → 고급에서 지원되는 한도 및 계정 요청에 사용할 프록시 URL과 제외 목록을 설정할 수 있습니다. (#1049)

### 변경
- **Claude 요금제:** 기존 Max 5x와 Max 20x를 각각 Max와 Ultra로 표시합니다. (#1288)

### 개선
- **Codex 기록 스캔:** 크기 제한을 초과한 압축 세션 파일을 건너뛸 때 최대 메모리 사용량을 줄였습니다. (#1285)
- **대규모 세션 기록:** 사용량 업데이트에 드는 처리 비용을 줄였습니다. (#1287)

### 수정
- **Trae CN 크레딧:** IDE 인증 정보가 거부되면 브라우저 Cookie를 직접 입력해 사용할 수 있습니다. (#1282)
- **Claude CLI 한도:** 주간 한도만 반환되어도 사용 불가로 처리하지 않고 표시합니다. (#1288)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.83.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.83.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-Setup-0.83.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.83.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **ネットワークプロキシ:** 「設定 → 一般 → 詳細設定」で、対応する上限・アカウント関連のリクエストに使うプロキシ URLと除外リストを設定できます。 (#1049)

### 変更
- **Claudeのプラン:** 従来のMax 5xとMax 20xを、それぞれMaxとUltraとして表示します。 (#1288)

### 改善
- **Codexの履歴スキャン:** サイズ制限を超えた圧縮セッションファイルをスキップする際のメモリ使用量のピークを抑えました。 (#1285)
- **大量のセッション履歴:** 使用量の更新にかかる処理負荷を軽減しました。 (#1287)

### 修正
- **Trae CNのクレジット:** IDEの認証情報が拒否される場合、ブラウザのCookieを手動で入力して利用できます。 (#1282)
- **Claude CLIの上限:** 週間上限のみが返された場合も、利用不可とせず表示します。 (#1288)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.83.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.83.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-Setup-0.83.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.83.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.83.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.83.0/Token-Monitor-0.83.0.AppImage)

</details>

</details>
