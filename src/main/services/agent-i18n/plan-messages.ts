import { localize, normalizeLanguage, type LocalizedText } from './messages';

export type PlanTemplateKey = 'routeGeneration' | 'routeEdit' | 'materialGeneration';

export interface LocalizedPlanTemplate {
  title: string;
  steps: Array<[string, string]>;
}

const TOOL_TITLES: Record<string, LocalizedText> = {
  web_search:                  { zh: '搜索参考资料', en: 'Search references' },
  generate_dag:                { zh: '生成课程路线', en: 'Generate roadmap' },
  update_profile:              { zh: '更新学习档案', en: 'Update learner profile' },
  read_roadmap:                { zh: '读取路线图', en: 'Read roadmap' },
  analyze_dag:                 { zh: '分析路线结构', en: 'Analyze route structure' },
  add_node:                    { zh: '添加路线节点', en: 'Add route node' },
  batch_add_nodes:             { zh: '批量添加节点', en: 'Batch add nodes' },
  remove_node:                 { zh: '删除路线节点', en: 'Remove route node' },
  connect_nodes:               { zh: '连接路线节点', en: 'Connect route nodes' },
  update_node:                 { zh: '更新路线节点', en: 'Update route node' },
  generate_outline:            { zh: '生成知识纲要', en: 'Generate outline' },
  generate_theory:             { zh: '生成原理资料', en: 'Generate theory material' },
  generate_practice:           { zh: '生成实践资料', en: 'Generate practice material' },
  generate_quiz:               { zh: '生成练习计划', en: 'Generate exercise plan' },
  generate_feynman_checklist:  { zh: '生成费曼复盘', en: 'Generate Feynman review' },
  generate_mindmap:            { zh: '生成思维导图', en: 'Generate mind map' },
  generate_external_reference_index: { zh: '生成外部参考索引', en: 'Generate external reference index' },
  read_materials:              { zh: '读取已有资料', en: 'Read existing materials' },
  search_knowledge:            { zh: '检索已有知识', en: 'Search existing knowledge' },
  read_file:                   { zh: '读取文件', en: 'Read file' },
  get_node_progress:           { zh: '读取节点进度', en: 'Read node progress' },
  save_file:                   { zh: '保存文件', en: 'Save file' },
  create_file:                 { zh: '创建文件', en: 'Create file' },
  record_mistake:              { zh: '记录错题', en: 'Record mistake' },
  append_to_notes:             { zh: '追加笔记', en: 'Append notes' },
  generate_topic:              { zh: '生成专题资料', en: 'Generate topic material' },
  search_videos:               { zh: '搜索教学视频', en: 'Search videos' },
};

const PLAN_TEMPLATES: Record<PlanTemplateKey, {
  title: LocalizedText;
  steps: Array<[string, LocalizedText]>;
}> = {
  routeGeneration: {
    title: { zh: '生成课程路线图', en: 'Generate course roadmap' },
    steps: [
      ['prepare_context', { zh: '准备路线上下文', en: 'Prepare route context' }],
      ['retrieve_sources', { zh: '检索路线参考资料', en: 'Retrieve route references' }],
      ['generate_content', { zh: '生成路线结构', en: 'Generate route structure' }],
      ['verify', { zh: '校验路线结构', en: 'Verify route structure' }],
      ['persist_artifacts', { zh: '保存路线图', en: 'Save route graph' }],
      ['emit_result', { zh: '发送生成结果', en: 'Emit result' }],
    ],
  },
  routeEdit: {
    title: { zh: '更新课程路线图', en: 'Update course roadmap' },
    steps: [
      ['inspect_route', { zh: '查看当前路线', en: 'Inspect current route' }],
      ['apply_route_changes', { zh: '执行路线修改', en: 'Apply route changes' }],
      ['refresh_route', { zh: '刷新路线图', en: 'Refresh route graph' }],
    ],
  },
  materialGeneration: {
    title: { zh: '准备节点学习资料', en: 'Prepare node learning material' },
    steps: [
      ['prepare_context', { zh: '准备节点上下文', en: 'Prepare node context' }],
      ['retrieve_sources', { zh: '检索参考资料', en: 'Retrieve references' }],
      ['generate_content', { zh: '生成学习内容', en: 'Generate learning content' }],
      ['verify', { zh: '校验生成内容', en: 'Verify generated content' }],
      ['persist_artifacts', { zh: '保存生成文件', en: 'Save generated files' }],
      ['emit_result', { zh: '发送生成结果', en: 'Emit result' }],
    ],
  },
};

export function getPlanToolTitle(toolName: string, language?: string): string {
  const title = TOOL_TITLES[toolName];
  if (title) return localize(title, language);
  return normalizeLanguage(language) === 'en' ? `Run tool: ${toolName}` : `执行工具：${toolName}`;
}

export function getPlanTemplate(key: PlanTemplateKey, language?: string): LocalizedPlanTemplate {
  const template = PLAN_TEMPLATES[key];
  return {
    title: localize(template.title, language),
    steps: template.steps.map(([id, title]) => [id, localize(title, language)]),
  };
}
