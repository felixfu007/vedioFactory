# 優化計畫

## 執行順序

### 1. 前端媒體資源生命週期（已完成）

- [x] 重新整理或移除影片項目時撤銷不再使用的 Blob URL。
- [x] 影片生成或剪輯成功、失敗時都停止 MediaRecorder 的媒體軌道。
- [x] 既有 API 測試及瀏覽器視覺驗證通過。

### 2. 降低影片上傳的記憶體峰值

- [x] 將影片由 Base64 JSON 改為二進位串流傳輸，避免瀏覽器與伺服器同時保留多份影片副本。
- [x] 加入單檔大小限制、上傳暫存清理及中斷/超限回歸測試；保留既有 JSON API 相容性。
- [x] 驗收：一般影片可保存、讀取；超限或中斷請求不留下不完整影片項目。

### 3. 強化本機 API 的輸入與存取邊界

- 驗證影片 metadata、推論工作欄位及請求大小，避免錯誤資料寫入磁碟。
- 確認服務綁定非 localhost 時的使用情境，再決定是否加入存取控制；預設維持 localhost 綁定。
- 驗收：非法輸入被明確拒絕，既有管理 API 行為保持相容。

### 4. 接入真正的本機 GPU 推論（ComfyUI）

- [x] 選定 ComfyUI 工作流 API，採 localhost-only 連線。
- [x] 以環境變數設定 ComfyUI API 端點與匯出的 API 工作流 JSON。
- [x] 支援提示詞/影片參數佔位符、可選來源圖片上傳、排程/狀態追蹤及 WebM 匯入。
- [x] 建立 10 個本機影片模型建議目錄，顯示工作類型/顯存注意事項/官方連結，並將選擇的模型 ID 傳入工作流。
- [x] 允許從 ComfyUI 待執行佇列取消工作；避免使用會中斷全域執行的 interrupt。
- [x] 從後端持久化工作清單恢復最新待執行/執行中 ComfyUI 工作的前端狀態追蹤。
- [x] 附 Wan 2.2 I2V API 工作流（`workflows/`，內建節點 + SaveWEBM），新增 `{{frames}}`/`{{steps}}`/`{{seed}}` 佔位符與低解析度選項。
- [x] 預檢加入 ComfyUI `/object_info` 即時檢查（缺節點/缺模型檔），失敗工作（`status_str: error`）正確標記為 failed 並記錄錯誤與執行秒數。
- [x] 兩份工作流已通過本機 ComfyUI 0.39.0 的節點與 `/prompt` 驗證，唯一錯誤是尚未下載的權重檔。
- [ ] 下載 Wan 2.2 TI2V-5B 權重後，依實際選定的模型工作流完成 Windows 11 / RTX 5070 Ti 端對端驗收（記錄 VRAM、耗時與可用參數）。

### 5. 擴充測試並整理前端邊界

- 對新增的儲存與推論流程補充失敗、競態、大檔及資源釋放測試。
- 在有測試保護後，逐步拆分前端影片生成、資料儲存及影片庫邏輯。

## 待辦

請匯出要使用的 ComfyUI API 工作流，設定 `VEDIO_FACTORY_COMFYUI_WORKFLOW`，並確認其中使用上述佔位符與 WebM 輸出節點。端對端的 GPU、VRAM 與模型品質驗證需要在安裝好 ComfyUI/模型的 Windows 11 主機上執行。

### 6. 目標：一張真人照片 → 10 秒以上真人跳舞影片（**已達成 2026-10-19**）

環境：ComfyUI 0.39.0 @127.0.0.1:8188（`--cache-none`）、RTX 5070 Ti 16GB；已有 `wan2.2_ti2v_5B_fp16`、`umt5_xxl_fp8_e4m3fn_scaled`、`wan2.2_vae`。
注意：`models/loras` 內的 `DR34ML4Y_TI2V_5B_V1` 不得用於本流程。

