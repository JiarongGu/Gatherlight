# tools/ — Standing utility projects

`tools/<name>/` 放可重用的、长期存在的代码工具。每个工具是独立的 Node 子项目(自己的 `package.json`、`node_modules`、`README.md`),跟 [`viewer/`](../viewer/) 同级。

## 与 scripts/ 的区别

| | `tools/<name>/` | `scripts/` |
|---|---|---|
| 生命周期 | 长期存在,被反复使用 | 一次性,用完即弃 |
| 项目结构 | 独立子项目(`src/`、`package.json`、`tsconfig.json`、`README.md`)| 单文件 `.ts` |
| 依赖管理 | 各自 `node_modules` | 默认无 npm 依赖 |
| 命名 | 名词(`puppeteer`、`ics-gen`、`exchange-rates`)| 动词或场景(`parse-old-budget.ts`)|

判断标准:**会被同一个工具用第二次吗?** 会 → `tools/`;不会 → `scripts/`。

## 现有工具

| 工具 | 用途 | 入口 |
|---|---|---|
| [pdf-form/](pdf-form/) | PDF AcroForm 检视/填充/合并(pdf-lib + fontkit,含 CJK) | `npm run inspect` / `fill` / `merge` |

> 浏览器抓取(scrape / flight_schedule / policy_check / flight_prices / hotel_prices / hotel_info / restaurant_info / wiki_info)已全部移植为 **C#/Playwright 原生工具**,见 [`src/server/.../Modules/Scrapers`](../src/server/Gatherlight.Server/Modules/Scrapers/) 与 [`docs/TOOLS.md`](../docs/TOOLS.md)。原 `tools/puppeteer/` Node 叶子已删除。

## 加一个新工具

1. `tools/<name>/` 建目录,跑 `npm init -y`,加 `tsconfig.json`、`README.md`。
2. 源码放 `tools/<name>/src/`,共享 helper 放 `src/<helper>.ts`。
3. `package.json#scripts` 暴露入口,统一 `tsx src/<entry>.ts` 调用。
4. 输出协议:**stdout = JSON 结果**,**stderr = 日志**。Claude 用 Bash 调用后解析 JSON。
5. 如对应一个高频任务,加 wrapper skill `.claude/skills/<name>/SKILL.md`。
6. 在本 README 加一行表格。
7. 更新 [`.claude/keywords/automation.md`](../.claude/keywords/automation.md) 路由(如属于自动化类)。

## 原则

- **stdout 只输出 JSON 结果**,机器友好。所有人类可读日志走 stderr。
- **CLI 优先**,无 GUI。Claude 用 Bash 调用。
- **错误也是 JSON**:catch 后 emit `{ error: "..." }`,不静默失败。
- **每个工具独立** —— 不共享 `node_modules`,不跨工具 import。要复用代码 → 把代码搬到独立 npm 包,或干脆复制粘贴(`no-throwaway-code` 精神:三行重复 < 一层抽象)。
