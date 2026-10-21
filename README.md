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

開啟 `http://127.0.0.1:8000`。Compose 將影片輸出和模型參考目錄保存在 Docker volumes，`docker compose down` 不會刪除資料；`docker compose down -v` 會刪除這些資料。ComfyUI 模型仍須安裝在主機上的 ComfyUI 模型目錄；`/data/models` 不會自動同步到 ComfyUI。

Docker 容器中的 `localhost` 指向容器本身，因此 Compose 使用 `host.docker.internal` 連回 Windows 主機。ComfyUI 預設只監聽 `127.0.0.1`；容器要連得到它，通常必須以 `--listen` 啟動 ComfyUI。

> **警告：`--listen` 會讓 ComfyUI 對整個區域網路開放。** ComfyUI 沒有任何驗證，同一個 Wi-Fi／區網上的任何裝置都能提交工作流、上傳檔案、讀取輸出並佔用 GPU。請只用 `--listen 0.0.0.0`（只綁 IPv4；不帶值的 `--listen` 也會綁 IPv6 `::`），並在啟動前套用下列防火牆規則。不使用 Docker 時不需要 `--listen`。

```powershell
# 以系統管理員身分執行 PowerShell
# 1. 停用 ComfyUI 第一次監聽時 Windows 自動建立的 python.exe 允許規則（它會對區網開放所有埠）
Get-NetFirewallRule -Direction Inbound |
  Where-Object { ($_ | Get-NetFirewallApplicationFilter).Program -like '*python*' } |
  Disable-NetFirewallRule

# 2. 只允許本機、WSL 2 與 Docker Desktop 網段連線 8188
New-NetFirewallRule -DisplayName 'ComfyUI 8188 - local/WSL/Docker only' -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 8188 -RemoteAddress 127.0.0.1,172.16.0.0/12,192.168.65.0/24 -Profile Any

# 3. 保險：封鎖其他所有 IPv4 來源（封鎖規則優先於允許規則，所以以位址範圍排除上面的網段）
New-NetFirewallRule -DisplayName 'ComfyUI 8188 - block LAN/Internet' -Direction Inbound -Action Block `
  -Protocol TCP -LocalPort 8188 -Profile Any `
  -RemoteAddress 0.0.0.0-126.255.255.255,128.0.0.0-172.15.255.255,172.32.0.0-192.168.64.255,192.168.66.0-255.255.255.255

# 啟動 ComfyUI（在 ComfyUI 目錄）
python main.py --listen 0.0.0.0 --port 8188
```

`172.16.0.0/12` 是 WSL 2 / Docker 的虛擬網段；若你的實體區網也使用 172.16–172.31 網段，請改成 `Get-NetIPAddress -InterfaceAlias 'vEthernet (WSL*)'` 查到的實際子網。完成後可從另一台裝置開 `http://<本機區網 IP>:8188` 確認連不上。移除規則：`Remove-NetFirewallRule -DisplayName 'ComfyUI 8188*'`。

若有 API 格式工作流，將它放在專案的 `workflows` 資料夾，並在啟動 Compose 前設定容器內路徑：

```powershell
$env:VEDIO_FACTORY_COMFYUI_WORKFLOW="/workflows/video-api.json"
docker compose up --build -d
```

網站埠只綁定主機的 `127.0.0.1`。若要更改主機埠，例如 8080，先設定 `$env:VEDIO_FACTORY_PORT="8080"` 再執行 Compose；Compose 會同時把它傳成 `VEDIO_FACTORY_PUBLIC_PORT`，讓 API 接受 `Host: localhost:8080`。Docker 部署不會替 ComfyUI 安裝模型、節點或 GPU 執行環境。

## Windows 11 使用方式

1. 上傳照片（可選）
2. 輸入提示詞或影片描述（至少填一項）
3. 選擇生成模組與影片參數
4. 直接使用預設後端輸出資料夾，或輸入新的絕對路徑（例如 `C:\Users\<你的帳號>\Videos\vedioFactory\Exports`）後按「套用後端資料夾」
5. 按下「生成影片」
6. 在下方管理區進行重新命名、剪輯輸出、刪除、重新產出等操作

後端影片庫會以二進位串流保存 WebM，單檔上限為 500 MiB；中斷或超限的上傳不會保留暫存影片。

## 環境變數

