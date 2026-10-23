// 健身房影片的 Canvas 預覽：健身者扛槓鈴做深蹲，右上角顯示次數與組間進度。
import {
  TAU,
  drawFigure,
  drawFloorShadow,
  drawTitleBar,
  easeInOutSine,
  lerp,
  placeOnFloor,
  solvePose,
} from '/assets/scenario-kit.js';

const REP_SECONDS = 2.2;

function drawGym(ctx, canvas, floorY) {
  const { width, height } = canvas;
  const wall = ctx.createLinearGradient(0, 0, 0, floorY);
  wall.addColorStop(0, '#2b3038');
  wall.addColorStop(1, '#41474f');
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, width, floorY);

  // 窗戶光線。
  for (let index = 0; index < 4; index += 1) {
    const x = width * (0.08 + index * 0.24);
    const light = ctx.createLinearGradient(x, 0, x, floorY);
    light.addColorStop(0, 'rgba(255, 252, 235, 0.22)');
    light.addColorStop(1, 'rgba(255, 252, 235, 0.02)');
    ctx.fillStyle = light;
    ctx.fillRect(x, height * 0.06, width * 0.14, floorY * 0.55);
  }

  // 牆面鏡子與啞鈴架。
  ctx.fillStyle = 'rgba(180, 200, 220, 0.12)';
  ctx.fillRect(width * 0.3, height * 0.18, width * 0.4, floorY - height * 0.22);
  ctx.fillStyle = '#1b1e23';
  ctx.fillRect(width * 0.03, floorY - height * 0.2, width * 0.2, height * 0.03);
  ctx.fillRect(width * 0.03, floorY - height * 0.1, width * 0.2, height * 0.03);
  for (let index = 0; index < 5; index += 1) {
    ['#c0392b', '#2c3e50'].forEach((color, row) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(width * (0.05 + index * 0.04), floorY - height * (0.22 - row * 0.1), height * 0.018, 0, TAU);
      ctx.fill();
    });
  }
  // 深蹲架。
  ctx.strokeStyle = '#8a9099';
  ctx.lineWidth = Math.max(4, width * 0.008);
  [0.78, 0.94].forEach((ratio) => {
    ctx.beginPath();
    ctx.moveTo(width * ratio, floorY);
    ctx.lineTo(width * ratio, height * 0.2);
    ctx.stroke();
  });

  // 橡膠地板。
  ctx.fillStyle = '#16181c';
  ctx.fillRect(0, floorY, width, height - floorY);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += width / 12) {
    ctx.beginPath();
    ctx.moveTo(x, floorY);
    ctx.lineTo(x - width * 0.05, height);
    ctx.stroke();
  }
}

// 槓鈴架在肩頸後方，所以要在人物之前畫，讓頭部擋在槓鈴前面。
function drawBarbell(ctx, joints, height) {
  const y = joints.neck.y;
  const centerX = joints.neck.x;
  const halfBar = height * 0.42;
  ctx.strokeStyle = '#c8ccd2';
  ctx.lineWidth = Math.max(3, height * 0.016);
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(centerX - halfBar, y);
  ctx.lineTo(centerX + halfBar, y);
  ctx.stroke();
  [-1, 1].forEach((side) => {
    ctx.fillStyle = '#20232a';
    ctx.fillRect(centerX + side * halfBar * 0.82 - height * 0.025, y - height * 0.1, height * 0.05, height * 0.2);
    ctx.fillStyle = '#e74c3c';
    ctx.fillRect(centerX + side * halfBar * 0.7 - height * 0.02, y - height * 0.075, height * 0.04, height * 0.15);
  });
}

function drawRepCounter(ctx, canvas, rep, repProgress) {
  const radius = Math.min(canvas.width, canvas.height) * 0.08;
  const x = canvas.width - radius * 1.6;
  const y = canvas.height * 0.2 + radius;
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.2, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#2ecc71';
  ctx.lineWidth = radius * 0.16;
  ctx.beginPath();
  ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + TAU * repProgress);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${Math.round(radius * 0.8)}px sans-serif`;
  ctx.fillText(String(rep), x, y - radius * 0.1);
  ctx.font = `${Math.round(radius * 0.32)}px sans-serif`;
  ctx.fillText('REPS', x, y + radius * 0.55);
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
}

export function renderFrame({ ctx, canvas, progress, image, spec, fitImage }) {
  const seconds = progress * spec.duration;
  const floorY = canvas.height * 0.88;
  drawGym(ctx, canvas, floorY);

  if (image) {
    const frame = fitImage(image, canvas, 0);
    ctx.globalAlpha = 0.15;
    ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height);
    ctx.globalAlpha = 1;
  }

  // 一下一上為一次深蹲；depth 0 為站直、1 為最低點。
  const cycle = seconds / REP_SECONDS;
  const repProgress = cycle - Math.floor(cycle);
  const depth = easeInOutSine(repProgress < 0.5 ? repProgress * 2 : 2 - repProgress * 2) * (0.7 + spec.motion / 330);
  const figureHeight = canvas.height * 0.66;
  const pose = placeOnFloor({
    x: canvas.width * 0.5,
    height: figureHeight,
    torso: 0,
    head: 0,
    // 手肘朝下、手握在肩膀外側的槓上。
    arms: { left: { upper: -1.3, lower: -0.56 }, right: { upper: 1.3, lower: 0.56 } },
    legs: {
      left: { upper: lerp(-0.18, -1.15, depth), lower: lerp(0.05, 1.75, depth) },
      right: { upper: lerp(0.18, 1.15, depth), lower: lerp(-0.05, -1.75, depth) },
    },
  }, floorY);

  drawFloorShadow(ctx, pose.x, floorY, figureHeight * 0.26);
  drawBarbell(ctx, solvePose(pose), figureHeight);
  drawFigure(ctx, pose, { top: '#2c3e50', bottom: '#1a1d22', skin: '#d9a07a', shoes: '#f1c40f' });
  drawRepCounter(ctx, canvas, Math.floor(cycle) + (repProgress > 0.5 ? 1 : 0), repProgress);
  drawTitleBar(ctx, canvas, '健身房影片', (spec.prompt || spec.story || '').slice(0, 36));
}
