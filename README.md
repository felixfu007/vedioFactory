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

## Windows 11 使用方式

1. 上傳照片（可選）
2. 輸入提示詞或影片描述（至少填一項）
3. 選擇生成模組與影片參數
4. 直接使用預設後端輸出資料夾，或輸入新的絕對路徑（例如 `C:\Users\<你的帳號>\Videos\vedioFactory\Exports`）後按「套用後端資料夾」
5. 按下「生成影片」
6. 在下方管理區進行重新命名、剪輯輸出、刪除、重新產出等操作

## 環境變數

| 變數名 | 預設值 | 說明 |
| --- | --- | --- |
| `VEDIO_FACTORY_OUTPUT_DIR` | `%USERPROFILE%\Videos\vedioFactory` | 影片輸出資料夾 |
| `VEDIO_FACTORY_MODEL_DIR` | `%USERPROFILE%\vedioFactory\models` | 本機模型權重目錄 |
| `VEDIO_FACTORY_COMFYUI_URL` | `http://127.0.0.1:8188` | 本機 ComfyUI HTTP API（僅接受 localhost） |
| `VEDIO_FACTORY_COMFYUI_WORKFLOW` | 空值 | ComfyUI 匯出的 API 格式工作流 JSON 絕對路徑 |
| `HOST` | `127.0.0.1` | 服務綁定位址 |
| `PORT` | `8000` | 服務埠號 |

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
- `{{quality}}`、`{{motion}}`、`{{caption_strength}}`
- `{{source_image}}`

來源圖片會上傳到本機 ComfyUI；ComfyUI 回傳的 `.webm` 輸出會匯入 vedioFactory 的影片資料夾。其他輸出格式目前不會自動匯入。工作狀態會透過 ComfyUI history/queue 查詢，工作 manifest 保存在輸出資料夾下的 `inference-jobs/`。

安全限制：目前只允許 HTTP 連線至 `localhost`、`127.0.0.1` 或 `::1`，不會將工作流或圖片送往第三方服務。尚未設定工作流時，介面只會建立標示為 `scaffolded` 的工作，不代表已執行模型。

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