| 變數名 | 預設值 | 說明 |
| --- | --- | --- |
| `VEDIO_FACTORY_OUTPUT_DIR` | `%USERPROFILE%\Videos\vedioFactory` | 影片輸出資料夾 |
| `VEDIO_FACTORY_MODEL_DIR` | `%USERPROFILE%\vedioFactory\models` | 本機模型權重目錄 |
| `VEDIO_FACTORY_COMFYUI_URL` | `http://127.0.0.1:8188` | 本機 ComfyUI HTTP API（僅接受 localhost） |
| `VEDIO_FACTORY_COMFYUI_WORKFLOW` | 空值 | ComfyUI 匯出的 API 格式工作流 JSON 絕對路徑 |
| `HOST` | `127.0.0.1` | 服務綁定位址 |
| `PORT` | `8000` | 服務埠號 |
| `VEDIO_FACTORY_PUBLIC_PORT` | 空值 | 瀏覽器實際使用的其他埠號（逗號分隔），例如 Docker 發佈的主機埠 |

`/api/*` 只接受 `Host` 為 `127.0.0.1`、`localhost` 或 `[::1]` 加上服務埠（或 `VEDIO_FACTORY_PUBLIC_PORT`）的請求；帶 `Origin` 時必須是同一來源；GET 以外的請求必須是 `Content-Type: application/json`（影片二進位上傳例外，但瀏覽器端須帶 `X-VedioFactory-Request: 1` 或同源 `Origin`）。這可阻擋其他網站以 CSRF 或 DNS rebinding 操作本機 API。若以區網 IP 或其他主機名開啟網站，API 會回 403。

### PowerShell 範例

```powershell
$env:VEDIO_FACTORY_OUTPUT_DIR="C:\AI\vedioFactory\output"
$env:VEDIO_FACTORY_MODEL_DIR="C:\AI\vedioFactory\models"
$env:VEDIO_FACTORY_COMFYUI_URL="http://127.0.0.1:8188"
$env:VEDIO_FACTORY_COMFYUI_WORKFLOW="C:\AI\vedioFactory\workflows\video-api.json"
npm start
```

## 本機 ComfyUI 工作流推論

請先在本機啟動 ComfyUI，並在 ComfyUI 將工作流匯出為 **API 格式 JSON**。在 vedioFactory 啟動前設定 `VEDIO_FACTORY_COMFYUI_WORKFLOW`，再從介面建立本機推論工作。

API 工作流可以在文字輸入中使用以下佔位符；`{{source_image}}` 可放在載入圖片節點的圖片欄位：

- `{{prompt}}`、`{{story}}`、`{{negative_prompt}}`
- `{{model_id}}`
- `{{width}}`、`{{height}}`、`{{duration}}`、`{{fps}}`
- `{{frames}}`：影格數，`floor(duration × fps / 4) × 4 + 1`（Wan / HunyuanVideo 需要 4n+1）
- `{{steps}}`：取樣步數，依品質設定（草稿 12、平衡 20、精緻 30）
- `{{seed}}`：隨機種子；未指定時每個工作隨機產生，並記錄在工作 manifest 與影片 `.webm.json`
- `{{quality}}`、`{{motion}}`、`{{caption_strength}}`
- `{{source_image}}`

整個欄位值只有一個佔位符時（例如 `"width": "{{width}}"`），會以數字型別代入，可直接接到 ComfyUI 的 INT/FLOAT 輸入。

按「檢查 ComfyUI 工作流」可在提交前檢查 API 節點結構、未知佔位符、是否選了來源圖片，以及影片/WebM 輸出節點提示。ComfyUI 可連線時，預檢還會查詢 `/object_info/{節點}`，回報 ComfyUI 沒有的節點類型（通常是缺 custom node）與選單中不存在的模型檔名（通常是權重檔未放入 `models/`）。送出工作時也會再次做這些檢查，未通過時不會上傳圖片或提交工作。

ComfyUI 執行失敗（例如 CUDA out of memory）時，工作會標記為 `failed` 並顯示失敗節點與錯誤訊息；成功時會記錄 ComfyUI 回報的實際執行秒數（`executionSeconds`）。

### Wan 2.2 圖生影片（I2V）

專案附兩份 API 格式工作流，都只使用 ComfyUI 內建節點（不需 custom nodes），以內建 `SaveWEBM`（VP9）輸出：

| 工作流 | 模型 | 建議設定（RTX 5070 Ti 16GB） |
| --- | --- | --- |
| `workflows/wan22-ti2v-5b-i2v.api.json`（主要） | Wan 2.2 TI2V-5B fp16 | 先用 832×480、2 秒、24 fps、草稿；再試 1280×720、5 秒（121 影格） |
| `workflows/wan22-i2v-a14b-4step.api.json`（進階，尚未實測） | Wan 2.2 I2V-A14B fp8 + lightx2v 4 步 LoRA | 832×480、≤ 5 秒；固定 4 步、忽略品質設定；需大量 CPU offload 與系統記憶體 |

