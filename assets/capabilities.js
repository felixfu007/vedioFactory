// Shared by server.js (CommonJS) and the browser (window.VedioFactoryCapabilities)
// so generation limits are defined in exactly one place.
(function initCapabilities(root, factory) {
  const capabilities = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = capabilities;
  } else {
    root.VedioFactoryCapabilities = capabilities;
  }
})(typeof self !== 'undefined' ? self : this, () => {
  const BASE_CAPABILITIES = Object.freeze({
    resolutions: Object.freeze([
      { value: '1280x720', label: '1280 × 720（16:9）' },
      { value: '1920x1080', label: '1920 × 1080（16:9）' },
      { value: '1080x1080', label: '1080 × 1080（1:1）' },
      { value: '720x1280', label: '720 × 1280（9:16）' },
      { value: '1080x1920', label: '1080 × 1920（9:16）' },
      { value: '1024x768', label: '1024 × 768（4:3）' },
      { value: '768x1024', label: '768 × 1024（3:4）' },
      { value: '1680x720', label: '1680 × 720（21:9）' },
    ]),
    fps: Object.freeze([12, 16, 24, 25, 30]),
    duration: Object.freeze({ min: 2, max: 30 }),
    customResolution: Object.freeze({
      enabled: true,
      multiple: 8,
      minSize: 256,
      maxWidth: 3840,
      maxHeight: 3840,
      maxPixels: 3840 * 2160,
    }),
    defaults: Object.freeze({ resolution: '1280x720', fps: 24, duration: 6 }),
  });

  function parseResolution(value) {
    const match = /^(\d{1,5})x(\d{1,5})$/u.exec(String(value || ''));
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  }

  function fitsCustomRules(resolution, rules) {
    const size = parseResolution(resolution);
    return Boolean(size)
      && size.width % rules.multiple === 0
      && size.height % rules.multiple === 0
      && size.width >= rules.minSize
      && size.height >= rules.minSize
      && size.width <= rules.maxWidth
      && size.height <= rules.maxHeight
      && size.width * size.height <= rules.maxPixels;
  }

  function isResolutionAllowed(resolution, capabilities) {
    if (capabilities.resolutions.some((item) => item.value === resolution)) return true;
    return capabilities.customResolution.enabled && fitsCustomRules(resolution, capabilities.customResolution);
  }

  function describeCustomRules(rules) {
    return `寬高需為 ${rules.multiple} 的倍數，介於 ${rules.minSize} 至 ${rules.maxWidth} × ${rules.maxHeight}`;
  }

  function labelResolution(value) {
    const known = BASE_CAPABILITIES.resolutions.find((item) => item.value === value);
    return known ? known.label : value.replace('x', ' × ');
  }

  function readIntegerList(value, field, min, max) {
    if (!Array.isArray(value) || !value.length || value.length > 32) {
      throw new Error(`${field} 必須是 1 至 32 個項目的陣列。`);
    }
    return [...new Set(value.map((item) => {
      if (!Number.isInteger(item) || item < min || item > max) {
        throw new Error(`${field} 只能包含 ${min} 至 ${max} 的整數。`);
      }
      return item;
    }))];
  }

  function readInteger(value, field, min, max, fallback) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${field} 必須是 ${min} 至 ${max} 的整數。`);
    }
    return value;
  }

  // Applies a workflow's .vf.json limits on top of the base capabilities.
  // Workflows may pick their own native FPS and resolutions but never exceed the base size ceiling.
  function narrowCapabilities(limits = {}) {
    const base = BASE_CAPABILITIES;
    const baseRules = base.customResolution;
    const customResolution = {
      enabled: limits.allowCustomResolution === undefined ? baseRules.enabled : limits.allowCustomResolution === true,
      multiple: readInteger(limits.resolutionMultiple, 'resolutionMultiple', 1, 128, baseRules.multiple),
      minSize: baseRules.minSize,
      maxWidth: readInteger(limits.maxWidth, 'maxWidth', baseRules.minSize, baseRules.maxWidth, baseRules.maxWidth),
      maxHeight: readInteger(limits.maxHeight, 'maxHeight', baseRules.minSize, baseRules.maxHeight, baseRules.maxHeight),
      maxPixels: baseRules.maxPixels,
    };
    if (limits.allowCustomResolution !== undefined && typeof limits.allowCustomResolution !== 'boolean') {
      throw new Error('allowCustomResolution 必須是 true 或 false。');
    }

    let resolutions = base.resolutions.filter((item) => fitsCustomRules(item.value, customResolution));
    if (limits.resolutions !== undefined) {
      if (!Array.isArray(limits.resolutions) || !limits.resolutions.length || limits.resolutions.length > 32) {
        throw new Error('resolutions 必須是 1 至 32 個項目的陣列。');
      }
      resolutions = [...new Set(limits.resolutions)].map((value) => {
        const rules = { ...customResolution, multiple: 1 };
        if (typeof value !== 'string' || !fitsCustomRules(value, rules)) {
          throw new Error(`resolutions 包含無效解析度：${value}（格式 寬x高，${describeCustomRules(rules)}）。`);
        }
        return { value, label: labelResolution(value) };
      });
    }

    const fps = limits.fps === undefined ? [...base.fps] : readIntegerList(limits.fps, 'fps', 1, 60);
    const minDuration = readInteger(limits.minDuration, 'minDuration', 1, 120, base.duration.min);
    const maxDuration = readInteger(limits.maxDuration, 'maxDuration', 1, 120, base.duration.max);
    if (minDuration > maxDuration) throw new Error('minDuration 不可大於 maxDuration。');

    const capabilities = {
      resolutions,
      fps,
      duration: { min: minDuration, max: maxDuration },
      customResolution,
      defaults: {},
    };
    if (!resolutions.length && !customResolution.enabled) {
      throw new Error('工作流至少需要一種可用解析度。');
    }
    const defaults = limits.defaults === undefined ? {} : limits.defaults;
    if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) {
      throw new Error('defaults 必須是物件。');
    }
    const fallbackResolution = isResolutionAllowed(base.defaults.resolution, capabilities)
      ? base.defaults.resolution
      : resolutions[0]?.value;
    capabilities.defaults = {
      resolution: defaults.resolution ?? fallbackResolution,
      fps: defaults.fps ?? (fps.includes(base.defaults.fps) ? base.defaults.fps : fps[0]),
      duration: defaults.duration ?? Math.min(Math.max(base.defaults.duration, minDuration), maxDuration),
    };
    if (!isResolutionAllowed(capabilities.defaults.resolution, capabilities)) {
      throw new Error('defaults.resolution 不在允許的解析度內。');
    }
    if (!fps.includes(capabilities.defaults.fps)) throw new Error('defaults.fps 不在允許的 FPS 內。');
    if (!Number.isInteger(capabilities.defaults.duration)
      || capabilities.defaults.duration < minDuration
      || capabilities.defaults.duration > maxDuration) {
      throw new Error('defaults.duration 超出允許的長度範圍。');
    }
    return capabilities;
  }

  return {
    BASE_CAPABILITIES,
    parseResolution,
    isResolutionAllowed,
    describeCustomRules,
    narrowCapabilities,
  };
});
