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
- Node.js 22 LTS 或更新
- Chrome 或 Edge（用於最佳 WebM / MediaRecorder 相容性）

### 本機 NVIDIA / CUDA 建議環境

- NVIDIA 顯示卡（你的目標機器可用 RTX 5070 Ti）
- 最新版 NVIDIA Driver
- CUDA Toolkit 12.x
- Python 3.11（未來接本機推論命令時建議）

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
| `VEDIO_FACTORY_LOCAL_ENGINE_COMMAND` | 空值 | 未來本機推論入口命令 |
| `VEDIO_FACTORY_LOCAL_ENGINE_ARGS` | 空值 | 推論命令參數 |
| `HOST` | `127.0.0.1` | 服務綁定位址 |
| `PORT` | `8000` | 服務埠號 |

### PowerShell 範例

```powershell
$env:VEDIO_FACTORY_OUTPUT_DIR="C:\AI\vedioFactory\output"
$env:VEDIO_FACTORY_MODEL_DIR="C:\AI\vedioFactory\models"
$env:VEDIO_FACTORY_LOCAL_ENGINE_COMMAND="python"
$env:VEDIO_FACTORY_LOCAL_ENGINE_ARGS=".\local-ai\run_inference.py --device cuda"
npm start
```

## 本機 NVIDIA / CUDA 推論骨架

目前已加入一個「骨架版」本機推論流程，目的不是直接完成真實模型推論，而是先把未來要接本機顯卡的結構準備好。

目前可用能力：

- 後端會提供 `/api/inference/runtime`
- 會檢查 `nvidia-smi` 是否可用
- 會回報目前平台、模型目錄、推論命令是否已設定
- 前端介面會顯示「本機 NVIDIA / CUDA 推論骨架」狀態
- 你可以直接從介面建立一筆「本機推論工作」
- 後端會把推論工作 manifest 寫到輸出資料夾下的 `inference-jobs/`

這代表之後要接真正模型時，只需要把：

- `VEDIO_FACTORY_LOCAL_ENGINE_COMMAND`
- `VEDIO_FACTORY_LOCAL_ENGINE_ARGS`
- 模型權重目錄

接到你自己的本機推論程式即可，不需要改成第三方 API。

## 驗證與測試

安裝測試依賴後可直接跑實際瀏覽器驗證：

```powershell
cd C:\path\to\vedioFactory
npm install
npm run test:api
npm run test:visual
```

此流程會：

- 啟動本機後端服務
- 用 Chromium 實際生成影片
- 輸出頁面截圖與影片中段畫面截圖到 `visual-output/`
- 將影片實際畫面與同設定下的參考畫面做相似度比對，確認生成內容與提示詞/描述一致

`npm run test:api` 會額外驗證：

- 後端輸出資料夾設定
- 影片保存 / 列表
- 重新命名
- 檔案讀取
- 刪除
- 本機推論 runtime API
- 本機推論工作 manifest 建立

## 常見問題

### 1. 為什麼畫面顯示「尚未偵測到 nvidia-smi」？

代表目前執行環境找不到 NVIDIA 工具鏈。請確認：

- 已安裝 NVIDIA Driver
- `nvidia-smi` 可在 PowerShell 直接執行
- 若有安裝 CUDA，相關路徑已加入 PATH

### 2. 為什麼現在還不是真的 AI 模型出片？

目前做的是 **本機 CUDA 推論骨架**，先把：

- Windows 11 路徑
- 本機 GPU 偵測
- 本機推論工作管理
- 前後端整合介面

準備好。下一步才是把你的實際模型流程接進來。

### 3. 如果我要換模型怎麼做？

保持現在的後端與前端不變，改你的：

- 本機推論命令
- 模型目錄
- 命令列參數

即可。

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
