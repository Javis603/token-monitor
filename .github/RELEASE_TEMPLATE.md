# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Command Code usage:** Command Code usage now appears in the usage views. (#411)
- **Qoder CN usage:** Turn on `Qoder CN` in `Settings → Tools` to see Qoder CN usage. (#301)
- **OpenCode Go quotas:** Go accounts signed in on this computer are detected automatically, so their quotas appear without copying a Cookie by hand. (#406, #414, #416)
- **Command Code limits:** `AI Tool Limits` now shows Command Code's 5-hour, weekly, monthly, and top-up credits. (#421)
- **Adaptive refresh:** Choose `Adaptive` to update percentage-based limits more often when usage is high. (#405)
- **Custom fonts:** Choose separate `Interface font` and `Display font` settings in `Appearance → Advanced customization`. (#432)

### Fixed
- **Trends dates:** Today's activity and streaks now follow the date on the device that produced the data, even when the Hub is in another time zone. (#428)
- **WSL detection guidance:** When WSL detects a tool such as CLI-only ZCode but cannot read its usage, the settings panel now prompts you to run the headless agent inside WSL. (#431)
- **Windows tray icons:** Tray icons stay visible when switching between light and dark themes. (#420)
- **Linux tray menu:** The Linux tray context menu is available again. (#413)
- **Proma cost estimates:** Known-model cost estimates remain available when online pricing cannot be reached. (#418)
- **AI Tool Limits with system proxy:** Limits can load through the operating system proxy without an extra shell proxy setting. (#380)
<!-- app-update-notes:en:end -->

## Download

- **macOS Apple Silicon** — [Token-Monitor-0.45.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.45.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-Setup-0.45.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.45.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.AppImage)

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
- **Command Code 用量：** 现在可以在用量视图中查看 Command Code 用量。（#411）
- **Qoder CN 用量：** 在“设置 → 工具”中启用 `Qoder CN` 后，即可查看 Qoder CN 用量。（#301）
- **OpenCode Go 额度：** 本机已登录的 Go 账号会自动检测并显示额度，不再需要手动复制 Cookie。（#406、#414、#416）
- **Command Code 额度：** “AI 工具额度”现在会显示 Command Code 的 5 小时、每周、月度和加购额度。（#421）
- **自适应刷新：** 选择“自适应”后，额度消耗较快时会更及时更新。（#405）
- **自定义字体：** 在“外观 → 高级自定义”中分别设置“界面字体”和“显示字体”。（#432）

### 修复
- **趋势日期：** “趋势”按产生数据的设备日期计算今日活动和连续天数，即使 Hub 位于其他时区也不会错位。（#428）
- **WSL 检测提示：** 当 WSL 检测到 CLI 版 ZCode 等工具但无法读取用量时，设置面板现在会提示你在 WSL 内运行 headless agent。（#431）
- **Windows 托盘图标：** Windows 切换浅色和深色主题后，托盘图标仍会保持可见。（#420）
- **Linux 托盘菜单：** Linux 托盘右键菜单恢复可用。（#413）
- **Proma 成本估算：** 在线价格查询不可用时，Proma 仍会使用本地价格信息显示已知模型的成本估算。（#418）
- **系统代理下的 AI 工具额度：** 应用会使用操作系统代理加载额度，不需要另外设置 shell 代理。（#380）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.45.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.45.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-Setup-0.45.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.45.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.44.0...v0.45.0">v0.44.0...v0.45.0</a></summary>

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
- **Command Code 用量：** 現在可以在用量檢視中查看 Command Code 用量。（#411）
- **Qoder CN 用量：** 在「設定 → 工具」中啟用 `Qoder CN` 後，即可查看 Qoder CN 用量。（#301）
- **OpenCode Go 額度：** 本機已登入的 Go 帳號會自動偵測並顯示額度，不再需要手動複製 Cookie。（#406、#414、#416）
- **Command Code 額度：** 「AI 工具額度」現在會顯示 Command Code 的 5 小時、每週、每月和加購額度。（#421）
- **自適應更新：** 選擇「自適應」後，額度消耗較快時會更及時更新。（#405）
- **自訂字體：** 在「外觀 → 進階自訂」中分別設定「介面字體」和「顯示字體」。（#432）

### 修復
- **趨勢日期：** 「趨勢」按產生資料的裝置日期計算今日活動和連續天數，即使 Hub 位於其他時區也不會錯位。（#428）
- **WSL 偵測提示：** 當 WSL 偵測到 CLI 版 ZCode 等工具但無法讀取用量時，設定面板現在會提示你在 WSL 內執行 headless agent。（#431）
- **Windows 托盤圖示：** Windows 切換淺色和深色主題後，托盤圖示仍會保持可見。（#420）
- **Linux 托盤選單：** Linux 托盤右鍵選單恢復可用。（#413）
- **Proma 成本估算：** 線上價格查詢不可用時，Proma 仍會使用本機價格資訊顯示已知模型的成本估算。（#418）
- **系統代理下的 AI 工具額度：** 應用程式會使用作業系統代理載入額度，不需要另外設定 shell 代理。（#380）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.45.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.45.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-Setup-0.45.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.45.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Command Code 사용량:** 사용량 보기에서 Command Code 사용량을 확인할 수 있습니다. (#411)
- **Qoder CN 사용량:** `설정 → 도구`에서 `Qoder CN`을 켜면 Qoder CN 사용량을 확인할 수 있습니다. (#301)
- **OpenCode Go 한도:** 이 컴퓨터에 로그인된 Go 계정을 자동으로 감지해 한도를 표시하므로 Cookie를 수동으로 복사할 필요가 없습니다. (#406, #414, #416)
- **Command Code 한도:** `AI 도구 한도`에 Command Code의 5시간, 주간, 월간 및 추가 크레딧이 표시됩니다. (#421)
- **적응형 새로 고침:** `적응형`을 선택하면 한도가 빠르게 소진될 때 더 자주 업데이트합니다. (#405)
- **글꼴 사용자 지정:** `외관 → 고급 사용자 지정`에서 `인터페이스 글꼴`과 `표시 글꼴`을 따로 설정할 수 있습니다. (#432)

### 수정
- **추이 날짜:** `추이`의 오늘 활동과 연속 기록이 데이터를 만든 기기의 날짜를 기준으로 계산되어 Hub가 다른 시간대에 있어도 어긋나지 않습니다. (#428)
- **WSL 감지 안내:** WSL에서 CLI 전용 ZCode 같은 도구를 감지했지만 사용량을 읽지 못하면, 설정 패널에 WSL 안에서 headless agent를 실행하라는 안내가 표시됩니다. (#431)
- **Windows 트레이 아이콘:** 밝은 테마와 어두운 테마를 바꿔도 트레이 아이콘이 계속 표시됩니다. (#420)
- **Linux 트레이 메뉴:** Linux 트레이 오른쪽 메뉴를 다시 사용할 수 있습니다. (#413)
- **Proma 비용 추정:** 온라인 가격 조회를 사용할 수 없어도 알려진 모델의 비용 추정을 표시합니다. (#418)
- **시스템 프록시의 AI 도구 한도:** 별도의 shell 프록시 설정 없이 운영체제 프록시를 통해 한도를 불러옵니다. (#380)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.45.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.45.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-Setup-0.45.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.45.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Command Code 使用量:** 使用量ビューで Command Code の使用量を確認できます。（#411）
- **Qoder CN 使用量:** `設定 → ツール` で `Qoder CN` を有効にすると、Qoder CN の使用量を確認できます。（#301）
- **OpenCode Go の上限:** このコンピューターでログイン中の Go アカウントを自動検出して上限を表示するため、Cookie を手動でコピーする必要がありません。（#406、#414、#416）
- **Command Code の制限:** `AIツール制限` に Command Code の 5時間・週次・月次・追加クレジットが表示されます。（#421）
- **自動調整の更新:** `自動調整` を選ぶと、上限の消費が速いときに更新頻度が上がります。（#405）
- **フォントのカスタマイズ:** `外観 → 詳細カスタマイズ` で `インターフェースフォント` と `表示フォント` を個別に設定できます。（#432）

### 修正
- **トレンドの日付:** `トレンド` の今日のアクティビティと連続日数がデータを作成したデバイスの日付を基準に計算され、Hub が別のタイムゾーンでもずれません。（#428）
- **WSL 検出の案内:** WSL で CLI 版 ZCode などのツールを検出しても使用量を読み取れない場合、設定パネルに WSL 内で headless agent を実行する案内が表示されます。（#431）
- **Windows のトレイアイコン:** 明るいテーマと暗いテーマを切り替えてもトレイアイコンが表示されます。（#420）
- **Linux のトレイメニュー:** Linux でトレイの右クリックメニューを再び使えます。（#413）
- **Proma のコスト推定:** オンラインの価格取得が使えなくても、既知のモデルのコスト推定を表示します。（#418）
- **システムプロキシでの AIツール制限:** 別の shell プロキシ設定なしで、OS のプロキシ経由で制限を読み込めます。（#380）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.45.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.45.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-Setup-0.45.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.45.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.45.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.45.0/Token-Monitor-0.45.0.AppImage)

</details>

</details>
