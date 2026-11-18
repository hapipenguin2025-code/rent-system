# 夾公仔舖收租系統

WhatsApp 做入口，Google Sheet 做資料庫，Cloudflare 做網站同中轉。

```
同事 / 租客 WhatsApp
        │
        ▼
Meta WhatsApp Cloud API ──► https://你的域名/webhook   （Cloudflare Worker：驗證簽名）
                                     │
                                     ▼
                        Google Apps Script（apps-script/Code.gs）
                                     │  讀寫
                                     ▼
                        Google Sheet：收租紀錄、對幣紀錄、每日結算、現金流…
                                     │
                                     └──► 回覆 WhatsApp、每日欠租提示、每週報表

https://你的域名/          → site/index.html（WhatsApp 示範 + CRM 後台）
https://你的域名/api/health → 檢查 Worker 密碼設定齊唔齊
```

## 資料夾

| 位置 | 係乜 |
|---|---|
| `site/index.html` | 網站。而家係示範版：資料係虛構（收租數由 Excel 搬入），refresh 就還原，唔會改到真 Sheet。 |
| `worker/src/index.js` | Cloudflare Worker：出網站、收 WhatsApp webhook、轉發去 Apps Script。 |
| `worker/test/` | Worker 測試（`npm test`）。 |
| `apps-script/Code.gs` | 後台程式，貼入 Google Sheet 嘅 Apps Script。 |
| `wrangler.toml` | Cloudflare 設定，包括自訂網域。 |
| `.github/workflows/deploy.yml` | （可選）push 去 main 自動上載 Cloudflare。 |
| `docs/安裝步驟.md` | Google Sheet、Apps Script、WhatsApp 嘅詳細設定同指令表。 |

**repo 入面冇任何密碼。** 所有密碼放 Cloudflare Secrets 同 Apps Script「指令碼屬性」。

## 安裝（大約 30 分鐘）

### 1. 放上 GitHub
GitHub → New repository（建議揀 **Private**）→ 將成個資料夾上載（或者 `git push`）。

### 2. Cloudflare 接 GitHub（唔使俾 token 任何人）
Cloudflare → **Workers & Pages** → **Create** → **Import a repository** → 揀呢個 repo。
- Build command：留空
- Deploy command：`npx wrangler deploy`

之後每次 push 去 main 都會自動更新。第一次完成後會有 `https://rent-system.<帳戶>.workers.dev`，打開見到 WhatsApp 示範就成功。

> 另一個方法：用 `.github/workflows/deploy.yml`，喺 GitHub repo Secrets 加 `CLOUDFLARE_API_TOKEN`（限權 token）同 `CLOUDFLARE_ACCOUNT_ID`。兩個方法揀一個就夠。

### 3. 駁自己個網域
1. 網域要先加入 Cloudflare（Add a domain → 跟住改 nameserver）。
2. 揀一個：
   - **Dashboard**：Worker `rent-system` → Settings → **Domains & Routes** → Add → **Custom domain** → 填 `rent.你的域名.com`。
   - **改設定檔**：打開 `wrangler.toml`，將 `routes` 嗰幾行嘅 `#` 刪走，改做你嘅網域，push。
3. 幾分鐘後 `https://rent.你的域名.com` 就用得，SSL 自動。

### 4. 後台：Google Sheet + Apps Script
跟 `docs/安裝步驟.md`：
1. 開新 Google Sheet → 擴充功能 → Apps Script → 貼 `apps-script/Code.gs`（可以順手貼 `appsscript.json`，時區香港）。
2. 專案設定 → **指令碼屬性** 加：`RELAY_SECRET`（自己作）、`WA_TOKEN`、`WA_PHONE_ID`、`OWNER_PHONE`、`RECEIPT_FOLDER_ID`、（可選）`CLAUDE_KEY`。
3. 部署 → 新增部署 → **網頁應用程式**，執行身分「我」，存取「任何人」→ 抄低網址（`…/exec`）。
4. 打開網址見到「收租機械人運作中」就得。

### 5. Worker 密碼
Cloudflare → Worker `rent-system` → Settings → **Variables and Secrets**，加 4 個（類型揀 Secret）：

| 名 | 填乜 |
|---|---|
| `VERIFY_TOKEN` | 自己作一串字，第 6 步 Meta 會用 |
| `APP_SECRET` | Meta App → App settings → Basic → App Secret |
| `GAS_URL` | 第 4 步嘅 Apps Script 網址 |
| `RELAY_SECRET` | 同 Apps Script 嘅 `RELAY_SECRET` 一樣 |

打開 `https://rent.你的域名.com/api/health`，見到 `"ok":true` 就齊。

### 6. WhatsApp（Meta）
Meta for Developers → 你個 App → WhatsApp → Configuration → Webhook：
- Callback URL：`https://rent.你的域名.com/webhook`
- Verify token：同 `VERIFY_TOKEN` 一樣
- Subscribe：`messages`

用同事電話 WhatsApp 個商業號碼打「欠款」，有回覆就成功。

## 本機測試（開發用）
```bash
npm install
npm test            # Worker 測試
cp .dev.vars.example .dev.vars   # 填假密碼
npm run dev         # http://localhost:8787
```

## 未做 / 之後
- 網站而家係示範資料；真 CRM 直接讀 Google Sheet 要另外加（要加登入保護）。
- 網站想加密碼：Cloudflare **Zero Trust → Access** 加一條規則，只准同事電郵登入。
- 電子支付平台自動攞數：等登入資料。
