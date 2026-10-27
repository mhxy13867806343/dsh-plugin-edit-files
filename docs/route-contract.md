# 接口契约 —— Host 路由（`/api/edit-files/*`）与 Client 期望

这份文档是 **Host 半边** 与 **Client 半边** 之间唯一的约定。改形状必须两边同时改。

- 插件包名：`dsh-plugin-edit-files`
- Host 入口：`index.js`（`export const name / inject / apply`）
- Host 只依赖 Node 内置模块（`node:fs`、`node:path`、`node:child_process`、`node:os`、`node:crypto`），不 import 任何 `@deepseek-ai/*` 包。
- 路由注册：`ctx.connection.fetch.register({ path, methods, requestBody: 'buffered', fetch })`，`path` 不带 `/api` 之外的前缀，形如 `/api/edit-files/git/info`。
- 所有响应都是 JSON（`content-type: application/json; charset=utf-8`、`cache-control: no-store`）。
- **永不抛异常到路由之外**：任何失败都返回 `{ ok: false, reason, error? }` + 合适的 HTTP 状态码。
- 参数：`GET` 从 query 取，`POST` 从 JSON body 取；同名字段两种都接受（便于 curl）。
  例外：第 8 节的三个写路由**只认 JSON body**（不读 query），body 缺失或不是 JSON 对象 → 400 `missing-json`。

配置（`cordis.patch.yml` 的 `config`，全部可选）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxFileBytes` | `2097152` | 单个文件读取/保存上限（字节） |
| `maxDiffLines` | `4000` | 单个文件 diff 最多回传行数 |
| `maxChangedFiles` | `3000` | 一次改动列表最多回传条数 |
| `maxTreeEntries` | `20000` | 文件树一次最多回传的条目数（请求 `limit` 只能更小） |
| `treeIgnores` | 见下 | 文件树默认忽略的目录名（数组；`.git` 永远忽略） |

`treeIgnores` 默认值（传非数组回退默认；空数组表示只忽略 `.git`）：

```json
["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".turbo", "target",
 "coverage", ".venv", "venv", "__pycache__", ".pytest_cache", ".cache", ".parcel-cache",
 ".svelte-kit", ".expo", ".output"]
```

---

## 1. `GET /api/edit-files/health`

自检/排障用。

```json
{ "ok": true, "name": "dsh-plugin-edit-files", "version": "0.1.0",
  "routes": ["/api/edit-files/health", "..."], "limits": { "maxFileBytes": 2097152, "maxDiffLines": 4000, "maxChangedFiles": 3000 } }
