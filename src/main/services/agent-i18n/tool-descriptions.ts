import { localize, type LocalizedText } from './messages';

type ToolPropertyDescriptions = Record<string, LocalizedText>;

interface ToolDescriptionEntry {
  description: LocalizedText;
  properties?: ToolPropertyDescriptions;
}

const TOOL_DESCRIPTIONS = {
  generate_theory: {
    description: {
      zh:
        '【做什么】为当前节点生成完整的理论讲解文档（概念定义、工作原理、代码示例、常见误区），保存到「原理资料」文件夹。' +
        '【何时调用】用户说"讲一下X"/"X是什么意思"/"帮我理解X"/"我不懂这个"/"给我解释一下"/"给我看下原理"/"从头讲讲"，或 AI 判断用户缺乏系统知识背景时。' +
        '【custom_instructions】若用户对格式、侧重点、题型等有具体要求，将用户原话填入此字段完整传递给生成管道。' +
        '【outline_version】原理资料默认由系统按 v1 学习蓝图主导、轻量参考 v2；不要因为已有原理资料就传 v2/v3。只有用户明确说按 outline/纲要 v1/v2/v3 生成时，才填对应版本。' +
        '【限制】生成需要时间，适合系统学习而非单个问题的快速解答；只覆盖当前节点范围，不跨节点；再次生成原理资料表示生成一个变体，不是升级 outline 版本。',
      en:
        'Generate a complete theory explanation for the current node, including concepts, principles, examples, and common pitfalls. Theory material defaults to the v1 Learning Blueprint with light v2 support; do not pass v2/v3 just because theory material already exists. Preserve custom_instructions exactly when present. Pass outline_version only when the user explicitly specifies outline v1/v2/v3. Regenerating theory material means creating a variant, not upgrading the outline version.',
    },
    properties: {
      topic: {
        zh: '聚焦的具体知识点（可不填，默认生成整个节点的理论）',
        en: 'Specific focus topic; omit to cover the whole node.',
      },
      custom_instructions: {
        zh: '用户对资料的具体要求（格式、侧重点、深度等），填入后优先级高于 topic',
        en: 'User-specific requirements for format, focus, or depth. Takes priority over topic.',
      },
      outline_version: {
        zh: '只有用户明确指定 outline/纲要 v1/v2/v3 时填写；未指定请留空，由系统按原理资料默认蓝图选择。',
        en: 'Fill only when the user explicitly specifies outline v1/v2/v3; otherwise omit and let theory-material routing choose the default blueprint.',
      },
    },
  },
  generate_practice: {
    description: {
      zh:
        '【做什么】为当前节点生成一套练习题（基础题→应用题→挑战题），保存到「实践资料」文件夹。' +
        '【何时调用】用户说"出几道题"/"给我练习一下"/"我想做题"/"帮我巩固"/"检验一下我"/"来个测试"/"练练手"/"下一套"/"再来一套"/"继续出题"/"不要重复"，或理论学完后用户想动手实践时。' +
        '【custom_instructions】若用户对题型、难度、格式等有具体要求，将用户原话填入此字段完整传递给生成管道。' +
        '【下一套语义】用户要求下一套/再来一套/继续练时，也调用本工具；不要自己读 outline，工具内部会读取 outline、出题历史和必要的已有资料预览，并生成非重复续练题。' +
        '【outline_version】实践资料默认由系统按 v2 实践与出题蓝图主导、辅以 v1/v3；只有用户明确说按 outline/纲要 v1/v2/v3 出题时，才填对应版本。' +
        '【限制】只生成题目，不批改答案；只覆盖当前节点范围；生成需要一定时间，不适合即问即答。',
      en:
        'Generate practice exercises for the current node, including next/additional/non-repeating sets. Practice material defaults to the v2 Practice & Exercise Blueprint with v1/v3 support and reads practice history internally. Preserve custom_instructions exactly when present. Pass outline_version only when the user explicitly specifies outline v1/v2/v3. This only generates materials for the current node.',
    },
    properties: {
      topic: {
        zh: '练习的具体方向或薄弱知识点（可不填）',
        en: 'Specific practice focus or weak point; optional.',
      },
      custom_instructions: {
        zh: '用户对练习题的具体要求（题型、难度、数量等），填入后优先级高于 topic',
        en: 'User-specific requirements for exercise type, difficulty, count, or format. Takes priority over topic.',
      },
      outline_version: {
        zh: '只有用户明确指定 outline/纲要 v1/v2/v3 时填写；未指定请留空，由系统按实践资料默认蓝图选择。',
        en: 'Fill only when the user explicitly specifies outline v1/v2/v3; otherwise omit and let practice-material routing choose the default blueprint.',
      },
    },
  },
  generate_feynman_checklist: {
    description: {
      zh:
        '【做什么】为当前节点生成深度复盘清单（激活回忆 → 知识点深化问题 → 整合提炼 → 学习过程复盘 → 下一步行动），保存到「费曼复盘」文件夹。' +
        '【何时调用】用户说"我学完了"/"复盘一下"/"检验一下自己"/"费曼一下"/"看看我掌握了没"/"我觉得我懂了，测测我"/"回顾一下"，或整个节点学习完毕时。' +
        '【蓝图】复盘资料默认由系统按 v3 复盘与深化蓝图主导，并参考 v1/v2 的 KC 与练习错误线索；这不是 outline 版本升级。' +
        '【限制】只生成清单，不自动批阅；适合节点学完后的整体巩固与反思，不适合单个知识点的快速问答。',
      en:
        'Generate a deep Feynman review checklist for the current node. Review material defaults to the v3 Review & Deepening Blueprint, with v1/v2 KC and exercise-error cues as support; this is not an outline-version upgrade. Use after the learner says they finished the node or wants to review, self-check, or consolidate. This generates a checklist only and does not grade answers.',
    },
  },
  read_materials: {
    description: {
      zh:
        '【做什么】读取当前节点已有的学习资料（theory/practice/notes/feynman），返回文件名和内容预览。' +
        '【何时调用】用户说"看看我之前的笔记"/"有什么资料"/"look at my notes"/"what materials do I have"，或 AI 要回答涉及已有资料的问题前应先调用以避免重复生成。' +
        '【限制】只能读取当前节点的文件，每个文件只显示前400字预览。' +
        '⚠️ 每个文件仅返回前400字预览，不包含完整题目内容——若用户要求解题、讲解练习题、分析题目内容，必须改用 read_file 工具读取完整文件后再作答，禁止基于预览内容作答。',
      en:
        'Read existing materials for the current node and return file names plus short previews. Use before answering questions that depend on existing notes/materials. Previews are incomplete; use read_file for full exercise or file analysis.',
    },
    properties: {
      folder: {
        zh: '要读取的文件夹（theory/practice/answer/notes/feynman）；不填则读取全部',
        en: 'Folder to read (theory/practice/answer/notes/feynman); omit to read all.',
      },
    },
  },
  save_file: {
    description: {
      zh:
        '将生成的学习资料保存为文件，并自动建立 RAG 索引。content 是完整的 Markdown 内容。' +
        'folderName 必须从以下四个值中选择（严格按对应关系，不得混淆）：' +
        '【theory = 原理资料】概念解析、原理讲解、思维导图；' +
        '【practice = 实践资料】练习题、实操任务；' +
        '【notes = 个人笔记】学习笔记、心得整理、关键点摘要；' +
        '【answer = 参考答案（独立文件夹，与实践资料配对）】参考答案文件；生成实践资料时必须同一响应中同时调用本工具两次，分别保存题目（practice）和参考答案（answer）。' +
        '内容生成完成后必须调用此工具，否则内容不会保留。\n' +
        '【公式格式】数学内容必须使用标准 Markdown + LaTeX：行内公式 `$a+b$`；块级公式 `$$` 单独一行、公式正文、`$$` 单独一行；矩阵/cases/array 换行用 `\\\\`。\n' +
        '【filename 填写规则】theory/practice/answer 只需填写内容描述词（≤6个汉字，无需加类型前缀和日期），系统自动生成完整文件名。' +
        '例如：folderName=theory 时填 "基础概念"，folderName=practice 时填 "全纲要"，folderName=answer 时填 "全纲要"。' +
        'notes 文件夹填写完整文件名（含 .md 扩展名）。',
      en:
        'Save generated learning material as a file and create a RAG index. content must be complete Markdown. Math must use standard Markdown + LaTeX: inline $a+b$, display $$ on separate lines, and matrix/cases/array row breaks as \\\\. folderName must be one of theory, practice, notes, answer. Practice generation must call this twice in the same response: practice for questions and answer for the answer key. For theory/practice/answer, filename should be a short descriptor; the system normalizes the final filename.',
    },
    properties: {
      content: {
        zh: '完整 Markdown 内容',
        en: 'Complete Markdown content.',
      },
      filename: {
        zh: 'theory/practice/answer：内容描述词（≤6个汉字），如"基础概念"、"全纲要"；notes：完整文件名（含.md）',
        en: 'For theory/practice/answer: short content descriptor. For notes: full filename including .md.',
      },
      folderName: {
        zh: 'theory=原理资料 | practice=实践资料 | notes=个人笔记 | answer=参考答案',
        en: 'theory=Theory | practice=Practice | notes=Notes | answer=Answer',
      },
    },
  },
  generate_quiz: {
    description: {
      zh:
        '生成实践资料的 Exercise Blueprint（认知动作 × 题型功能 × KC/掌握证据覆盖）。' +
        '调用后，按返回的 A/B/C/D 组蓝图生成练习册式题目，确保有原型题、变式题、错误诊断题和迁移/综合题。' +
        '调用时机：开始生成实践资料前，用于规划每个知识点/掌握证据对应的认知动作、题型和质量约束；若上下文有结构化题目资产，只能改编题型和答案结构，不要照搬原题。',
      en:
        'Generate an Exercise Blueprint for practice materials: cognitive action × exercise function × KC/mastery-evidence coverage. Call before generating practice materials so the output includes prototype, variation, diagnosis, and transfer/synthesis exercises. If structured exercise assets are present, adapt their patterns and answer structure; do not copy questions.',
    },
    properties: {
      nodeName: {
        zh: '节点名称',
        en: 'Node name.',
      },
      totalCount: {
        zh: '总题目数量（4-20，默认 8）',
        en: 'Total question count, 4-20, default 8.',
      },
    },
  },
  rag_retrieve: {
    description: {
      zh: '检索当前节点已有的参考资料片段。生成内容前必须先调用此工具，了解现有内容以避免重复。返回相关资料片段列表。',
      en: 'Retrieve indexed reference snippets for the current node. Call before generating content to avoid duplicating existing material.',
    },
    properties: {
      query: {
        zh: '检索关键词，通常是概念名称或问题关键词',
        en: 'Search keyword, usually a concept name or question keyword.',
      },
      limit: {
        zh: '返回条数，1-10，默认 5',
        en: 'Number of results, 1-10, default 5.',
      },
    },
  },
  read_roadmap: {
    description: {
      zh: '读取当前课程路线图的最新事实快照，返回章节、节点 ID、状态、难度和前置依赖。需要确认最新节点列表或 ID 时调用；结构质量分析请用 analyze_dag。',
      en: 'Read the latest factual snapshot of the current course roadmap, including chapters, node IDs, statuses, difficulty, and prerequisites. Use when confirming current node lists or IDs; use analyze_dag for quality analysis.',
    },
    properties: {
      chapter: {
        zh: '可选，只读取指定章节；不填则读取全路线图',
        en: 'Optional chapter filter; omit to read the full roadmap.',
      },
      include_edges: {
        zh: '是否返回依赖边列表，默认 true',
        en: 'Whether to include dependency edges; defaults to true.',
      },
    },
  },
  add_node: {
    description: {
      zh:
        '【做什么】在课程路线图中新增一个知识节点，自动连接前置依赖边，路线图实时刷新。' +
        '【何时调用】用户要求添加、补充单个知识点，或规划路线时需要新增一个内容。' +
        '【关键】prerequisites 必须填写上下文中列出的节点 UUID；不填则新节点不与任何节点相连。',
      en:
        'Add one knowledge node to the current course roadmap and optionally connect prerequisite edges. Use for a single added topic. prerequisites must use node UUIDs from context.',
    },
    properties: {
      name: {
        zh: '节点名称，简洁清晰（≤20字）',
        en: 'Short, clear node name.',
      },
      chapter: {
        zh: '所属章节名称（必须与现有章节一致，或新章节名）',
        en: 'Chapter name; use an existing chapter or a new chapter name.',
      },
      description: {
        zh: '节点内容描述（1-2句话）',
        en: 'Brief node description in one or two sentences.',
      },
      difficulty: {
        zh: '难度级别：beginner/intermediate/advanced',
        en: 'Difficulty level: beginner, intermediate, or advanced.',
      },
      node_type: {
        zh: '节点类型：main 为普通节点，boss 为综合考核节点',
        en: 'Node type: main for a normal node, boss for a comprehensive assessment.',
      },
      prerequisites: {
        zh: '前置节点的 UUID 列表，从当前路线图上下文获取',
        en: 'List of prerequisite node UUIDs from the current roadmap context.',
      },
      source_ids: {
        zh: '规划依据来源 ID 列表，从 web_search 返回的 source_id 复制；无来源时为空数组',
        en: 'Planning source IDs copied from source_id values returned by web_search; use an empty array when no source supports the node.',
      },
      rationale: {
        zh: '为什么加入该节点及其依赖位置；只说明学习价值或编排理由',
        en: 'Why this node is included and placed here in the dependency order; describe learning value or sequencing only.',
      },
    },
  },
  batch_add_nodes: {
    description: {
      zh:
        '一次性批量新增多个路线图节点，并统一建立依赖边。适合扩展某章、补充多个知识点或新增一整章。每个新节点必须有唯一 temp_id；prerequisites 可引用已有节点 UUID 或同批次 temp_id。整批事务写入，失败则不产生半成品。',
      en:
        'Add multiple roadmap nodes in one transaction and create dependency edges together. Use for expanding a chapter, adding several topics, or creating a new chapter. Each node must have a unique temp_id; prerequisites may reference existing node UUIDs or temp_ids from the same batch. The whole batch fails without partial writes if validation fails.',
    },
    properties: {
      nodes: {
        zh: '要新增的节点数组，按学习顺序排列；每个节点包含 temp_id、name、chapter、description、difficulty、node_type、prerequisites、source_ids、rationale',
        en: 'Nodes to add, ordered by learning sequence. Each node includes temp_id, name, chapter, description, difficulty, node_type, prerequisites, source_ids, and rationale.',
      },
      temp_id: {
        zh: '本批次内唯一临时 ID，如 n1、n2；供同批次 prerequisites 引用',
        en: 'Unique temporary ID within this batch, such as n1 or n2; used by prerequisites in the same batch.',
      },
      name: {
        zh: '节点名称，简洁清晰（≤20字）',
        en: 'Short, clear node name.',
      },
      chapter: {
        zh: '所属章节名称（必须与现有章节一致，或新章节名）',
        en: 'Chapter name; use an existing chapter or a new chapter name.',
      },
      description: {
        zh: '节点内容描述（1-2句话）',
        en: 'Brief node description in one or two sentences.',
      },
      difficulty: {
        zh: '难度级别：beginner/intermediate/advanced',
        en: 'Difficulty level: beginner, intermediate, or advanced.',
      },
      node_type: {
        zh: '节点类型：main 为普通节点，boss 为综合考核节点',
        en: 'Node type: main for a normal node, boss for a comprehensive assessment.',
      },
      prerequisites: {
        zh: '前置依赖，可填已有节点 UUID 或同批次 temp_id',
        en: 'Prerequisites; use existing node UUIDs or temp_ids from the same batch.',
      },
      source_ids: {
        zh: '规划依据来源 ID 列表，从 web_search/search_library 返回的 source_id 复制；无来源时为空数组',
        en: 'Planning source IDs copied from source_id values returned by web_search/search_library; use an empty array when no source supports the node.',
      },
      rationale: {
        zh: '为什么加入该节点及其依赖位置；只说明学习价值或编排理由',
        en: 'Why this node is included and placed here in the dependency order; describe learning value or sequencing only.',
      },
    },
  },
  remove_node: {
    description: {
      zh: '从当前课程路线图中删除一个节点，并清理关联边和后续节点前置依赖。删除不可撤销，必须使用节点 UUID。',
      en: 'Remove a node from the current course roadmap and clean up related edges and prerequisite references. This is irreversible and requires a node UUID.',
    },
    properties: {
      node_id: {
        zh: '要删除的节点 UUID（从当前路线图上下文获取）',
        en: 'UUID of the node to remove, taken from the roadmap context.',
      },
    },
  },
  connect_nodes: {
    description: {
      zh: '在两个已有节点之间新增一条有向依赖边（source → target），用于补充路线图中的前置关系。不能创建重复边或循环依赖。',
      en: 'Add a directed dependency edge between two existing nodes (source to target). Use to represent prerequisite relationships. Duplicate edges and cycles are not allowed.',
    },
    properties: {
      source_node_id: {
        zh: '源节点 UUID（前置节点，必须先完成）',
        en: 'Source node UUID, the prerequisite node that should be completed first.',
      },
      target_node_id: {
        zh: '目标节点 UUID（后续节点，依赖前置）',
        en: 'Target node UUID, the later node that depends on the source.',
      },
    },
  },
  generate_dag: {
    description: {
      zh:
        '根据学习主题生成完整课程路线图（DAG），包含章节、知识节点和依赖关系。' +
        '如果用户同时提供学习目标、已掌握内容或时间预算，应先调用 update_profile 保存档案。' +
        '生成全新路线图时不要先调用 web_search、search_library 或 read_source；本工具内部会按当前搜索模式统一检索证据。',
      en:
        'Generate a complete course roadmap DAG from a learning topic, including chapters, knowledge nodes, and dependencies. If the user also provides goals, known topics, or time budget, call update_profile first. Do not call web_search, search_library, or read_source before a brand-new roadmap; this tool retrieves evidence internally under the current search mode.',
    },
    properties: {
      topic: {
        zh: '学习主题或课程名称，如"Python机器学习"、"有机化学基础"',
        en: 'Learning topic or course name, such as "Python machine learning".',
      },
    },
  },
  update_profile: {
    description: {
      zh: '当用户表达学习目标、已掌握主题或时间预算时，保存这些信息到课程学习档案。只传用户明确提到的字段。',
      en: 'Save learner profile details for the course when the user mentions goals, known topics, or time budget. Only pass fields explicitly provided by the user.',
    },
    properties: {
      goal_text: {
        zh: '学习目标（想达到什么水平、为什么学）',
        en: 'Learning goal, including desired level or reason for learning.',
      },
      known_topics: {
        zh: '已掌握的主题/技能（如：Python基础、SQL查询）',
        en: 'Topics or skills the learner already knows.',
      },
      time_budget: {
        zh: '时间预算（如：每天2小时，共3个月）',
        en: 'Available time budget, such as two hours per day for three months.',
      },
    },
  },
  analyze_dag: {
    description: {
      zh: '分析当前课程路线图结构质量，包括节点分布、难度曲线、孤立节点、章节平衡和总学时。',
      en: 'Analyze the structure quality of the current course roadmap, including node distribution, difficulty curve, isolated nodes, chapter balance, and total hours.',
    },
  },
  web_search: {
    description: {
      zh: '搜索网络获取权威参考资料，返回按学习资料槽位组织的资料包，包含来源、质量判断、用途概览、证据片段和检索缺口。用于最新官方文档、API 变更、真实课程大纲、权威教材或当前年份的新技术。',
      en: 'Search the web for authoritative references and return a learning-source package with sources, quality judgment, purpose overview, snippets, and gaps. Use for current official docs, API changes, real course outlines, authoritative textbooks, or new technology.',
    },
    properties: {
      query: {
        zh: '搜索关键词（中英文均可，尽量精确）',
        en: 'Precise search query; English or other languages are allowed.',
      },
      maxResults: {
        zh: '返回结果数量，1-5，默认 3',
        en: 'Number of results, 1-5, default 3.',
      },
    },
  },
  web_fetch: {
    description: {
      zh: '抓取用户提供的网页链接，返回清洗后的正文内容（不需要搜索 API）。用户在对话中粘贴了某个网址（博客、官方文档、Stack Overflow、GitHub README 等）希望你阅读/讲解时，或 web_search 返回结果后需要深入读取某条来源正文时调用。只支持 http/https，禁止本地/内网地址；一次只抓一个链接，不要用它做关键词搜索（用 web_search）。',
      en: 'Fetch a user-provided web URL and return its cleaned main text (no search API needed). Use it when the user pastes a link (blog, official docs, Stack Overflow, GitHub README, etc.) and wants you to read/explain it, or to read the full text of a source after web_search. Only http/https is supported; local/internal addresses are blocked; fetch one URL at a time and do not use it for keyword search (use web_search).',
    },
    properties: {
      url: {
        zh: '要抓取的网页完整链接（必须以 http:// 或 https:// 开头）',
        en: 'Full web URL to fetch (must start with http:// or https://).',
      },
    },
  },
  update_node: {
    description: {
      zh: '修改路线图中已有节点的属性（名称、描述、难度、预估时间、章节等）。只更新传入字段，不改变前置依赖关系。',
      en: 'Update properties of an existing roadmap node, such as name, description, difficulty, estimated hours, chapter, or node type. Only provided fields are changed; dependencies are not modified.',
    },
    properties: {
      node_id: {
        zh: '要修改的节点 UUID',
        en: 'UUID of the node to update.',
      },
      name: {
        zh: '新名称',
        en: 'New node name.',
      },
      description: {
        zh: '新描述',
        en: 'New node description.',
      },
      difficulty: {
        zh: '新难度级别：beginner/intermediate/advanced',
        en: 'New difficulty level: beginner, intermediate, or advanced.',
      },
      chapter: {
        zh: '修改所属章节',
        en: 'New chapter name.',
      },
      node_type: {
        zh: '新节点类型：main 或 boss',
        en: 'New node type: main or boss.',
      },
      source_ids: {
        zh: '更新规划依据来源 ID 列表',
        en: 'Updated planning source ID list.',
      },
      rationale: {
        zh: '更新规划依据说明',
        en: 'Updated planning rationale.',
      },
    },
  },
  create_file: {
    description: {
      zh:
        '在当前节点文件夹内自由创建 Markdown 文件或子文件夹，支持多级相对路径。' +
        '用于保存到标准资料文件夹之外的位置。path 不能包含 .. 或绝对路径。默认不覆盖已有文件。',
      en:
        'Create a Markdown file or subfolder inside the current node folder using a relative path. Use for custom locations outside standard material folders. path must not contain parent traversal or an absolute path. Does not overwrite by default.',
    },
    properties: {
      path: {
        zh: '相对于节点文件夹的路径，例如 "草稿/笔记.md" 或 "草稿"（不能含 ..）',
        en: 'Path relative to the node folder, such as "drafts/notes.md" or "drafts". Must not contain parent traversal.',
      },
      content: {
        zh: '文件内容（Markdown 格式）；创建文件夹时留空',
        en: 'File content in Markdown format; omit when creating a folder.',
      },
      isFolder: {
        zh: 'true = 创建文件夹；false 或不填 = 创建文件',
        en: 'true creates a folder; false or omitted creates a file.',
      },
      overwrite: {
        zh: '目标已存在时是否覆盖；默认 false。只有用户明确要求覆盖/替换时才使用 true。',
        en: 'Whether to overwrite an existing target; default false. Use true only when the user explicitly asks to overwrite or replace.',
      },
    },
  },
  read_node_materials: {
    description: {
      zh:
        '直接读取当前节点某个资料文件夹内所有 Markdown 文件的完整内容。' +
        '用于了解已有内容完整覆盖情况，避免重复生成，或在 _index.md 不够详细时补充上下文。',
      en:
        'Read the full Markdown contents of all files in one material folder for the current node. Use to inspect complete coverage, avoid duplicate generation, or supplement an incomplete index.',
    },
    properties: {
      folderName: {
        zh: '稳定文件夹 key：outline/theory/practice/answer/notes/feynman',
        en: 'Stable folder key: outline/theory/practice/answer/notes/feynman.',
      },
    },
  },
  generate_mindmap: {
    description: {
      zh: '为当前节点或用户指定的聚焦方向生成 Mermaid 思维导图，保存到原理资料文件夹。用于整理知识层级结构、局部专题结构或快速可视化概览。',
      en: 'Generate a Mermaid mind map for the current node or a user-specified focus and save it to the Theory folder. Use to visualize full-node structure, a focused subtopic, or a quick overview.',
    },
    properties: {
      topic: {
        zh: '思维导图聚焦的方向。用户说“针对/围绕/关于 X 生成导图”时必须填写 X；不填才默认整个节点。',
        en: 'Mind map focus. When the user asks for a map about/focused on X, pass X here; omit only to cover the whole node.',
      },
    },
  },
  generate_external_reference_index: {
    description: {
      zh:
        '【做什么】为当前节点生成「外部参考索引」Markdown 文件，默认保存到「原理资料」文件夹。索引会围绕当前节点和三层基础蓝图，整理教材/PDF、官方文档、开放课程/视频、论文、开源 notebook、仿真、数据集和真实案例的名称、链接或搜索词、用途、质量风险和导入建议。' +
        '【何时调用】用户说"生成外部参考索引"/"参考资源索引"/"资料导航"/"帮我找教材论文视频链接"/"开放课程和论文入口"/"外部资源清单"时调用。' +
        '【限制】这是资源导航，不是标准原理资料；不要再自动调用 generate_theory。只能使用检索到的具体链接；没有可靠链接时应给搜索词，不要编造 URL。',
      en:
        'Generate an External Reference Index Markdown file for the current node and save it to the Theory folder. It curates textbooks/PDFs, official docs, open courses/videos, papers, notebooks, simulations, datasets, and real cases, with links or search queries, use cases, quality/risk notes, and import suggestions. Use when the user asks for an external reference index, resource guide, or links to textbooks/papers/videos. This is not standard theory material; do not automatically call generate_theory afterward, and do not invent URLs.',
    },
    properties: {
      topic: {
        zh: '可选聚焦方向；用户要求围绕某个 KC、资料类型或场景时填写',
        en: 'Optional focus, such as a KC, resource type, or scenario.',
      },
      custom_instructions: {
        zh: '用户对资源类型、语言、深度、是否偏论文/视频/教材等的具体要求',
        en: 'User requirements for resource type, language, depth, or emphasis such as papers/videos/textbooks.',
      },
    },
  },
  generate_topic: {
    description: {
      zh:
        '为指定 KC、题型、误解或应用情景生成专题纲要，作为三层基础蓝图之外的手动拓展分支保存到纲要文件夹。' +
        '只有用户明确要求专题深钻时调用，不要用它替代 generate_outline。',
      en:
        'Generate a topic outline for a specific KC, exercise type, misconception, or application scenario and save it to the Outline folder. This is a manual extension branch beyond the three foundation blueprints; call it only when the user explicitly asks for a deep dive.',
    },
    properties: {
      kcId: {
        zh: 'KC 编号，如 "KC3"',
        en: 'KC identifier, such as "KC3".',
      },
      kcName: {
        zh: 'KC 名称，如 "变量作用域"',
        en: 'KC name, such as "variable scope".',
      },
    },
  },
  generate_outline: {
    description: {
      zh:
        '为当前节点一次性生成或补齐三层基础蓝图：v1 学习蓝图、v2 实践与出题蓝图、v3 复盘与深化蓝图。' +
        '已有完整三层时不重复生成；旧纲要不会作为新版基础蓝图链路继续升级。工具结果会返回保存路径和预览；除非用户明确要求展示全文，否则不要再调用 read_file/search_knowledge 查找同一纲要。',
      en:
        'Generate or complete the three foundation blueprints for the current node in one run: v1 Learning Blueprint, v2 Practice & Exercise Blueprint, and v3 Review & Deepening Blueprint. If all three already exist, do not regenerate them. Legacy outlines are not upgraded as the new blueprint chain. The result includes saved paths and a preview; do not call read_file/search_knowledge for the same outline unless the user explicitly asks for the full text.',
    },
  },
  search_videos: {
    description: {
      zh: '通过 YouTube Data API 搜索与知识点相关的教学视频，返回标题、链接和频道。无 API Key 时返回空结果而不报错。',
      en: 'Search YouTube for educational videos related to a knowledge point and return titles, links, and channels. If no API key is configured, returns an empty result without failing.',
    },
    properties: {
      query: {
        zh: '搜索关键词，如节点名称或具体知识点',
        en: 'Search query, such as a node name or specific knowledge point.',
      },
      keywords: {
        zh: '附加关键词（可不填）',
        en: 'Optional extra keywords.',
      },
    },
  },
  record_mistake: {
    description: {
      zh: '将一道做错的题追加记录到实践资料的 mistakes.md 错题本，包括题目、错误答案、正确答案和分析。',
      en: 'Append an incorrectly answered exercise to the mistakes.md log in the Practice folder, including the question, learner answer, correct answer, and analysis.',
    },
    properties: {
      question: {
        zh: '题目内容',
        en: 'Question text.',
      },
      my_answer: {
        zh: '用户的错误答案',
        en: "Learner's incorrect answer.",
      },
      correct_answer: {
        zh: '正确答案',
        en: 'Correct answer.',
      },
      analysis: {
        zh: '错误原因分析（AI 可填写）',
        en: 'Optional error analysis provided by the AI.',
      },
    },
  },
  append_to_notes: {
    description: {
      zh: '将对话中值得保留的解释、总结或关键点保存为个人笔记文件。每次调用创建一个新 Markdown 文件。',
      en: 'Save useful explanations, summaries, or key points from the conversation as a new Markdown note in the Notes folder.',
    },
    properties: {
      content: {
        zh: '要保存的笔记内容（Markdown 格式）',
        en: 'Note content in Markdown format.',
      },
      title: {
        zh: '笔记标题，用于生成文件名（可不填）',
        en: 'Optional note title used to generate the filename.',
      },
    },
  },
  read_file: {
    description: {
      zh:
        '读取当前节点某个具体文件的完整内容，而不是预览。' +
        '可直接使用 list_node_files 返回的相对路径，例如 纲要/_outline_v1.md；用户要求解题、讲解练习题或分析题目内容时，应先读取完整文件再回答。',
      en:
        'Read the full contents of a specific file in the current node instead of a preview. You may pass a relative path returned by list_node_files, such as Outline/_outline_v1.md. Use before solving, explaining, or analyzing exercises from a saved file.',
    },
    properties: {
      filename: {
        zh: '文件名或当前节点相对路径，例如 mistakes.md、原理-v1-0420-basics.md、纲要/_outline_v1.md',
        en: 'File name or node-relative path, such as mistakes.md, theory-v1-0420-basics.md, or Outline/_outline_v1.md.',
      },
      folder: {
        zh: '要查找的文件夹（outline/theory/practice/answer/notes/feynman）；不填则搜索全部',
        en: 'Folder to search in (outline/theory/practice/answer/notes/feynman); omit to search all.',
      },
    },
  },
  list_node_files: {
    description: {
      zh:
        '列出当前节点工作区内的文件和文件夹，返回相对路径、类型、大小和更新时间。' +
        '当用户要求查看、修改、删除、重命名或移动文件，而你不确定准确路径时，先调用此工具。',
      en:
        'List files and folders in the current node workspace, including relative paths, type, size, and modified time. Use before editing, deleting, renaming, or moving files when the exact path is uncertain.',
    },
    properties: {
      path: {
        zh: '可选的当前节点内相对路径；不填则列出整个节点工作区',
        en: 'Optional relative path inside the current node; omit to list the whole node workspace.',
      },
    },
  },
  search_node_files: {
    description: {
      zh:
        '在当前节点工作区内搜索文件名、Markdown 标题和正文片段，返回相对路径、匹配类型、行号和短片段。' +
        '当用户说“找一下某内容在哪个文件”“把包含 X 的地方改掉”“我不确定文件名”时，先调用此工具定位。',
      en:
        'Search file names, Markdown headings, and text snippets inside the current node workspace. Returns relative paths, match type, line numbers, and snippets. Use when the file or edit location is uncertain.',
    },
    properties: {
      query: {
        zh: '要搜索的关键词或短语',
        en: 'Keyword or phrase to search for.',
      },
      path: {
        zh: '可选，限制在当前节点内某个相对路径下搜索',
        en: 'Optional node-relative path to limit the search.',
      },
      include_content: {
        zh: '是否搜索正文内容；默认 true。只想找文件名时可设为 false。',
        en: 'Whether to search file contents; default true. Set false to search file names only.',
      },
      max_results: {
        zh: '最多返回结果数，1-50，默认 30',
        en: 'Maximum number of results, 1-50, default 30.',
      },
      extensions: {
        zh: '可选扩展名过滤，如 [".md", ".txt"]',
        en: 'Optional extension filter, such as [".md", ".txt"].',
      },
    },
  },
  list_markdown_headings: {
    description: {
      zh: '列出当前节点内某个 Markdown 文件的标题树、层级和行号。修改长 md 文件前应先用它确认目标小节。',
      en: 'List the heading tree, levels, and line numbers of a Markdown file in the current node. Use before editing long Markdown files.',
    },
    properties: {
      path: {
        zh: '当前节点内 Markdown 文件的相对路径',
        en: 'Node-relative Markdown file path.',
      },
      max_headings: {
        zh: '最多返回标题数，默认 120',
        en: 'Maximum headings to return, default 120.',
      },
    },
  },
  read_markdown_section: {
    description: {
      zh: '按标题精准读取当前节点内某个 Markdown 小节，适合长文局部理解和修改前确认上下文。',
      en: 'Read a specific Markdown section by heading inside the current node. Use to inspect local context before editing long files.',
    },
    properties: {
      path: {
        zh: '当前节点内 Markdown 文件的相对路径',
        en: 'Node-relative Markdown file path.',
      },
      heading: {
        zh: '要读取的小节标题或唯一关键词',
        en: 'Section heading or unique heading substring.',
      },
      heading_level: {
        zh: '可选，限制标题层级 1-6；同名标题较多时使用',
        en: 'Optional heading level 1-6 for disambiguation.',
      },
      include_heading: {
        zh: '是否包含标题行；默认 true',
        en: 'Whether to include the heading line; default true.',
      },
      max_chars: {
        zh: '最多返回字符数，默认 12000，最大 20000',
        en: 'Maximum returned characters, default 12000, max 20000.',
      },
    },
  },
  update_file: {
    description: {
      zh:
        '修改当前节点内已有文本文件。仅支持当前节点工作区内的相对路径，不能访问节点外文件。' +
        '支持整文件替换、追加内容、精确替换一段文本。replace_text 找不到或匹配多处会失败。',
      en:
        'Update an existing text file inside the current node workspace. Only relative paths inside this node are allowed. Supports full replacement, append, and exact single text replacement; replace_text fails if the search text is missing or ambiguous.',
    },
    properties: {
      path: {
        zh: '当前节点内的相对文件路径，建议来自 list_node_files',
        en: 'Relative file path inside the current node, preferably from list_node_files.',
      },
      operation: {
        zh: 'replace_all=整文件替换；append=追加；replace_text=精确替换一段文本',
        en: 'replace_all=replace entire file; append=append content; replace_text=replace one exact text segment.',
      },
      content: {
        zh: 'replace_all 或 append 使用的内容',
        en: 'Content for replace_all or append.',
      },
      search: {
        zh: 'replace_text 要查找的原文，必须在文件中只出现一次',
        en: 'Original text for replace_text; must appear exactly once.',
      },
      replacement: {
        zh: 'replace_text 的替换文本；不填则替换为空',
        en: 'Replacement text for replace_text; omit to replace with empty text.',
      },
    },
  },
  edit_markdown_file: {
    description: {
      zh:
        '按 Markdown 标题结构修改当前节点内已有 .md 文件。适合用户说“在第二步后加一段”“把某小节替换掉”“在某标题前插入内容”。' +
        '会按标题定位；找不到标题或匹配多个标题会失败，避免写错位置。修改前若路径不确定，先调用 list_node_files/read_file。',
      en:
        'Edit an existing Markdown file inside the current node by heading structure. Use for requests like inserting after a section, appending to a heading, or replacing a section. It fails when the heading is missing or ambiguous. If the path is uncertain, call list_node_files/read_file first.',
    },
    properties: {
      path: {
        zh: '当前节点内 Markdown 文件的相对路径，建议来自当前打开文件上下文或 list_node_files',
        en: 'Node-relative Markdown path, preferably from the active file context or list_node_files.',
      },
      operation: {
        zh: 'insert_after_heading=标题行后插入；append_to_section=小节末尾插入；insert_before_heading=标题前插入；replace_section=替换该标题下整个小节正文',
        en: 'insert_after_heading=insert right after the heading line; append_to_section=insert at the end of that section; insert_before_heading=insert before the heading; replace_section=replace that section body.',
      },
      heading: {
        zh: '用于定位的标题文字，可填标题中的唯一关键词，如“第二步”或“4.5 对称矩阵的判定练习”',
        en: 'Heading text or a unique substring, such as "Step 2" or "4.5 Symmetric matrix practice".',
      },
      heading_level: {
        zh: '可选，限制标题层级 1-6；同名标题较多时使用',
        en: 'Optional heading level 1-6 to disambiguate headings.',
      },
      content: {
        zh: '要插入或替换的小节正文，Markdown 格式；不要重复写外层标题，除非你确实要插入新标题',
        en: 'Markdown body to insert or replace. Do not repeat the outer heading unless intentionally inserting a new heading.',
      },
    },
  },
  patch_markdown_file: {
    description: {
      zh:
        '对当前节点内已有 Markdown 文件执行一组原子化补丁操作。支持按标题插入/追加/替换小节，也支持精确 replace_text。' +
        '任一操作找不到、匹配多处或有风险时整体失败，不会写入半成品。适合一次完成多个局部修改。',
      en:
        'Apply an atomic batch of patches to an existing Markdown file inside the current node. Supports heading-based insert/append/replace and exact replace_text. If any operation is missing or ambiguous, the whole patch fails without partial writes.',
    },
    properties: {
      path: {
        zh: '当前节点内 Markdown 文件的相对路径',
        en: 'Node-relative Markdown file path.',
      },
      operations: {
        zh: '补丁操作数组，1-20 个；每个操作使用 operation 指定类型',
        en: 'Array of patch operations, 1-20 items. Each item uses operation to specify the action.',
      },
      operation: {
        zh: 'insert_after_heading、append_to_section、insert_before_heading、replace_section 或 replace_text',
        en: 'insert_after_heading, append_to_section, insert_before_heading, replace_section, or replace_text.',
      },
      heading: {
        zh: '标题定位文字；标题类操作必填',
        en: 'Heading locator text; required for heading-based operations.',
      },
      heading_level: {
        zh: '可选标题层级 1-6，用于消歧',
        en: 'Optional heading level 1-6 for disambiguation.',
      },
      content: {
        zh: '要插入或替换的小节正文；标题类操作必填',
        en: 'Markdown body to insert or replace; required for heading-based operations.',
      },
      search: {
        zh: 'replace_text 要查找的原文，必须只出现一次',
        en: 'Text to find for replace_text; must appear exactly once.',
      },
      replacement: {
        zh: 'replace_text 的替换文本；不填则删除',
        en: 'Replacement for replace_text; omitted means delete.',
      },
    },
  },
  delete_node_item: {
    description: {
      zh:
        '删除当前节点工作区内的文件或自定义子文件夹。只能用当前节点内相对路径；不能删除节点根目录，也不能删除标准资料根文件夹本身。用户明确要求删除时可直接调用。',
      en:
        'Delete a file or custom subfolder inside the current node workspace. Only relative paths are allowed; cannot delete the node root or standard material root folders. Call directly when the user asks to delete.',
    },
    properties: {
      path: {
        zh: '要删除的当前节点内相对路径，建议来自 list_node_files',
        en: 'Relative path to delete, preferably from list_node_files.',
      },
    },
  },
  rename_node_item: {
    description: {
      zh:
        '重命名当前节点工作区内的文件或自定义子文件夹。不能重命名节点根目录或标准资料根文件夹本身；目标已存在时失败。用户明确要求重命名时可直接调用。',
      en:
        'Rename a file or custom subfolder inside the current node workspace. Cannot rename the node root or standard material root folders; fails if the target exists. Call directly when the user asks to rename.',
    },
    properties: {
      path: {
        zh: '要重命名的当前节点内相对路径，建议来自 list_node_files',
        en: 'Relative path to rename, preferably from list_node_files.',
      },
      new_name: {
        zh: '新的文件名或文件夹名，只能是单个名称，不能包含 / 或 ..',
        en: 'New file or folder name; must be one simple name without / or ..',
      },
    },
  },
  move_node_item: {
    description: {
      zh:
        '移动当前节点工作区内的文件或自定义子文件夹到另一个相对路径。不能移动节点根目录或标准资料根文件夹本身；目标已存在时失败。用户明确要求移动时可直接调用。',
      en:
        'Move a file or custom subfolder inside the current node workspace to another relative path. Cannot move the node root or standard material root folders; fails if the target exists. Call directly when the user asks to move.',
    },
    properties: {
      path: {
        zh: '要移动的当前节点内相对路径，建议来自 list_node_files',
        en: 'Relative source path to move, preferably from list_node_files.',
      },
      destination_path: {
        zh: '目标相对路径，包含最终文件名或文件夹名；不能是绝对路径或包含 ..',
        en: 'Destination relative path including the final file or folder name; must not be absolute or contain ..',
      },
    },
  },
  copy_node_item: {
    description: {
      zh:
        '复制当前节点工作区内的文件或自定义子文件夹到另一个相对路径。默认不覆盖目标；目标已存在时失败，除非用户明确要求覆盖并设置 overwrite=true。',
      en:
        'Copy a file or custom subfolder inside the current node workspace to another relative path. Does not overwrite by default; fails if the target exists unless overwrite=true is explicitly used.',
    },
    properties: {
      path: {
        zh: '要复制的当前节点内相对路径，建议来自 search_node_files/list_node_files',
        en: 'Relative source path to copy, preferably from search_node_files/list_node_files.',
      },
      destination_path: {
        zh: '目标相对路径，包含最终文件名或文件夹名；不能是绝对路径或包含 ..',
        en: 'Destination relative path including the final file or folder name; must not be absolute or contain ..',
      },
      overwrite: {
        zh: '目标已存在时是否覆盖；默认 false，只有用户明确要求覆盖时使用 true',
        en: 'Whether to overwrite an existing target; default false. Use true only when explicitly requested.',
      },
    },
  },
  search_knowledge: {
    description: {
      zh: '语义检索当前节点已索引的所有资料，返回与查询最相关的片段而非全文。',
      en: 'Semantically search all indexed materials for the current node and return the most relevant snippets rather than full files.',
    },
    properties: {
      query: {
        zh: '检索关键词或问题描述',
        en: 'Search keyword or question description.',
      },
    },
  },
  search_library: {
    description: {
      zh: '检索当前可见参考库，返回最相关的参考资料来源、AI 概览（资料语义预处理）和片段摘要。先依据 AI 概览判断资料是否值得展开，需要具体页/段落时再调用 read_source。',
      en: 'Search the currently visible source library and return the most relevant sources, AI overview/semantic profile, and excerpt summaries. Use the overview first to decide whether the source is worth expanding; call read_source only when exact pages or paragraphs are needed.',
    },
    properties: {
      query: {
        zh: '参考库检索关键词或问题',
        en: 'Library search query or question.',
      },
      limit: {
        zh: '返回参考资料条数，1-8，默认 5',
        en: 'Number of sources to return, 1-8, default 5.',
      },
    },
  },
  read_source: {
    description: {
      zh: '展开阅读某条资料的更完整片段。通常先用 search_library 查看 AI 概览并找到 source_id；确认需要正文细节后，再对 PDF/文档指定 page、page_start/page_end 或 unit_index 精读具体范围。',
      en: 'Read fuller excerpts from a specific source. Usually inspect the AI overview from search_library first, then call this only when body details are needed; for PDFs/documents, pass page, page_start/page_end, or unit_index to inspect a precise range.',
    },
    properties: {
      source_id: {
        zh: 'search_library 返回的 source_id',
        en: 'The source_id returned by search_library.',
      },
      max_chunks: {
        zh: '展开片段数量，1-8，默认 5',
        en: 'Number of excerpts to expand, 1-8, default 5.',
      },
      page: {
        zh: '读取单页页码，适用于 PDF 等分页文档',
        en: 'Single page number to read, for paginated documents such as PDFs.',
      },
      page_start: {
        zh: '读取页码范围起点，适用于 PDF 等分页文档',
        en: 'Start page for a page range, for paginated documents such as PDFs.',
      },
      page_end: {
        zh: '读取页码范围终点，适用于 PDF 等分页文档',
        en: 'End page for a page range, for paginated documents such as PDFs.',
      },
      unit_index: {
        zh: '读取结构化文档单元索引，0 开始；适用于非分页文档',
        en: 'Structured document unit index to read, 0-based; useful for non-paginated documents.',
      },
      max_blocks: {
        zh: '最多返回内容块数量，1-120，默认 36',
        en: 'Maximum number of document blocks to return, 1-120, default 36.',
      },
    },
  },
  get_node_progress: {
    description: {
      zh: '获取当前课程所有节点的学习进度、已生成资料数量和是否有错题记录，用于分析薄弱环节。',
      en: 'Get learning progress for all nodes in the current course, including status, material counts, and whether mistake logs exist. Use to identify weak areas.',
    },
  },
  write_todos: {
    description: {
      zh:
        '【做什么】维护一份贯穿整个任务的待办清单，让你和用户都清楚多步骤工作进行到哪一步。每次调用都用完整列表覆盖旧列表。' +
        '【何时调用】接到需要多步骤完成的复合任务时，先用本工具写下计划；每完成一步就更新对应项的状态。' +
        '【关键】只要清单里还有 pending/in_progress 项，系统就会让你继续工作而不会提前结束；完成或放弃某项时务必更新状态，避免空转。' +
        '【限制】简单的一步到位问答不需要建清单。',
      en:
        'Maintain a task checklist that persists across the whole job so both you and the user can see multi-step progress. Each call replaces the full list. ' +
        'Use it at the start of any multi-step task and update item statuses as you go. While any item is pending/in_progress the loop keeps you working instead of ending early, so always update statuses when an item is done or dropped. Skip it for simple one-shot answers.',
    },
    properties: {
      todos: {
        zh: '完整的待办项数组；每项含 content（要做什么）与 status（pending/in_progress/completed/cancelled）',
        en: 'The full array of todos; each has content (what to do) and status (pending/in_progress/completed/cancelled).',
      },
    },
  },
  spawn_subtask: {
    description: {
      zh:
        '【做什么】派出一个上下文隔离的子 agent 独立完成一个聚焦的子任务，子 agent 完成后只把简洁结论回报给你，不会污染当前对话上下文。' +
        '【何时调用】当某个子任务需要较多自有步骤（多次检索、读多个文件、整理后写入）、且其中间过程对主线无价值时。' +
        '【限制】子 agent 不能再派子任务；为控制成本请给出明确目标和必要的工具范围。',
      en:
        'Spawn a context-isolated sub-agent to complete one focused sub-task; it reports back only a concise result and does not pollute the current conversation context. ' +
        'Use it when a sub-task needs many of its own steps (multiple retrievals, reading several files, then writing) whose intermediate process has no value to the main thread. Sub-agents cannot spawn further sub-agents; give a clear objective and a minimal tool scope to control cost.',
    },
    properties: {
      objective: {
        zh: '子任务的明确目标（要完成什么、产出什么）',
        en: 'The clear objective of the sub-task (what to accomplish and produce).',
      },
      tools: {
        zh: '可选，限定子 agent 可用的工具名数组；不填则给一组安全的只读 + 必要工具',
        en: 'Optional array of tool names the sub-agent may use; omit for a safe read-only + essential default set.',
      },
      max_turns: {
        zh: '可选，子 agent 的最大轮数上限（默认 15）',
        en: 'Optional max turn ceiling for the sub-agent (default 15).',
      },
    },
  },
} as const satisfies Record<string, ToolDescriptionEntry>;

