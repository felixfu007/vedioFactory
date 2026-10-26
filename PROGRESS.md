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
- Civitai：`lib/model-installer.js`＋網頁區塊；只收 .safetensors、掃描須通過、SHA-256 驗證、不覆蓋、一次一個；顯示商用授權。實測真實 Civitai 查詢與 36 MB LoRA 下載安裝（暫存資料夾）成功；Docker 內可寫入 ComfyUI models。
- 使用說明書（Claude 文件）：https://claude.ai/artifact/7h9FKEp794oKJaMwAsDwXh
- 待使用者回覆：預先安裝哪些常見客戶需求的場景模組、是否做「結構化細節欄位」（穿著／表情／動作／鏡頭／光線）。

## 目前工作：細節欄位與人物類模組（2026-10-24 使用者決定，分支 `feature/detail-fields-people`）

使用者選擇：細節欄位做成「選單加自填」；預裝人物類模組：藝人形象、活動形象、寫真攝影、人物介紹、體育競技。
注意：人物皆為 AI 虛構，提示詞不得寫真實藝人姓名；寫真攝影排除裸露與性感暗示。

- [x] D1 細節欄位：`modules/_shared/fields.json` 共用欄位庫，module.json `fields` 用 `use` 引用並覆寫；後端 `validateFieldDefinition`，`/api/scenario-modules` 回傳 `fields`。（未做「使用者預設記住 scenarioModuleId」：使用者另存的預設是已填好的文字，不含變數，不需要。）
- [x] D2 前端：`readPresetVariableValues()`、`createVariableField()`；下拉選單＋「自訂…」（值 `__custom__`）；修正「切換預設時沿用上一個預設的輸入值」（用 `presetVariables.dataset.presetId` 判斷）。
- [x] D3 跳舞／走秀／健身房改用細節欄位（變數 person 取代 dancer/model/athlete）。
- [x] D4 五個人物模組：talent（直式）、event（橫式）、portrait（直式）、profile（橫式）、sports（橫式），只有 AI 工作流沒有 Canvas。產生器：暫存區 `gen_modules2.py`（已用完，模組檔已提交）。
- 提交：`ab8af9f`（本機分支，尚未推送）。`npm run test:all` 全部通過。
- [x] D5 五個新模組範例影片（2026-10-24 本機 GPU，每部約 5～6 分鐘，全部通過檢查，最高 83°C）：藝人形象（黑色亮面皮外套、轉頭微笑、霓虹夜景）、活動形象（主持人張開雙手、舞台）、寫真攝影（米白針織、窗邊陽光）、人物介紹（灰西裝主管、辦公室）、體育競技（田徑場衝刺、跟拍）。說明書與 README 已更新。

### 已處理的決定（2026-10-24）

- 說明書匯出檔 `vedioFactory 使用說明書.md`：使用者選「只留在本機」，已加入 .gitignore。
- 八個模組負面提示詞移除裸露／色情排除條款：使用者確認保留（客戶要求尊重設計師創作自由，另有人工評審）。
- Civitai 安裝規則：使用者選「保留真人肖像（poi，只擋真實存在的特定人物，擬真虛構人物不受影響）與未成年人兩條」；成人內容（nsfw）改為只顯示提醒、不阻擋。使用者曾自行提交 5cee266 移除全部規則，之後經說明選擇此方案。**不要再移除 poi 與 minor 兩條規則**；提交前逐一檢查每個檔案的變更。

### 給壓縮後的自己

- 使用者看不懂英文：回覆、工具步驟說明（description）、PR、commit 全部台灣中文。
- 需要決策一律用選項詢問並列優缺點。
- 我的思考內容也要用中文（使用者看得到）；英文錯誤訊息要翻成中文說明。
- Docker 版正在 8000 埠執行（`docker compose ps`）；改了程式後要 `docker compose up --build -d` 才會更新。Tailscale：https://desktop-77qk2tg.taild30d3d.ts.net:8443。

## 目前工作：第 9 項結構整理（2026-10-25，分支 `feature/split-server`）

- [x] 後端拆分：`server.js`（2,823 → 約 380 行，只留組裝與路由）＋ `lib/` 的 config、utils、validation、catalog、runtime、comfyui、workflows、inference、presets、library、deliveries。提交 `435d70f`。
- [x] 安全修正：靜態檔原本以專案根目錄提供（`npm start` 時 `.env` 會外洩），改為只開放 `index.html` 與 `assets/`，並加測試。提交 `ee35d96`。
- [x] 前端拆分：`assets/app.js`（入口，約 110 行）＋ `assets/app/` 16 個 ES modules（Agent 完成，我驗收：語法檢查、`npm run test:all` 通過）。
- [x] 修正剪輯失敗時錯誤訊息被 TypeError 蓋掉（`trimBlob`）。
- 已知小問題（未修）：載入工作清單途中收到更新事件會被略過；切換為瀏覽器資料夾後輪詢未停止；改 ES modules 後無法用 file:// 直接開 index.html（README 本來就要求經由伺服器開啟）。