```

---

## 2. `GET /api/edit-files/git/info?path=<绝对路径>`

`path` 可以是目录，也可以是文件（文件就取 `dirname` 当起点）；从该点向上找仓库根。

```json
{
  "ok": true,
  "isRepo": true,
  "path": "/Users/me/project/src",
  "root": "/Users/me/project",
  "branch": "main",
  "detached": false,
  "upstream": "origin/main",
  "hasUpstream": true,
  "base": "origin/main",
  "baseKind": "upstream",
  "remoteName": "origin",
  "remoteUrl": "git@github.com:me/project.git",
  "head": "abc1234",
  "ahead": 2,
  "behind": 0,
  "gitVersion": "2.50.1"
}
```

- 不是 git 仓库：`{ "ok": true, "isRepo": false, "path": "<原样>" }`，HTTP 200。**这不是错误**，Client 据此隐藏 git 入口。
- 路径不存在：`{ "ok": false, "reason": "not-found" }`，HTTP 404。
- `git` 可执行文件缺失：`{ "ok": false, "reason": "git-unavailable", "error": "..." }`，HTTP 503。

**基准（base）怎么定**（`changes` / `diff` / `file` 三个接口共用，逻辑放在一个函数里）：

1. 有上游（`git rev-parse --abbrev-ref --symbolic-full-name @{u}` 成功）→ `base = upstream`，`baseKind = "upstream"`。
2. 没上游，但有 `origin/HEAD`（`git symbolic-ref refs/remotes/origin/HEAD` 成功）→ `base = origin/HEAD 解析出的 remote/branch`，`baseKind = "remote-head"`。
3. 再退 `base = "HEAD"`，`baseKind = "head"`。
4. 空仓库（HEAD 不存在，`git rev-parse HEAD` 失败）→ `base = null`，`baseKind = "empty"`；此时所有被跟踪外的文件都算 untracked（见下）。

`ahead/behind`：有上游时 `git rev-list --left-right --count <upstream>...HEAD` 的第一个数 = behind、第二个数 = ahead（注意方向别搞反：输出是 `<upstream>...HEAD`，左边是 behind 的提交数，右边是 ahead 的提交数）。没有上游就都回 `null`。

---

## 3. `GET /api/edit-files/git/changes?path=<绝对路径>`

**核心语义：只列出「本地工作区 vs 远程基准」真正不一样的文件。**
`base` 按上面规则取（通常是 `origin/main` 这类远程跟踪分支）。比较方式覆盖「本地已提交但没推的提交」+「未提交的暂存/工作区修改」+「未跟踪的新文件」，统一用：

- 已跟踪：`git -C <root> diff --name-status <base> --`（工作区 vs base，含本地提交和未提交改动）
- 行数：`git -C <root> diff --numstat <base> --`
- 未跟踪：`git -C <root> ls-files --others --exclude-standard`（每条 `status: "A"`, `untracked: true`）

本地改动又被改回与远程一样时，`git diff` 自然不再列它 —— 这正是需求：「改回一样的文件就不展示」。

```json
{
  "ok": true, "isRepo": true,
  "root": "/Users/me/project",
  "branch": "main",
  "base": "origin/main",
  "baseKind": "upstream",
  "upstream": "origin/main",
  "remoteUrl": "git@github.com:me/project.git",
  "ahead": 1, "behind": 0,
  "files": [
    { "path": "src/main.ts", "oldPath": null, "status": "M",
      "additions": 12, "deletions": 3, "binary": false, "untracked": false, "staged": false }
  ],
  "totals": { "files": 1, "additions": 12, "deletions": 3, "untracked": 0 },
  "truncated": false
}
```

- `status` 单字母：`M` / `A` / `D` / `R` / `C` / `T` / `U`；未跟踪一律 `A` + `untracked: true`。
- 重命名：`oldPath` 给原路径，`path` 给新路径；`R100` 这类得分只取首字母。
- 二进制文件 `binary: true`，`additions/deletions` 回 `0`（`--numstat` 给的是 `-`）。
- 排序：`path` 字典序（忽略大小写），稳定。
- 不是仓库：`{ "ok": true, "isRepo": false }`。
- 超过 `maxChangedFiles`：只回前 N 条，`truncated: true`。
- 空仓库：`files` 里把全部文件当 untracked 列出（`ls-files --others` 在空仓库里能列出来）。

---

## 4. `GET /api/edit-files/git/diff?path=<绝对路径>&file=<仓库相对路径>`

`path` 同 info（文件或目录）；`file` 必须来自 `changes` 返回的 `path`。

```json
{
  "ok": true,
  "file": "src/main.ts",
  "status": "M",
  "untracked": false,
  "binary": false,
  "truncated": false,
  "diff": "diff --git a/src/main.ts b/src/main.ts\n...\n@@ -1,3 +1,4 @@\n ...",
  "additions": 12, "deletions": 3,
  "newText": null
}
```

- 已跟踪：`git -C <root> diff --no-color --no-ext-diff --unified=3 <base> -- <file>`。
  若 `<base>` 为 `null`（空仓库）→ 当作 untracked 处理。
- 未跟踪：`diff` 回空串，`newText` 回文件全文（受 `maxFileBytes` 限制，超了 `binary:false` 但 `truncated:true` 且 `newText` 截断到上限）；二进制则 `binary:true`、`newText:null`。
- 已删除文件：正常 diff（`+++ /dev/null`）。
- `diff` 行数超过 `maxDiffLines`：截断到前 N 行，`truncated: true`。
- `file` 解析后不在 `root` 内：`{ "ok": false, "reason": "outside-repo" }`，HTTP 400。
- 文件不存在且不是「已删除」状态：`{ "ok": false, "reason": "not-found" }`，404。
- 不是仓库：`{ "ok": false, "reason": "not-a-repo" }`，400。

---

## 5. `GET /api/edit-files/git/file?path=<绝对文件路径>`

给「右侧文档预览工具栏」「会话行标记」用：快速判断当前文件是否与远程不同。

```json
{ "ok": true, "isRepo": true, "root": "/Users/me/project", "branch": "main",
  "base": "origin/main", "baseKind": "upstream",
  "file": { "path": "src/main.ts", "status": "M", "additions": 12, "deletions": 3,
            "binary": false, "untracked": false, "changed": true } }
```

- 文件与远程一致 → `"file": null`（Client 据此不显示「已改动」标记）。
- 不是仓库：`{ "ok": true, "isRepo": false, "file": null }`。
- 文件路径不存在也可以正常判断（只要目录在仓库里）：`{ "ok": true, "isRepo": true, "file": null }`。

---

## 6. `POST /api/edit-files/file/read` body `{ "path": "<绝对路径>" }`

```json
{ "ok": true, "path": "/abs/file.md", "content": "…", "size": 1234,
  "mtimeMs": 1730000000000, "eol": "lf", "bom": false, "mode": 420 }
