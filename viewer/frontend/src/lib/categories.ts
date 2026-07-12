// Single source of truth for 中文 category labels, shared by App header,
// CommandPalette, and Sidebar. Sidebar overrides Budgets/Packing with a
// "(独立)" suffix for its standalone (un-paired) buckets.
export const CATEGORY_LABEL: Record<string, string> = {
  Trips: '旅游',
  Daily: '日程',
  Weekly: '周计划',
  Budgets: '预算',
  Packing: '打包',
  Visa: '签证',
  Household: '家庭',
  Dev: '开发(UI)',
  Templates: '模板',
  Workflows: '流程',
  Index: '索引',
  Rules: '规则',
  Skills: '技能',
  Other: '其他'
};