所需權重（放在 ComfyUI 的 `models/` 對應資料夾）：

| 檔案 | 放置資料夾 | 大小 | 用於 |
| --- | --- | --- | --- |
| `wan2.2_ti2v_5B_fp16.safetensors` | `diffusion_models/` | 10.0 GB | 5B |
| `wan2.2_vae.safetensors` | `vae/` | 1.41 GB | 5B |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders/` | 6.74 GB | 5B、A14B |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | `diffusion_models/` | 14.3 GB | A14B |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | `diffusion_models/` | 14.3 GB | A14B |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | `loras/` | 1.23 GB | A14B |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | `loras/` | 1.23 GB | A14B |
| `wan_2.1_vae.safetensors` | `vae/` | 0.25 GB | A14B |

來源：[Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged)（`split_files/...`）與 [Comfy-Org/Wan_2.1_ComfyUI_repackaged](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged)（文字編碼器）。Wan 2.2 權重標示為 Apache-2.0，商用前仍請查核模型卡與 LoRA 授權。

#### 模型來源紀錄（`server.js` 的 `comfyUIFiles`）

每個權重檔記錄 `provider`、`folder`、`file`、`sizeBytes`、`sha256`、`source`、`license`、`commercialUse`；啟動時由 `validateModelFileSource` 檢查，只接受 `.safetensors`（拒絕 `.ckpt/.pt/.bin` 等 pickle 格式），來源主機須在 `TRUSTED_MODEL_SOURCE_HOSTS`（`huggingface.co`、`civitai.com`、`civitai.red`）內，且必須完全相符（不接受子網域或相似網域）。Civitai 條目（`provider: 'civitai'`，或來源主機為 `civitai.com`／`civitai.red`）一律以 `https://<host>/api/download/models/<modelVersionId>` 下載，另須 `modelPageUrl`（`https://civitai.com/models/<id>` 或 `https://civitai.red/models/<id>`）、`modelVersionId`，以及該模型頁標示的授權與商用許可。需要 API token 時只從環境變數 `CIVITAI_API_TOKEN` 讀取（`civitai.com` 與 `civitai.red` 共用同一個變數），不得寫入程式碼、manifest 或紀錄。

`civitai.red` 已於 2026-10-15 加入信任清單：使用者確認其為 Civitai 官方網域並核准加入。規則與 `civitai.com` 完全相同（只接受 `.safetensors`、須 sha256、license、modelPageUrl、modelVersionId、commercialUse）。

```powershell
$env:VEDIO_FACTORY_COMFYUI_WORKFLOW="$PWD\workflows\wan22-ti2v-5b-i2v.api.json"
npm start
```

注意：5B 模型的 VAE 以 32 像素為單位，原生 720p 是 1280×704；選 1280×720 時模型內部會補齊後裁切，可以執行但非原生尺寸。Wan 2.2 5B 原生 24 fps，選 12/30 fps 會改變播放速度感；工作流使用 `{{frames}}` 時，影格數超過模型上限（5B 為 121 影格）會直接回 400 並說明可用片長（24 fps 為 2–5 秒、12 fps 為 2–10 秒、30 fps 為 2–4 秒）。A14B 原生為 16 fps。

推論工作在 ComfyUI 尚未開始執行時可從待執行佇列取消。若工作已在執行，介面會拒絕取消：ComfyUI 的 `/interrupt` 會中斷目前全域執行，可能影響其他工作，因此本專案不會自動呼叫它。

重新整理頁面或重啟 vedioFactory 後，前端會從 `inference-jobs/` 恢復追蹤最新的待執行/執行中工作。這依賴 ComfyUI 保留對應 prompt history/queue；若 ComfyUI 重啟或清除 queue/history，需手動重新建立工作。

來源圖片會先檢查檔頭是否真的是宣告的 PNG/JPEG/WebP、寬高不超過 4096，所有檢查通過後才上傳到本機 ComfyUI 的 `input/vediofactory/`（以內容雜湊命名、`overwrite=false`，相同圖片會重用同一檔案）。ComfyUI 沒有刪除上傳圖片的 API，這些檔案需要時請手動清理。工作 manifest 只記錄工作流檔名與 SHA-256（`workflowName`、`workflowSha256`），不記錄絕對路徑。ComfyUI 回傳的 `.webm` 輸出會匯入 vedioFactory 的影片資料夾。其他輸出格式目前不會自動匯入。工作狀態會透過 ComfyUI history/queue 查詢，工作 manifest 保存在輸出資料夾下的 `inference-jobs/`。

