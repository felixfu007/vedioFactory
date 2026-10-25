# vedioFactory

本機優先的 AI 影片生成服務網站，支援：

- 匯入照片 + 提示詞，或直接輸入影片描述生成影片
- 可切換 / 擴充生成模組，快速輸出不同風格
- 可調整影片長度、FPS、解析度、品質與運鏡強度
- 可把輸出透過本機後端保存到指定資料夾，也可切換成瀏覽器資料夾授權模式
- 內建影片管理：下載、重新命名、剪輯輸出、刪除、重新產出
- 後續可延伸成地端本機顯示卡運算流程，不依賴第三方影片 API

## Windows 11 系統需求

### 必要條件

- Windows 11
- Node.js 22.12+（建議最新 LTS）
- Chrome 或 Edge（用於最佳 WebM / MediaRecorder 相容性）

### 本機 NVIDIA / CUDA 建議環境

- NVIDIA 顯示卡（你的目標機器可用 RTX 5070 Ti）
- 最新版 NVIDIA Driver
- CUDA Toolkit 12.x
- ComfyUI（本機安裝模型與相容的 Python/CUDA 執行環境）

## Windows 11 安裝與啟動

### 1. 安裝 Node.js

- 到 `https://nodejs.org/` 下載 LTS 版本
- 安裝時勾選加入 PATH
- 安裝後在 PowerShell 驗證：

```powershell
node --version
npm --version
```

### 2. 下載專案並安裝依賴

```powershell
cd C:\path\to\vedioFactory
npm install
```

### 3. 啟動服務

```powershell
npm start
```

然後開啟 `http://127.0.0.1:8000`。

> 在 Windows 11 上，預設輸出資料夾會是 `C:\Users\<你的帳號>\Videos\vedioFactory`。你也可以在網站上輸入任意絕對路徑，切換成本機後端管理的資料夾。若想改用瀏覽器授權資料夾，也可以在介面中手動切換。

## Docker 部署（ComfyUI 留在 Windows 主機）

專案也提供 Docker Compose 設定，只將 vedioFactory 容器化；ComfyUI 和 GPU 推論仍在 Windows 主機執行。先安裝並啟動 Docker Desktop，然後在專案目錄的 PowerShell 執行：

```powershell
docker compose up --build -d
```

開啟 `http://127.0.0.1:8000`。複製 `.env.example` 為 `.env` 並填入主機資料夾後，Docker 版會和 `npm start` 共用同一份影片庫、參數預設與 ComfyUI models 資料夾（從 Civitai 安裝模型時寫入）；未填時改存在 Docker volumes，`docker compose down` 不會刪除資料；`docker compose down -v` 會刪除這些資料。ComfyUI 模型仍須安裝在主機上的 ComfyUI 模型目錄；`/data/models` 不會自動同步到 ComfyUI。

Docker 容器中的 `localhost` 指向容器本身，因此 Compose 使用 `host.docker.internal` 連回 Windows 主機。若要執行推論，ComfyUI 必須允許 Docker 容器連線（例如以 `--listen 0.0.0.0` 啟動），並在 Windows 防火牆限制存取範圍；不要將 ComfyUI 的 8188 埠公開到不可信的網路。若有 API 格式工作流，將它放在專案的 `workflows` 資料夾，並在啟動 Compose 前設定容器內路徑：

```powershell
$env:VEDIO_FACTORY_COMFYUI_WORKFLOW="/workflows/video-api.json"
docker compose up --build -d
```

網站埠只綁定主機的 `127.0.0.1`。若要更改主機埠，例如 8080，先設定 `$env:VEDIO_FACTORY_PORT="8080"` 再執行 Compose。Docker 部署不會替 ComfyUI 安裝模型、節點或 GPU 執行環境。

### 用 Tailscale 從外部連線

```powershell
tailscale serve --bg --https=8443 http://127.0.0.1:8000
```