- [x] 6.1 測試用照片：以本機 realisticVision 生成合成（非真實人物）全身寫實人像 `tests/fixtures/dance-source.png`。（ai-inference-engineer）
- [x] 6.2 單段基準：TI2V-5B I2V 121 幀 @24fps 的解析度/步數/耗時/VRAM 量測。（ai-inference-engineer）
  - 結果：544x960/20 步/121 幀約 211 s、整卡峰值 14.7 GB（ComfyUI 約 10–11 GB）；480x832 約 142 s。問題：單段內約第 60 幀起出現身分漂移（髮色/口紅改變），快速動作臉部模糊。
- [x] 6.3 ≥10 秒工作流：`workflows/wan22-ti2v-5b-dance-10s.api.json`，單一 prompt 內以「上一段末幀 → 下一段起始圖」串接多段，輸出單一 WebM ≥ 241 幀 @24fps。（ai-inference-engineer）
  - 已寫好 3 段串接工作流（每段 {{frames}}，總幀 3×frames−2；5 秒→361 幀=15 s），段 2/3 種子用 ComfyMathExpression seed+1/+2（尚未經真實 ComfyUI 驗證）；假 ComfyUI 測試通過。**2026-10-17 17:53 GPU 掉卡（nvidia-smi: GPU is lost），需重開機**，端對端尚未執行。
- [x] 6.4 內容驗證腳本：`tests/dance-video-verify.*`，檢查時長 ≥10s、無黑幀/凍結、各時段皆偵測到人體姿態、肢體有持續舞動、首幀與來源照片相符、段落接縫無跳變；輸出 JSON 報告與退出碼。（qa-engineer）
  - 完成：`tests/dance-video-verify.py`（mediapipe 姿態/臉部，CPU）、自測 `npm run test:dance:selftest` 12/12 控制組符合預期；`npm run test:dance` 驗 `tests/fixtures/output/dance-e2e.webm`。門檻尚待真實 Wan 輸出校正。
- [ ] 6.5 端對端：透過 vedioFactory API 以該工作流出片，並通過 6.4 驗證。
- [x] 6.6 前後端：介面提供「照片 → 跳舞影片（10 秒）」預設，README 更新。

