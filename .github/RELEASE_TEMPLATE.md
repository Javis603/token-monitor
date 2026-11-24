# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Session sorting.** Switch between most recent activity and highest token usage in the Sessions list. (#1615)
- **Individual setting resets.** Click the reset arrow beside a changed setting to restore its default. (#1620)
- **Local Antigravity quota.** Turn off automatic detection on this device to stop reading local quota. Detection is on by default, and saved OAuth accounts refresh independently. (#1634)
- **Zed usage.** Track usage from Zed Agent threads that use a ChatGPT subscription. (#1631)

### Fixed
- **New session totals.** Show zero tokens and zero cost while the first usage reading is pending. (#1637)
- **Edge Dock across displays.** An open auto-hide dock stays open if the pointer slips just onto the adjacent display. (#1638)
- **Plugin icons in Settings.** AI Tool Limits shows the icon supplied by a plugin when one is available. (#1632)
- **Antigravity quota.** Remove the stale anonymous quota row when the same local account is identified again. (#1630)
- **Pi session names.** When a renamed or cleared session is next scanned, the change appears across date ranges. (#1631)
- **Kimi Code response speed.** Show response speed for sessions with recorded response timing when the request duration is unavailable. (#1631)
- **GPT-6.2 cost estimates.** Apply the long-context rate to the entire request for Astra and Sol when input exceeds 272,000 tokens. (#1631)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.97.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.97.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-Setup-0.97.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.97.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.AppImage)

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

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → General → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **会话排序。** 会话列表可按最近活动或 Token 用量从高到低排序。 （#1615）
- **恢复单项设置。** 点击已修改设置旁的恢复按钮，即可恢复该项默认值。 （#1620）
- **Antigravity 本机额度。** 可关闭“自动检测本机 Antigravity 账号”，停止读取本机额度。检测默认开启，已保存的 OAuth 账号会独立刷新。 （#1634）
- **Zed 用量。** 支持统计通过 ChatGPT 订阅运行的 Zed Agent 会话用量。 （#1631）

### 修复
- **新会话用量。** 在收到首笔用量数据前，Token 数和费用均显示为零。 （#1637）
- **双屏侧边栏。** 自动隐藏模式下，鼠标短距离越过屏幕边缘时，已展开的侧边栏会保持打开。 （#1638）
- **设置中的插件图标。** “AI 工具额度”会显示插件提供的图标。 （#1632）
- **Antigravity 额度。** 重新识别出同一个本机账号后，移除旧的匿名额度条目。 （#1630）
- **Pi 会话名称。** 再次扫描到该会话时，各时间范围都会反映名称的修改或清除。 （#1631）
- **Kimi Code 响应速度。** 缺少请求耗时时，仍可根据会话记录中的响应耗时显示速度。 （#1631）
- **GPT-6.2 费用估算。** Astra 和 Sol 的输入超过 272,000 Token 时，整笔请求按长上下文费率计价。 （#1631）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.97.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.97.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-Setup-0.97.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.97.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.AppImage)

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

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 常规 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.96.1...v0.97.0">v0.96.1...v0.97.0</a></summary>

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
- **會話排序。** 會話列表可按最近活動排序，也可將 Token 用量最高的會話排在前面。 （#1615）
- **還原個別設定。** 點選已修改設定旁的還原按鈕，即可將該項還原為預設值。 （#1620）
- **Antigravity 本機額度。** 可關閉「自動偵測本機 Antigravity 帳戶」，停止讀取本機額度。偵測預設開啟，已儲存的 OAuth 帳戶會獨立更新。 （#1634）
- **Zed 用量。** 支援統計透過 ChatGPT 訂閱執行的 Zed Agent 會話用量。 （#1631）

### 修復
- **新會話用量。** 收到第一筆用量資料前，Token 數和費用都會顯示為零。 （#1637）
- **雙螢幕側邊欄。** 自動隱藏模式下，游標稍微越過螢幕邊緣時，已展開的側邊欄會保持開啟。 （#1638）
- **設定中的外掛圖示。** 「AI 工具額度」會顯示外掛提供的圖示。 （#1632）
- **Antigravity 額度。** 重新辨識出同一個本機帳戶後，會移除舊的匿名額度項目。 （#1630）
- **Pi 會話名稱。** 下次掃描到該會話時，各時間範圍都會反映名稱的變更或清除。 （#1631）
- **Kimi Code 回應速度。** 缺少請求耗時時，仍可根據會話記錄中的回應耗時顯示速度。 （#1631）
- **GPT-6.2 費用估算。** Astra 和 Sol 的輸入超過 272,000 Token 時，整筆請求會按長上下文費率計算。 （#1631）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.97.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.97.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-Setup-0.97.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.97.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **세션 정렬.** 세션 목록을 최근 활동순이나 토큰이 많은 순으로 볼 수 있습니다. (#1615)
- **개별 설정 재설정.** 변경한 설정 옆의 재설정 버튼을 누르면 해당 설정을 기본값으로 되돌릴 수 있습니다. (#1620)
- **로컬 Antigravity 할당량.** ‘로컬 Antigravity 계정 자동 감지’를 끄면 이 기기의 할당량 조회를 중단할 수 있습니다. 기본값은 켜짐이며, 저장된 OAuth 계정은 별도로 갱신됩니다. (#1634)
- **Zed 사용량.** ChatGPT 구독을 이용하는 Zed Agent 스레드의 사용량을 집계합니다. (#1631)

### 수정
- **새 세션의 사용량.** 첫 사용량 데이터가 들어올 때까지 토큰 수와 비용을 0으로 표시합니다. (#1637)
- **다중 디스플레이에서 가장자리 도크.** 자동 숨김 모드에서 포인터가 화면 가장자리를 조금 넘어가도 펼친 도크가 열린 상태로 유지됩니다. (#1638)
- **설정의 플러그인 아이콘.** ‘AI 도구 한도’에 플러그인이 제공하는 아이콘을 표시합니다. (#1632)
- **Antigravity 할당량.** 같은 로컬 계정이 다시 식별되면 이전 익명 할당량 항목을 제거합니다. (#1630)
- **Pi 세션 이름.** 이름을 바꾸거나 지운 세션을 다시 읽으면 각 기간에 변경 사항이 반영됩니다. (#1631)
- **Kimi Code 응답 속도.** 요청 소요 시간을 알 수 없어도 세션에 기록된 응답 시간이 있으면 속도를 표시합니다. (#1631)
- **GPT-6.2 예상 비용.** Astra와 Sol의 입력이 272,000토큰을 넘으면 요청 전체에 긴 컨텍스트 요율을 적용합니다. (#1631)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.97.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.97.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-Setup-0.97.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.97.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **セッションの並べ替え。** セッション一覧を最近のアクティビティ順とトークン数の多い順で切り替えられます。 （#1615）
- **設定項目ごとのリセット。** 変更した項目の横にあるボタンを押すと、その項目を既定値に戻せます。 （#1620）
- **Antigravity のローカル使用量上限。** 「ローカルの Antigravity アカウントを自動検出」をオフにすると、この端末からの上限取得を停止できます。既定ではオンで、保存済みの OAuth アカウントは個別に更新されます。 （#1634）
- **Zed の使用量。** ChatGPT のサブスクリプションを利用する Zed Agent スレッドの使用量を集計します。 （#1631）

### 修正
- **新しいセッションの使用量。** 最初の使用量データが届くまで、トークン数と費用をゼロと表示します。 （#1637）
- **複数画面でのエッジドック。** 自動で隠れるモードでは、ポインターが隣の画面に少しはみ出しても、開いたドックを表示し続けます。 （#1638）
- **設定のプラグインアイコン。** 「AIツール制限」にプラグインが提供するアイコンを表示します。 （#1632）
- **Antigravity の使用量上限。** 同じローカルアカウントを再び識別できたときに、以前の匿名の上限表示を取り除きます。 （#1630）
- **Pi のセッション名。** セッションが次に読み込まれたとき、名前の変更や削除が各期間に反映されます。 （#1631）
- **Kimi Code の応答速度。** リクエストの所要時間が取得できない場合も、セッションに応答時間の記録があれば速度を表示します。 （#1631）
- **GPT-6.2 の推定費用。** Astra と Sol の入力が 272,000 トークンを超えると、リクエスト全体に長いコンテキスト向けの料金を適用します。 （#1631）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.97.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.97.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-Setup-0.97.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.97.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.97.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.97.0/Token-Monitor-0.97.0.AppImage)

</details>

</details>
