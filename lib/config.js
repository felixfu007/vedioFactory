const os = require('node:os');
const path = require('node:path');

const ROOT_DIR = path.join(__dirname, '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8000);
const DEFAULT_OUTPUT_DIR = path.resolve(
  process.env.VEDIO_FACTORY_OUTPUT_DIR || path.join(os.homedir(), 'Videos', 'vedioFactory'),
);
const DEFAULT_MODEL_DIR = path.resolve(
  process.env.VEDIO_FACTORY_MODEL_DIR || path.join(os.homedir(), 'vedioFactory', 'models'),
);
const DEFAULT_DATA_DIR = path.resolve(
  process.env.VEDIO_FACTORY_DATA_DIR || path.join(os.homedir(), 'vedioFactory'),
);
const DEFAULT_WORKFLOWS_DIR = path.resolve(process.env.VEDIO_FACTORY_WORKFLOWS_DIR || path.join(ROOT_DIR, 'workflows'));
const DEFAULT_MODULES_DIR = path.resolve(process.env.VEDIO_FACTORY_MODULES_DIR || path.join(ROOT_DIR, 'modules'));
const DEFAULT_FFMPEG_COMMAND = [process.env.VEDIO_FACTORY_FFMPEG || 'ffmpeg'];
// 推論工作、模型安裝批次與交付都放在輸出資料夾內的子資料夾。
const INFERENCE_JOBS_DIR_NAME = 'inference-jobs';
const MODEL_SETUP_DIR_NAME = 'model-setup';
const SOURCE_IMAGES_DIR_NAME = 'sources';
const DELIVERIES_DIR_NAME = 'deliveries';
const PRESETS_DIR_NAME = 'presets';

module.exports = {
  ROOT_DIR,
  HOST,
  PORT,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_MODEL_DIR,
  DEFAULT_DATA_DIR,
  DEFAULT_WORKFLOWS_DIR,
  DEFAULT_MODULES_DIR,
  DEFAULT_FFMPEG_COMMAND,
  INFERENCE_JOBS_DIR_NAME,
  MODEL_SETUP_DIR_NAME,
  SOURCE_IMAGES_DIR_NAME,
  DELIVERIES_DIR_NAME,
  PRESETS_DIR_NAME,
};
