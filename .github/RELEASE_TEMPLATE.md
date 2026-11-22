# English

## What's changed

<!-- app-update-notes:en:start -->
### Improved
- **Collection settings.** Untracked tools show “Has data” when this computer already has recorded usage, or “Detected” when local data is found on disk. (#1604)
- **AI Tool Limits settings.** Disabled providers show device icons and a tooltip listing devices with live quota readings. (#1604)
- **Main Screen settings.** Move the view visibility switch into the header with a status note when hidden or locked, and display Home “Activity” options as full-width dropdown rows. (#1595)
- **Devin quota cards.** Show the signed-in email when it matches the configured organization, falling back to the organization name when unavailable. (#1602)
- **App memory.** Lower background footprint while unfocused and send smaller incremental updates to visible windows. (#1498, #1592)

### Fixed
- **Windows Chinese fonts.** Use regional sans-serif fonts instead of NSimSun in the “App default” preset across app windows. (#1598)
- **Qoder quotas.** Keep different accounts separate when multiple devices sync to the same Hub, instead of collapsing them into one row. (#1574)
- **Z.ai Team quotas.** Keep different team projects separate across synced devices while still merging readings for the same project after an API key rotates. (#1575)
- **Live usage collection.** Avoid rescanning every tracked tool when a file update includes an idle tool with no usage today. (#1591)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.95.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-Setup-0.95.1.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.95.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.AppImage)

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
### 改进
- **采集设置：** 未追踪的工具在本机已有用量记录时显示“有数据”，检测到本地数据文件时显示“已检测”。 （#1604）
- **AI 工具额度设置：** 已停用的服务商显示设备图标和提示，列出已有实时额度读数的设备。 （#1604）
- **主界面设置：** 将视图显示开关移至顶部标题栏，隐藏或无法切换时给出原因说明；主页“活动”选项改用全宽下拉行。 （#1595）
- **Devin 额度卡片：** 当登录成员与所配组织一致时显示登录邮箱，不可用时回退显示组织名。 （#1602）
- **内存与更新：** 窗口未聚焦时降低后台内存占用，并向可见窗口发送更轻量的增量更新。 （#1498, #1592）

### 修复
- **Windows 中文字体：** “App 默认”预设下各窗口改用区域无衬线字体，不再回退为新宋体（NSimSun）。 （#1598）
- **Qoder 额度：** 修复多设备同步到同一 Hub 时，不同账号可能合并为同一行的问题。 （#1574）
- **Z.ai 团队额度：** 修复多设备同步时不同团队项目合并显示的问题，并在轮换 API 密钥后仍能合并同一项目的读数。 （#1575）
- **实时用量采集：** 监听更新包含今日暂无用量的空闲工具时，不再触发全部已追踪工具的重新扫描。 （#1591）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.95.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-Setup-0.95.1.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.95.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.95.0...v0.95.1">v0.95.0...v0.95.1</a></summary>

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
- **採集設定：** 未追蹤的工具在本機已有用量記錄時顯示「有資料」，偵測到本機資料時顯示「已偵測」。 （#1604）
- **AI 工具額度設定：** 已停用的服務商顯示裝置圖示與提示，列出已有即時額度讀數的裝置。 （#1604）
- **主畫面設定：** 將檢視顯示開關移至頂部標題列，隱藏或無法切換時顯示原因說明；主頁「活動」選項改用全寬下拉列。 （#1595）
- **Devin 額度卡片：** 登入成員與所設組織一致時顯示登入信箱，無法取得時改顯示組織名稱。 （#1602）
- **記憶體與更新：** 視窗未聚焦時降低背景記憶體用量，並向可見視窗傳送更輕量的增量更新。 （#1498, #1592）

### 修復
- **Windows 中文字體：** 「App 預設」下各視窗改用區域無襯線字體，不再退回新宋體（NSimSun）。 （#1598）
- **Qoder 額度：** 修復多裝置同步到同一 Hub 時，不同帳號可能合併為同一列的問題。 （#1574）
- **Z.ai 團隊額度：** 修復多裝置同步時不同團隊專案合併顯示的問題，並在輪換 API 金鑰後仍能合併同一專案的讀數。 （#1575）
- **即時用量採集：** 監聽更新包含今日尚無用量的閒置工具時，不再觸發所有已追蹤工具的重新掃描。 （#1591）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.95.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-Setup-0.95.1.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.95.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 개선
- **수집 설정.** 추적하지 않는 도구에 이 컴퓨터의 사용 기록이 있으면 ‘데이터 있음’, 로컬 데이터가 있으면 ‘감지됨’ 태그를 표시합니다. (#1604)
- **AI 도구 한도 설정.** 비활성화된 제공업체에 실시간 할당량 데이터가 있는 기기 아이콘과 기기 목록 툴팁을 표시합니다. (#1604)
- **메인 화면 설정.** 보기 표시 스위치를 헤더로 옮기고 숨김·잠금 상태일 때 안내 문구를 표시합니다. 홈 ‘활동’ 옵션도 가로 전체 너비의 드롭다운 행으로 정리했습니다. (#1595)
- **Devin 할당량 카드.** 로그인된 멤버십이 설정된 조직과 일치하면 로그인 이메일을 표시하고, 확인할 수 없으면 조직 이름을 표시합니다. (#1602)
- **메모리 및 갱신.** 창에 포커스가 없을 때 백그라운드 메모리 사용량을 줄이고, 표시된 창에는 변경된 부분만 가볍게 전달합니다. (#1498, #1592)

### 수정
- **Windows 중국어 글꼴.** ‘앱 기본값’ 글꼴 프리셋에서 앱 창 전반의 간체·번체 중국어에 NSimSun 대신 지역 산세리프 글꼴을 사용합니다. (#1598)
- **Qoder 할당량.** 여러 기기가 같은 Hub에 동기화될 때 서로 다른 계정이 한 행으로 합쳐지지 않고 따로 표시됩니다. (#1574)
- **Z.ai 팀 할당량.** 여러 기기에서 동기화된 서로 다른 팀 프로젝트를 구분해 표시하며, API 키를 교체해도 같은 프로젝트의 데이터는 하나로 유지합니다. (#1575)
- **실시간 사용량 수집.** 파일 변경 알림에 오늘 사용량이 없는 유휴 도구가 포함되더라도 추적 중인 모든 도구를 다시 스캔하지 않습니다. (#1591)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.95.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-Setup-0.95.1.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.95.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 改善
- **収集設定。** 未追跡のツールにこの端末の使用履歴がある場合は「データあり」、ローカルデータが見つかった場合は「検出済み」を表示します。 （#1604）
- **AIツール制限の設定。** 無効になっているプロバイダーに、最新の残量データがある端末のアイコンと一覧ツールチップを表示します。 （#1604）
- **メイン画面の設定。** ビューの表示スイッチをヘッダーへ移し、非表示や変更不可のときに理由を表示します。ホームの「アクティビティ」設定も幅いっぱいのドロップダウン行に統一しました。 （#1595）
- **Devin の残量カード。** ログイン中のメンバーシップが設定済みの組織と一致する場合はメールアドレスを表示し、取得できない場合は組織名を表示します。 （#1602）
- **メモリと更新。** ウィンドウが非アクティブな間のバックグラウンドメモリ使用量を抑え、表示中のウィンドウには差分のみを軽く反映します。 （#1498, #1592）

### 修正
- **Windows の中国語フォント。** 「アプリのデフォルト」フォント設定で、各ウィンドウの中国語表示に NSimSun ではなく地域別のサンセリフ体を使います。 （#1598）
- **Qoder の残量。** 複数の端末を同じ Hub に同期したとき、別々のアカウントが 1 行にまとまらず個別に表示されるようにしました。 （#1574）
- **Z.ai チームの残量。** 同期された端末間で別々のチームプロジェクトを分けて表示しつつ、API キーを更新しても同じプロジェクトのデータは統合されます。 （#1575）
- **リアルタイムの使用量収集。** 監視更新に当日の使用量がない待機中のツールが含まれていても、追跡中のすべてのツールを再スキャンしないようにしました。 （#1591）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.95.1-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.95.1-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-Setup-0.95.1.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.95.1.exe](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.95.1.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.95.1/Token-Monitor-0.95.1.AppImage)

</details>

</details>
