# Viewer / 日常规划浏览器

本地 React + Vite + **antd v5** 小应用,用浏览器浏览 `plans/`、`household/`、模板和流程文档。

## 运行

```bash
cd viewer
npm install
npm run dev
```

启动后终端会打印 **两个 URL**:

```
  ➜  Local:   http://localhost:5317/
  ➜  Network: http://192.168.1.42:5317/   ← LAN IP
```

- **本机访问**:Local URL
- **手机 / 平板访问**(同一 WiFi):Network URL — 浏览器输入即可

⚠️ Windows 防火墙首次可能阻挡端口 5317,放行 Node 进程即可。Network URL 的 IP 是电脑当前 LAN IP,换网时会变。

## 路线图 / Route Map(Leaflet + OpenStreetMap)

在任意 plan markdown 文件加 HTML 块:

```markdown
<div class="trip-map" data-cities="osaka,kanazawa,tokyo,takamatsu,naoshima,kyoto"></div>
```

viewer 自动:
- 在 [`src/lib/cityCoords.ts`](src/lib/cityCoords.ts) 查每个城市的 lat/lng
- 渲染 leaflet 地图(OpenStreetMap 免费 tiles)+ 编号 markers(1, 2, 3…)+ polyline 顺序连接
- 自适应 bounds + tooltip(中英文名 + 序号)

**支持的城市**(已加坐标):大阪 / 金泽 / 东京 / 京都 / 奈良 / 宇治 / 高松 / 直岛 / 丰岛 / 冲绳 / 那霸 / 幕张 / 悉尼。

**加新城市**:打开 `src/lib/cityCoords.ts`,加一行:

```ts
saitama: { lat: 35.8617, lng: 139.6455, nameZh: '埼玉', nameEn: 'Saitama' },
```

slug 用 kebab-case 小写,与 markdown `data-cities` 里写的一致。

⚠️ PDF 导出时,leaflet 地图依赖 OpenStreetMap tile 网络请求,**html2pdf 渲染时 tile 可能缺失**(显示空格)。可选:用浏览器自带"打印"截屏地图后嵌入。

## 导出 / 离线查阅

打开任意 `plans/trips/<slug>.md`,主标题下方出现 3 个导出按钮:

| 按钮 | 输出 | 用途 |
|---|---|---|
| 📕 **导出 PDF**(推荐) | `<slug>-export-<date>.pdf`(A4,直接下载)| 手机 / 平板 / 出差离线查阅 — **任何设备无依赖** |
| 📄 **Markdown** | `<slug>-export-<date>.md`(单文件)| 二次编辑、git 版本控制、传给其他工具 |
| 🖨️ **打印** | 浏览器打印对话框 | 直 PDF 失败时备选 |

