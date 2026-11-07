# OpenAI API Credits

在 Token Monitor 原生額度頁顯示實際的 OpenAI Platform API 點數餘額。

![額度頁中的 OpenAI API 點數餘額](assets/limits.png)

介面示例；餘額及到期時間以你的實際帳戶為準。

## 功能

- 可與其他供應商一起排序的 **OpenAI** 額度項目，沿用 Codex 圖示、配色及你的自訂顏色。
- 可選進度條及餘額，或純餘額。
- 多筆可用點數到期時間不同時，顯示各筆餘額及 UTC 到期時間。
- 手動輸入登入憑證，由 App 驗證及管理。
- 介面、README 及更新記錄支援英文、繁中、簡中、日文、韓文及巴西葡文。

此插件顯示 API 點數，不是 ChatGPT 訊息限額，也不是根據 Costs 推算的餘額。

## 相容性及安裝

使用支援原生額度插件、憑證驗證及原生外觀的 Token Monitor（`tmApi: 1`）。若 App 無法顯示此額度模組，請先更新 App。

在「**設定 → 插件**」匯入 `.tmplugin` 檔案或完整來源資料夾，檢查後啟用。然後在「**AI 工具額度**」勾選並展開 **OpenAI**。安裝不會自動設定帳戶。

## 設定

1. 將 OpenAI 設定內的帳單網址複製到慣用瀏覽器，登入並選擇組織。
2. 開啟 DevTools（**F12** 或 **Cmd+Opt+I**）→ **Network**，重新載入並選取 `credit_grants`。
3. 在 **Headers → Request Headers**，將 `Authorization` 複製到 **Platform session token**，將 `OpenAI-Organization` 複製到 **Organization ID**。Token 可包含 `Bearer` 前綴；不要使用一般 API key、Cookie header 或 ChatGPT/Codex token。
4. 儲存憑證。App 會驗證，成功後收起編輯器；返回「**額度**」查看餘額。

使用「修改憑證」取代已儲存的值；輸入框不會回填秘密。登入過期時重新取得憑證。不要在對話或截圖分享憑證。此插件不會開啟內嵌登入瀏覽器。

## 顯示及刷新

餘額直接取自服務。進度條以目前可用而且仍有餘額的點數批次總額作分母。例如可用 $100 加上已停用的 $0/$24，會顯示 **$100 / $100**。這是目前可用的點數池，不是每月或歷史消費；批次到期或耗盡時，分母亦會改變。

批次資料無法可靠解釋餘額時，只顯示實際餘額；零仍顯示零。進度條下方顯示可用點數最早的已知到期時間。只有多筆可用點數到期時間不同時，Tooltip 才列出各筆餘額，不重複歷史總額，也不會把過期點數稱為消費。

刷新沿用 App 的額度間隔、自適應設定及介面可見狀態。儲存憑證會另作一次驗證；插件沒有自行輪詢的計時器。你亦可在設定選擇「純餘額」。

## 資料及存取

App 在使用者資料目錄下的 `plugin-credentials/openai-api-credit/credits.json` 以私人權限、未加密檔案儲存憑證，與插件程式及一般偏好設定分開。後端經 App 支援代理的傳輸層，將憑證送至 `https://api.openai.com/v1/dashboard/billing/credit_grants`。這是未公開記載的端點，端點及登入憑證可能改變或失效。

介面只接收整理後的額度資料。插件不讀取其他 App 的登入檔案、不開登入視窗，也不傳送分析資料。插件屬受信任的本機程式，並非與作業系統使用者檔案隔離。目前此模組整合原生額度及設定頁。

## 更新

在「**設定 → 插件**」匯入較新版本並檢查更新；不會自動安裝。詳見[更新記錄](CHANGELOG.zh-TW.md)。

如要從儲存庫根目錄打包，請選擇尚不存在的輸出路徑：

```sh
node scripts/build-plugin-package.js plugins/openai-api-credit /tmp/openai-api-credit-0.1.0.tmplugin
```

## 授權

[MIT](LICENSE)。
