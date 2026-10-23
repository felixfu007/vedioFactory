// 走秀影片的 Canvas 預覽：模特兒沿著透視伸展台走向鏡頭，兩側觀眾閃光燈此起彼落。
import {
  TAU,
  clamp,
  drawFigure,
  drawFloorShadow,
  drawTitleBar,
  easeInOutSine,
  lerp,
  placeOnFloor,
  seededRandom,
} from '/assets/scenario-kit.js';

const STEPS_PER_SECOND = 1.8;

function drawVenue(ctx, canvas, horizonY) {
  const { width, height } = canvas;
  const background = ctx.createLinearGradient(0, 0, 0, height);
  background.addColorStop(0, '#050507');
  background.addColorStop(0.4, '#15151c');
  background.addColorStop(1, '#08080b');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  // 背板與聚光燈光暈。
  const glow = ctx.createRadialGradient(width / 2, horizonY, 0, width / 2, horizonY, width * 0.7);
  glow.addColorStop(0, 'rgba(255, 244, 220, 0.45)');
  glow.addColorStop(1, 'rgba(255, 244, 220, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  // 透視伸展台：遠端窄、近端寬。
  const farHalf = width * 0.05;
  const nearHalf = width * 0.42;
  const runway = ctx.createLinearGradient(0, horizonY, 0, height);
  runway.addColorStop(0, '#d9d4cc');
  runway.addColorStop(1, '#f7f4ef');
  ctx.fillStyle = runway;
  ctx.beginPath();
  ctx.moveTo(width / 2 - farHalf, horizonY);
  ctx.lineTo(width / 2 + farHalf, horizonY);
  ctx.lineTo(width / 2 + nearHalf, height);
  ctx.lineTo(width / 2 - nearHalf, height);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = Math.max(2, width * 0.004);
  ctx.stroke();
}

function drawAudience(ctx, canvas, horizonY, seconds, seed) {
  const { width, height } = canvas;
  const random = seededRandom(seed);
  const flashRandom = seededRandom(seed + Math.floor(seconds * 8));
  for (let row = 0; row < 6; row += 1) {
    const depth = row / 5;
    const y = lerp(horizonY + height * 0.02, height * 0.95, depth);
    const size = lerp(width * 0.012, width * 0.05, depth);
    const edge = lerp(width * 0.06, width * 0.43, depth);
    for (const side of [-1, 1]) {
      for (let seat = 0; seat < 3; seat += 1) {
        const x = width / 2 + side * (edge + size * 1.4 * (seat + 0.6) + random() * size * 0.4);
        ctx.fillStyle = '#1e1e26';
        ctx.beginPath();
        ctx.arc(x, y - size * 1.6, size * 0.55, 0, TAU);
        ctx.fill();
        ctx.fillRect(x - size * 0.7, y - size * 1.1, size * 1.4, size * 1.2);
        if (flashRandom() > 0.93) {
          const flash = ctx.createRadialGradient(x, y - size * 1.4, 0, x, y - size * 1.4, size * 3);
          flash.addColorStop(0, 'rgba(255, 255, 255, 0.95)');
          flash.addColorStop(1, 'rgba(255, 255, 255, 0)');
          ctx.fillStyle = flash;
          ctx.fillRect(x - size * 3, y - size * 4.4, size * 6, size * 6);
        }
      }
    }
  }
}

export function renderFrame({ ctx, canvas, progress, image, spec, fitImage }) {
  const seconds = progress * spec.duration;
  const horizonY = canvas.height * 0.36;
  drawVenue(ctx, canvas, horizonY);

  if (image) {
    const frame = fitImage(image, { width: canvas.width, height: horizonY }, 0);
    ctx.globalAlpha = 0.25;
    ctx.drawImage(image, frame.x, 0, frame.width, frame.height);
    ctx.globalAlpha = 1;
  }

  drawAudience(ctx, canvas, horizonY, seconds, spec.seed ?? 7);

  // 前 85% 時間走向鏡頭，最後停下擺姿勢。
  const walkProgress = easeInOutSine(clamp(progress / 0.85, 0, 1));
  const walking = progress < 0.85;
  const depth = lerp(0.12, 1, walkProgress);
  const floorY = lerp(horizonY + canvas.height * 0.05, canvas.height * 0.97, depth);
  const figureHeight = canvas.height * lerp(0.16, 0.58, depth);
  const stride = walking ? Math.sin(seconds * Math.PI * STEPS_PER_SECOND) * (0.35 + spec.motion / 400) : 0;
  const pose = placeOnFloor({
    x: canvas.width / 2 + Math.sin(seconds * Math.PI * STEPS_PER_SECOND) * figureHeight * 0.02,
    height: figureHeight,
    torso: walking ? -stride * 0.08 : 0.06,
    head: walking ? 0 : -0.12,
    arms: walking
      ? { left: { upper: -0.18 - stride * 0.5, lower: -0.15 }, right: { upper: 0.18 - stride * 0.5, lower: 0.15 } }
      : { left: { upper: -0.35, lower: -1.4 }, right: { upper: 0.12, lower: 0.1 } },
    legs: walking
      ? { left: { upper: stride * 0.6 + 0.04, lower: Math.max(0, -stride) * 0.6 }, right: { upper: -stride * 0.6 - 0.04, lower: Math.max(0, stride) * 0.6 } }
      : { left: { upper: 0.08, lower: -0.05 }, right: { upper: -0.2, lower: 0.1 } },
  }, floorY);

  drawFloorShadow(ctx, pose.x, floorY, figureHeight * 0.18, 0.25);
  drawFigure(ctx, pose, { top: '#111114', bottom: '#111114', skin: '#e6b48c', shoes: '#c9a24a' });
  drawTitleBar(ctx, canvas, '走秀影片', (spec.prompt || spec.story || '').slice(0, 22));
}