#### 6.x 待辦（掉卡後）
- 重開機後：確認 ComfyUI 正常 → 以 `tests/run-dance-e2e.mjs` 透過 vedioFactory API 出片 → `npm run test:dance`。
- 掉卡當時另有非本專案 GPU 工作（C:\Users\User\SD\...\multi_identity_swap.py）同時執行，出片時應避免並行。
- [x] server.js：支援 544x960/704x1280；工作流節點 `_meta.vediofactory.segments` 宣告段數，duration=總長、frames 上限按每段計算（24fps 最長 15 s）；`/api/inference/runtime` 回傳 `comfyUI.workflowSegments`；`npm run e2e:dance`（tests/run-dance-e2e.mjs）完成。重開機後 GPU 已恢復（2026-10-18）。
- 若串接後身分漂移過大：考慮每段都以原照片為錨點，或改用 Wan 2.2 Animate／VACE + 姿態參考。
- [x] 驗證腳本加入臉部身分（YuNet+SFace，餘弦中位數 ≥0.55、最差 2 s 視窗 ≥0.45）；TI2V-5B 單段 bench 544x960 中位數僅 0.18 → **TI2V-5B 無法維持身分**，自測 14/14。
- [x] 6.7 兩階段架構（研究完成，ai-inference-engineer）：階段 1 TI2V-5B 串接產生舞蹈動作 → 階段 2 Wan 2.2 Animate 以原照片為角色參考、由階段 1 影片抽姿態驅動重繪，輸出 `workflows/wan22-animate-dance.api.json`；之後 server.js 需支援兩階段/驅動影片佔位符。
- **2026-10-18 第二次掉卡**：e2e（3×97 幀、544x960、單獨執行）約 4.5 分鐘、100% 滿載、VRAM 峰值 14.6 GB 時 GPU is lost，畫面消失但主機未當機；事件檢視器無 nvlddmkm/WHEA 紀錄 → 判斷為長時間滿載下的電源瞬態／硬體或驅動不穩，非並行工作造成。
- [x] GPU 防護：`tools/gpu-guard.mjs`（每秒 fsync 記錄溫度/功耗/瞬時功耗/時脈/降頻原因/VRAM 到 `logs/gpu/*.csv`；溫度 ≥85°C 或硬體降頻連續 3 秒即中斷 ComfyUI；`npm run gpu:monitor` 可獨立監看）；`tools/gpu-safe-mode.ps1`（系統管理員執行：功耗 250 W、核心時脈上限 2400 MHz，重開機後失效需重跑）；`npm run e2e:dance` 預檢：功耗上限 >250 W、溫度 >65°C、或 GPU 被其他工作占用時拒絕啟動。
- 下一步：使用者以系統管理員執行 `tools/gpu-safe-mode.ps1` → 重跑 `npm run e2e:dance` → 若仍掉卡，檢查 logs/gpu 最後幾秒數據並排查電源/線材/驅動。之後恢復 6.7（Wan Animate 研究被重開機中斷，需 resume，且必須在 gpu-guard 下執行）。
- **2026-10-18 第一部完整影片**：降功耗 250 W + 時脈上限 1900 MHz（`nvidia-smi -lgc 210,1900`）後，最高 75°C、約 180 W、無降頻，3×97 幀 = 12.04 s，ComfyUI 439 s。上一次只限 250 W 時 4.3 分鐘達 85°C 被保護中斷 → **掉卡主因是散熱不足**（已建議使用者清灰塵／調風扇曲線）。
  - `npm run test:dance`：容器、畫面健康、人物、舞動、接縫全部通過；**唯一失敗是臉部身分**（每秒中位數 0.62→0.17–0.36，最差視窗 0.19），髮色後段偏紅。→ 進行 6.7 兩階段（Wan Animate）。
- **2026-10-19 兩階段成功**：Wan Animate 2（`Comfy-Org/Wan-Animate-2`，Apache-2.0；`wan_animate_2_distill_int8_convrot` 16.65 GB、`clip_vision_h`、`Wan2_1_VAE_bf16`），全部核心節點，直接吃原始驅動影片（不需姿態抽取）。`workflows/wan22-animate-dance.api.json`（4 段 × 73 幀，新佔位符 `{{driving_video}}`、`{{reference_strength}}`）、`tests/run-dance-animate-e2e.mjs`。
  - 544x960、參考強度 1.3、10 步：1754 s、71°C、139 W、VRAM 13.7 GB。臉部中位數 **0.628**（第一階段 0.18–0.37），其他全通過；唯一失敗為最後 0.04 s 僅 1 張臉的尾端視窗（0.345），完整視窗皆 ≥0.51。目視：全程同一人、髮色穩定；約第 11 秒甩頭時頭髮整片蓋住臉（來自第一階段動作）。
- [x] 6.8 驗證腳本：過短/臉數過少的尾端視窗不單獨判定（qa-engineer）。
  - 完成：尾端不足 2 s 併入前一視窗、樣本 <3 的視窗併入相鄰視窗，門檻未調降；自測 15/15。兩階段輸出 `dance-animate-e2e.webm` **全部通過**（臉部中位數 0.628、最差視窗 0.503）；第一階段輸出仍不通過（0.375）。
- [x] 6.9 server.js 兩階段工作（第一階段 TI2V → 上傳驅動影片 → 第二階段 Animate，只匯入最終影片，全程 GPU 預檢＋防護）（backend-engineer）。
- [x] 6.10 第一階段舞蹈提示詞避免甩頭/甩髮（已改提示詞與負面詞，待實跑驗證），之後以 6.9 完整端對端重跑並通過 `npm run test:dance`。
- [x] 6.6 前端「照片 → 跳舞影片」預設 + README。
- 6.9 完成（2026-10-19）：`VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW` 開啟兩階段；每階段 GPU 預檢、階段間 `cooling` 等待（預設 20 分）、執行中防護；只匯入第二階段；24fps 允許 11–13 秒（241 幀未實測故 10 秒暫不開放）；`npm run e2e:dance:full` → `npm run test:dance:full`。
  - 待辦：前端 cooling 狀態恢復/顯示 stageLabel/取消按鈕；Docker 沒有 tools/ 與 nvidia-smi；README。
