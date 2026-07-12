# puppeteer/ — 浏览器自动化工具

基于 Puppeteer(headless Chromium)的本地工具。两个命令:**通用页面抓取** + **Skyscanner 多日期机票比价**。

跟 [`viewer/`](../../viewer/) 一样,是 daily-planner 的 sanctioned standing code,跟其他 `tools/<name>/` 平级。

## 首次安装

```bash
cd tools/puppeteer
npm install
```

**注意:** 会下载 Puppeteer 捆绑的 Chromium(~280 MB)。如担心体积,可改用 `puppeteer-core` + 系统 Chrome 路径(手改源码即可)。

## 命令

### `npm run scrape -- <url> [options]`

通用页面抓取。等 page load + 可选 `--wait-for` selector,然后抓全文或指定 selector。

```bash
# 抓全页文本
npm run scrape -- https://www.senso-ji.jp/about/

# 抓特定区域
npm run scrape -- https://benesse-artsite.jp/en/art/chichu.html --selector "main" --text

# 抓所有链接,JSON 格式带 href
npm run scrape -- https://example.com --selector "a" --json
```

选项:

| 标志 | 默认 | 作用 |
|---|---|---|
| `--selector <css>` | (无) | 抓指定 CSS 选择器,多匹配 → 数组 |
| `--wait-for <css>` | (无) | 抓前等指定元素出现 |
| `--text` | ✓ | 输出 innerText |
| `--html` | | 输出 outerHTML |
| `--json` | | JSON 含 tag/text/href/src |
| `--timeout <ms>` | 30000 | 导航超时 |

### `npm run flight-prices -- <origin> <dest> <d1> <d2> [--also <d3>:<d4>]*`

Skyscanner 多日期机票比价。

```bash
# 本次日本行三组日期对比
npm run flight-prices -- SYD KIX 2026-08-22 2026-09-08 \
  --also 2026-08-29:2026-09-15 \
  --also 2026-08-15:2026-09-01
```

输出 JSON:

```json
{
  "origin": "SYD",
  "destination": "KIX",
  "currency": "AUD",
  "source": "Skyscanner (economy, 1 adult)",
  "rows": [
    {
      "depart": "2026-08-22",
      "return": "2026-09-08",
      "cheapestAUD": 1432,
      "notes": "cheapest of 8 prices on page",
      "url": "https://..."
    }
  ],
  "note": "Indicative prices — verify on Skyscanner before booking."
}
```

## 直接 Claude 调用方式

Claude 通过 Bash 调用,**stdout = JSON**(机器解析),**stderr = 日志**(人类可读):

```bash
cd tools/puppeteer && npm run scrape -- https://example.com
cd tools/puppeteer && npx tsx src/scrape.ts https://example.com   # 等价
```

Claude 把 JSON 结果用进:trip 文件 citation、budget 文件比价表、TBD 项验证。

### `npm run wiki-info -- --file <attractions-json>`

Wikipedia 批量信息提取(per [.claude/rules/tool-first.md](../../.claude/rules/tool-first.md))。

```bash
# 批量提取 Wikipedia 文章信息
echo '[{"name":"Osaka Aquarium Kaiyukan","wikipediaUrl":"https://en.wikipedia.org/wiki/Osaka_Aquarium_Kaiyukan"}]' > .tmp-test-attractions.json
npm run wiki-info -- --file .tmp-test-attractions.json > .tmp-test-attractions-results.json
```

每个条目提取:**summary (首段)** + **imageUrl** (infobox 主图) + **officialUrl** (infobox Website) + **coordinates**。

Use case: 生成 / 重生 `.claude/workflows/<DEST>_ATTRACTIONS.md` 等景点库,**避免 hand-curate from model memory 导致 fabrication**(opening hours / prices / image URLs)。

## 包装 skill

| Skill | 包装 |
|---|---|
| [`/scrape`](../../.claude/skills/scrape/SKILL.md) | `src/scrape.ts` |
| [`/compare-flights`](../../.claude/skills/compare-flights/SKILL.md) | `src/flight-prices.ts` |
| [`/hotel-prices`](../../.claude/skills/hotel-prices/SKILL.md) | `src/hotel-prices.ts` |
| [`/wiki-info`](../../.claude/skills/wiki-info/SKILL.md) | `src/wiki-info.ts` (Wikipedia 批量信息) |
| [`/restaurant-info`](../../.claude/skills/restaurant-info/SKILL.md) | `src/restaurant-info.ts` (餐厅链接验证 + DDG 搜索替代) |
| [`/hotel-info`](../../.claude/skills/hotel-info/SKILL.md) | `src/hotel-info.ts` (酒店 address+phone 多源核验) |
| [`/flight-schedule`](../../.claude/skills/flight-schedule/SKILL.md) | `src/flight-schedule.ts` (航班 schedule 验证 via FlightAware+FlightStats) |
| [`/policy-check`](../../.claude/skills/policy-check/SKILL.md) | `src/policy-check.ts` (签证 / 护照 policy 验证 via MOFA) |

## 项目结构

```
tools/puppeteer/
├── package.json
├── tsconfig.json
├── README.md (this file)
└── src/
    ├── browser.ts          # 共享:launchBrowser / newPage / emit / log
    ├── scrape.ts           # 命令 1:通用抓取
    └── flight-prices.ts    # 命令 2:Skyscanner 比价
```

## 已知坑

1. **Skyscanner 反爬虫严格。** 第一次/前几次抓通常 OK,持续高频会 CAPTCHA。遇到 `cheapestAUD: null` + `notes: CAPTCHA hit` 时,手动到站点确认。
2. **价格是 indicative。** 单成人 economy。订票前必须到原站重核。
3. **每次 query 之间已 sleep 2.5s** 降被检测概率。极端情况可加 `puppeteer-extra-plugin-stealth`。
4. **headless = true。** 调试时改 `src/browser.ts` 里 `headless: false` 看浏览器跑过程。

## 加一个新命令

例:增加 `screenshot` 命令。

1. 新建 `src/screenshot.ts`,顶层 async,JSON 输出 stdout。
2. 用共享的 `import { launchBrowser, newPage, emit, log } from './browser.js'`。
3. `package.json#scripts` 加 `"screenshot": "tsx src/screenshot.ts"`。
4. 本 README 加一节说明。
5. 如对应高频任务,加 `.claude/skills/screenshot/SKILL.md` wrapper。
