# tools/ — Node leaf tools (server-invoked)

`tools/<name>/` 是**服务端**调用的 Node 叶子工具:一个 C# `IGatherlightTool`(`Modules/Documents/Tools`)把它作为子进程跑起来,再把 stdout 的 JSON 交给调用方。**规划 agent 从不直接调用它们** —— agent 只看得到 MCP 工具名(`pdf_fill`、`fill_itinerary`…),看不到、也进不了这个目录(scope guard 把 agent 关在数据目录里)。

历史上这里是 prototype 的「Claude 用 Bash 跑脚本」目录;现在只剩下一条路径:**server → leaf**。

## 打包(必读)

发布包里**没有** `tools/`。`build-production.mjs` 第 3.8 步用 esbuild 把每个入口打成自包含单文件,放进 `publish/Gatherlight/res/tools/<name>/<entry>.cjs`;目标机器用 `node <entry>.cjs` 跑,**不需要 npm install / npx / tsx / node_modules**。

运行时由 [`ResourcePaths.NodeLeaf`](../src/server/Gatherlight.Server/Modules/Core/Services/ResourcePaths.cs) 定位:先找安装布局的 `res/tools/<name>`,找不到再从 exe 往上走找源码子项目 —— 所以**开发时改 `src/*.ts` 立即生效**,发布时跑的是打好的包。

> ⚠️ 这条曾经漏过:早期 `tools/` 完全没进发布包,`pdf_inspect` / `pdf_fill` / `pdf_merge` / `fill_itinerary` 在**每一个安装版**里都是死的(报 `工具目录不存在:` + 空路径),只有从源码仓库跑才正常。`build-production.mjs` 现在把这四个 `.cjs` 列入必需产物,e2e-p10 也覆盖了打包后的运行形态。

## 现有工具

| 工具 | 用途 | 入口(dev / 发布) | 调用方 |
|---|---|---|---|
| [pdf-form/](pdf-form/) | PDF AcroForm 检视/填充/合并 + 签证行程表(pdf-lib + fontkit,含 CJK) | `npx tsx src/<entry>.ts` / `node <entry>.cjs` | `PdfInspectTool`、`PdfFillTool`、`PdfMergeTool`、`FillItineraryTool` |

> 浏览器抓取(scrape / flight_schedule / policy_check / flight_prices / hotel_prices / hotel_info / restaurant_info / wiki_info)已全部移植为 **C#/Playwright 原生工具**,见 [`src/server/.../Modules/Scrapers`](../src/server/Gatherlight.Server/Modules/Scrapers/) 与 [`docs/TOOLS.md`](../docs/TOOLS.md)。原 `tools/puppeteer/` Node 叶子已删除。**能用原生 C# 写就别加叶子** —— 叶子多一个 Node 依赖、多一份打包责任。

## 加一个新叶子

1. `tools/<name>/`:`package.json` + `tsconfig.json` + `src/<entry>.ts` + `README.md`。
2. `package.json#scripts.build` 用 esbuild 打包:`--bundle --platform=node --format=cjs --out-extension:.js=.cjs --outdir=dist`(照抄 `pdf-form`)。
3. C# 侧:继承 `DocumentToolBase`(或直接用 `FixedNodeLeaf(dir, entry, argv, resourcesPath)`),目录用 `ResolveLeafDir("<name>")`。
4. **把 `<name>` 加进 `build-production.mjs` 3.8 步的叶子列表 + `required()` 必需产物** —— 漏了就是上面那个 bug 重演。
5. 输出协议:**stdout = JSON 结果**,**stderr = 日志**;出错 `{ error: "..." }`,不静默失败。
6. 在本 README 加一行表格,并在 [`docs/TOOLS.md`](../docs/TOOLS.md) 登记 MCP 工具名。

## 原则

- **stdout 只输出 JSON 结果**,机器友好。所有人类可读日志走 stderr。
- **无 GUI、无交互**;参数走 argv,由 C# 侧 `ArgumentList` 传(绝不拼 shell)。
- **每个工具独立** —— 不共享 `node_modules`,不跨工具 import。
- **打包产物是发布契约**:`dist/*.cjs` 必须能在没有 `node_modules` 的机器上单独跑起来。
