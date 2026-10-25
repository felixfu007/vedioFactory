// Canvas 錄影共用工具：位元率、MediaRecorder 格式、圖片縮放與字幕區塊繪製。

export const qualityBitrates = {
  draft: 1_200_000,
  balanced: 2_500_000,
  premium: 4_200_000,
};

export function getSupportedMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

export function fitImage(image, canvas, scaleBoost = 0) {
  const ratio = Math.max(canvas.width / image.width, canvas.height / image.height) * (1 + scaleBoost);
  const width = image.width * ratio;
  const height = image.height * ratio;
  return {
    width,
    height,
    x: (canvas.width - width) / 2,
    y: (canvas.height - height) / 2,
  };
}

function wrapText(ctx, text, maxWidth) {
  const splitByWhitespace = /\s/u.test(text);
  const words = splitByWhitespace ? text.split(/\s+/u).filter(Boolean) : Array.from(text);
  if (!words.length) return [''];

  const lines = [];
  let current = words.shift() ?? '';

  words.forEach((word) => {
    const candidate = splitByWhitespace ? `${current} ${word}` : `${current}${word}`;
    if (ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  });

  lines.push(current);
  return lines;
}

export function drawCaptionBlock(ctx, text, canvas, emphasis) {
  if (!text) return;
  const padding = 28;
  ctx.save();
  ctx.font = `${Math.max(26, Math.round(canvas.width * 0.028))}px sans-serif`;
  const lines = wrapText(ctx, text, canvas.width - padding * 2);
  const lineHeight = Math.max(36, Math.round(canvas.height * 0.06));
  const boxHeight = lineHeight * lines.length + 24;
  const y = canvas.height - boxHeight - 24;
  const alpha = 0.35 + emphasis / 220;
  ctx.fillStyle = `rgba(2, 7, 13, ${Math.min(alpha, 0.85)})`;
  ctx.fillRect(18, y, canvas.width - 36, boxHeight);
  ctx.fillStyle = '#ffffff';
  lines.forEach((line, index) => {
    ctx.fillText(line, padding, y + 40 + index * lineHeight);
  });
  ctx.restore();
}