导出内容(合并到单文件):
1. **🗺️ 行程**(trip)— 全文
2. **💰 预算**(配对 budget)— 全文
3. **🎒 打包**(配对 packing)— 全文
4. **👥 家庭背景快照**(household/*)— 出行家庭成员、偏好、约束、收入、支出

PDF 通过 `marked`(md→html)+ `html2pdf.js`(html→pdf)生成,A4 纵向,含目录链接、表格、checklist、内联图。

## 手机适配(< 768px)

自动切换响应式布局:
- **顶部 sticky header**:汉堡 ☰ 打开文件树 / ⋮ 打开右栏目录
- **文件树 Drawer**(左滑出,85% 宽度):点文件后自动关闭
- **目录 Drawer**(右滑出,80% 宽度):点 heading 后自动滚动 + 关闭
- **主区**:全宽 + 缩小字号 + gallery 2 列布局 + 表格紧凑
- **桌面**(≥ 768px)恢复原 3 栏 Layout

实现:antd `Grid.useBreakpoint()` 检测 `md` 断点 + 条件渲染 Drawer vs Sider。

## 功能

### 三栏布局

- **左栏 — 文件树**:按类别分组(行程 / 日程 / 周计划 / 预算 / 打包 / 家庭 / …),点击切换文件。
- **中栏 — 内容**:Markdown 渲染,含表格、checklist、代码块。
- **右栏 — 目录(TOC)**:当前文件 h1/h2/h3 标题树,点击滚动到对应位置。**长行程文件导航利器**。文件标题少于 2 个时自动隐藏。

### 搜索

- 搜索框匹配:**文件名、文件标题、文件正文**(全文)。
- 命中文件下方显示**匹配预览**(单行带 mark 高亮的片段)。
- 搜索激活时**所有折叠分类自动展开**,避免漏看。

### 分类折叠

- **系统文档默认折叠**:模板 / 流程 / 索引 / 规则 / 技能 (这五类是 Claude 工作配置,平时不查阅)。
- 点击分类标题展开 / 折叠。状态在当前会话内保留(刷新页面重置)。
- 搜索激活时一律展开。

## 原则

- **只读** — 编辑通过 Claude 的工具或你的编辑器;viewer 永远不加编辑 UI。
- **无后端** — Vite `import.meta.glob` 直接读 markdown,无 API、无数据库。
- **无规划逻辑** — viewer 只负责渲染,不计算预算/日期/天气。
- **目录派生于路径前缀** — 加新类别 = 改 [`src/lib/collectFiles.ts`](src/lib/collectFiles.ts) 的 `categorise()` + 中文标签加到 [`src/lib/categories.ts`](src/lib/categories.ts) + (如需在侧栏出现) 改 [`src/shared/components/composite/Sidebar.tsx`](src/shared/components/composite/Sidebar.tsx) 的 category-order 数组。

## 技术栈

| 层 | 用 |
|---|---|
| App shell | **antd `Layout`** (`Sider` + `Content` + `Sider`) |
| 左栏文件树 | **antd `Menu`**(inline,可折叠 group)+ **antd `Input.Search`** + 自定义 snippet 渲染 |
| 右栏 TOC | **antd `Anchor`** + 自定义 scroll-by-text 点击处理 |
| 中栏 markdown | `react-markdown` + `remark-gfm`(GFM 表/任务列表)+ `rehype-raw`(允许嵌 HTML)+ **antd `Image`**(预览 / 缩放)|
| 主题 | **antd ConfigProvider** + `theme.darkAlgorithm` + 中文 locale `zh_CN` |
| 图标 | `@ant-design/icons`(行程 = `CompassOutlined`、家庭 = `HomeOutlined` 等)|

## 文件结构

```
src/
├── main.tsx                     # entry,包 ConfigProvider(暗色主题 + 中文 locale)
├── App.tsx                      # antd Layout 3 栏布局
├── styles.css                   # 主题 token + markdown 内容样式
├── components/
│   ├── Sidebar.tsx              # antd Menu + Input.Search + 高亮 snippet
│   ├── MarkdownView.tsx         # react-markdown + antd Image 替换 img
│   └── TOC.tsx                  # antd Anchor,scroll-by-text
└── lib/
    ├── collectFiles.ts          # 扫描 markdown,分类
    └── markdown.ts              # extractHeadings + extractSnippet
```

## 图片支持

通过 `rehype-raw` 启用 markdown 中的原生 HTML,所有 `<img>` 标签被 **antd `Image` 组件接管**(点击可全屏预览 + 缩放 + 旋转)。三种用法:

### 1. 内联单图(标准 markdown 语法)

```markdown
![兼六园早晨](https://upload.wikimedia.org/wikipedia/commons/thumb/0/0f/Kenrokuen.jpg/640px-Kenrokuen.jpg)
```

自动响应式 + 圆角 + max-width 100%。

### 2. 图片画廊(HTML)

```markdown
<div class="gallery">
  <figure><img src="https://example.com/naoshima-pumpkin.jpg" alt="直岛黄南瓜" /><figcaption>直岛 草间弥生</figcaption></figure>
  <figure><img src="https://example.com/chichu.jpg" alt="地中美术馆" /><figcaption>地中美术馆</figcaption></figure>
  <figure><img src="https://example.com/benesse.jpg" alt="Benesse House" /><figcaption>Benesse House</figcaption></figure>
</div>
```

自适应 grid,每列 180px+,图片裁切 + 标题。

### 3. Hero 图(头图)

```markdown
<div class="hero">
  <img src="https://example.com/japan-hero.jpg" alt="日本松弛行" />
</div>
```

宽幅(max-height 320px,object-fit: cover)。

### 注意

- **图片源**:推荐 Wikipedia Commons(`upload.wikimedia.org`)— 稳定、开放许可。官方旅游局站点 hotlink 可能失效。
- **不要本地路径** — viewer 用 Vite 的 import.meta.glob,本地图片需要额外 import 步骤,目前不支持。
- **alt 必填**:无障碍 + 加载失败时显示文本。
- **不要太大的图** — 单图 > 1MB 影响 viewer 加载。Wikipedia Commons 的 `/thumb/.../640px-*.jpg` 缩略图够用。

## 不做的事

- 编辑 / 同步 / 部署 — 那是别的工具的事。
- 翻译 docs/* 系统文档为中文 — rules/templates 用英文 keyword 做 RAG 索引,翻译会破。系统文档默认折叠是解决"英文满屏"的正解。
- 本地图片托管 — 远程 URL 优先,符合"viewer 是工具不堆功能"的原则。
