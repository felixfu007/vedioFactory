# 進度紀錄

此檔記錄目前推進中的工作狀態，供中斷或 context 壓縮後接續。完整計畫見 `OPTIMIZATION_PLAN.md`。

## 決策紀錄

- 2026-10-21：參數預設存於固定應用資料夾 `VEDIO_FACTORY_DATA_DIR/presets/`（預設 `%USERPROFILE%\vedioFactory\presets`），不隨輸出資料夾切換。
- 2026-10-21：客戶／專案採兩層標籤（client、project 字串），檔案仍放同一輸出資料夾。
- 2026-10-21：每個計畫項目各自開分支並推送開 PR；後續項目疊在前一項分支上（stacked PR）。

## 已完成

### 第 5 項：可重現生成 — PR #5（分支 `feature/reproducible-generation`）

- seed／負面提示詞、工作流 SHA-256 與 prompt JSON 快照、來源圖片內容雜湊快照、`POST /api/inference/jobs/:id/rerun`。

### 第 6 項：參數預設與客戶／專案管理（分支 `feature/presets-and-projects`，基於第 5 項分支）

- 後端：`/api/presets` GET/POST、`/api/presets/:id` PUT/DELETE、`/api/presets/export`、`/api/presets/import`（全部驗證通過才寫入）。
- 後端：抽出 `validateGenerationSettings`、`validateSeed`、`readOptionalText` 等共用驗證；推論工作、rerun、匯入影片帶 `client`、`project`、`presetId`。
- 前端：客戶／專案輸入（含 datalist 建議）、預設選擇與 `{變數}` 欄位、套用／儲存／更新／刪除／匯出／匯入；影片庫依客戶／專案篩選，卡片顯示客戶／專案。
- Docker：新增 `VEDIO_FACTORY_DATA_DIR=/data/app` 與 `vediofactory-app` volume。
- 測試：API 測試涵蓋 CRUD、驗證、路徑穿越、匯出匯入往返、部分無效匯入不寫入；視覺測試新增預設套用→生成→篩選情境。`npm run test:all` 通過。

### 第 7 項：多工作流與動態參數規格（分支 `feature/multi-workflow`，基於第 6 項分支）

- 決策（2026-10-22）：同名檔配對 `xxx.json` + 選用 `xxx.vf.json`；工作流資料夾預設為專案內 `workflows/`（`VEDIO_FACTORY_WORKFLOWS_DIR` 可改）。
- `assets/capabilities.js`：前後端共用規格（8 種解析度、FPS 12/16/24/25/30、2–30 秒、自訂解析度 8 的倍數 256–3840 且 ≤4K 像素）與 `narrowCapabilities`。
- 後端：`GET /api/workflows`、`GET /api/capabilities?workflowId=`；工作、預檢、預設接受 `workflowId` 並依該工作流規格驗證；環境變數工作流註冊為 `default`；設定檔錯誤的工作流標示 error 且不可送出。
- 前端：工作流選單與說明、參數選項依工作流動態產生、自訂解析度欄位、預設記住工作流並在不相容時提示。
- Docker：`VEDIO_FACTORY_DATA_DIR=/data/app`、`VEDIO_FACTORY_WORKFLOWS_DIR=/workflows`。
- 測試：API 與視覺測試（工作流切換、自訂解析度 1000x600 產出）通過。未實際執行 docker build。

PR #7（以 main 為基底；#5、#6 已由使用者合併）。

### 第 8 項：交付格式、批次與工作佇列（分支 `feature/delivery-batch-queue`，基於 `feature/multi-workflow`／PR #7）

決策（2026-10-22）：交付包＝匯出成資料夾；MP4＝匯入 ComfyUI 的 MP4/GIF/WebP，加上偵測到 ffmpeg 時可選轉檔。

- [x] 8a 多格式：`.webm/.mp4/.gif/.webp`、影片串流支援 Range、改名保留副檔名、GIF/WebP 以圖片預覽。
- [x] 8b ffmpeg：`/api/config` 回報 ffmpeg；`POST /api/videos/:name/transcode`（H.264/AAC、一次一個、失敗清理）。
- [x] 8c 批次：`POST /api/inference/batches`（prompts × seeds，≤50，單筆失敗隔離，`batchId`/`batchIndex`）。
- [x] 8d 佇列面板：`GET /api/inference/jobs?refresh=1&limit=`（摘要、不含 prompt JSON 快照）；前端狀態篩選、取消、重跑、自動更新。
- [x] 8e 交付資料夾：`POST /api/deliveries`、`POST /api/deliveries/replay`；資料夾名稱保留中文並避開 Windows 保留字。
- 另修正：手機寬度（390px）頁面橫向溢出（`.layout`/卡片 `min-width: 0`、長路徑換行、`library-grid` 最小欄寬）；佇列表格在自身容器內橫向捲動。
- 測試：`npm run test:all` 通過。

PR #8（疊在 #7 上）。

### 第 9 項：輸入邊界、測試與結構整理 — 進行中