預檢只靜態檢查 JSON 和節點名稱/設定提示，不會執行工作流，不能確認模型權重或 custom nodes 已安裝、模型/節點彼此相容、VRAM 足夠或實際輸出格式正確。仍需在本機 ComfyUI 實際生成驗證。

安全限制：目前只允許 HTTP 連線至 `localhost`、`127.0.0.1` 或 `::1`，不會將工作流或圖片送往第三方服務。尚未設定工作流時，預檢會回報未設定；介面仍可建立標示為 `scaffolded` 的工作，但不代表已執行模型。

## 照片 → 10 秒以上跳舞影片

**最快的啟動方式**：先啟動 ComfyUI，再在專案資料夾執行 `npm run start:dance`，然後用瀏覽器開啟 **http://127.0.0.1:8000** 。完成的影片會存在 `C:\Users\<使用者>\Videos\vedioFactory`。

只要一張本人的全身照片，就能在這台電腦上產生 11–13 秒、同一個人在跳舞的影片。流程分兩個階段，全部在本機顯示卡執行：

1. **第一階段：產生舞蹈動作**（Wan 2.2 TI2V-5B，`workflows/wan22-ti2v-5b-dance-10s.api.json`）：以照片為起始畫面，三段串接產生舞蹈動作影片。這一階段的臉孔會逐漸變得不像本人，所以只當作「動作來源」，不會放進影片庫（保留在輸出資料夾的 `pipeline-drafts/`）。
2. **第二階段：保持本人臉孔**（Wan Animate 2，`workflows/wan22-animate-dance.api.json`）：以原照片作為人物參考、第一階段影片作為動作來源重新繪製，讓整段影片都是照片中的本人。只有這一階段的影片會加入影片庫。

兩個階段之間若顯示卡溫度偏高，伺服器會等它降溫後自動繼續（預設最多等 20 分鐘）。

### 使用方式

伺服器同時設定兩個工作流後，網頁最上方會出現「照片 → 跳舞影片」區塊：

1. 選擇一張全身照片：全身入鏡（從頭到腳都在畫面內）、正面、臉部清楚、背景單純、畫面中只有一個人。
2. 影片長度只會列出目前設定可用的秒數（每秒 24 張畫面時為 11–13 秒，預設 12 秒）。
3. 解析度預設 544 × 960；更高的解析度可能超過 16 GB 顯示記憶體而失敗。
4. 「進階設定」可調整本人相似度（參考強度，0.5–2，預設 1.3）。
5. 按「開始產生跳舞影片」。在這台電腦（RTX 5070 Ti 16GB）上，544 × 960、12 秒約需：第一階段約 7 分鐘＋第二階段約 29 分鐘，另加降溫等待時間。

進度區會顯示目前階段、各階段狀態與耗時、顯示卡最高溫度／功耗／顯示記憶體用量，以及「顯示卡降溫中，會自動繼續」的等待狀態；失敗時顯示伺服器回報的原因。重新整理或關閉頁面不會中斷工作，回來後會自動恢復顯示（排隊中、產生中、降溫中的工作都會恢復）。排隊中、降溫中或兩個階段之間可以取消；某個階段已經開始產生時無法從網頁取消（避免中斷顯示卡上的全域運算），請等它完成。同一時間只能進行一個跳舞影片工作。

### 需要的模型（放在 ComfyUI 的 `models/` 對應資料夾）

