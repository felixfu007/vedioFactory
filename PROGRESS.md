# 進度紀錄

此檔記錄目前推進中的工作狀態，供中斷或 context 壓縮後接續。完整計畫見 `OPTIMIZATION_PLAN.md`。

## 已完成

### 第 5 項：可重現生成（分支 `feature/reproducible-generation`）

- 後端：`negativePrompt`、`seed`（未提供時隨機產生並記錄 `seedMode`）驗證與 `{{seed}}` 佔位符。
- 後端：工作 manifest 記錄 `workflowSha256`、`workflowPath`、`submittedWorkflow`、`comfyUIVersion`、`sourceImage`（依 SHA-256 保存於 `inference-jobs/sources/`）。
- 後端：來源圖片以內容雜湊命名上傳 ComfyUI，確保重跑時 prompt JSON 完全相同。
- 後端：`POST /api/inference/jobs/:id/rerun` 以工作流快照與原 seed 重新提交；工作流/ComfyUI 版本變更時回傳 `warnings`。
- 後端：匯入影片 metadata 帶 `seed`、`negativePrompt`、`videoModelId`、`workflowSha256`。
- 前端：負面提示詞、seed 模式/數值欄位；狀態列顯示實際 seed；影片卡顯示 seed；ComfyUI 影片「以相同設定重新產出」呼叫 rerun API。
- 測試：`npm run test:all` 通過；修正 Windows 路徑跳脫造成的既有測試失敗。
- 注意：執行 visual 測試前需 `npm ci` 安裝 puppeteer-core，並需本機 Chrome/Edge。

## 下一步

- 第 6 項：參數預設與客戶／專案管理（需先確認儲存位置與分組模型的決策）。