export type ToolDescriptionKey = keyof typeof TOOL_DESCRIPTIONS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

export function hasToolDescription(toolName: string): toolName is ToolDescriptionKey {
  return Object.prototype.hasOwnProperty.call(TOOL_DESCRIPTIONS, toolName);
}

export function hasToolPropertyDescription(
  toolName: string,
  propertyName: string,
): toolName is ToolDescriptionKey {
  if (!hasToolDescription(toolName)) return false;
  const entry = TOOL_DESCRIPTIONS[toolName] as ToolDescriptionEntry;
  return Object.prototype.hasOwnProperty.call(entry.properties ?? {}, propertyName);
}

export function toolDescription(toolName: ToolDescriptionKey, language?: string): string {
  return localize(TOOL_DESCRIPTIONS[toolName].description, language);
}

export function toolPropertyDescription(
  toolName: ToolDescriptionKey,
  propertyName: string,
  language?: string,
): string {
  const entry = TOOL_DESCRIPTIONS[toolName] as ToolDescriptionEntry;
  const properties = entry.properties;
  const property = properties?.[propertyName];
  return property ? localize(property, language) : propertyName;
}

export function localizeToolDefinition(
  toolName: string,
  fallbackDescription: string,
  inputSchema: Record<string, unknown>,
  language?: string,
): { description: string; inputSchema: Record<string, unknown> } {
  const description = hasToolDescription(toolName)
    ? toolDescription(toolName, language)
    : fallbackDescription;
  const localizedSchema = cloneSchema(inputSchema);

  function localizeProperties(schema: Record<string, unknown>): void {
    const nestedProperties = isRecord(schema.properties) ? schema.properties : undefined;
    if (nestedProperties) {
      for (const [propertyName, propertySchema] of Object.entries(nestedProperties)) {
        if (isRecord(propertySchema)) {
          if (hasToolPropertyDescription(toolName, propertyName)) {
            propertySchema.description = toolPropertyDescription(toolName, propertyName, language);
          }
          localizeProperties(propertySchema);
        }
      }
    }
    if (isRecord(schema.items)) localizeProperties(schema.items);
  }

  localizeProperties(localizedSchema);

  return { description, inputSchema: localizedSchema };
}
