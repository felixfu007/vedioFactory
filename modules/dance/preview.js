// 跳舞影片的 Canvas 預覽：舞者隨 118 BPM 節拍切換舞步，舞台燈光同步變色。
import {
  TAU,
  beat,
  drawFigure,
  drawFloorShadow,
  drawTitleBar,
  easeInOutSine,
  lerp,
  placeOnFloor,
} from '/assets/scenario-kit.js';

const BPM = 118;

// 每一拍的關鍵姿勢；相鄰兩拍之間平滑過渡。
const MOVES = [
  { torso: -0.08, arms: { left: { upper: -2.7, lower: 0.2 }, right: { upper: 2.7, lower: -0.2 } }, legs: { left: { upper: -0.35, lower: 0.15 }, right: { upper: 0.35, lower: -0.15 } } },
  { torso: 0.1, arms: { left: { upper: -1.6, lower: -0.6 }, right: { upper: 1.6, lower: 0.6 } }, legs: { left: { upper: -0.55, lower: 0.9 }, right: { upper: 0.55, lower: -0.9 } } },
  { torso: 0.18, arms: { left: { upper: -0.4, lower: -1.2 }, right: { upper: 2.9, lower: 0 } }, legs: { left: { upper: -0.15, lower: 0.1 }, right: { upper: 0.75, lower: -0.5 } } },
  { torso: -0.18, arms: { left: { upper: -2.9, lower: 0 }, right: { upper: 0.4, lower: 1.2 } }, legs: { left: { upper: -0.75, lower: 0.5 }, right: { upper: 0.15, lower: -0.1 } } },
  { torso: 0, arms: { left: { upper: -1.2, lower: 1.9 }, right: { upper: 1.2, lower: -1.9 } }, legs: { left: { upper: -0.45, lower: 0.95 }, right: { upper: 0.45, lower: -0.95 } } },
  { torso: 0.05, arms: { left: { upper: -2.2, lower: -0.9 }, right: { upper: 2.2, lower: 0.9 } }, legs: { left: { upper: -0.3, lower: 0.05 }, right: { upper: 0.3, lower: -0.05 } } },
];

function blendLimb(from, to, amount) {
  return { upper: lerp(from.upper, to.upper, amount), lower: lerp(from.lower, to.lower, amount) };
}

function blendMoves(from, to, amount) {
  return {
    torso: lerp(from.torso, to.torso, amount),
    arms: { left: blendLimb(from.arms.left, to.arms.left, amount), right: blendLimb(from.arms.right, to.arms.right, amount) },
    legs: { left: blendLimb(from.legs.left, to.legs.left, amount), right: blendLimb(from.legs.right, to.legs.right, amount) },
  };
}

function drawStage(ctx, canvas, seconds, pulse, beatIndex) {
  const { width, height } = canvas;
  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, '#0b0620');
  background.addColorStop(0.65, '#1a0d3a');
  background.addColorStop(1, '#05030c');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // 三盞會擺動的聚光燈，顏色每拍輪替。
  const hues = [320, 200, 45];
  hues.forEach((baseHue, index) => {
    const hue = (baseHue + beatIndex * 40) % 360;
    const originX = width * (0.2 + index * 0.3);
    const swing = Math.sin(seconds * 1.4 + index * 2) * width * 0.18;
    const gradient = ctx.createLinearGradient(originX, 0, originX + swing, height * 0.85);
    gradient.addColorStop(0, `hsla(${hue}, 100%, 65%, ${0.35 + pulse * 0.3})`);
    gradient.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.moveTo(originX - width * 0.02, 0);
    ctx.lineTo(originX + width * 0.02, 0);
    ctx.lineTo(originX + swing + width * 0.14, height * 0.85);
    ctx.lineTo(originX + swing - width * 0.14, height * 0.85);
    ctx.closePath();
    ctx.fill();
  });

  // 舞台地板與節拍光圈。
  const floorY = height * 0.86;
  ctx.fillStyle = '#120a24';
  ctx.fillRect(0, floorY, width, height - floorY);
  ctx.strokeStyle = `rgba(255, 120, 220, ${0.25 + pulse * 0.5})`;
  ctx.lineWidth = Math.max(2, height * 0.006);
  ctx.beginPath();
  ctx.ellipse(width / 2, floorY + height * 0.02, width * (0.16 + pulse * 0.05), height * 0.035, 0, 0, TAU);
  ctx.stroke();
  return floorY;
}

export function renderFrame({ ctx, canvas, progress, image, spec, fitImage }) {
  const seconds = progress * spec.duration;
  const { index, phase, pulse } = beat(seconds, BPM);
  const floorY = drawStage(ctx, canvas, seconds, pulse, index);

  if (image) {
    const frame = fitImage(image, canvas, 0.05);
    ctx.globalAlpha = 0.18;
    ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height);
    ctx.globalAlpha = 1;
  }

  const motion = 0.6 + (spec.motion / 100) * 0.6;
  const move = blendMoves(MOVES[index % MOVES.length], MOVES[(index + 1) % MOVES.length], easeInOutSine(phase * 1.6));
  const figureHeight = canvas.height * 0.62;
  const sway = Math.sin(seconds * Math.PI * (BPM / 60)) * canvas.width * 0.025 * motion;
  const pose = placeOnFloor({
    x: canvas.width / 2 + sway,
    height: figureHeight,
    torso: move.torso * motion,
    head: -move.torso * 0.5,
    arms: move.arms,
    legs: move.legs,
  }, floorY);
  pose.y -= pulse * figureHeight * 0.03 * motion; // 每拍的小跳躍

  drawFloorShadow(ctx, pose.x, floorY, figureHeight * 0.22);
  drawFigure(ctx, pose, { top: '#f5f5f7', bottom: '#14141c', skin: '#e8b98f', shoes: '#ff4fa3' });
  drawTitleBar(ctx, canvas, '跳舞影片', (spec.prompt || spec.story || '').slice(0, 36));
}