| 檔案 | 放置資料夾 | 用於 | 來源 |
| --- | --- | --- | --- |
| `wan2.2_ti2v_5B_fp16.safetensors` | `diffusion_models/` | 第一階段 | [Comfy-Org/Wan_2.2_ComfyUI_Repackaged](https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged) |
| `wan2.2_vae.safetensors` | `vae/` | 第一階段 | 同上 |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | `text_encoders/` | 兩個階段 | [Comfy-Org/Wan_2.1_ComfyUI_repackaged](https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged) |
| `wan_animate_2_distill_int8_convrot.safetensors`（約 16.65 GB） | `diffusion_models/` | 第二階段 | [Comfy-Org/Wan-Animate-2](https://huggingface.co/Comfy-Org/Wan-Animate-2) |
| `clip_vision_h.safetensors` | `clip_vision/` | 第二階段 | Comfy-Org（Hugging Face） |
| `Wan2_1_VAE_bf16.safetensors` | `vae/` | 第二階段 | Comfy-Org（Hugging Face） |

以上權重皆標示為 Apache-2.0；商用前仍請查核各模型卡。兩個工作流都只使用 ComfyUI 內建節點。`models/loras` 內的 `DR34ML4Y_TI2V_5B_V1` 不得用於本流程。

### 環境變數

| 變數名 | 說明 |
| --- | --- |
| `VEDIO_FACTORY_COMFYUI_WORKFLOW` | 第一階段工作流（舞蹈動作）：`workflows\wan22-ti2v-5b-dance-10s.api.json` 的絕對路徑 |
| `VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW` | 第二階段工作流（保持本人臉孔）：`workflows\wan22-animate-dance.api.json` 的絕對路徑；設定後即開啟兩階段流程 |
| `VEDIO_FACTORY_GPU_COOLING_MINUTES` | 兩階段之間等待顯示卡降溫的上限分鐘數（預設 20） |
| `VEDIO_FACTORY_GPU_GUARD` | 顯示卡保護，預設開啟；`off` 只適用於沒有顯示卡的測試環境，正式產生影片時不可關閉 |

```powershell
$env:VEDIO_FACTORY_COMFYUI_WORKFLOW="$PWD\workflows\wan22-ti2v-5b-dance-10s.api.json"
$env:VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW="$PWD\workflows\wan22-animate-dance.api.json"
npm start
```

### 顯示卡安全（必讀）

長時間滿載曾造成顯示卡斷線（主因為散熱不足）。**每次重新開機後**，都要以系統管理員身分開啟 PowerShell 執行以下兩行（或執行 `powershell -ExecutionPolicy Bypass -File "C:\Users\User\Documents\vedioFactory\tools\gpu-safe-mode.ps1"`，請用完整路徑，因為系統管理員視窗預設在 C:\Windows\system32；預設即 250 瓦＋時脈上限 1900 MHz）：

```powershell
nvidia-smi -pl 250
nvidia-smi -lgc 210,1900
```

- 第一行把功耗上限設為 250 瓦，第二行把核心時脈上限設為 1900 MHz；重開機後會失效。
- 伺服器每個階段開始前都會檢查：功耗上限高於 250 瓦、溫度高於 65°C，或顯示卡正被其他工作使用時，會拒絕開始（兩階段之間則改為等待降溫）。
- 產生期間伺服器持續監看，溫度達 85°C、硬體降頻持續 3 秒或顯示卡斷線時會立即中斷 ComfyUI，工作標示為失敗並顯示原因。
- 每秒的溫度、功耗、時脈、降頻原因與顯示記憶體用量都記錄在 `logs/gpu/*.csv`；也可用 `npm run gpu:monitor` 獨立監看。
- 不要同時執行其他使用顯示卡的程式。

### 端對端產生與內容檢查

```powershell
npm run e2e:dance:full          # 用真正的 ComfyUI 與顯示卡，透過 vedioFactory API 跑完整兩階段，輸出 tests\fixtures\output\dance-full-e2e.webm
npm run test:dance:full         # 檢查上面那部影片的內容，報告寫到 visual-output\dance-full-e2e.report.json
npm run test:dance:selftest     # 檢查程式本身的自我測試（用人工製作的好／壞影片確認每一項檢查都會正確通過或失敗）
```

`e2e:dance:full` 可加 `-- --duration 13` 改長度（11–13 秒）；它拒絕在 `VEDIO_FACTORY_GPU_GUARD=off` 下執行，中斷（Ctrl+C）或逾時時會移除尚未開始的工作或中斷正在執行的階段。內容檢查需要 ffmpeg/ffprobe 與 `tests/requirements-qa.txt` 的套件（建議裝在 `.venv-qa`，只用處理器、不占用顯示卡），檢查項目：

1. **影片格式**：可以解碼、實際長度至少 10 秒、每秒畫面數合理、短邊至少 256 像素。
2. **畫面健康**：沒有全黑、過曝或空白畫面，沒有超過 0.5 秒的畫面凍結。
3. **人物存在**：九成以上取樣、且每一秒都偵測得到人體姿勢（肩、髖、四肢）。
4. **真的在跳舞**：每 2 秒都有以軀幹為基準的四肢動作，整體動作幅度足夠。
5. **同一個人**：第一張畫面與來源照片相符；衣服顏色與臉孔全程一致（臉部相似度中位數至少 0.55，最差的 2 秒區間至少 0.45；過短的結尾區間會併入前一段判定）。
6. **段落接縫**：相鄰畫面之間沒有異常的跳動。

全部通過時退出碼為 0，任一項失敗為 1，環境問題（缺檔案、ffmpeg 或套件）為 2。

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
