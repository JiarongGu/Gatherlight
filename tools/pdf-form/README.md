# pdf-form/ — PDF AcroForm 填充

填表用的 PDF 工具。给一个有 AcroForm 字段的 PDF + 一个 JSON 数据,输出填好的 PDF。主要场景:签证申请 "Travel Itinerary / Schedule of Stay" 这种 16-行表格。

## 首次安装

```bash
cd tools/pdf-form
npm install
```

下载 pdf-lib + fontkit(纯 JS,无 native deps,~5MB)。

## 命令

### `npm run inspect -- <input.pdf>`

报告 PDF 页数、维度、AcroForm 字段名 + 坐标。决定是用 form-fill 还是 text-overlay 方式。

```bash
npx tsx src/inspect.ts .tmp-input-mom-visa-sep2026.pdf
```

输出 JSON: `{ pages, hasForm, fieldCount, fields: [{ name, type, widget: {x,y,w,h} }] }`

### `npm run fill-itinerary -- --in <template.pdf> --data <data.json> --out <filled.pdf>`

填 Travel Itinerary 表(application7.pdf 这种 16-行 visa 表)。需要 AcroForm 字段名匹配:
- `DateRow1..DateRow16`
- `Activity PlanRow1..Activity PlanRow16`(注意空格!)
- `ContactRow1..ContactRow16`
- `AccommodationRow1..AccommodationRow16`
- `Year`, `Month`, `Day`(顶部签名日)

```bash
npx tsx src/fill-itinerary.ts \
  --in .tmp-input-mom-visa-sep2026.pdf \
  --data .tmp-mom-visa-data.json \
  --out .tmp-output-mom-visa-sep2026-filled.pdf
```

数据 JSON 结构:

```json
{
  "applicationDate": { "year": "2026", "month": "05", "day": "27" },
  "rows": [
    {
      "date": "Sep 5 (Sat) 2026",
      "activity": "Arrive Kansai Intl 19:50 via flight XX123. Train to Osaka.",
      "contact": "+81-6-0000-0000",
      "accommodation": "Example Hotel Osaka\n1-1-1 Example-cho, Kita-ku, Osaka\n530-0001"
    }
  ]
}
```

- 8pt 字号(强制),确保行 15-16(更高的字段)不会 auto-scale 过大
- PDF 被 flatten — 字段烧进页面,不可在 Acrobat 中再编辑
- 最多 16 行(visa 表标准)

## 包装 skill

| Skill | 包装 |
|---|---|
| [`/fill-itinerary`](../../.claude/skills/fill-itinerary/SKILL.md) | `src/fill-itinerary.ts`(visa Travel Itinerary 表) |

## 已知坑

1. **Helvetica 不支持 CJK**。中日韩字符在 form 字段中会显示为空白 / 乱码。当前只用英文 / 罗马字 / ASCII 标点。如需 CJK,要先 `pdf.embedFont(notoSansCJK)` + 给 setText 指定字体。
2. **字段必须有 AcroForm 定义**。静态 PDF(扫描件 / 没 form 的 vector PDF)不能用这工具。要用 text-overlay at coordinates,目前没建。
3. **行 15-16 字段更高**(40.68 vs 29.4),pdf-lib 默认 auto-fit 字号会放大,故 `setFontSize(8)` 强制统一。
4. **Address 3 行内**:Vista Premio Kyoto 这种 4+ 行地址会被截。压缩成 hotel name / 街道 / 城市+邮编 三行内。
5. **flatten 不可逆**:flatten 后用户不能在 Acrobat 中编辑。要可编辑则在 `fill-itinerary.ts` 删掉 `form.flatten()`。

## 项目结构

```
tools/pdf-form/
├── package.json
├── tsconfig.json
├── README.md(本文件)
└── src/
    ├── inspect.ts          # 报告 PDF 结构
    └── fill-itinerary.ts   # 填 16-行 visa Travel Itinerary
```

## 加一个新表

例:增加 `fill-financial.ts`(visa 财务证明表)。

1. 跑 `inspect` 确认目标 PDF 的 AcroForm 字段名
2. 新建 `src/fill-financial.ts`,模板自 `fill-itinerary.ts`
3. `package.json#scripts` 加 `"fill-financial": "tsx src/fill-financial.ts"`
4. 本 README 加一节
5. 如对应高频任务,加 wrapper skill `.claude/skills/fill-financial/SKILL.md`

## 验证可用(2026-05-27)

测试样本:application7.pdf(Japan visa Travel Itinerary,67 AcroForm fields,A4 portrait)。16-行 Mom 日本签证申请填好 = `.tmp-output-mom-visa-sep2026-filled.pdf`。
