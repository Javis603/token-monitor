# English

## What's changed

<!-- app-update-notes:en:start -->
### Added
- **Quota alerts:** Supports desktop notifications when session quota runs low, recovers or becomes full, available through an optional plugin. (#1278)
- **Official plugin updates:** Supports installing and approving compatible updates from the official catalog independently of app releases. (#1280)

### Changed
- **macOS requirements:** Requires macOS 13 or later. macOS 12 is no longer supported. (#1267)
- **Codex cache countdown:** Removes the estimated cache-expiry countdown because Codex does not report a reliable expiry time. Cache usage remains available. (#1275)
- **Experimental plugin compatibility:** Some existing location/background choices may need to be selected again. Plugins offering multiple replacement views for the same target must be updated before they can load. (#1269)

### Improved
- **Plugin first-use settings:** Review display locations, replacement content, background execution and appearance together before enabling a plugin. Confirmed choices are retained across updates and enable/disable cycles. (#1269)

### Fixed
- **Archived usage totals:** Prevents matching archived sessions from being counted again alongside newly collected usage, including lower and zero corrections. (#1266)
- **Archived token breakdowns:** Restores saved input counts and retains observed per-model input, cache and output breakdowns for multi-model sessions. Older records without this evidence remain unclassified. (#1268)
- **Home plugin controls:** Preserves drafts and focus when usage refreshes retain the same Home modules. (#1270)
- **Window reopening:** Prevents unintended header-button focus and accidental Enter activation when reopening with the global shortcut or a physical tray click on macOS. Deliberate keyboard selection is preserved. (#1262)
<!-- app-update-notes:en:end -->
## Download

- **macOS Apple Silicon** — [Token-Monitor-0.82.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.82.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-x64.dmg)
- **Windows Installer** — [Token-Monitor-Setup-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-Setup-0.82.0.exe) (recommended)
- **Windows Portable** — [Token-Monitor-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.exe) (no install required)
- **Linux x64** — [Token-Monitor-0.82.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.AppImage)

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
- **配额提醒：** 支持在会话配额不足、恢复或回满时发送桌面通知，可通过插件启用。 （#1278）
- **官方插件更新：** 支持从官方目录安装插件、确认兼容更新，无需等待应用发版。 （#1280）

### 变更
- **macOS 系统要求：** 最低要求升至 macOS 13，不再支持 macOS 12。 （#1267）
- **Codex 缓存倒计时：** 由于缺少可靠的到期时间，不再显示缓存到期估算；缓存用量仍可查看。 （#1275）
- **实验性插件兼容性：** 部分已有显示位置和后台运行选项可能需要重新选择。同一目标提供多个替换视图的插件需先更新才能加载。 （#1269）

### 改进
- **插件首次设置：** 启用前可一并确认显示位置、替换内容、后台运行和外观；确认后的选择会在更新及停用后重新启用时保留。 （#1269）

### 修复
- **历史用量总计：** 避免已保存的同一会话与新采集用量重复计数，并保留调低及归零的修正结果。 （#1266）
- **历史 Tokens 明细：** 恢复已保存的输入计数，并保留多模型会话中已采集的各模型输入、缓存及输出明细。缺少这些记录的旧数据仍显示为未分类。 （#1268）
- **主页插件控件：** 用量刷新保留原有主页模块时，输入草稿和焦点不再丢失。 （#1270）
- **窗口重新打开：** 修复通过全局快捷键或 macOS 托盘鼠标点击打开窗口后，顶部按钮意外获得焦点、被回车误触的问题；保留主动键盘选择。 （#1262）
<!-- app-update-notes:zh:end -->

## 下载

- **macOS Apple Silicon** — [Token-Monitor-0.82.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.82.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-x64.dmg)
- **Windows 安装版** — [Token-Monitor-Setup-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-Setup-0.82.0.exe)（推荐）
- **Windows 便携版** — [Token-Monitor-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.exe)（免安装）
- **Linux x64** — [Token-Monitor-0.82.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.AppImage)

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
<summary><strong>Full Changelog:</strong> <a href="https://github.com/Javis603/token-monitor/compare/v0.81.0...v0.82.0">v0.81.0...v0.82.0</a></summary>

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
- **配額提醒：** 支援在會話配額不足、恢復或回滿時傳送桌面通知，可透過外掛啟用。 （#1278）
- **官方外掛更新：** 支援從官方目錄安裝外掛、確認相容更新，不必等待應用程式發版。 （#1280）

### 變更
- **macOS 系統需求：** 最低需求升至 macOS 13，不再支援 macOS 12。 （#1267）
- **Codex 快取倒數：** 由於缺少可靠的到期時間，不再顯示快取到期估算；快取用量仍可查看。 （#1275）
- **實驗性外掛相容性：** 部分既有顯示位置與背景執行選項可能需要重新選擇。同一目標提供多個替換檢視的外掛需先更新才能載入。 （#1269）

### 改進
- **外掛首次設定：** 啟用前可一併確認顯示位置、替換內容、背景執行與外觀；確認後的選擇會在更新及停用後重新啟用時保留。 （#1269）

### 修復
- **歷史用量總計：** 避免已儲存的同一會話與新收集用量重複計算，並保留調低及歸零的修正結果。 （#1266）
- **歷史 Token 明細：** 還原已儲存的輸入計數，並保留多模型會話中已收集的各模型輸入、快取與輸出明細。缺少這些紀錄的舊資料仍顯示為未分類。 （#1268）
- **主頁外掛控制項：** 用量刷新保留原有主頁模組時，輸入草稿與焦點不再遺失。 （#1270）
- **視窗重新開啟：** 修復透過全域快捷鍵或 macOS 系統匣滑鼠點擊開啟視窗後，頂部按鈕意外取得焦點、被 Enter 誤觸的問題；保留主動鍵盤選擇。 （#1262）
<!-- app-update-notes:zh-TW:end -->

## 下載

- **macOS Apple Silicon** — [Token-Monitor-0.82.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.82.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-x64.dmg)
- **Windows 安裝版** — [Token-Monitor-Setup-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-Setup-0.82.0.exe)（推薦）
- **Windows 便攜版** — [Token-Monitor-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.exe)（免安裝）
- **Linux x64** — [Token-Monitor-0.82.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.AppImage)

</details>

<details>
<summary><strong>한국어</strong></summary>

## 한국어

## 업데이트 내용

<!-- app-update-notes:ko:start -->
### 추가
- **할당량 알림:** 플러그인을 통해 세션 할당량 부족, 회복 또는 100% 복구 시 데스크톱 알림을 받을 수 있습니다. (#1278)
- **공식 플러그인 업데이트:** 앱 출시를 기다리지 않고 공식 카탈로그에서 플러그인을 설치하고 호환되는 업데이트를 승인할 수 있습니다. (#1280)

### 변경
- **macOS 시스템 요구 사항:** macOS 13 이상이 필요합니다. macOS 12는 더 이상 지원하지 않습니다. (#1267)
- **Codex 캐시 만료 표시:** 신뢰할 수 있는 만료 시간이 제공되지 않아 예상 만료 카운트다운을 제거했습니다. 캐시 사용량은 계속 확인할 수 있습니다. (#1275)
- **실험적 플러그인 호환성:** 기존 표시 위치와 백그라운드 실행 선택 중 일부를 다시 설정해야 할 수 있습니다. 같은 대상에 여러 대체 보기를 제공하는 플러그인은 업데이트해야 불러올 수 있습니다. (#1269)

### 개선
- **플러그인 최초 사용 설정:** 활성화 전에 표시 위치, 대체 콘텐츠, 백그라운드 실행과 모양을 함께 확인할 수 있습니다. 확정한 선택은 업데이트하거나 비활성화 후 다시 활성화해도 유지됩니다. (#1269)

### 수정
- **과거 사용량 합계:** 저장된 동일 세션이 새로 수집된 사용량과 중복 집계되는 문제를 수정했습니다. 더 낮은 값이나 0으로 정정된 값도 반영합니다. (#1266)
- **과거 토큰 세부 내역:** 저장된 입력 수치를 복원하고, 여러 모델을 사용한 세션에서 관측된 모델별 입력·캐시·출력 내역을 보존합니다. 근거가 없는 이전 기록은 미분류로 남습니다. (#1268)
- **홈 플러그인 컨트롤:** 사용량 새로고침 시 기존 홈 모듈이 유지되면 입력 초안과 포커스도 유지됩니다. (#1270)
- **창 다시 열기:** 전역 단축키나 macOS 트레이의 마우스 클릭으로 창을 열 때 상단 버튼에 뜻하지 않게 포커스가 가고 Enter로 실행되는 문제를 수정했습니다. 키보드로 직접 선택한 항목은 유지됩니다. (#1262)
<!-- app-update-notes:ko:end -->

## 다운로드

- **macOS Apple Silicon** — [Token-Monitor-0.82.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.82.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-x64.dmg)
- **Windows 설치 버전** — [Token-Monitor-Setup-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-Setup-0.82.0.exe) (권장)
- **Windows 포터블 버전** — [Token-Monitor-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.exe) (설치 필요 없음)
- **Linux x64** — [Token-Monitor-0.82.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.AppImage)

</details>

<details>
<summary><strong>日本語</strong></summary>

## 日本語

## 更新内容

<!-- app-update-notes:ja:start -->
### 追加
- **クォータ通知:** プラグインを有効にすると、セッションクォータの不足・回復・全回復をデスクトップ通知で受け取れます。 (#1278)
- **公式プラグインの更新:** アプリのリリースを待たずに、公式カタログからプラグインをインストールし、互換性のある更新を承認できます。 (#1280)

### 変更
- **macOSのシステム要件:** macOS 13以降が必要になりました。macOS 12はサポート対象外です。 (#1267)
- **Codexのキャッシュ残り時間:** 信頼できる有効期限が提供されないため、推定のカウントダウンを削除しました。キャッシュ使用量は引き続き確認できます。 (#1275)
- **実験的プラグインの互換性:** 既存の表示位置やバックグラウンド実行の設定を、一部選び直す必要があります。同じ対象に複数の置き換えビューを提供するプラグインは、読み込む前に更新が必要です。 (#1269)

### 改善
- **プラグインの初回設定:** 有効化する前に、表示位置、置き換えるコンテンツ、バックグラウンド実行、外観をまとめて確認できます。確定した選択は、更新や無効化後の再有効化でも維持されます。 (#1269)

### 修正
- **過去の使用量の合計:** 保存済みの同じセッションが、新たに収集した使用量と二重計上される問題を修正しました。減少やゼロへの訂正も反映します。 (#1266)
- **過去のトークン内訳:** 保存済みの入力数を復元し、複数モデルのセッションで観測したモデル別の入力・キャッシュ・出力内訳を保持します。根拠のない古い記録は未分類のままです。 (#1268)
- **ホームのプラグイン操作:** 使用量の更新で既存のホームモジュールが維持される場合、入力中の内容とフォーカスも保持します。 (#1270)
- **ウィンドウの再表示:** グローバルショートカットやmacOSトレイのマウスクリックで開いた際、意図せず上部ボタンにフォーカスが移り、Enterで実行される問題を修正しました。キーボードで明示的に選んだ項目は維持されます。 (#1262)
<!-- app-update-notes:ja:end -->

## ダウンロード

- **macOS Apple Silicon** — [Token-Monitor-0.82.0-arm64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-arm64.dmg)
- **macOS Intel** — [Token-Monitor-0.82.0-x64.dmg](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0-x64.dmg)
- **Windows インストーラー** — [Token-Monitor-Setup-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-Setup-0.82.0.exe)（推奨）
- **Windows ポータブル版** — [Token-Monitor-0.82.0.exe](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.exe)（インストール不要）
- **Linux x64** — [Token-Monitor-0.82.0.AppImage](https://github.com/Javis603/token-monitor/releases/download/v0.82.0/Token-Monitor-0.82.0.AppImage)

</details>

</details>
