# 場景模組

每個子資料夾就是一個場景模組（例如 `dance`、`runway`、`gym`）。把新的資料夾放進來、重新整理網頁，就會出現新的影片類型，不需要修改程式或重新啟動。

```
modules/
  dance/
    module.json     ← 必要：模組說明、預設、工作流設定
    preview.js      ← 選用：Canvas 預覽動畫（不需要 GPU）
    workflow.json   ← 選用：ComfyUI API 格式工作流（用 GPU 產生 AI 影片）
```

- 資料夾名稱只能用小寫英數字與 `-`，且必須和 `module.json` 的 `id` 相同。
- 以 `_` 或 `.` 開頭的資料夾不會被當成模組。
- 有錯誤的模組仍會列在 `GET /api/scenario-modules`，並附上錯誤原因，但不會載入。

## module.json

```json
{
  "schemaVersion": 1,
  "id": "dance",
  "name": "跳舞影片",
  "description": "畫面上顯示的說明",
  "version": "1.0.0",
  "tags": ["人物", "舞蹈"],
  "canvas": { "entry": "preview.js", "tagline": "一句話介紹", "bestFor": "適合用途" },
  "workflow": {
    "file": "workflow.json",
    "videoModelIds": ["wan-2.2-ti2v-5b"],
    "resolutions": ["1280x704", "704x1280"],
    "resolutionMultiple": 32,
    "fps": [24],
    "minDuration": 2,
    "maxDuration": 5,
    "defaults": { "resolution": "1280x704", "fps": 24, "duration": 5 }
  },
  "preset": {
    "promptTemplate": "一位{dancer}在{stage}上跳{style}……",
    "storyTemplate": "……",
    "negativePrompt": "……",
    "videoModelId": "wan-2.2-ti2v-5b",
    "seedMode": "random",
    "settings": { "resolution": "1280x704", "fps": 24, "duration": 5, "quality": "premium", "motion": 60, "captionStrength": 40 }
  },
  "example": { "variables": { "dancer": "年輕舞者", "stage": "霓虹舞台", "style": "街舞" }, "seed": 20261023 },
  "safety": { "requiresPersonConsent": true, "notes": "使用真人照片前需取得本人同意。" }
}
```

- `workflow` 的欄位和 `workflows/*.vf.json` 相同（見根目錄 README「多工作流與參數規格」）。工作流會以 `module-<id>` 出現在工作流選單。
- `preset` 會以「［場景模組］」內建預設出現在預設清單，不可修改或刪除，但可以套用後另存為自己的預設。
- `example.variables` 會預先填入預設的 `{變數}` 欄位；`tools/generate-examples.mjs` 也會用它和 `example.seed` 產生範例影片。
- `safety.requiresPersonConsent` 為 `true` 時，使用者若加入照片送出 ComfyUI 工作，網頁會先要求確認已取得照片人物同意；後端也會要求請求帶 `personConsent: true`，並把確認時間記錄在工作記錄（`personConsent.confirmedAt`）與交付 manifest 中。
- 要用照片當第一格的模組，工作流用 `LoadImage` 載入 `{{source_image}}`，接到 `Wan22ImageToVideoLatent` 的 `start_image`，並在 `workflow` 設定 `"requiresSourceImage": true`；範例見 `modules/photo-person`。

## 細節欄位（fields）

`module.json` 的 `fields` 讓預設的 `{變數}` 以下拉選單或文字框呈現：

```json
"fields": [
  { "use": "camera", "default": "遠景全身" },
  { "use": "outfit" },
  { "name": "danceStyle", "label": "舞風", "type": "select", "options": ["街舞", "爵士舞"], "default": "街舞" },
  { "name": "scene", "label": "場景", "type": "text", "default": "霓虹燈光的舞台", "help": "寫得越具體越好" }
]
```

- `name` 對應提示詞範本裡的 `{name}`；`type` 為 `select`（下拉選單，另附「自訂…」）或 `text`（文字框）。
- `use` 會先帶入 `modules/_shared/fields.json` 的共用欄位（camera、angle、movement、person、outfit、expression、lighting、style），其餘欄位可覆寫，例如改 `label`、`options`、`default`。
- 最多 20 個欄位；`options` 最多 30 個、每個 100 字以內。欄位顯示順序依 `fields` 排列。

## preview.js（Canvas 預覽）

瀏覽器以 ES module 載入，必須匯出 `renderFrame`，每一格畫面都會呼叫一次：

```js
import { drawFigure, placeOnFloor, beat } from '/assets/scenario-kit.js';

export function renderFrame({ ctx, canvas, progress, image, spec, fitImage, drawCaptionBlock }) {
  // progress：0–1 的影片進度；spec.duration 秒數、spec.motion 運鏡強度、spec.prompt 提示詞
  // image：使用者上傳的照片（沒有則為 null）
}
```

`/assets/scenario-kit.js` 提供人形骨架（`solvePose`、`drawFigure`、`placeOnFloor`）、節拍（`beat`）、緩動（`easeInOutSine`）、可重現亂數（`seededRandom`）與標題列（`drawTitleBar`）等工具，可參考 `dance/preview.js`。

## workflow.json（ComfyUI）

ComfyUI 匯出的 **API 格式** JSON，可使用 `{{prompt}}`、`{{negative_prompt}}`、`{{seed}}`、`{{width}}`、`{{height}}`、`{{fps}}`、`{{frames}}`（Wan 系列需要的 4n+1 幀數）等佔位符。三個內建模組使用本機的 Wan 2.2 TI2V 5B 文生影片，**不載入任何 LoRA**，負面提示詞也排除裸露與色情內容。
