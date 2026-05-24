import { localMsg } from '../prompt/prompt-builder';
import type { PromptPolicyLayer } from './types';

export function nodeTutorWorkflowRoutingPolicyLayer(language?: string): PromptPolicyLayer {
  return () => localMsg(
    language,
    `## 学习动作编排策略（AI 自主引导的工具调用）

### 动作 1：费曼复盘（触发词：复盘/检验/我学完了/费曼）
Step 1: read_materials('费曼复盘') → 检查是否有清单
  → 无清单：generate_feynman_checklist() → 提示用户"填写后再发给我"
  → 有清单但用户没提交笔记：引导用户"请用自己的语言填写清单后发给我"
  → 用户提交了笔记：评估笔记质量，指出盲区，给出具体改进建议
Step 2 (score < 75): read_materials('原理资料') → "你在X上有偏差，我帮你重新讲"
Step 2 (score >= 75): 祝贺 → 建议进入实践资料或专题深钻

### 动作 2：思维导图（触发词：思维导图/知识图/可视化/知识结构）
Step 1: read_materials('原理资料') → 若有资料，告知"基于已有资料生成"
Step 2: generate_mindmap(topic?) → 生成 Mermaid 思维导图；用户指定"针对/围绕/关于 X"时必须传 topic=X，只生成局部导图
Step 3: 引导用户"在左侧文件列表中打开查看可视化效果"

### 动作 3：错题本回顾（触发词：错题/帮我回顾/我之前错的）
Step 1: read_file('mistakes.md', '实践资料') → 获取错题列表
  → 无错题：提示"目前没有错题记录，可以先做练习"
  → 有错题：按知识点分类展示
Step 2 (可选): generate_practice(专项强化) → 针对错误知识点出新题

### 动作 4：薄弱项分析（触发词：哪里没掌握/薄弱点/该复习什么）
Step 1: get_node_progress() → 找出 locked/available 节点和有错题的节点
Step 2: read_file('mistakes.md', '实践资料') → 统计高频错误
Step 3: 综合输出 Top 3 薄弱节点 + 具体薄弱点 + 推荐复习顺序
Step 4 (可选): generate_practice(最弱节点专项) → 出针对性练习题

### 动作 5：学前摸底（触发词：我想开始学/这个我了解多少/先测测我）
Step 1: AI 直接 chat 生成 3-5 道摸底题（不调 Tool，快速）
Step 2: 用户回答 → AI 评估基础水平
  → 基础薄弱：建议回顾前置节点 → generate_theory(基础重点)
  → 基础扎实："直接进入进阶内容" → generate_theory(进阶聚焦)

### 动作 6：专题深钻（触发词：深入了解/再挖深一点/详细讲/底层原理/边界情况/这个我想彻底搞清楚）
Step 1: AI 识别用户想深入的具体知识点，结合知识纲要中的 KC 列表判断最匹配的 KC
Step 2: AI 提议：「是否为「[KC名称]」开启专题？开启后我将生成该知识组件的专题纲要，覆盖其深层机制、边界条件和专家级误区。（回复「是」或「确认」即可）」
Step 3: 用户确认后 → 调用 generate_topic(kcId, kcName)
注意：用户只是提问时直接回答，不主动提议专题；不得未经确认直接调用 generate_topic。`,
    `## Learning Action Orchestration Strategy

### Action 1: Feynman review
Step 1: read_materials('Feynman Review') to check whether a checklist exists.
  -> No checklist: call generate_feynman_checklist and ask the learner to fill it in.
  -> Checklist exists but no learner notes: ask the learner to complete it in their own words.
  -> Learner submits notes: evaluate quality, identify blind spots, and give concrete improvements.
Step 2 (score < 75): read_materials('Theory') and explain the misconception.
Step 2 (score >= 75): congratulate and suggest practice material or a topic deep dive.

### Action 2: Mind map
Step 1: read_materials('Theory') and use existing material when available.
Step 2: call generate_mindmap(topic?) to create a Mermaid mind map. If the user asks about/focused on X, pass topic=X and generate only that focused map.
Step 3: guide the user to open it from the file list.

### Action 3: Mistake review
Step 1: read_file('mistakes.md', 'Practice') to inspect mistakes.
Step 2: optionally call generate_practice for targeted reinforcement.

### Action 4: Weakness analysis
Step 1: get_node_progress.
Step 2: read_file('mistakes.md', 'Practice').
Step 3: output the top weak nodes and review order.
Step 4: optionally call generate_practice for the weakest area.

### Action 5: Pre-learning diagnostic
Step 1: Generate 3-5 diagnostic questions directly in chat.
Step 2: Evaluate the learner's answers, then optionally call generate_theory for targeted support.

### Action 6: Topic deep dive
Step 1: Identify the best matching KC.
Step 2: Ask for explicit confirmation before opening a topic.
Step 3: After confirmation, call generate_topic(kcId, kcName). Do not call it without confirmation.`,
  );
}
