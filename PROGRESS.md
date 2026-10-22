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

### 第 8 項：交付格式、批次與工作佇列（分支 `feature/delivery-batch-queue`，基於 `feature/multi-workflow`）— 進行中

決策（2026-10-22）：交付包＝匯出成資料夾 `<outputDir>/deliveries/<客戶>/<專案>/<時間戳>/`；MP4＝匯入 ComfyUI 的 MP4/GIF/WebP，加上偵測到 ffmpeg 時可選轉檔。

子步驟（每步完成就 commit）：
- [x] 8a 多格式：`.webm/.mp4/.gif/.webp` 檔名、列表、播放（gif/webp 用 `<img>`）、改名保留副檔名、ComfyUI 匯入多格式、預檢警告文字。
- [ ] 8b ffmpeg：偵測（`VEDIO_FACTORY_FFMPEG` 或 PATH；測試用 `options.ffmpegCommand=[node, fake.mjs]`）、`POST /api/videos/:name/transcode` 轉 MP4（yuv420p、偶數尺寸、faststart），一次一個。
- [ ] 8c 批次：`POST /api/inference/batches`（prompts × seeds/seedCount，≤50），逐筆建立，單筆失敗不影響其他，工作帶 `batchId`。
- [ ] 8d 佇列面板：`GET /api/inference/jobs?refresh=1` 更新進行中工作；列表回應移除 `submittedWorkflow`；前端面板顯示狀態／取消／重跑。
- [ ] 8e 交付資料夾：`POST /api/deliveries`（依客戶/專案或檔名）複製影片＋來源圖＋`manifest.json`（含完整工作 manifest）；`POST /api/deliveries/replay` 用交付 manifest 重新產出（重用 rerun 邏輯）。

## 下一步

- 完成第 8 項子步驟 8a–8e。
- 注意：執行 visual 測試前需 `npm ci`，並需本機 Chrome/Edge。