PR #15 已合併（2026-10-25）。

## 目前工作：照片驅動人物影片（2026-10-25 使用者選定，分支 `feature/photo-driven-video`）

- [x] P1 後端同意紀錄：模組 `safety.requiresPersonConsent` 且附照片時，請求必須帶 `personConsent: true`，否則 400；工作記錄存 `personConsent.confirmedAt`，重跑沿用、交付 manifest 隨工作記錄帶出。前端確認後送出。
- [x] P2 模組 `photo-person`（照片人物動態）：LoadImage → ImageScale（lanczos、置中裁切）→ Wan22ImageToVideoLatent start_image。
- [x] P3 API 測試（缺同意 400、非布林 400、記錄、重跑沿用、純文字不記錄）通過；GPU 實測（來源＝藝人範例影片第 2.5 秒畫面，AI 虛構人物）：704×1280、121 幀、317 秒、最高 82°C，揮手動作正確，長相／髮型／服裝／飾品一致；小瑕疵：手部動態模糊、左下角出現白色小物件。影片 `comfyui-2ef68465-1.webm`（客戶「測試」、專案「照片人物」）在影片庫，可自行刪除。
- [x] P4 文件（README、modules/README.md）、PR。

## 目前工作：功能分頁與示意動畫／AI 按鈕區分（2026-10-25，分支 `feature/tabbed-ui`，疊在 PR #16 上）

- 使用者回報：手機送出「讓人物在沙灘上深蹲，展現健康美」，影片內容與檔名無關。原因：按到「生成影片」（瀏覽器 Canvas 骨架示意動畫，跳舞樣式，不用 AI，不看提示詞），檔名取自提示詞；沒有建立任何 AI 推論工作。真正的 AI 是「建立本機推論工作」按鈕。
- [x] 一頁式改為四個分頁：製作影片／工作佇列（排隊中數字標記）／影片庫（含影片存放位置）／模型安裝；網址 `#queue` 等可直接開分頁，並記住上次分頁；狀態訊息移到分頁列下方，任何分頁都看得到。
- [x] 「用 AI 生成影片」改為主要按鈕；原按鈕改名「產生示意動畫（不用 AI）」並移到虛線框的選用區塊，附說明；影片卡片標示「AI 影片」或「示意動畫（非 AI）」。
- [x] 測試：視覺測試改為先切換分頁、新增 390px 手機寬度每個分頁不溢出檢查；修正原本寫死預設／工作流數量（加照片人物模組後失敗）的測試。`npm run test:all` 通過。

## 14B 模型與影片增強模型（2026-10-26）

- Civitai 金鑰已設定（.env，帳號 felixfu007613）。使用者裝的「maid classic」是 Krea 2 圖片 LoRA，與 Wan 不相容且禁止商用輸出。
- 女僕 LoRA（Civitai 1932283，14B）標籤含 loli 且作者說明固定產生色情內容 → 不安裝；安裝器補上「標籤含 loli／shota 等也視為未成年」檢查（已提交）。
- 新模組 `modules/costume-14b`（服裝造型 14B）：T2V 14B fp8 高低雜訊＋lightx2v 4 步 LoRA，16 FPS。實測兩名 20 歲日本女僕跳舞 832×480、81 幀，84 秒，最高 82°C，畫面正確（人物偏小、背景為宅邸外觀）。
- 已下載並驗證 SHA-256：14B T2V 高／低（各 14.3 GB）、T2V 4 步 LoRA 高／低（各 1.2 GB）、RIFE v4.26（23 MB）、FILM（69 MB）、Real-ESRGAN x4plus（67 MB）、Stable Audio 3 small music（2.3 GB）＋ t5gemma 文字編碼器（1.2 GB）、Wan-Dancer global／local（各 18.3 GB）、I2V 480p 4 步 LoRA（0.7 GB）。
- 實測後製：RIFE 補幀 16→32 FPS 只需 15 秒；補幀＋Real-ESRGAN 放大到 1664×960 需 264 秒，細節明顯變清晰。結果已放進影片庫。
- 尚未整合進網站：後製（補幀／放大）、Stable Audio 配樂、Wan-Dancer（需起始圖＋音樂，一次 149 幀，顯存風險高）。

## 下一步候選（待規畫）

- 拆分 `server.js`、`assets/app.js`（ES modules），降低維護成本。
- 照片驅動的人物影片：以使用者照片（需本人同意）為起始畫面的圖生影片模組（Wan 2.2 TI2V 圖生影片、Wan Animate 2）。
- 更長的影片：多段串接或 Wan Animate 延伸，超過 5 秒。
- 更多場景模組（產品展示、美食、房地產等）與模組範本產生器。
