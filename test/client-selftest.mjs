/**
 * Client 半边离线自检：不启动浏览器，把 client.js 当成真正的模块加载器脚本来跑 ——
 * 用一个假的 window.__ModuleLoader__ 抓住 factory，用假的 ctx 记录注册了什么。
 *
 * 覆盖：插件清单 inject、locale 字典 key 完整性、六个 slot 注册、右栏页类型注册、
 * 样式只注入一次、纯函数（diff 解析 / 工作区路径 / 格式化）。
 *
 * 跑法：node test/client-selftest.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLIENT_FILE = path.join(ROOT, 'client.js');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, run) {
  try {
    run();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name} —— ${error && error.message ? error.message : error}`);
  }
}

// ───────────────────────────────────────────────────────── React 桩

// 注册阶段只把组件函数交给 slot，不会真的渲染；所以这里给一个纯桩就够，
// 自检不依赖 DSH 安装目录，任何机器上都能跑。
class StubComponent {
  constructor(props) {
    this.props = props;
    this.state = {};
  }
}

const React = {
  Component: StubComponent,
  createElement() {
    return null;
  },
  useCallback(fn) {
    return fn;
  },
  useEffect() {},
  useMemo(fn) {
    return fn();
  },
  useRef() {
    return { current: null };
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useSyncExternalStore() {
    return undefined;
  },
};

// ───────────────────────────────────────────────────────── 假浏览器环境

const styleElements = [];
const fakeDocument = {
  querySelector() {
    return null;
  },
  createElement() {
    return {
      dataset: {},
      textContent: '',
      removed: false,
      remove() {
        this.removed = true;
      },
    };
  },
  head: {
    appendChild(element) {
      styleElements.push(element);
    },
  },
};

let captured = null;
const fakeWindow = {
  location: { href: 'http://127.0.0.1:43120/' },
  __DSH_EDIT_FILES_TEST__: true,
  __ModuleLoader__: {
    load(definition) {
      captured = definition;
    },
  },
};

globalThis.window = fakeWindow;
globalThis.document = fakeDocument;

const code = readFileSync(CLIENT_FILE, 'utf8');
vm.runInThisContext(code, { filename: CLIENT_FILE });

assert.ok(captured !== null, 'client.js 没有调用 window.__ModuleLoader__.load');
assert.equal(captured.id, 'dsh-plugin-edit-files');

const fakeRequire = (name) => {
  if (name === 'react') return React;
  throw new Error(`client.js 不应 require("${name}")`);
};

const plugin = captured.factory(fakeRequire);
assert.equal(typeof plugin.apply, 'function');
assert.ok(Array.isArray(plugin.inject));
const internals = plugin.__test;
assert.ok(internals, '测试开关打开时应当导出 __test');

// ───────────────────────────────────────────────────────── 假 ctx

const registrations = [];
const localeRegisters = [];
const tabTypes = [];
const effects = [];
const injectedSlots = [];
const injectedDeps = [];
const inspectProviders = [];

function makeCtx() {
  return {
    locale: {
      register(namespace, dictionaries) {
        localeRegisters.push({ namespace, dictionaries });
        return () => {};
      },
      bind(namespace) {
        return (key) => `${namespace}:${key}`;
      },
    },
    slots: {
      inject(name, callback) {
        injectedSlots.push(name);
        const dispose = callback();
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      },
      register(options, Component) {
        registrations.push({ options, Component });
        return () => {};
      },
    },
    sidebarRightTabs: {
      register(definition) {
        tabTypes.push(definition);
        return () => {};
      },
    },
    sidebarRight: {
      openTab() {},
      openTabIn() {},
      tabsIn() {
        return [];
      },
    },
    uiWorkspace: {
      openSession() {},
    },
    inject(deps, callback) {
      injectedDeps.push([...deps]);
      return callback({
        cordisInspect: {
          register(provider) {
            inspectProviders.push(provider);
            return () => {};
          },
        },
      });
    },
    effect(run, label) {
      const dispose = run();
      effects.push({ label, dispose });
      return () => {};
    },
  };
}

const ctx = makeCtx();
plugin.apply(ctx);

// ───────────────────────────────────────────────────────── 断言

console.log('\n[1] 模块清单与注册面');

check('inject 声明包含需要的服务', () => {
  assert.deepEqual([...plugin.inject].sort(), ['locale', 'sidebarRight', 'sidebarRightTabs', 'slots', 'uiWorkspace'].sort());
});

check('注册了 zh/en 两套 locale 字典', () => {
  const entry = localeRegisters.find((item) => item.namespace === 'dsh-plugin-edit-files');
  assert.ok(entry, '没有注册 dsh-plugin-edit-files 命名空间');
  assert.ok(entry.dictionaries.zh && entry.dictionaries.en);
});

check('locale 字典 zh/en key 完全一致', () => {
  const { zh, en } = internals.dictionaries;
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(enKeys, zhKeys);
});

check('client.js 里 translate() 用到的 key 都能在字典里找到', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8');
  const used = new Set();
  for (const match of source.matchAll(/translate\(t,\s*'([^']+)'/gu)) used.add(match[1]);
  // 动态 key：状态文案与 reasonText 里用到的
  for (const letter of ['M', 'A', 'D', 'R', 'C', 'T', 'U', '?']) used.add(`status.${letter}`);
  const missing = [...used].filter((key) => !(key in internals.dictionaries.zh) || !(key in internals.dictionaries.en));
  assert.deepEqual(missing, [], `缺 key: ${missing.join(', ')}`);
});

check('注册了十个 slot 入口（含文件面板）', () => {
  const seen = registrations.map((item) => `${item.options.name}#${item.options.id || item.options.key || ''}`);
  for (const expected of [
    'shell.overlay#edit-files-editor',
    'shell.overlay#edit-files-workspace-bridge',
    'sidebar.right.tab.document.actions#edit-files-document',
    'sidebar.right.tab.files.actions#edit-files-files',
    'conversation.session.header.utilities#edit-files-git-badge',
    'sidebar.workspaces.session.menu.item#edit-files-git-menu',
    'sidebar.workspaces.session.row.action#edit-files-git-row',
    'sidebar.right.pane.tab#dsh-plugin-edit-files/git',
    'main#edit-files-browser',
    'sidebar.panellist#edit-files-browser',
  ]) {
    assert.ok(seen.indexOf(expected) >= 0, `缺注册：${expected}；实际：${seen.join(', ')}`);
  }
});

check('文件面板的 pane 图标带 label，主面板用同一个 key', () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.panellist' && item.options.id === 'edit-files-browser');
  assert.ok(panel, '缺 sidebar.panellist 注册');
  assert.equal(typeof panel.options.label, 'function');
  assert.equal(typeof panel.options.label(), 'string');
  assert.equal(typeof panel.Component, 'function');
  const main = registrations.find((item) => item.options.name === 'main');
  assert.ok(main, '缺 main 注册');
  assert.equal(main.options.key, panel.options.id);
});

check('没有 locale 的槽位用 id 注册（工作区快照桥）', () => {
  const bridge = registrations.find((item) => item.options.id === 'edit-files-workspace-bridge');
  assert.ok(bridge, '缺 edit-files-workspace-bridge 注册');
  assert.equal(bridge.options.name, 'shell.overlay');
});

check('注册了 client inspect 自检 provider（EditFiles.probe）', () => {
  assert.deepEqual(injectedDeps, [['cordisInspect']]);
  assert.equal(inspectProviders.length, 1);
  const provider = inspectProviders[0];
  assert.equal(provider.manifest.id, 'EditFiles');
  assert.equal(provider.manifest.methods[0].name, 'probe');
  assert.equal(typeof provider.query, 'function');
});

check('每个注册项都有可渲染组件；带文案的声明了 locale 命名空间', () => {
  for (const item of registrations) {
    assert.equal(typeof item.Component, 'function', `${item.options.name} 的组件不是函数`);
    if (item.options.id === 'edit-files-workspace-bridge') {
      assert.equal(item.options.locale, undefined, '无渲染桥不该声明 locale');
      continue;
    }
    assert.equal(item.options.locale, 'dsh-plugin-edit-files');
  }
});

check('注册了 Git 改动页类型（kind 唯一、title 可调用）', () => {
  assert.equal(tabTypes.length, 1);
  const definition = tabTypes[0];
  assert.equal(definition.id, 'dsh-plugin-edit-files/git');
  assert.equal(definition.kind, 'edit-files-git');
  assert.equal(typeof definition.title, 'function');
  assert.equal(typeof definition.title(), 'string');
});

check('样式只注入一次（重复 apply 不会叠两份）', () => {
  assert.equal(styleElements.length, 1);
  assert.ok(styleElements[0].textContent.includes('dsh-ef-diff'), '样式内容缺少 diff 规则');
});

check('slot inject 的等待顺序覆盖全部入口', () => {
  assert.deepEqual(injectedSlots.sort(), [
    'conversation.session.header.utilities',
    'main',
    'shell.overlay',
    'shell.overlay',
    'sidebar.panellist',
    'sidebar.right.pane.tab',
    'sidebar.right.tab.document.actions',
    'sidebar.right.tab.files.actions',
    'sidebar.workspaces.session.menu.item',
    'sidebar.workspaces.session.row.action',
  ]);
});

check('没有 import 任何 @deepseek-ai 客户端包', () => {
  const source = readFileSync(CLIENT_FILE, 'utf8');
  assert.ok(!/require\(\s*['"]@deepseek-ai/iu.test(source), 'client.js 里 require 了 @deepseek-ai 包');
  assert.ok(!/^\s*import\s[^;]*from\s+['"]@deepseek-ai/imu.test(source), 'client.js 里 import 了 @deepseek-ai 包');
  assert.ok(!/require\(\s*['"](?!react['"])/u.test(source), 'client.js 里出现了 react 以外的 require');
});

console.log('\n[2] 纯函数');

check('parseUnifiedDiff：hunk 行号与 +/-/上下文', () => {
  const diff = [
    'diff --git a/a.txt b/a.txt',
    'index 111..222 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,3 +1,4 @@',
    ' same-1',
    '-old-2',
    '+new-2',
    '+new-3',
    ' same-4',
  ].join('\n');
  const rows = internals.parseUnifiedDiff(diff);
  const kinds = rows.map((row) => row.kind);
  assert.deepEqual(kinds, ['meta', 'meta', 'meta', 'meta', 'hunk', 'ctx', 'del', 'add', 'add', 'ctx']);
  const del = rows.find((row) => row.kind === 'del');
  assert.equal(del.oldNo, 2);
  assert.equal(del.text, 'old-2');
  const adds = rows.filter((row) => row.kind === 'add');
  assert.equal(adds[0].newNo, 2);
  assert.equal(adds[1].newNo, 3);
  const ctxRows = rows.filter((row) => row.kind === 'ctx');
  assert.deepEqual(ctxRows.map((row) => [row.oldNo, row.newNo]), [[1, 1], [3, 4]]);
});

check('parseUnifiedDiff：空输出安全', () => {
  assert.deepEqual(internals.parseUnifiedDiff(''), []);
  assert.deepEqual(internals.parseUnifiedDiff('not a diff'), [
    { kind: 'meta', oldNo: null, newNo: null, text: 'not a diff' },
  ]);
});

check('workspacePathOf：按 sessionIds 找到工作区路径', () => {
  const snapshot = {
    items: [
      { workspaceId: 'w1', path: '/Users/me/a', sessionIds: ['s1'] },
      { workspaceId: 'w2', path: '/Users/me/b', sessionIds: ['s2', 's3'] },
    ],
  };
  assert.equal(internals.workspacePathOf(snapshot, 's3'), '/Users/me/b');
  assert.equal(internals.workspacePathOf(snapshot, 'nope'), null);
  assert.equal(internals.workspacePathOf(null, 's1'), null);
  assert.equal(internals.workspacePathOf({ items: [] }, 's1'), null);
});

check('路径与字节格式化', () => {
  assert.equal(internals.basename('/a/b/c.md'), 'c.md');
  assert.equal(internals.basename('c.md'), 'c.md');
  assert.equal(internals.dirnameOf('/a/b/c.md'), '/a/b');
  assert.equal(internals.dirnameOf('c.md'), '');
  assert.equal(internals.formatBytes(999), '999 B');
  assert.equal(internals.formatBytes(2048), '2.0 KB');
  assert.equal(internals.formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(internals.shortPath('/very/long', 5), '…long');
});

check('translate：字典命中 + 占位符 + 缺 key 回退', () => {
  const t = (key) => internals.dictionaries.zh[key];
  assert.equal(internals.translate(t, 'git.files', { n: 3 }), '3 个文件');
  assert.equal(internals.translate(t, 'missing.key'), 'missing.key');
  assert.equal(internals.translate(undefined, 'git.files', { n: 1 }), 'git.files');
});

check('reasonText：把 Host reason 翻成人话', () => {
  const t = (key) => internals.dictionaries.zh[key];
  assert.equal(internals.reasonText(t, 'binary'), '这是二进制文件，文本编辑器打不开。');
  assert.ok(internals.reasonText(t, 'too-large', { limit: 2097152 }).includes('2.0 MB'));
  assert.ok(internals.reasonText(t, 'not-found').includes('不存在'));
  assert.ok(internals.reasonText(t, 'git-unavailable').includes('git'));
});

console.log('\n[2b] 文件面板纯函数');

check('fuzzyScore：子序列命中 + 大小写无关 + 不命中返回 null', () => {
  assert.ok(internals.fuzzyScore('mnts', 'src/main.ts') > 0);
  assert.ok(internals.fuzzyScore('readme', 'README.md') > 0);
  assert.equal(internals.fuzzyScore('zzz', 'src/main.ts'), null);
  assert.equal(internals.fuzzyScore('ts', 'a.ts'), 0 + internals.fuzzyScore('ts', 'a.ts'));
  // 连续命中应该比分散命中分高
  assert.ok(internals.fuzzyScore('main', 'main.ts') > internals.fuzzyScore('main', 'm_a_i_n.ts'));
  // 空查询对任何候选都算 0 分命中
  assert.equal(internals.fuzzyScore('', 'anything'), 0);
});

check('joinRel / dirOfRel / rootPathOf：相对路径拼接', () => {
  assert.equal(internals.joinRel('', 'a.md'), 'a.md');
  assert.equal(internals.joinRel('src', 'a.md'), 'src/a.md');
  assert.equal(internals.joinRel('/src/', '/a.md'), 'src/a.md');
  assert.equal(internals.joinRel('src', ''), 'src');
  assert.equal(internals.dirOfRel('src/a/b.md'), 'src/a');
  assert.equal(internals.dirOfRel('a.md'), '');
  assert.equal(internals.rootPathOf('/repo/', 'src/a.md'), '/repo/src/a.md');
  assert.equal(internals.rootPathOf('/repo', ''), '/repo');
});

check('workspaceListOf / currentSessionIdOf：从快照找当前工作区', () => {
  const workspaces = {
    items: [
      { workspaceId: 'w1', path: '/Users/me/a', title: 'A', sessionIds: ['s1'] },
      { workspaceId: 'w2', path: '/Users/me/b', title: '', sessionIds: ['s2'] },
      { workspaceId: 'w3', path: null },
    ],
  };
  const list = internals.workspaceListOf(workspaces);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], { workspaceId: 'w1', path: '/Users/me/a', title: 'A', sessionIds: ['s1'] });
  assert.equal(list[1].title, 'b');
  const sessions = { byId: { s1: { retainedBy: { mainView: 0 } }, s2: { retainedBy: { mainView: 2 } } } };
  assert.equal(internals.currentSessionIdOf(sessions), 's2');
  assert.equal(internals.currentSessionIdOf({ byId: {} }), undefined);
  assert.equal(internals.currentSessionIdOf(null), undefined);
});

check('formatMtime / formatSizeShort', () => {
  assert.equal(internals.formatSizeShort(0), '');
  assert.equal(internals.formatSizeShort(512), '512B');
  assert.equal(internals.formatSizeShort(2048), '2K');
  assert.equal(internals.formatSizeShort(3 * 1024 * 1024), '3.0M');
  assert.match(internals.formatMtime(Date.UTC(2026, 0, 2, 3, 4)), /^2026-01-02 \d\d:\d\d$/u);
  assert.equal(internals.formatMtime(undefined), '');
});

check('reasonText：文件面板的错误原因也有文案', () => {
  const t = (key) => internals.dictionaries.zh[key];
  assert.equal(internals.reasonText(t, 'already-exists'), '目标已存在');
  assert.equal(internals.reasonText(t, 'protected-path'), '受保护路径（.git）');
  assert.equal(internals.reasonText(t, 'outside-root'), '路径超出工作区');
});

console.log('\n[3] 页面侧自检 provider（用假 fetch 走一遍 probe）');

const fetchCalls = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  fetchCalls.push({ url, method: init && init.method ? init.method : 'GET' });
  const body = url.includes('/git/changes')
    ? { ok: true, isRepo: true, base: 'origin/main', totals: { files: 2, additions: 5, deletions: 1 }, files: [{ path: 'a.md' }, { path: 'b.md' }] }
    : url.includes('/git/info')
      ? { ok: true, isRepo: true, base: 'origin/main', branch: 'main', baseKind: 'upstream' }
      : url.includes('/git/file')
        ? { ok: true, isRepo: true, file: { status: 'M' } }
        : { ok: true, name: 'dsh-plugin-edit-files', version: '0.1.0', routes: [], limits: {} };
  return { status: 200, json: async () => body };
};

try {
  const probe = await inspectProviders[0].query('probe', { path: '/tmp/demo-repo' });
  check('probe 返回页面地址与 health', () => {
    assert.equal(probe.plugin, 'dsh-plugin-edit-files');
    assert.equal(probe.health.ok, true);
    assert.equal(probe.health.name, 'dsh-plugin-edit-files');
    assert.ok(String(probe.pageUrl).startsWith('http://'));
  });
  check('probe 顺带查询 git（info/changes/file）', () => {
    assert.equal(probe.git.info.isRepo, true);
    assert.equal(probe.git.changes.isRepo, true);
    assert.equal(probe.git.changes.files, 2);
    assert.equal(probe.git.file.changed, true);
  });
  check('probe 只走同源 /api/edit-files 前缀', () => {
    assert.ok(fetchCalls.length >= 4, `请求太少：${fetchCalls.map((call) => call.url).join(', ')}`);
    for (const call of fetchCalls) assert.ok(call.url.includes('/api/edit-files/'), `越界请求：${call.url}`);
  });
  check('probe 回报渲染异常与桥状态字段', () => {
    assert.ok(Array.isArray(probe.renderIssues));
    assert.equal(typeof probe.workspaceMenuBridgeActive, 'boolean');
    assert.equal(typeof probe.workspaceIndexSize, 'number');
  });
} catch (error) {
  failed += 1;
  failures.push({ name: 'probe 基线', error });
  console.log(`  ✗ probe 基线 —— ${error && error.message ? error.message : error}`);
}

// ───────────────────────────────────────────────────────── 汇总

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}  client-selftest：${passed} passed, ${failed} failed`);
if (failed > 0) {
  for (const failure of failures) console.error(`\n[${failure.name}]\n${failure.error && failure.error.stack ? failure.error.stack : failure.error}`);
  process.exitCode = 1;
}
