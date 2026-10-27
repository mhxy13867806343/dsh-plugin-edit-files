/**
 * lib/config.js —— 插件配置归一化。
 *
 * 配置来自 cordis.patch.yml 里那一行的 config，全部可选：
 *   三个「上限」 + 文件树的条目上限与忽略目录名。
 * 坏值（0、负数、NaN、字符串垃圾、非数组）一律退回默认值：宁可保守，
 * 也不要让一个手滑的 0 把插件变成「任何文件都太大」。
 */

export const API_PREFIX = '/api/edit-files';
export const PLUGIN_NAME = 'dsh-plugin-edit-files';
export const PLUGIN_VERSION = '0.1.0';

export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 2097152,
  maxDiffLines: 4000,
  maxChangedFiles: 3000,
});

/** 文件树默认忽略的目录名：依赖/构建产物这类目录一展开就是几万条，面板会被拖垮。 */
export const DEFAULT_TREE_IGNORES = Object.freeze([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  'target',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.cache',
  '.parcel-cache',
  '.svelte-kit',
  '.expo',
  '.output',
]);

export const DEFAULT_TREE = Object.freeze({
  maxTreeEntries: 20000,
  treeIgnores: DEFAULT_TREE_IGNORES,
});

const LIMIT_KEYS = Object.freeze(['maxFileBytes', 'maxDiffLines', 'maxChangedFiles']);

function positiveInt(value, fallback) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

/** 非数组回退默认；数组里只留非空字符串（去重），空数组表示「除 .git 外不忽略」。 */
function normalizeIgnores(value) {
  if (!Array.isArray(value)) return [...DEFAULT_TREE_IGNORES];
  const names = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const name = item.trim();
    if (name === '' || names.includes(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * 把外部 config 归一成
 * `{ maxFileBytes, maxDiffLines, maxChangedFiles, maxTreeEntries, treeIgnores }`。
 */
export function normalizeConfig(config) {
  const input = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const limits = {};
  for (const key of LIMIT_KEYS) limits[key] = positiveInt(input[key], DEFAULT_LIMITS[key]);
  return {
    ...limits,
    maxTreeEntries: positiveInt(input.maxTreeEntries, DEFAULT_TREE.maxTreeEntries),
    treeIgnores: normalizeIgnores(input.treeIgnores),
  };
}
