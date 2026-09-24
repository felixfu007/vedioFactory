# vedioFactory

本機優先的 AI 影片生成服務網站，支援：

- 匯入照片 + 提示詞，或直接輸入影片描述生成影片
- 可切換 / 擴充生成模組，快速輸出不同風格
- 可調整影片長度、FPS、解析度、品質與運鏡強度
- 可把輸出直接保存到本機指定資料夾（支援瀏覽器資料夾授權時）
- 內建影片管理：下載、重新命名、剪輯輸出、刪除、重新產出

## 快速啟動

```bash
cd /home/runner/work/vedioFactory/vedioFactory
python3 -m http.server 8000
```

然後開啟 `http://localhost:8000`。

> 建議使用 Chromium / Edge / Chrome，在 localhost 環境下可使用 File System Access API 直接把影片寫入指定資料夾；若瀏覽器不支援，系統會退回成下載模式。

## 使用方式

1. 上傳照片（可選）
2. 輸入提示詞或影片描述（至少填一項）
3. 選擇生成模組與影片參數
4. 視需要選擇本機輸出資料夾
5. 按下「生成影片」
6. 在下方管理區進行重新命名、剪輯輸出、刪除、重新產出等操作

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

若已授權資料夾，系統會在指定資料夾中保存：

- `*.webm`：生成後的影片檔
- `*.webm.json`：對應的影片設定與來源資訊，供重新整理、重新產出與管理功能使用
