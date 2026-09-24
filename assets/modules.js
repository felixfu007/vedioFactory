(() => {
  const registry = window.VedioFactory;

  registry.registerModule({
    id: 'cinematic-motion',
    name: 'Cinematic Motion',
    tagline: '照片轉電影感推鏡',
    description: '適合把單張人物或產品照片轉成電影式鏡頭，會搭配 Ken Burns 推拉與柔和字幕區塊。',
    bestFor: '品牌形象、產品視覺、人物海報轉影片',
    capabilities: ['照片導向構圖', '動態光暈背景', '提示詞文字條', '平衡品質輸出'],
    renderFrame({ ctx, canvas, progress, image, spec, fitImage, drawCaptionBlock }) {
      const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      gradient.addColorStop(0, '#08182f');
      gradient.addColorStop(0.55, '#132f5d');
      gradient.addColorStop(1, '#050913');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const pulse = 0.06 + Math.sin(progress * Math.PI * 2) * 0.015;
      if (image) {
        const frame = fitImage(image, canvas, pulse + spec.motion / 700);
        const shiftX = (progress - 0.5) * canvas.width * (spec.motion / 380);
        const shiftY = (0.5 - progress) * canvas.height * (spec.motion / 500);
        ctx.drawImage(image, frame.x + shiftX, frame.y + shiftY, frame.width, frame.height);
      }

      ctx.fillStyle = `rgba(91, 140, 255, ${0.08 + spec.captionStrength / 1000})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawCaptionBlock(ctx, spec.prompt || spec.story, canvas, spec.captionStrength);
    },
  });

  registry.registerModule({
    id: 'storyboard-focus',
    name: 'Storyboard Focus',
    tagline: '文字分鏡與重點卡片',
    description: '把描述文字拆成簡報式段落，搭配照片縮圖與資訊卡，適合快速規劃腳本、產品展示或社群短片。',
    bestFor: '腳本提案、教學短片、產品說明',
    capabilities: ['文字分鏡切換', '雙欄卡片排版', '封面標題', '可重複產出版本'],
    renderFrame({ ctx, canvas, progress, image, spec, fitImage }) {
      ctx.fillStyle = '#050913';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const accent = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
      accent.addColorStop(0, '#5b8cff');
      accent.addColorStop(1, '#7f78ff');
      ctx.fillStyle = accent;
      ctx.fillRect(24, 24, canvas.width - 48, canvas.height - 48);

      ctx.fillStyle = 'rgba(4, 11, 21, 0.92)';
      ctx.fillRect(36, 36, canvas.width - 72, canvas.height - 72);

      if (image) {
        const frame = fitImage(image, { width: canvas.width * 0.38, height: canvas.height * 0.7 }, spec.motion / 850);
        ctx.drawImage(
          image,
          52,
          96,
          frame.width,
          frame.height,
        );
      }

      ctx.fillStyle = '#ecf4ff';
      ctx.font = `${Math.max(28, Math.round(canvas.width * 0.03))}px sans-serif`;
      ctx.fillText('Storyboard', canvas.width * 0.46, 110);

      ctx.font = `${Math.max(20, Math.round(canvas.width * 0.022))}px sans-serif`;
      const script = (spec.story || spec.prompt || '請輸入影片描述').split(/[。.!?\n]/u).filter(Boolean);
      const currentIndex = Math.min(script.length - 1, Math.floor(progress * Math.max(script.length, 1)));
      script.slice(0, 3).forEach((line, index) => {
        const isActive = index === currentIndex;
        ctx.fillStyle = isActive ? '#ffffff' : 'rgba(236, 244, 255, 0.45)';
        ctx.fillText(`${index + 1}. ${line.slice(0, 30)}`, canvas.width * 0.46, 180 + index * 74);
      });

      ctx.fillStyle = 'rgba(91, 140, 255, 0.12)';
      ctx.fillRect(canvas.width * 0.46, canvas.height - 170, canvas.width * 0.44, 110);
      ctx.fillStyle = '#ffffff';
      ctx.font = `${Math.max(18, Math.round(canvas.width * 0.02))}px sans-serif`;
      ctx.fillText(`長度 ${spec.duration}s・${spec.quality}・${spec.resolution}`, canvas.width * 0.49, canvas.height - 104);
      ctx.fillText(spec.prompt.slice(0, 40) || '描述驅動輸出', canvas.width * 0.49, canvas.height - 64);
    },
  });

  registry.registerModule({
    id: 'neon-pulse',
    name: 'Neon Pulse',
    tagline: '高彩度節奏動態',
    description: '適合純文字描述或潮流照片，利用霓虹光帶、節奏縮放與對比字幕打造鮮明風格。',
    bestFor: '活動宣傳、社群短影音、視覺情緒片段',
    capabilities: ['純文字也能輸出', '高對比背景', '速度感轉場', '適合再剪輯'],
    renderFrame({ ctx, canvas, progress, image, spec, fitImage, drawCaptionBlock }) {
      ctx.fillStyle = '#03030a';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      for (let index = 0; index < 6; index += 1) {
        const size = canvas.width * (0.14 + index * 0.13);
        const offset = Math.sin(progress * Math.PI * (index + 1)) * 60;
        ctx.strokeStyle = `hsla(${220 + index * 30}, 100%, 65%, ${0.18 + index * 0.08})`;
        ctx.lineWidth = 16 - index * 2;
        ctx.strokeRect((canvas.width - size) / 2 + offset, (canvas.height - size) / 2 - offset, size, size);
      }

      if (image) {
        const frame = fitImage(image, canvas, 0.08 + spec.motion / 650);
        ctx.globalAlpha = 0.82;
        ctx.drawImage(image, frame.x, frame.y, frame.width, frame.height);
        ctx.globalAlpha = 1;
      }

      ctx.fillStyle = 'rgba(3, 3, 10, 0.3)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      drawCaptionBlock(ctx, spec.story || spec.prompt, canvas, spec.captionStrength + 10);
    },
  });
})();
