/**
 * lib/config.js —— 插件配置归一化。
 *
 * 配置来自 cordis.patch.yml 里那一行的 config，三项都是可选的「上限」。
 * 坏值（0、负数、NaN、字符串垃圾）一律退回默认值：宁可保守，也不要让一个手滑的 0
 * 把插件变成「任何文件都太大」。
 */

export const API_PREFIX = '/api/edit-files';
export const PLUGIN_NAME = 'dsh-plugin-edit-files';
export const PLUGIN_VERSION = '0.1.0';

export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 2097152,
  maxDiffLines: 4000,
  maxChangedFiles: 3000,
});

const LIMIT_KEYS = Object.freeze(['maxFileBytes', 'maxDiffLines', 'maxChangedFiles']);

function positiveInt(value, fallback) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

/** 把外部 config 归一成 `{ maxFileBytes, maxDiffLines, maxChangedFiles }`，只含正整数。 */
export function normalizeConfig(config) {
  const input = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const limits = {};
  for (const key of LIMIT_KEYS) limits[key] = positiveInt(input[key], DEFAULT_LIMITS[key]);
  return limits;
}