- 6.6 完成（2026-10-19）：網頁「照片 → 跳舞影片」區塊、兩階段進度卡、降溫狀態、重新整理後恢復追蹤、README 中文說明；`npm run test:all` 通過。
- **2026-10-19 完整兩階段實跑（npm run e2e:dance:full）**：第一階段 437 s（75°C/180 W），第二階段 1508 s（71°C/140 W），全程無過熱。
  - 發現並修正 bug：第二階段 ComfyUI history 會把 LoadVideo 的輸入預覽（type "input"＝第一階段草稿）列為輸出，伺服器因此匯入兩支影片且第一支是草稿 → `findComfyWebmOutputs` 排除 type "input"。（待補回歸測試）
  - 真正的第二階段影片（visual-output/dance-full-e2e-library/comfyui-d4f168e0-2.webm）：臉部中位數 **0.646**、最差視窗 0.583（新提示詞後提升；目視全程臉朝鏡頭、無頭髮遮臉）。唯一失敗：首幀與照片的整張像素比對 NCC 0.839 < 0.85，原因是第二階段把人物重新置中（照片中人物偏左），姿勢/衣著/人相同。
  - 待辦：驗證腳本首幀比對改為以人物位置對齊後比較（qa）；重跑 e2e:dance:full 確認只匯入一支影片且全通過。
- **2026-10-19 目標達成**：首幀比對改為依人物姿態對齊後於 96 px 比較（門檻不變；同人重構圖 ≥0.797、不同人 ≤0.629）。最終驗收 `npm run e2e:dance:full -- --seed 20261019`：第一階段 432 s（75°C/181 W）、第二階段 1507 s（71°C/140 W），只匯入 1 支影片，12.04 s；`npm run test:dance:full` **六項全通過**（臉部中位數 0.637、最差視窗 0.570、首幀 SSIM 0.934/NCC 0.978）。`npm run test:all` 通過；`npm run test:dance:selftest` 17 個合成控制組＋2 個真實控制組（完整流程須通過、僅第一階段須只在身分失敗）全部符合預期。
- 後續可做（非必要）：10 秒（241 幀）第二階段實測後開放；Docker 映像加入 tools/ 與停用 GPU 防護設定；資安審查新增的上傳/驅動影片路徑；用使用者自己的真人照片實測（需全身、正面）。

### 7. 通用版：照片＋任意提示詞 → 10 秒以上本人影片（2026-10-20 起，使用者已同意）
流程：① 身分保持的修圖模型產生「本人在提示詞場景中的第一張畫面」→ ② TI2V-5B 依提示詞串接成 ≥10 s → ③ Wan Animate 2 保持本人臉孔。跳舞成為其中一個範例。
**內容政策**：只做適合一般觀眾、服裝完整的內容；使用者要求成人內容已拒絕（真人照片＋本人臉孔＝可被用於非自願私密影像）。不得使用 models/loras 的 DR34ML4Y LoRA，不下載任何 NSFW 模型。
- [ ] 7.1 可行性研究＋示範：「騎馬」「走路」兩支示範影片（ai-inference-engineer）。
- [ ] 7.2 server/前端：網頁改為「照片＋想要的內容」，動作範例選單。
- [ ] 7.3 驗證：通用檢查＋畫面內容符合提示詞（例如真的有馬）。
- 7.x 內容政策落實：兩階段（保留真人臉孔）流程拒絕任何 LoRA（server.js 建立工作時檢查＋回歸測試）。
