# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Edge Dock cache hit rate:** Adds a selectable item showing today's rate, with a hit/miss bar and session details in the card. (#1307)
- **Session search:** Search the session list from the icon beside the total cost, matching titles, tool and model labels, and IDs in the current period. (#1454)
- **Currencies:** Supports AUD, BRL, CAD, CHF, EUR, GBP, INR, JPY, KRW and SGD for display costs and subscription amounts. Update every device sharing a subscription list before recording these currencies. (#1449, #1452)

### Improved
- **Cursor quotas:** The “Included usage” quota is labeled “Weekly” or “Monthly” according to its period. (#1447)
- **Sync uploads:** Raises the upload size limit to 2 MiB, so devices with large histories keep more session detail and daily totals. Self-hosted Workers keep the 1 MiB limit until redeployed, and iCloud sync users should update every Mac. (#1450)
- **Platform wording:** Settings descriptions and shortcut hints name only the current operating system. (#1455)

### Fixed
- **Cursor accounts:** Switching desktop accounts no longer leaves a stale account asking to sign in on the quota card. (#1447)
- **macOS panels:** Switching Notch or Edge Dock materials no longer leaves a black rectangle around the panel. (#1445)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.91.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.91.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-Setup-0.91.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.91.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.AppImage)

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
- **侧边栏缓存命中率：** 新增可选项目，显示今日命中率，卡片内含命中/未命中比例条与会话明细。 （#1307）
- **会话搜索：** 可通过总费用旁的图标搜索会话列表，匹配当前周期内的标题、工具与模型标签及 ID。 （#1454）
- **货币：** 费用显示与订阅金额支持 AUD、BRL、CAD、CHF、EUR、GBP、INR、JPY、KRW 和 SGD。使用这些货币前，请先更新所有共享订阅列表的设备。 （#1449、#1452）

### 改进
- **Cursor 额度：** “Included usage”额度按周期显示为“Weekly”或“Monthly”。 （#1447）
- **同步上传：** 上传大小上限提高到 2 MiB，历史较大的设备可保留更多会话明细与每日合计。自托管 Worker 重新部署前仍为 1 MiB 上限，使用 iCloud 同步时请更新每一台 Mac。 （#1450）
- **平台文案：** 设置说明与快捷键提示只显示当前操作系统的写法。 （#1455）

### 修复
- **Cursor 账号：** 切换桌面账号后，额度卡片不再残留要求重新登录的旧账号。 （#1447）
- **macOS 面板：** 切换刘海面板或侧边栏的材质后，面板周围不再残留黑色方框。 （#1445）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.91.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.91.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-Setup-0.91.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.91.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.90.0...v0.91.0">v0.90.0...v0.91.0</a></summary>

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
- **側邊欄快取命中率：** 新增可選項目，顯示今日命中率，卡片內含命中/未命中比例條與會話明細。 （#1307）
- **會話搜尋：** 可透過總費用旁的圖示搜尋會話列表，比對目前週期內的標題、工具與模型標籤及 ID。 （#1454）
- **貨幣：** 費用顯示與訂閱金額支援 AUD、BRL、CAD、CHF、EUR、GBP、INR、JPY、KRW 與 SGD。使用這些貨幣前，請先更新所有共用訂閱清單的裝置。 （#1449、#1452）

### 改進
- **Cursor 額度：** 「Included usage」額度依週期顯示為「Weekly」或「Monthly」。 （#1447）
- **同步上傳：** 上傳大小上限提高到 2 MiB，歷史較大的裝置可保留更多會話明細與每日合計。自架 Worker 重新部署前仍為 1 MiB 上限，使用 iCloud 同步時請更新每一台 Mac。 （#1450）
- **平台文案：** 設定說明與快捷鍵提示只顯示目前作業系統的寫法。 （#1455）

### 修復
- **Cursor 帳號：** 切換桌面帳號後，額度卡片不再殘留要求重新登入的舊帳號。 （#1447）
- **macOS 面板：** 切換瀏海面板或側邊欄的材質後，面板周圍不再殘留黑色方框。 （#1445）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.91.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.91.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-Setup-0.91.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.91.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Edge Dock 캐시 적중률:** 오늘의 적중률을 표시하는 선택형 항목을 추가했습니다. 카드에서 적중/미적중 막대와 세션 상세를 확인할 수 있습니다. (#1307)
- **세션 검색:** 총 비용 옆 아이콘으로 세션 목록을 검색합니다. 현재 기간의 제목, 도구·모델 라벨, ID와 일치하는 세션을 찾습니다. (#1454)
- **통화:** 비용 표시와 구독 금액에서 AUD, BRL, CAD, CHF, EUR, GBP, INR, JPY, KRW, SGD를 지원합니다. 이 통화로 기록하기 전에 구독 목록을 공유하는 모든 기기를 업데이트하세요. (#1449, #1452)

### 개선
- **Cursor 할당량:** “Included usage” 할당량을 기간에 따라 “Weekly” 또는 “Monthly”로 표시합니다. (#1447)
- **동기화 업로드:** 업로드 크기 한도를 2 MiB로 높여, 기록이 많은 기기도 더 많은 세션 상세와 일별 합계를 유지합니다. 자체 호스팅 Worker는 다시 배포하기 전까지 1 MiB 한도를 유지하며, iCloud 동기화를 사용한다면 모든 Mac을 업데이트하세요. (#1450)
- **플랫폼별 문구:** 설정 설명과 단축키 안내에 현재 운영체제의 표기만 나타납니다. (#1455)

### 수정
- **Cursor 계정:** 데스크톱 계정을 전환한 뒤에도 할당량 카드에 로그인을 요구하는 이전 계정이 남던 문제를 수정했습니다. (#1447)
- **macOS 패널:** 노치 패널 또는 Edge Dock의 재질을 바꾼 뒤 패널 주변에 검은 사각형이 남던 문제를 수정했습니다. (#1445)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.91.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.91.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-Setup-0.91.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.91.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **エッジドックのキャッシュヒット率:** 今日のヒット率を表示する選択式の項目を追加しました。カードにはヒット/ミスの比率バーとセッションの詳細が表示されます。 (#1307)
- **セッション検索:** 合計コストの横のアイコンからセッション一覧を検索できます。現在の期間のタイトル、ツールとモデルのラベル、IDが対象です。 (#1454)
- **通貨:** コスト表示とサブスクリプション金額でAUD、BRL、CAD、CHF、EUR、GBP、INR、JPY、KRW、SGDに対応しました。これらの通貨で記録する前に、サブスクリプション一覧を共有するすべての端末を更新してください。 (#1449, #1452)

### 改善
- **Cursorの使用量上限:** 「Included usage」の上限を期間に応じて「Weekly」または「Monthly」と表示します。 (#1447)
- **同期アップロード:** アップロードサイズの上限を2 MiBに引き上げ、履歴の多い端末でもセッション詳細と日別合計をより多く保持できます。セルフホストのWorkerは再デプロイするまで1 MiBの上限のままです。iCloud同期をお使いの場合は、すべてのMacを更新してください。 (#1450)
- **プラットフォーム別の表記:** 設定の説明とショートカットの案内に、現在のOSの表記だけが表示されます。 (#1455)

### 修正
- **Cursorアカウント:** デスクトップのアカウントを切り替えた後も、ログインを求める古いアカウントが上限カードに残る問題を修正しました。 (#1447)
- **macOSのパネル:** ノッチパネルまたはエッジドックの素材を切り替えた後、パネルの周囲に黒い四角形が残る問題を修正しました。 (#1445)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.91.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.91.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-Setup-0.91.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.91.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.91.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.91.0/Token-Monitor-0.91.0.AppImage)

</details>

</details>