```

- 不是普通文件（目录、设备、socket）：`{ "ok": false, "reason": "not-regular-file" }`，400。
- 超过 `maxFileBytes`：`{ "ok": false, "reason": "too-large", "size": 123, "limit": 2097152 }`，413。
- 二进制（前 8 KiB 出现 `\0`，或 UTF-8 解码出现替换符过多）：`{ "ok": false, "reason": "binary" }`，415。
- 不存在：`{ "ok": false, "reason": "not-found" }`，404。
- `content` 是去掉 BOM 的 UTF-8 文本；`eol` = 首个 `\n` 前面是不是 `\r`（`"crlf"` / `"lf"` / `"mixed"`）；`bom` 表示原文有 BOM。

---

## 7. `POST /api/edit-files/file/write` body

```json
{ "path": "/abs/file.md", "content": "新内容", "expectedMtimeMs": 1730000000000,
  "eol": "lf", "bom": false, "force": false }
```

```json
{ "ok": true, "path": "/abs/file.md", "mtimeMs": 1730000000123, "size": 1234,
  "bytes": 1234, "created": false, "unchanged": false }
```

- 乐观并发：`expectedMtimeMs` 给了且与磁盘当前 `mtimeMs` 相差 > 1ms，且 `force !== true`
  → `{ "ok": false, "reason": "conflict", "currentMtimeMs": 1730000000456 }`，409。
- 内容与磁盘完全相同 → 不写盘，回 `unchanged: true`。
- 原子写：同目录临时文件（`.dsh-edit-<pid>-<random>.tmp`）+ `fs.rename`；保留原文件权限位（`mode`）；新建文件用 `0o666 & ~umask`。
- `eol === "crlf"` 时把内容里的 `\n` 统一成 `\r\n`（已经是 `\r\n` 的不重复加）；`bom === true` 时补回 BOM。
- 父目录不存在：`{ "ok": false, "reason": "no-parent" }`，400。
- 超过 `maxFileBytes`：`{ "ok": false, "reason": "too-large" }`，413。
- 目标存在但不是普通文件：`{ "ok": false, "reason": "not-regular-file" }`，400。

---

## Client 侧约定（同一个文件 `client.js`）

- API 前缀常量 `API = '/api/edit-files'`，用相对路径 `fetch`。
- 所有 git 入口先调 `git/info` 或 `git/file`，`isRepo === false` 时**不渲染任何入口**（需求：没有 git 就不展示）。
- 「已改动」的文件才展示 diff；列表为空时显示「与远程一致」。
- 编辑器读盘用 `file/read`、保存用 `file/write`，保存时带 `expectedMtimeMs`（来自 read 或上次 save），遇到 `conflict` 由 UI 让用户选择覆盖。

---

## 8. 工程文件浏览与增删改

「文件」面板用：浏览工作区目录树 + 新建 / 重命名 / 删除。四条路由与第 1-7 节共用响应约定
（JSON、`cache-control: no-store`、永不抛异常）。

**这三个写路由（create / rename / delete）只认 JSON body，不读 query**：写操作不能被一个 URL 触发；
body 缺失、不是合法 JSON、或不是 JSON 对象（数组/`null` 都算）→ 400 `missing-json`。

### 8.1 `GET /api/edit-files/files/tree`

query：`root=<绝对目录>`（必填）、`includeIgnored=1`（可选）、`limit=<正整数>`（可选）。

递归列出 root 下的目录与文件，**平铺**返回：每个条目的 `rel` 是相对 root 的路径，`dir` 是它相对 root
的父目录（空串 = root 层），前端按 `dir === cwd` 过滤即可逐层浏览。

```json
{
  "ok": true,
  "root": "/Users/me/project",
  "entries": [
    { "rel": "src", "name": "src", "dir": "", "type": "dir", "size": 0, "mtimeMs": 1730000000000 },
    { "rel": "src/main.ts", "name": "main.ts", "dir": "src", "type": "file", "size": 123, "mtimeMs": 1730000000000 },
    { "rel": "link", "name": "link", "dir": "", "type": "symlink", "size": 0, "mtimeMs": 1730000000000 }
  ],
  "counts": { "files": 2, "dirs": 3 },
  "truncated": false,
  "ignored": ["node_modules", ".git"],
  "limit": 20000
}
```

- `entries` 按 `rel` 字典序；`type` 只有 `file` / `dir` / `symlink`。
- `counts.files` 统计普通文件与符号链接（所有非目录条目），`counts.dirs` 只统计目录。
- 目录与符号链接的 `size` 固定回 `0`；`mtimeMs` 取 lstat 结果。
- **不跟随符号链接目录**（避免目录环）：符号链接只返回条目本身，不展开；`root` 本身是符号链接目录时可以正常列。
- 默认跳过 `treeIgnores` 里的目录名与**任何层级**名为 `.git` 的条目；`includeIgnored=1` 时展开 `treeIgnores`
  目录，但 `.git` 永远跳过。隐藏文件（`.` 开头）正常返回。
- `ignored`：遍历过程中实际跳过的忽略目录名（去重；按 `treeIgnores` 配置顺序回传，不在列表里的名字追加在末尾），
  供前端显示「已忽略」。
- 条目上限 = `min(请求 limit, maxTreeEntries)`（limit 只能更小）；超出时只回已遍历的前 N 条并置
  `truncated: true`。响应里的 `limit` 是本次生效的上限，供前端显示「只显示前 N 条」。
- 错误：缺 `root` → 400 `missing-root`；`root` 不是绝对路径 → 400 `invalid-path`；
  `root` 不存在 → 404 `not-found`；`root` 不是目录 → 400 `not-directory`。

### 8.2 `POST /api/edit-files/files/create`

body `{ "root": "/abs", "rel": "src/new.ts", "kind": "file" | "dir", "content": "…" }`

- `rel` 是相对 root 的路径；`kind` 只认 `"dir"`，缺省/其它值按 `"file"` 处理。
- 文件可带 `content`（字符串，缺省空串）；UTF-8 字节数超过 `maxFileBytes` → 413 `too-large`（带 `limit`）；
  `content` 不是字符串 → 400 `invalid-path`。
- 文件用 `flag: 'wx'` 创建（并发下也不覆盖），目录用 `mkdir`；目标已存在（含符号链接）→ 409 `already-exists`。
- 父目录不存在或不是目录 → 400 `no-parent`；目标父目录经 realpath 跑出 root（符号链接逃逸）→ 400 `outside-root`。
- 返回 `{ "ok": true, "rel": "src/new.ts", "kind": "file" }`。

### 8.3 `POST /api/edit-files/files/rename`

body `{ "root": "/abs", "from": "a.txt", "to": "dir/a.txt" }`

- 支持同目录改名与移动到 root 内其它目录（文件/目录/符号链接都可以）。
- `from` 不存在 → 404 `not-found`；`to` 已存在 → 409 `target-exists`；`to` 父目录不存在或不是目录 → 400 `no-parent`。
- 目录不能移进自己内部 → 400 `invalid-path`。
- `from` 是逃逸符号链接（真实路径在 root 外）→ 400 `outside-root`；`to` 的父目录是逃逸符号链接同样拒绝。
- 返回 `{ "ok": true, "from": "a.txt", "to": "dir/a.txt" }`（回传规范化后的相对路径）。

### 8.4 `POST /api/edit-files/files/delete`

body `{ "root": "/abs", "rel": "dist", "recursive": true }`

- 文件与符号链接直接删（删的是链接本身，不跟随）；目录必须 `recursive === true`，否则 409 `is-directory-needs-recursive`。
- `rel` 为空串或只有 `.`（等于删 root 本身）→ 400 `root-itself`；`rel` 不存在 → 404 `not-found`。
- `rel` 是逃逸符号链接（真实路径在 root 外）→ 400 `outside-root`，链接与目标都不会被删。
- 返回 `{ "ok": true, "rel": "dist", "recursive": true }`（`recursive` 表示是否按目录递归删除）。

### 8.5 四条路由共用的安全规则

- `root` 必须是绝对路径且是现存目录：缺/空 → 400 `missing-root`；相对路径 → 400 `invalid-path`；
  不存在 → 404 `not-found`；不是目录 → 400 `not-directory`。
- `rel` / `from` / `to` 必须是 root 内的相对路径：
  - 绝对路径、含 NUL 字节 → 400 `invalid-path`；
  - 任何一段是 `..` → 400 `outside-root`（先拒绝，再谈规范化）；
  - 空或只有 `.`（create / rename）→ 400 `missing-rel`（delete 则映射 400 `root-itself`）；
  - 任何一层是 `.git`（大小写不敏感，`.git` 文件或目录都算）→ 403 `protected-path`。
- 已存在路径（delete/rename 的源、create/rename 的目标父目录）先做 `realpath`：真实路径跑出 root
  （符号链接逃逸）→ 400 `outside-root`。悬空符号链接按「操作链接本身」放行。
- 所有 fs 错误都映射成 `{ ok: false, reason, error? }` + 合适状态码，不会把异常抛出路由之外；
  未知错误走 500 `{ "ok": false, "reason": "error", "error": "…" }`。