之後在 tailnet 內的裝置開啟 `https://<電腦名稱>.<tailnet>.ts.net:8443`，並把這個主機名稱加入 `.env` 的 `VEDIO_FACTORY_ALLOWED_HOSTS`。請勿使用 `tailscale funnel`：它會公開到整個網際網路，而本服務沒有登入機制。關閉：`tailscale serve --https=8443 off`。

### 存取保護

vedioFactory 沒有登入機制，因此後端只接受以 `localhost`、`127.0.0.1` 或 `[::1]` 連線的請求，可防止 DNS rebinding；也會拒絕從其他網站送來的寫入請求（POST／PUT／PATCH／DELETE，依 `Origin` 判斷），可防止 CSRF。若要讓區網其他電腦連線，除了把 `HOST` 設為 `0.0.0.0`，還要把它們使用的主機名稱或 IP 加入 `VEDIO_FACTORY_ALLOWED_HOSTS`。請注意：區網中任何能連到此埠的人都能管理影片與工作，只應在可信任的網路使用。

## Windows 11 使用方式

1. 上傳照片（可選）
2. 輸入提示詞或影片描述（至少填一項）
3. 選擇生成模組與影片參數
4. 直接使用預設後端輸出資料夾，或輸入新的絕對路徑（例如 `C:\Users\<你的帳號>\Videos\vedioFactory\Exports`）後按「套用後端資料夾」
5. 按下「生成影片」
6. 在下方管理區進行重新命名、剪輯輸出、刪除、重新產出等操作

後端影片庫會以二進位串流保存影片，單檔上限為 500 MiB；中斷或超限的上傳不會保留暫存影片。

### 影片格式與 MP4 轉檔

- 影片庫支援 WebM、MP4、GIF、WebP。Canvas 模組產生 WebM；ComfyUI 輸出的這四種格式都會匯入（PNG 等單張圖片不會）。GIF／WebP 以圖片預覽，無法在瀏覽器內剪輯。
- 若本機可執行 ffmpeg（在 PATH 中，或以 `VEDIO_FACTORY_FFMPEG` 指定路徑），非 MP4 影片卡片會出現「轉成 MP4」：以 H.264（yuv420p、CRF 18）＋ AAC 輸出，並保留原影片的參數 metadata（含 seed、客戶／專案）。轉檔一次執行一個。Windows 可從 https://ffmpeg.org/download.html 下載。Docker 映像預設不含 ffmpeg。

## 環境變數

