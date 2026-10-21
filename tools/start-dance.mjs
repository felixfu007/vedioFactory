// One-command start for the photo -> dancing video pipeline (OPTIMIZATION_PLAN 6): sets both ComfyUI workflows
// unless already set, then starts the normal vedioFactory server.  npm run start:dance  ->  http://127.0.0.1:8000
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.VEDIO_FACTORY_COMFYUI_WORKFLOW ||= path.join(repoRoot, 'workflows', 'wan22-ti2v-5b-dance-10s.api.json');
process.env.VEDIO_FACTORY_COMFYUI_STAGE2_WORKFLOW ||= path.join(repoRoot, 'workflows', 'wan22-animate-dance.api.json');

const { startServer } = createRequire(import.meta.url)(path.join(repoRoot, 'server.js'));
const app = await startServer();
const { port } = app.server.address();
console.log(`照片 → 跳舞影片 網頁：http://127.0.0.1:${port}`);
console.log(`影片存放資料夾：${app.getOutputDir()}`);