- 決策（2026-10-22）：拆分 server.js / app.js 要等 #7、#8 合併後再做；前端拆檔採瀏覽器原生 ES modules（`<script type="module">`）。
- 等待期間先做不搬移程式碼的部分（分支 `feature/request-guards`，基於 `feature/delivery-batch-queue`）：
  - [x] Host 標頭檢查（防 DNS rebinding）＋ 跨來源 Origin 拒絕非 GET 請求（防 CSRF）；`VEDIO_FACTORY_ALLOWED_HOSTS` 可加入區網主機名稱。
  - [ ] 補充其餘輸入驗證與測試。

## 目前目標（2026-10-23 使用者指示）

使用者已授權合併並推進：「直到可以透過追加模組，產生跳舞影片、走秀影片、健身房影片三種範例影片後，再規畫下一步」。
#7、#10（取代被自動關閉的 #8）、#9 已合併到 main。

環境：本機 RTX 5070 Ti 16GB、ComfyUI 0.39 在 127.0.0.1:8188 執行；已安裝 wan2.2_ti2v_5B_fp16、wan2.2_vae、umt5_xxl_fp8 文字編碼器、Wan Animate 2。
注意：本機另有 NSFW 類 LoRA，場景模組工作流不得載入任何 LoRA，負面提示詞需排除裸露／色情。

### 場景模組（分支 `feature/scenario-modules`）

- [x] S1 後端：`modules/<id>/module.json` 掃描（`VEDIO_FACTORY_MODULES_DIR`）、`GET /api/scenario-modules`、`/scenario-modules/<id>/<檔案>` 靜態服務、模組工作流註冊為 `module-<id>`、模組預設以 `module:<id>` 出現在預設清單（唯讀）、新增 `{{frames}}`（4n+1）佔位符、測試。
- [x] S2 前端：`assets/scenario-kit.js`（人形骨架繪圖工具，ES module）、載入模組 Canvas 預覽並註冊為生成模組、內建預設唯讀。
- [x] S3 三個模組：`modules/dance`、`modules/runway`、`modules/gym`（preview.js＋workflow.json〔Wan 2.2 TI2V 5B 文生影片，無 LoRA〕＋預設）。
- [x] S4 `tools/generate-examples.mjs`（`npm run examples`）：依序產生範例影片、監控 GPU 溫度、以 ffprobe／ffmpeg 檢查時長、解析度、非黑畫面與動態。
- [x] S5 文件（README、modules/README.md）、PR #11。

### 範例影片實際產出結果（2026-10-23，本機 RTX 5070 Ti）

| 模組 | 解析度 | 長度 | 用時 | 檢查 | 畫面確認 |
| --- | --- | --- | --- | --- | --- |
| 跳舞 dance | 1280×704 | 5.04 秒／121 幀 | 307 秒 | 通過（動態 17.2） | 霓虹舞台上的街舞舞者，舞步連續變化 |
| 走秀 runway | 704×1280 | 5.04 秒／121 幀 | 317 秒 | 通過（動態 19.2） | 黑西裝模特兒在伸展台走向鏡頭，兩側觀眾 |
| 健身房 gym | 1280×704 | 5.04 秒／121 幀 | 317 秒 | 通過（動態 7.9） | 第一次頭部出鏡；調整提示詞（遠景側面、從頭到腳）後重產，槓鈴深蹲完整入鏡 |

GPU 最高約 84°C、功耗約 265 W、顯存約 11–13 GB。影片在使用者影片庫（`%USERPROFILE%\Videos\vedioFactory`），報告為同資料夾的 `examples-report.json`。第一次產出、頭部出鏡的健身房影片（`comfyui-717567b5-1.webm`）也還在影片庫，可自行刪除。

目標「透過追加模組產生三種範例影片」已達成，下一步待與使用者規畫。

## Docker、Tailscale、Civitai 安裝（2026-10-24，PR #12）

- Docker：本機已用 `docker compose up --build -d` 執行（開機自動重啟），透過 `.env` 與 npm start 共用影片庫、預設、ComfyUI models；容器經 host.docker.internal 連到主機 ComfyUI（實測可連，ComfyUI 不需改 --listen）。
- Tailscale：`tailscale serve --bg --https=8443 http://127.0.0.1:8000`（tailnet only），網址 https://desktop-77qk2tg.taild30d3d.ts.net:8443；443 埠原有服務（轉 3000）未變動；實測頁面、同源寫入正常、跨來源寫入被擋。
- Civitai：`lib/model-installer.js`＋網頁區塊；只收 .safetensors、掃描須通過、SHA-256 驗證、不覆蓋、一次一個；拒絕 nsfw／poi／minor 模型；顯示商用授權。實測真實 Civitai 查詢與 36 MB LoRA 下載安裝（暫存資料夾）成功；Docker 內可寫入 ComfyUI models。
- 使用說明書（Claude 文件）：https://claude.ai/artifact/7h9FKEp794oKJaMwAsDwXh
- 待使用者回覆：預先安裝哪些常見客戶需求的場景模組、是否做「結構化細節欄位」（穿著／表情／動作／鏡頭／光線）。

## 下一步候選（待規畫）

- 拆分 `server.js`、`assets/app.js`（ES modules），降低維護成本。
- 照片驅動的人物影片：以使用者照片（需本人同意）為起始畫面的圖生影片模組（Wan 2.2 TI2V 圖生影片、Wan Animate 2）。
- 更長的影片：多段串接或 Wan Animate 延伸，超過 5 秒。
- 更多場景模組（產品展示、美食、房地產等）與模組範本產生器。