| 變數名 | 預設值 | 說明 |
| --- | --- | --- |
| `VEDIO_FACTORY_OUTPUT_DIR` | `%USERPROFILE%\Videos\vedioFactory` | 影片輸出資料夾 |
| `VEDIO_FACTORY_MODEL_DIR` | `%USERPROFILE%\vedioFactory\models` | 本機模型權重目錄 |
| `VEDIO_FACTORY_DATA_DIR` | `%USERPROFILE%\vedioFactory` | 應用資料目錄；參數預設存於其下的 `presets/` |
| `VEDIO_FACTORY_COMFYUI_URL` | `http://127.0.0.1:8188` | 本機 ComfyUI HTTP API（僅接受 localhost） |
| `VEDIO_FACTORY_COMFYUI_WORKFLOW` | 空值 | 選用：額外指定一個預設工作流 JSON 的絕對路徑 |
| `VEDIO_FACTORY_FFMPEG` | `ffmpeg`（PATH） | 選用：ffmpeg 執行檔路徑，用於「轉成 MP4」 |
| `VEDIO_FACTORY_COMFYUI_MODELS_DIR` | `%USERPROFILE%\ComfyUI\models` | ComfyUI 的 models 資料夾，從 Civitai 安裝模型時寫入 |
| `VEDIO_FACTORY_CIVITAI_TOKEN` | 空值 | 選用：Civitai API 金鑰，下載需要登入的模型時使用 |
| `VEDIO_FACTORY_MODULES_DIR` | 專案內 `modules\` | 場景模組資料夾，見「場景模組」 |
| `VEDIO_FACTORY_WORKFLOWS_DIR` | 專案內 `workflows\` | 多工作流資料夾，見「多工作流與參數規格」 |
| `HOST` | `127.0.0.1` | 服務綁定位址 |
| `VEDIO_FACTORY_ALLOWED_HOSTS` | 空值 | 選用：逗號分隔的額外主機名稱（例如 `studio.local,192.168.1.20`），允許以這些名稱連線 |
| `PORT` | `8000` | 服務埠號 |

### PowerShell 範例

```powershell
$env:VEDIO_FACTORY_OUTPUT_DIR="C:\AI\vedioFactory\output"
$env:VEDIO_FACTORY_MODEL_DIR="C:\AI\vedioFactory\models"
$env:VEDIO_FACTORY_COMFYUI_URL="http://127.0.0.1:8188"
$env:VEDIO_FACTORY_COMFYUI_WORKFLOW="C:\AI\vedioFactory\workflows\video-api.json"
npm start
```

## 客戶專案與參數預設

頁面上方的「客戶專案與參數預設」區可以：

- 填寫**客戶**與**專案**：之後產出的 Canvas 影片、ComfyUI 推論工作與匯入影片都會帶上這兩個標籤，影片庫可依客戶／專案篩選。
- **儲存目前設定為新預設**：保存提示詞範本、影片描述範本、負面提示詞、生成模組、影片模型、長度/FPS/解析度/品質/運鏡/文字強度，以及 seed 模式（固定 seed 會一併保存）。
- **範本變數**：提示詞或影片描述中寫 `{product}`、`{slogan}` 等變數，選擇預設後會出現對應欄位，按「套用預設」時填入。
- **匯出／匯入**：匯出全部預設為 JSON，方便在其他機器或同事間交接；匯入時會先驗證全部內容，任一筆無效就不寫入任何預設，相同 ID 的預設會被覆蓋。

預設保存在 `VEDIO_FACTORY_DATA_DIR\presets\`（預設 `%USERPROFILE%\vedioFactory\presets\`），不隨輸出資料夾切換而改變。Docker 部署時保存在 `vediofactory-app` volume。

## 從 Civitai 安裝模型

網頁的「從 Civitai 安裝模型」區塊：貼上 civitai.com 的模型網址 → 按「查詢模型」確認名稱、類型、大小、觸發詞與**商用授權** → 按「下載並安裝」。檔案會依類型放進 ComfyUI 的 models 子資料夾（Checkpoint → `checkpoints`、LoRA → `loras` 等，可手動改成 `diffusion_models` 等），下載進度顯示在同一區塊，ComfyUI 不需重啟即可看到新模型。

安全規則：只接受 `.safetensors`（舊式 `.ckpt`／`.pt` 載入時可能執行程式碼）、Civitai 安全掃描須通過、下載後比對 SHA-256、不覆蓋既有檔案、一次只下載一個；不提供自動安裝描繪特定真實人物（Civitai 的 poi 標記，擬真風格的虛構人物不受影響）或涉及未成年人的模型；作者標示為成人內容的模型會顯示提醒，產出內容請經人工審查；作者未允許商用的模型會在安裝前提醒。需要登入才能下載的模型，請在 `.env` 設定 `VEDIO_FACTORY_CIVITAI_TOKEN`（Civitai 帳號設定中的 API Key）。

## 場景模組（跳舞、走秀、健身房與人物類）

`modules\` 資料夾裡的每個子資料夾都是一個「場景模組」，放進新資料夾後重新整理網頁就會出現新的影片類型。內建九個模組：

| 模組 | Canvas 預覽（不需 GPU） | ComfyUI AI 影片 |
| --- | --- | --- |
| 跳舞影片 `dance` | 舞者隨節拍換舞步、舞台燈光 | Wan 2.2 TI2V 5B，橫式 1280×704、5 秒 |
| 走秀影片 `runway` | 透視伸展台、台步、閃光燈 | Wan 2.2 TI2V 5B，直式 704×1280、5 秒 |
| 健身房影片 `gym` | 槓鈴深蹲、次數計數 | Wan 2.2 TI2V 5B，橫式 1280×704、5 秒 |
| 藝人形象影片 `talent` | 無 | 直式 704×1280、5 秒 |
| 活動形象影片 `event` | 無 | 橫式 1280×704、5 秒 |
| 寫真攝影影片 `portrait` | 無 | 直式 704×1280、5 秒 |
| 人物介紹影片 `profile` | 無 | 橫式 1280×704、5 秒 |
| 體育競技影片 `sports` | 無 | 橫式 1280×704、5 秒 |
| 照片人物動態影片 `photo-person` | 無 | Wan 2.2 TI2V 5B 圖生影片，以一張人物照片為第一個畫面，直式／橫式、5 秒 |

### 照片人物動態影片（需本人同意）

在「來源圖片」選一張人物照片，套用「［場景模組］照片人物動態影片」預設，選擇動作（轉頭微笑、揮手、點頭等）後按「建立本機推論工作」。照片會置中裁切成所選解析度，當作影片的第一格；提示詞只描述動作與運鏡，長相、髮型、服裝都以照片為準。動作越小，越能保持人物長相一致。

只能使用已取得照片人物本人同意的照片（客戶提供時，請確認客戶已取得授權；未成年人需監護人同意），且不得用於冒充、誤導或不雅內容。送出前網頁會要求確認；後端也會檢查，沒有確認（API 的 `personConsent: true`）就拒絕。確認時間會存進工作記錄的 `personConsent.confirmedAt`，以相同設定重新產出時沿用，建立交付資料夾時也會隨工作記錄寫進 `manifest.json`。

每個模組都有「細節欄位」：鏡頭遠近、拍攝角度、運鏡、人物、穿著、臉部表情、動作、場景、光線、風格等，以下拉選單選擇常用選項，或選「自訂…」自己填寫，系統再依固定順序組成提示詞。畫面中的人物由 AI 虛構，請勿在提示詞寫入真實藝人或公眾人物姓名。

使用方式：在「客戶專案與參數預設」選擇「［場景模組］跳舞影片」等預設，確認變數後按「套用預設」。之後按「生成影片」會產生 Canvas 預覽影片；按「建立本機推論工作」則會用 ComfyUI 產生 AI 影片。

產生三部 AI 範例影片（依序執行、每部之間讓 GPU 休息，並自動檢查時長、解析度、非黑畫面與動態）：

```powershell
npm run examples
# 只產生其中幾種，或改變長度：
node tools/generate-examples.mjs --only dance,gym --duration 4
```

影片會匯入影片庫（客戶「範例」、專案「場景模組」），檢查報告寫在輸出資料夾的 `examples-report.json`。需要本機 ComfyUI 已安裝 `wan2.2_ti2v_5B_fp16.safetensors`、`wan2.2_vae.safetensors` 與 `umt5_xxl_fp8_e4m3fn_scaled.safetensors`，檢查需要 ffmpeg／ffprobe。

自行製作模組請見 [modules/README.md](modules/README.md)。

## 批次、工作佇列與交付資料夾

- **批次生成**：「本機 ComfyUI 推論」區展開「批次生成」，每行輸入一個提示詞（留空則用上方提示詞），並設定每個提示詞產生幾個 seed。固定 seed 時依序使用 seed、seed+1…；隨機時每個工作各自產生 seed。單一批次最多 50 個工作，單筆失敗不影響其他工作（`POST /api/inference/batches`）。
- **工作佇列**：「推論工作佇列」區列出所有工作的狀態、客戶／專案、seed、工作流與批次，可依狀態篩選、取消排隊中的工作，或以相同設定重跑；有進行中工作時每 4 秒自動更新，完成後影片庫會自動重新整理。
- **交付資料夾**：在影片庫篩選客戶／專案後按「為目前篩選建立交付資料夾」，會建立 `輸出資料夾\deliveries\<客戶>\<專案>\<時間>\`，內含 `videos\`（影片副本）、`sources\`（ComfyUI 來源圖片）與 `manifest.json`（每部影片的 SHA-256、完整參數，以及 ComfyUI 工作的工作流快照與 seed）。
- **從交付資料夾重新產出**：把交付資料夾放回（或保留在）`輸出資料夾\deliveries\` 底下，呼叫 `POST /api/deliveries/replay`，body 為 `{"manifestPath": "<manifest.json 絕對路徑>", "index": 0}`，即可用 manifest 中保存的工作流快照、seed 與來源圖片重新提交 ComfyUI。Canvas 影片的參數同樣記錄在 manifest，但需在影片庫中重新產出。

## 多工作流與參數規格

把 ComfyUI 匯出的 **API 格式** JSON 放進 `workflows\` 資料夾（或 `VEDIO_FACTORY_WORKFLOWS_DIR`），就會出現在「本機 ComfyUI 推論」區的工作流選單，不需重啟。可在旁邊放同名的 `.vf.json` 設定檔（選用），描述名稱、適用模型與參數限制：

```
workflows\
  wan-t2v.json        ← ComfyUI 匯出的原檔，重新匯出時直接覆蓋
  wan-t2v.vf.json     ← vedioFactory 設定（選用）
