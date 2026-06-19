# 🚬 Smoking Tracker

iPhone 主畫面捷徑用的個人抽菸紀錄 App。前端為單一 HTML 靜態頁面，後端為 Cloudflare Worker + D1 資料庫。

**Live：** https://eathonlee.github.io/smoking-tracker/

---

## 功能

- 記錄每次抽菸時間，按下即記錄
- 可自訂抽菸間距（小時），設為 0 表示不限制
- 倒數計時 + 進度條顯示距下一根的剩餘時間
- 圖表：今日每小時抽菸次數
- 圖表：本月每日抽菸次數
- 匯出今年每月統計為 `.txt` 檔案（1–12 月全顯示，無紀錄顯示 0）
- 多裝置共用（家人、朋友），資料以 device UUID 隔離

---

## 架構

```
index.html          → GitHub Pages（靜態前端）
worker/src/index.ts → Cloudflare Worker（API）
                       └── D1（SQLite 資料庫）
```

### D1 Schema

```sql
smoke_logs      (id, device_id, smoked_at)         -- 每筆抽菸紀錄
device_settings (device_id, cooldown_hours, nickname)
```

### Worker API

| Method | Path | 說明 |
|--------|------|------|
| `POST` | `/smoke` | 新增一筆紀錄 |
| `DELETE` | `/smoke` | 刪除一筆紀錄 |
| `DELETE` | `/smoke/all` | 清除所有紀錄 |
| `GET` | `/smoke/today?date=YYYY-MM-DD` | 當日紀錄 |
| `GET` | `/smoke/stats/hourly?date=YYYY-MM-DD` | 當日每小時統計 |
| `GET` | `/smoke/stats/daily?month=YYYY-MM` | 當月每日統計 |
| `GET` | `/settings` | 讀取裝置設定 |
| `PUT` | `/settings` | 更新冷卻時間 |
| `POST` | `/export` | 回傳今年每月統計（供前端下載） |

所有 request 需帶 `x-device-id: <uuid>` header。

---

## 部署

### 前置條件

- [Cloudflare 帳號](https://dash.cloudflare.com/) + Wrangler CLI

### 1. 建立 D1 資料庫

```bash
cd worker
npm install
npx wrangler d1 create smoking-tracker
```

將輸出的 `database_id` 填入 `worker/wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "smoking-tracker"
database_id = "<貼上 database_id>"
```

### 2. 執行 Migration

```bash
# 本地測試用
npx wrangler d1 execute smoking-tracker --local --file=migrations/0001_init.sql

# 正式環境
npx wrangler d1 execute smoking-tracker --file=migrations/0001_init.sql
```

### 3. 部署 Worker

```bash
npm run deploy
# 輸出 Worker URL，例如：https://smoking-tracker.your-subdomain.workers.dev
```

### 4. 設定前端 Worker URL

編輯 `index.html`，找到以下這行並替換：

```js
const WORKER_URL = 'https://smoking-tracker.eathon601.workers.dev';
```

### 5. 推送前端

```bash
git add index.html
git commit -m "feat: set worker URL"
git push
```

GitHub Pages 會自動部署，約 1 分鐘後生效。

---

## 本地開發

```bash
cd worker
npm install
npx wrangler dev
```

Worker 預設跑在 `http://localhost:8787`。前端直接在瀏覽器開 `index.html` 即可，`WORKER_URL` 會自動偵測 localhost。

---

## 免費額度說明

| 服務 | 免費額度 | 預估用量（每日 20 根 × 10 人）|
|------|----------|-------------------------------|
| Cloudflare Workers | 100,000 req/day | < 500 req/day |
| Cloudflare D1 reads | 5,000,000/day | < 1,000/day |
| Cloudflare D1 writes | 100,000/day | < 200/day |
| D1 storage | 5 GB | < 10 MB/year |

永遠不會超出免費額度。

---

## 資料隱私

- 每台裝置在首次開啟時自動產生 UUID，存於 `localStorage`
- D1 只儲存時間戳記，**不儲存任何個人資料**
