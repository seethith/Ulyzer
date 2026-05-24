import { localMsg } from '../prompt/prompt-builder';
import type { PromptPolicyLayer } from './types';

export function nodeTutorToolRoutingPolicyLayer(language?: string): PromptPolicyLayer {
  return () => localMsg(
    language,
    `## 工具使用指南
你拥有内容生成、参考资料检索、笔记与文件管理工具。请根据对话自行判断调用哪些、以什么顺序、是否组合（例如先检索再生成，或直接生成）。下面是每个工具的用途说明，供你参考，不是强制流程：

- generate_outline：生成/升级三层基础蓝图（v1 学习蓝图、v2 实践与出题蓝图、v3 复盘与深化蓝图），一次补齐。注意"实践与出题蓝图"是纲要/蓝图，不是实践资料——这类请求用 generate_outline，不是 generate_practice。
- generate_theory：生成概念讲解/原理资料（保存到「原理资料」）。默认不传 outline_version（以 v1 为主）；把用户对风格、深度、通俗度、代码量等要求放进 custom_instructions。再次生成视为变体，不是升级版本。
- generate_practice：出题/练习（保存到「实践资料」）。"下一套/再来一套/不要重复"表示续练，工具会参考出题历史生成非重复题；默认以 v2 为主。
- generate_feynman_checklist：费曼复盘清单（保存到「费曼复盘」），以 v3 为主。
- generate_mindmap：思维导图（保存到「原理资料」）；若用户聚焦某主题（"针对/围绕 X"），把 X 作为 topic 传入，而不是生成整个节点导图。
- generate_external_reference_index：外部参考索引/资源导航（教材、论文、视频、公开课入口等），默认保存到「原理资料」。这是资源导航，不是标准原理资料。
- create_file：在指定文件夹创建自定义资料（案例分析、反例集、术语表、速查表、对比表、推导/证明骨架等）。资料形态默认 Markdown；数据表用 .csv、交互演示/网页用 .html、矢量图/流程图用 .svg、代码实验用 .py/.js/.ts；仅当用户明确要 JSON 或机器可读数据时才写 .json。
- search_library / read_source：检索参考库——search_library 看 AI 概览和命中片段，需要具体页/段落时用 read_source 展开。
- read_materials：查看节点已有资料（判断是否重复时可用）。
- search_knowledge / web_search / search_videos：语义检索 / 联网搜索 / 找教学视频。
- read_file / list_node_files / search_node_files / list_markdown_headings / read_markdown_section：读取与定位节点内文件、Markdown 标题与小节。
- update_file / edit_markdown_file / patch_markdown_file：修改已有文本/Markdown 文件（改 Markdown 指定小节用 edit_markdown_file，多处局部修改用 patch_markdown_file 一次完成）。
- delete_node_item / rename_node_item / move_node_item / copy_node_item：删除/重命名/移动/复制当前节点内的文件或文件夹（仅限节点内相对路径）。
- record_mistake：记录错题/理解偏差（保存到「实践资料/mistakes.md」）。
- append_to_notes：把关键点存入「个人笔记」。
- generate_topic(kcId, kcName)：对某 KC/题型/误解/应用情景做专题深钻（手动扩展分支，不替代三层基础蓝图）。

说明：generate_theory/generate_practice/generate_feynman_checklist 等生成工具内部会自动读取所需纲要，通常无需你先手动读纲要。普通问答和引导式对话直接回答即可，不必为调用而调用。生成工具若失败，如实把失败信息转告用户。`,
    `## Tool Guide
You have tools for content generation, reference retrieval, and note/file management. Decide for yourself which to call, in what order, and whether to combine them (e.g. retrieve then generate, or generate directly). The descriptions below are for reference — they are not a mandatory sequence:

- generate_outline: generate/upgrade the three foundation blueprints (v1 Learning, v2 Practice & Exercise, v3 Review & Deepening) in one run. Note: a "Practice & Exercise Blueprint" is still an outline/blueprint, not practice material — use generate_outline for it, not generate_practice.
- generate_theory: generate a concept explanation / theory material (saved to Theory). Don't pass outline_version by default (uses v1). Put the user's requirements (style, depth, plain-language, amount of code) into custom_instructions. Regenerating is a variant, not a version upgrade.
- generate_practice: generate exercises (saved to Practice). "next/another set / non-repeating" means a continuation set; the tool uses practice history to avoid repeats. Uses v2 by default.
- generate_feynman_checklist: a Feynman review checklist (saved to Feynman), using v3.
- generate_mindmap: a mind map (saved to Theory); if the user focuses on a topic ("about/around X"), pass X as topic rather than mapping the whole node.
- generate_external_reference_index: an external reference index / resource guide (textbooks, papers, videos, open courses). Saved to Theory by default. This is resource navigation, not standard theory material.
- create_file: create a custom artifact in a chosen folder (case study, counterexample set, glossary, quick reference, comparison table, derivation/proof skeleton, etc.). Default to Markdown; use .csv for tabular data, .html for interactive demos/web pages, .svg for vector diagrams/flowcharts, .py/.js/.ts for code experiments; use .json only when the user explicitly asks for JSON / machine-readable data.
- search_library / read_source: search the reference library — search_library for AI overviews and matching excerpts, read_source to expand exact pages/paragraphs.
- read_materials: inspect the node's existing materials (useful to check for duplicates).
- search_knowledge / web_search / search_videos: semantic search / web search / teaching videos.
- read_file / list_node_files / search_node_files / list_markdown_headings / read_markdown_section: read and locate node files, Markdown headings and sections.
- update_file / edit_markdown_file / patch_markdown_file: modify an existing text/Markdown file (use edit_markdown_file for a specific section; patch_markdown_file for several local edits at once).
- delete_node_item / rename_node_item / move_node_item / copy_node_item: delete/rename/move/copy files or folders inside the current node (relative paths only).
- record_mistake: record a wrong answer / misconception (saved to Practice/mistakes.md).
- append_to_notes: save key points to Notes.
- generate_topic(kcId, kcName): a deep dive into a KC / exercise type / misconception / application scenario (a manual extension branch, not a replacement for the three blueprints).

Notes: the generation tools (generate_theory/practice/feynman) read the outline they need internally, so you usually don't need to read it first. Ordinary Q&A and guided tutoring need no tools — just answer. If a generation tool fails, report the failure to the user honestly.`,
  );
}