```

```json
{
  "name": "Wan 2.1 文生影片 480p",
  "description": "832x480 原生解析度，16 FPS",
  "videoModelIds": ["wan-2.1-t2v-1.3b"],
  "requiresSourceImage": false,
  "resolutions": ["832x480", "480x832"],
  "allowCustomResolution": false,
  "resolutionMultiple": 16,
  "maxWidth": 1280,
  "maxHeight": 1280,
  "fps": [16],
  "minDuration": 2,
  "maxDuration": 5,
  "defaults": { "resolution": "832x480", "fps": 16, "duration": 3 }
}
```

所有欄位都可省略，省略時使用基本規格：8 種常用解析度（16:9、9:16、1:1、4:3、3:4、21:9）、FPS 12/16/24/25/30、長度 2–30 秒，以及寬高為 8 的倍數、介於 256 至 3840（總像素不超過 4K）的自訂解析度。選擇工作流後，「設定影片參數」區只會列出該工作流允許的值，後端也會拒絕超出範圍的參數。設定檔有錯時，工作流仍會列出但標示「設定錯誤」，無法送出工作。

`VEDIO_FACTORY_COMFYUI_WORKFLOW` 仍可使用：它指定的檔案會成為預設工作流（ID 為 `default`）。參數預設會記住所選工作流；套用時若工作流不存在或不支援預設中的參數，介面會提示並改用可用值。

規格也可由 `GET /api/workflows` 與 `GET /api/capabilities?workflowId=<id>` 取得。

## 本機 ComfyUI 工作流推論

請先在本機啟動 ComfyUI，並在 ComfyUI 將工作流匯出為 **API 格式 JSON**，放入 `workflows\` 資料夾（或設定 `VEDIO_FACTORY_COMFYUI_WORKFLOW`），再從介面選擇工作流並建立本機推論工作。

API 工作流可以在文字輸入中使用以下佔位符；`{{source_image}}` 可放在載入圖片節點的圖片欄位：

- `{{prompt}}`、`{{story}}`、`{{negative_prompt}}`、`{{seed}}`
- `{{model_id}}`
- `{{width}}`、`{{height}}`、`{{duration}}`、`{{fps}}`
- `{{quality}}`、`{{motion}}`、`{{caption_strength}}`
- `{{source_image}}`

按「檢查 ComfyUI 工作流」可在提交前檢查 API 節點結構、未知佔位符、是否選了來源圖片，以及影片/WebM 輸出節點提示。送出工作時也會再次做必要檢查，避免不支援的佔位符或缺少必需來源圖片時先上傳圖片。

### 可重現生成（seed 與工作流快照）

- 「本機 ComfyUI 推論」區可填負面提示詞，並選擇 seed 模式：「每次隨機」會由後端產生 seed 並顯示在狀態列；「固定」則使用輸入的整數（0 至 9007199254740991）。請將 `{{seed}}` 放在 KSampler 等節點的 seed 欄位。
- 每個工作 manifest（`inference-jobs/*.json`）會記錄所有參數、seed、工作流檔案 SHA-256、實際送給 ComfyUI 的 prompt JSON（`submittedWorkflow`）與可取得時的 ComfyUI 版本。
- 來源圖片會依內容 SHA-256 保存在 `inference-jobs/sources/`，並以相同內容產生相同檔名上傳 ComfyUI，確保重跑時 prompt JSON 完全一致。
- 影片庫中由 ComfyUI 產生的影片按「以相同設定重新產出」，會呼叫 `POST /api/inference/jobs/:id/rerun`，以原工作流快照、seed 與來源圖片重新提交。若目前工作流檔案或 ComfyUI 版本已不同，介面會顯示警告。
- 相同 prompt JSON 只保證送出的輸入一致；模型權重、custom nodes、驅動或非決定性 GPU 運算仍可能讓畫面略有差異。

推論工作在 ComfyUI 尚未開始執行時可從待執行佇列取消。若工作已在執行，介面會拒絕取消：ComfyUI 的 `/interrupt` 會中斷目前全域執行，可能影響其他工作，因此本專案不會自動呼叫它。

重新整理頁面或重啟 vedioFactory 後，前端會從 `inference-jobs/` 恢復追蹤最新的待執行/執行中工作。這依賴 ComfyUI 保留對應 prompt history/queue；若 ComfyUI 重啟或清除 queue/history，需手動重新建立工作。

來源圖片會上傳到本機 ComfyUI；ComfyUI 回傳的 `.webm` 輸出會匯入 vedioFactory 的影片資料夾。其他輸出格式目前不會自動匯入。工作狀態會透過 ComfyUI history/queue 查詢，工作 manifest 保存在輸出資料夾下的 `inference-jobs/`。

預檢只靜態檢查 JSON 和節點名稱/設定提示，不會執行工作流，不能確認模型權重或 custom nodes 已安裝、模型/節點彼此相容、VRAM 足夠或實際輸出格式正確。仍需在本機 ComfyUI 實際生成驗證。

安全限制：目前只允許 HTTP 連線至 `localhost`、`127.0.0.1` 或 `::1`，不會將工作流或圖片送往第三方服務。尚未設定工作流時，預檢會回報未設定；介面仍可建立標示為 `scaffolded` 的工作，但不代表已執行模型。

## 本機影片模型選擇

模型規劃介面列出 10 種本機文生影片/圖生影片選項。可從介面選擇模型，並將模型 ID 傳入 API 工作流的 `{{model_id}}` 佔位符。

### 建議測試順序（假設 RTX 5070 Ti 16GB VRAM）

1. **Wan 2.2 TI2V-5B** — 文生/圖生影片皆可，建議先測短片與較低解析度。
2. **FramePack-F1** — 可從圖片逐段生成；官方 Windows 桌面程式和 ComfyUI 整合是不同路線。
3. **Wan 2.1 T2V-1.3B** — 小型文生影片選擇，適合驗證流程。
4. **LTX-Video 0.9.8** — 支援多種條件控制，須配對正確模型與節點。
5. **LTX-2** — 支援影音相關工作流；先驗證 ComfyUI 版本及 16GB 顯存可行性。
6. **HunyuanVideo-1.5** — 有官方 ComfyUI 指引；建議從較低負載設定測試。
7. **CogVideoX1.5-5B-I2V** — 圖生影片專用選擇，須確認相容節點及權重授權。
8. **AnimateDiff** — 適合短動畫與風格實驗，需安裝對應 motion module/節點。
9. **Stable Video Diffusion XT** — 較早期的圖生短片模型，可作基準比較。
10. **Mochi 1** — 約 10B 模型，官方範例會使用 CPU 卸載，不建議作為 16GB 顯卡的第一個目標。

VRAM 提示是初步規劃，不是硬體相容保證。量化方式、解析度、影格數、ComfyUI 節點與 CPU 卸載都會影響實際顯存和速度。模型權重授權可能與程式碼授權不同，商用前請查閱該版本的模型授權。

目前專案內真正整合的 AI 模型仍是 **0**。本機 ComfyUI 連線與 API 工作提交已完成；真正出片必須另外安裝模型/節點，選取相符工作流，並設定 `VEDIO_FACTORY_COMFYUI_WORKFLOW`。目前只有輸出 WebM 的工作流可自動匯入影片庫。

### 輔助模型與後處理元件

專案也保留 SDXL（首幀/圖片生成）、Real-ESRGAN（放大修復）、RIFE（補幀）、ControlNet/IP-Adapter（條件控制）等工作流元件；它們不計入上述 10 個影片模型選項。

`GET /api/models/catalog` 回傳模型目錄；`POST /api/models/setup-batch` 只為下列輔助元件產生規劃 manifest，不會安裝或下載權重：

- `sdxl`
- `animatediff`
- `realesrgan`
- `rife`

## 驗證與測試

安裝測試依賴後可直接跑實際瀏覽器驗證：

```powershell
cd C:\path\to\vedioFactory
npm install
npm test
npm run test:all
npm run test:visual
```

此流程會：

- 啟動本機後端服務
- 用 Chromium 實際生成影片
- 輸出頁面截圖與影片中段畫面截圖到 `visual-output/`
- 將影片實際畫面與同設定下的參考畫面做相似度比對，確認生成內容與提示詞/描述一致

`npm test` / `npm run test:api` 會額外驗證：

- 後端輸出資料夾設定
- 影片保存 / 列表
- 重新命名
- 檔案讀取
- 刪除
- 本機推論 runtime API
- 本機推論工作 manifest 建立

`npm run test:visual` 會：

- 自動尋找 Windows 常見的 Chrome / Edge 路徑
- 若找不到瀏覽器，可改用 `CHROMIUM_PATH` 指定瀏覽器執行檔

## 常見問題

### 1. 為什麼畫面顯示「尚未偵測到 nvidia-smi」？

代表目前執行環境找不到 NVIDIA 工具鏈。請確認：

- 已安裝 NVIDIA Driver
- `nvidia-smi` 可在 PowerShell 直接執行
- 若有安裝 CUDA，相關路徑已加入 PATH

### 2. 為什麼現在還不是真的 AI 模型出片？

目前已提供 **本機 ComfyUI 工作流 API 整合**。要實際生成模型影片，還需要：

- 啟動本機 ComfyUI 並安裝模型/所需自訂節點
- 匯出 API 格式工作流並設定 `VEDIO_FACTORY_COMFYUI_WORKFLOW`
- 在工作流使用支援的佔位符與 WebM 輸出節點

### 3. 如果我要換模型怎麼做？

匯出另一份 ComfyUI API 格式工作流，更新 `VEDIO_FACTORY_COMFYUI_WORKFLOW` 後重新啟動 vedioFactory。模型、節點與 VRAM 需求由該工作流及本機 ComfyUI 安裝決定。

## 模組擴充

前端核心註冊器位於 `assets/app.js`，內建模組位於 `assets/modules.js`。

每個模組只要呼叫：

```js
window.VedioFactory.registerModule({
  id: 'custom-module',
  name: 'Custom Module',
  tagline: '自訂風格',
  description: '說明你的模組用途',
  bestFor: '適用情境',
  capabilities: ['能力一', '能力二'],
  renderFrame({ ctx, canvas, progress, image, spec, fitImage, drawCaptionBlock }) {
    // 在這裡繪製每一幀
  },
});
```

即可被網站自動載入成新的可選模組。

## 輸出內容

若使用後端資料夾模式，系統會在指定資料夾中保存：

- `*.webm`：生成後的影片檔
- `*.webm.json`：對應的影片設定與來源資訊，供重新整理、重新產出與管理功能使用
