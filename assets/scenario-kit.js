// 場景模組開發套件：給 modules/<id>/preview.js 使用的 Canvas 繪圖工具。
// 角度一律以弧度表示，0 代表肢體朝正下方，正值往畫面右側擺動。

export const TAU = Math.PI * 2;

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

export function easeInOutSine(amount) {
  return -(Math.cos(Math.PI * clamp(amount, 0, 1)) - 1) / 2;
}

// 以 bpm 計算節拍：phase 為 0–1 的拍內進度，pulse 在拍點最強、之後衰減。
export function beat(seconds, bpm = 120) {
  const beats = (seconds * bpm) / 60;
  const phase = beats - Math.floor(beats);
  return { index: Math.floor(beats), phase, pulse: Math.exp(-phase * 6) };
}

// 可重現的偽隨機數（同一個 seed 每次都得到相同序列）。
export function seededRandom(seed = 1) {
  let state = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

function limbPoint(from, angle, length) {
  return { x: from.x + Math.sin(angle) * length, y: from.y + Math.cos(angle) * length };
}

// 依姿勢計算關節位置。height 為人物站直時的像素高度。
export function solvePose(pose) {
  const height = pose.height;
  const torsoAngle = pose.torso ?? 0;
  const hip = { x: pose.x, y: pose.y };
  const torsoLength = height * 0.3;
  const neck = { x: hip.x + Math.sin(torsoAngle) * torsoLength, y: hip.y - Math.cos(torsoAngle) * torsoLength };
  const headRadius = height * 0.065;
  const headAngle = torsoAngle + (pose.head ?? 0);
  const head = {
    x: neck.x + Math.sin(headAngle) * headRadius * 1.5,
    y: neck.y - Math.cos(headAngle) * headRadius * 1.5,
  };
  const shoulderWidth = height * 0.1;
  const hipWidth = height * 0.06;
  const across = { x: Math.cos(torsoAngle), y: Math.sin(torsoAngle) };
  const shoulders = {
    left: { x: neck.x - across.x * shoulderWidth, y: neck.y - across.y * shoulderWidth },
    right: { x: neck.x + across.x * shoulderWidth, y: neck.y + across.y * shoulderWidth },
  };
  const hips = {
    left: { x: hip.x - across.x * hipWidth, y: hip.y - across.y * hipWidth },
    right: { x: hip.x + across.x * hipWidth, y: hip.y + across.y * hipWidth },
  };
  const arm = (side, start) => {
    const limb = pose.arms?.[side] ?? {};
    const upper = limbPoint(start, limb.upper ?? 0, height * 0.16);
    return { start, joint: upper, end: limbPoint(upper, (limb.upper ?? 0) + (limb.lower ?? 0), height * 0.15) };
  };
  const leg = (side, start) => {
    const limb = pose.legs?.[side] ?? {};
    const knee = limbPoint(start, limb.upper ?? 0, height * 0.23);
    return { start, joint: knee, end: limbPoint(knee, (limb.upper ?? 0) + (limb.lower ?? 0), height * 0.24) };
  };
  return {
    hip,
    neck,
    head,
    headRadius,
    shoulders,
    hips,
    arms: { left: arm('left', shoulders.left), right: arm('right', shoulders.right) },
    legs: { left: leg('left', hips.left), right: leg('right', hips.right) },
  };
}

function strokeLimb(ctx, limb, width, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(limb.start.x, limb.start.y);
  ctx.lineTo(limb.joint.x, limb.joint.y);
  ctx.lineTo(limb.end.x, limb.end.y);
  ctx.stroke();
}

// 畫出剪影風格人物。colors 可指定 skin、top、bottom、shoes、outline。
export function drawFigure(ctx, pose, colors = {}) {
  const joints = solvePose(pose);
  const height = pose.height;
  const palette = {
    skin: '#f2c7a5',
    top: '#5b8cff',
    bottom: '#1d2438',
    shoes: '#f5f7ff',
    outline: 'rgba(0, 0, 0, 0.35)',
    ...colors,
  };
  const limbWidth = height * 0.055;

  // 遠側肢體先畫，產生前後層次。
  strokeLimb(ctx, joints.legs.left, limbWidth * 1.15, palette.bottom);
  strokeLimb(ctx, joints.arms.left, limbWidth * 0.85, palette.skin);

  ctx.fillStyle = palette.top;
  ctx.strokeStyle = palette.outline;
  ctx.lineWidth = Math.max(1, height * 0.006);
  ctx.beginPath();
  ctx.moveTo(joints.shoulders.left.x, joints.shoulders.left.y);
  ctx.lineTo(joints.shoulders.right.x, joints.shoulders.right.y);
  ctx.lineTo(joints.hips.right.x, joints.hips.right.y);
  ctx.lineTo(joints.hips.left.x, joints.hips.left.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  strokeLimb(ctx, joints.legs.right, limbWidth * 1.15, palette.bottom);
  strokeLimb(ctx, joints.arms.right, limbWidth * 0.85, palette.skin);

  ctx.fillStyle = palette.shoes;
  [joints.legs.left.end, joints.legs.right.end].forEach((foot) => {
    ctx.beginPath();
    ctx.ellipse(foot.x, foot.y + limbWidth * 0.2, limbWidth * 0.75, limbWidth * 0.4, 0, 0, TAU);
    ctx.fill();
  });

  ctx.strokeStyle = palette.skin;
  ctx.lineWidth = limbWidth * 0.6;
  ctx.beginPath();
  ctx.moveTo(joints.neck.x, joints.neck.y);
  ctx.lineTo(joints.head.x, joints.head.y);
  ctx.stroke();
  ctx.fillStyle = palette.skin;
  ctx.beginPath();
  ctx.arc(joints.head.x, joints.head.y, joints.headRadius, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = palette.outline;
  ctx.stroke();
  return joints;
}

export function drawFloorShadow(ctx, x, y, width, alpha = 0.35) {
  const gradient = ctx.createRadialGradient(x, y, 0, x, y, width);
  gradient.addColorStop(0, `rgba(0, 0, 0, ${alpha})`);
  gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.ellipse(x, y, width, width * 0.22, 0, 0, TAU);
  ctx.fill();
}

// 在畫面上方畫出模組標題列（例如「跳舞影片｜街舞」）。
export function drawTitleBar(ctx, canvas, title, subtitle = '') {
  const size = Math.max(18, Math.round(Math.min(canvas.width, canvas.height) * 0.045));
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.fillRect(0, 0, canvas.width, size * 2.4);
  ctx.fillStyle = '#ffffff';
  ctx.font = `600 ${size}px sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText(title, size, size * 1.2);
  if (subtitle) {
    const titleWidth = ctx.measureText(title).width;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.font = `${Math.round(size * 0.7)}px sans-serif`;
    ctx.fillText(subtitle, size * 1.6 + titleWidth, size * 1.25);
  }
  ctx.textBaseline = 'alphabetic';
}

// 調整姿勢的 y，讓最低的腳剛好踩在 floorY（屈膝時人物會自然下沉）。
export function placeOnFloor(pose, floorY) {
  const joints = solvePose({ ...pose, y: 0 });
  const lowestFoot = Math.max(joints.legs.left.end.y, joints.legs.right.end.y);
  return { ...pose, y: floorY - lowestFoot };
}
