# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Codex Dots usage:** Adds experimental tracking of local tasks while connected, disabled by default, with separate collection and visibility controls. (#944)
- **Edge Dock refresh:** Adds an optional refresh button to update usage and limits without opening the app. (#954)
- **Edge Dock size:** Choose Small, Medium or Large, or a custom size from 75% to 150%. (#961)

### Improved
- **Model aliases:** Select model IDs or enter them manually, and assign several aliases to one model in a single edit. (#943)
- **Edge Dock handle:** Easier to reveal as the pointer approaches, with a larger handle and a nearby hover zone. (#958)
- **Edge Dock running indicator:** Replaces the glow with a spinner that can be hidden in settings. (#962, #964)
- **Edge Dock quota rings:** Makes quota progress easier to read. (#962)

### Fixed
- **MiMo Desktop on Windows:** Fixes detection of the locally signed-in account for quotas. (#950)
- **Edge Dock cards on Windows:** Fixes cards failing to switch at some display scaling settings. (#927)
- **Edge Dock clicks:** Fixes quick clicks on the collapsed handle passing through to the app beneath. (#960)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.68.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.68.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-Setup-0.68.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.68.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.AppImage)

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

Tokscale is bundled with this app and updated through Token Monitor releases. See **Settings → Advanced → Tokscale** for the version and fork build identifier. Tokscale is MIT, open-source: https://github.com/junhoyeo/tokscale

</details>

---

# 中文

## 更新内容

<!-- app-update-notes:zh:start -->
### 新增
- **Codex Dots 用量：** 新增实验性本机任务用量追踪，仅记录连接期间的用量，默认关闭，可分别控制采集与显示。 （#944）
- **侧边栏刷新：** 新增可选刷新按钮，无需打开 App 即可更新用量与额度。 （#954）
- **侧边栏大小：** 支持小、中、大三档，以及 75%–150% 的自定义大小。 （#961）

### 改进
- **模型别名：** 支持选择模型 ID 或手动输入，并在一次编辑中将多个别名合并至同一模型。 （#943）
- **侧边栏把手：** 鼠标靠近时把手会变大，在附近悬停即可展开，更容易唤出。 （#958）
- **侧边栏运行指示：** 将光晕改为旋转指示，可在设置中关闭。 （#962、#964）
- **侧边栏额度圆环：** 更清晰地显示额度进度。 （#962）

### 修复
- **Windows MiMo Desktop：** 修复无法识别本机已登录账号并显示额度的问题。 （#950）
- **Windows 侧边栏卡片：** 修复部分显示缩放设置下卡片无法切换的问题。 （#927）
- **侧边栏点击：** 修复快速点击收起的把手时，点击可能落到下方应用的问题。 （#960）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.68.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.68.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-Setup-0.68.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.68.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.AppImage)

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

Tokscale 已随应用内置，并通过 Token Monitor 发布版本更新。你可以在 **设置 → 高级 → Tokscale** 查看版本和 fork 构建标识。Tokscale 是 MIT 开源项目：https://github.com/junhoyeo/tokscale

</details>

---

<details>
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.67.0...v0.68.0">v0.67.0...v0.68.0</a></summary>

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
- **Codex Dots 用量：** 新增實驗性本機任務用量追蹤，僅記錄連線期間的用量，預設關閉，可分別控制採集與顯示。 （#944）
- **側邊欄重新整理：** 新增可選的重新整理按鈕，不必開啟 App 即可更新用量與額度。 （#954）
- **側邊欄大小：** 支援小、中、大三種大小，以及 75%–150% 的自訂大小。 （#961）

### 改進
- **模型別名：** 支援選擇模型 ID 或手動輸入，並在一次編輯中將多個別名合併至同一模型。 （#943）
- **側邊欄把手：** 游標靠近時把手會放大，在附近停留即可展開，更容易喚出。 （#958）
- **側邊欄執行指示：** 將光暈改為旋轉指示，可在設定中關閉。 （#962、#964）
- **側邊欄額度圓環：** 更清晰地顯示額度進度。 （#962）

### 修復
- **Windows MiMo Desktop：** 修復無法辨識本機已登入帳號並顯示額度的問題。 （#950）
- **Windows 側邊欄卡片：** 修復部分顯示縮放設定下卡片無法切換的問題。 （#927）
- **側邊欄點擊：** 修復快速點擊收起的把手時，點擊可能落到下方 App 的問題。 （#960）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.68.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.68.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-Setup-0.68.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.68.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **Codex Dots 사용량:** 연결 중인 로컬 작업의 사용량을 기록하는 실험 기능을 추가했습니다. 기본값은 꺼짐이며 수집과 표시를 따로 설정할 수 있습니다. (#944)
- **가장자리 도크 새로 고침:** 앱을 열지 않고 사용량과 한도를 갱신하는 선택형 버튼을 추가했습니다. (#954)
- **가장자리 도크 크기:** 작게, 보통, 크게 중에서 선택하거나 75%–150%로 직접 조절할 수 있습니다. (#961)

### 개선
- **모델 별칭:** 모델 ID를 선택하거나 직접 입력하고, 한 번에 여러 별칭을 같은 모델로 합칠 수 있습니다. (#943)
- **가장자리 도크 손잡이:** 포인터가 다가오면 커지고 근처에 머물면 펼쳐져 더 쉽게 열 수 있습니다. (#958)
- **가장자리 도크 실행 표시:** 빛 효과를 회전 표시로 바꾸고 설정에서 숨길 수 있도록 했습니다. (#962, #964)
- **가장자리 도크 한도 링:** 한도 진행 상태가 더 잘 보이도록 개선했습니다. (#962)

### 수정
- **Windows MiMo Desktop:** 로컬 로그인 계정을 감지하지 못해 한도가 표시되지 않는 문제를 수정했습니다. (#950)
- **Windows 가장자리 도크 카드:** 일부 디스플레이 배율에서 카드가 전환되지 않는 문제를 수정했습니다. (#927)
- **가장자리 도크 클릭:** 접힌 손잡이를 빠르게 클릭하면 뒤쪽 앱이 클릭되는 문제를 수정했습니다. (#960)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.68.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.68.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-Setup-0.68.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.68.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **Codex Dots 使用量：** 接続中のローカルタスクを記録する実験的機能を追加しました。初期設定はオフで、収集と表示を個別に切り替えられます。 （#944）
- **エッジドックの更新：** アプリを開かずに使用量と上限を更新できる、任意の更新ボタンを追加しました。 （#954）
- **エッジドックのサイズ：** 小・中・大から選ぶか、75%–150%の範囲で調整できます。 （#961）

### 改善
- **モデルの別名：** モデル ID の選択と手入力に対応し、複数の別名を一度の編集で同じモデルに統合できます。 （#943）
- **エッジドックのハンドル：** ポインターが近づくと大きくなり、付近で止めると展開するため、開きやすくなりました。 （#958）
- **エッジドックの実行中表示：** 光彩を回転インジケーターに変更し、設定で非表示にできるようにしました。 （#962、#964）
- **エッジドックの上限リング：** 上限の進捗を見やすくしました。 （#962）

### 修正
- **Windows の MiMo Desktop：** ローカルでログインしているアカウントを検出できず、上限が表示されない問題を修正しました。 （#950）
- **Windows のエッジドックカード：** 一部の画面倍率でカードが切り替わらない問題を修正しました。 （#927）
- **エッジドックのクリック：** 折りたたまれたハンドルを素早くクリックすると、背後のアプリがクリックされる問題を修正しました。 （#960）
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.68.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.68.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-Setup-0.68.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.68.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.68.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.68.0/Token-Monitor-0.68.0.AppImage)

</details>

</details>
