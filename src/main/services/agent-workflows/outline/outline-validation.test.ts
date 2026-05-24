import { describe, expect, it } from 'vitest';
import { validateOutlineStructure } from './outline-validation';

describe('outline validation', () => {
  it('accepts a complete KC outline', () => {
    const result = validateOutlineStructure(`# 知识纲要 — 示例（v1）

## 知识单元（KCs）

### KC1: 基本概念
- 类型：陈述性
- 布鲁姆层级：记忆/理解
- 前置KC：无
- 掌握指标：能用自己的话解释核心概念并指出一个典型例子。

### KC2: 操作步骤
- 类型：程序性
- 布鲁姆层级：应用
- 前置KC：KC1
- 掌握指标：能在给定情境下独立完成完整步骤并检查结果是否合理。

## 常见误解（Misconceptions）
1. 误解：把定义和操作混为一谈。 实际：二者分别回答是什么和怎么做。
2. 误解：只记结论即可。 实际：需要能解释适用条件。

## 边界条件
- 当输入条件不满足时，步骤需要先调整再执行。
`, '2-3', 1);

    expect(result.passed).toBe(true);
  });

  it('rejects a truncated outline', () => {
    const result = validateOutlineStructure(`# 知识纲要 — 示例（v1）

## 知识单元（KCs）

### KC1: 基本概念
- 类型：陈述性
- 布鲁姆层级：记忆/理解
- 前置KC：无
- 掌握指标：能判断一个
`, '3-6', 1);

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('kc-incomplete-mastery');
    expect(result.issues.map((issue) => issue.code)).toContain('missing-misconceptions');
  });

  it('allows natural ellipses in mathematical blueprint content', () => {
    const result = validateOutlineStructure(`# 学习蓝图 — 示例（v1）

## 1. 学习目标与任务边界
- 终点能力：能说明向量组 v1, v2, ... 的线性无关含义。

## 2. 前置准备
- 必要前置：线性组合、零向量。

## 3. 核心知识结构

### KC1: 线性无关的判定
- 学习作用：核心概念
- 认知动作：理解
- 前置依赖：无
- 核心关系：若 c1v1 + c2v2 + ... + cnvn = 0 只有零系数解，则向量组线性无关。
- 表征与例反例：符号式 / 二维向量反例 / 矩阵行化简。
- 常见误解：看到很多向量就认为一定线性相关。
- 掌握证据：能解释 v1, v2, ... 中省略号代表一般向量组，并用系数方程判断是否线性无关。

## 4. 学习推进顺序
- 激活旧知：复习线性组合。
- 建立核心概念：说明零组合条件。
- 例子/反例辨析：比较无关和相关向量组。
- Worked Example 演示：用方程组求系数。
- 自检纠错：解释一个错误判断。

## 5. 掌握证据与诊断
| KC | 掌握证据 | 常见错误/误解 | 暴露的知识缺口 | 适合生成的练习/复盘问题 |
| --- | --- | --- | --- | --- |
| KC1 | 能写出 c1v1 + c2v2 + ... + cnvn = 0 并判断系数解。 | 把非零系数解当成无关。 | 混淆零组合的唯一性。 | 给一个向量组，要求写出系数方程并判断。 |
`, '4-8', 1);

    expect(result.passed).toBe(true);
    expect(result.issues.map((issue) => issue.code)).not.toContain('placeholder');
  });

  it('still rejects real template placeholders in blueprint fields', () => {
    const result = validateOutlineStructure(`# 学习蓝图 — 示例（v1）

## 1. 学习目标与任务边界
- 终点能力：...

## 2. 前置准备
- 必要前置：线性组合。

## 3. 核心知识结构

### KC1: [名称]
- 学习作用：核心概念
- 认知动作：理解
- 前置依赖：无
- 核心关系：...
- 表征与例反例：符号式。
- 常见误解：把向量个数当作唯一标准。
- 掌握证据：...

## 4. 学习推进顺序
- 激活旧知：复习线性组合。
- 建立核心概念：说明定义。
- 例子/反例辨析：比较例子。
- Worked Example 演示：完整演示。

## 5. 掌握证据与诊断
| KC | 掌握证据 | 常见错误/误解 | 暴露的知识缺口 | 适合生成的练习/复盘问题 |
| --- | --- | --- | --- | --- |
| KC1 | ... | 把向量个数当作唯一标准。 | 不理解定义。 | 给例子判断。 |
`, '4-8', 1);

    expect(result.passed).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain('placeholder');
  });

  it('accepts a concise learning blueprint without enforcing KC count range', () => {
    const result = validateOutlineStructure(`# 学习蓝图 — 示例（v1）

## 1. 学习目标与任务边界
- 终点能力：能判断一组向量是否构成基，并说明原因。
- 典型任务：判断、构造、解释。
- 成功表现：能区分不张成和不无关两类失败。
- 学习边界：不涉及无限维空间。
- 粒度说明：常规粒度。

## 2. 前置准备
- 必要前置：线性组合、张成。
- 需要激活的旧概念：向量空间。
- 前置自检：能否写出线性组合方程。
- 前置不足会卡在：无法解释张成。

## 3. 核心知识结构

### KC1: 基等于线性无关加张成
- 学习作用：核心概念
- 认知动作：分析
- 前置依赖：无
- 核心关系：基同时要求无冗余和覆盖整个空间。
- 推荐表征：符号 / 图形 / 反例表格
- 最小例子 / 关键反例：R2 两个不共线向量；两个共线向量数量够但不是基。
- 常见误解：以为向量个数等于维数就一定是基。
- 掌握证据：能判断一组向量是否为某空间的基，并说明失败原因是不无关还是不张成。

## 4. 学习推进顺序
- 激活旧知：复述张成和线性组合。
- 建立核心概念：说明基的两个条件。
- 例子/反例辨析：比较共线和不共线向量组。
- Worked Example 演示：用矩阵秩判断一组向量是否为基。
- 引导练习：给出三组向量判断是否为基。
- 迁移整合：把判断迁移到子空间。
- 自检纠错：解释一个失败反例。

## 5. 掌握证据与诊断
| KC | 掌握证据 | 常见错误/误解 | 暴露的知识缺口 | 适合生成的练习/复盘问题 |
| --- | --- | --- | --- | --- |
| KC1 | 能判定基并说明理由；答案中同时检查张成和线性无关。 | 只看向量个数。 | 不理解基必须同时满足覆盖和无冗余。 | 给三组向量，要求判断是否为基并说明失败类型。 |
`, '3-6', 1);

    expect(result.passed).toBe(true);
    expect(result.format).toBe('learning_blueprint');
    expect(result.warnings.map((issue) => issue.code)).not.toContain('kc-count-soft');
  });

  it('does not fail a learning blueprint only because the learning flow is compact', () => {
    const result = validateOutlineStructure(`# 学习蓝图 — 示例（v1）

## 1. 学习目标与任务边界
- 终点能力：能判断映射是否为线性变换。

## 2. 前置准备
- 必要前置：函数、向量加法、数乘。

## 3. 核心知识结构

### KC1: 线性变换的双保持条件
- 学习作用：核心概念
- 认知动作：理解
- 前置依赖：无
- 核心关系：线性变换同时保持加法和数乘。
- 表征与例反例：符号定义、平移反例。
- 常见误解：只检查 T(0)=0。
- 掌握证据：能用两个保持条件判断一个映射是否线性，并指出失败条件。

## 4. 学习推进顺序
先激活函数与向量运算，再建立双保持条件，接着用例子/反例辨析，最后用一个 Worked Example 和自检纠错收束。

## 5. 掌握证据与诊断
| KC | 掌握证据 | 常见错误/误解 | 暴露的知识缺口 | 适合生成的练习/复盘问题 |
| --- | --- | --- | --- | --- |
| KC1 | 能同时检查加法保持和数乘保持。 | 只看 T(0)=0。 | 把必要条件当充分条件。 | 给一个 T(0)=0 但不线性的映射，要求定位失败条件。 |
`, '4-8', 1);

    expect(result.passed).toBe(true);
    expect(result.issues.map((issue) => issue.code)).not.toContain('learning-flow-thin');
  });

  it('counts table-style learning flow as sufficient structure', () => {
    const result = validateOutlineStructure(`# 学习蓝图 — 示例（v1）

## 1. 学习目标与任务边界
- 终点能力：能判断映射是否为线性变换。

## 2. 前置准备
- 必要前置：函数、向量加法、数乘。

## 3. 核心知识结构

### KC1: 线性变换的双保持条件
- 学习作用：核心概念
- 认知动作：理解
- 前置依赖：无
- 核心关系：线性变换同时保持加法和数乘。
- 表征与例反例：符号定义、平移反例。
- 常见误解：只检查 T(0)=0。
- 掌握证据：能用两个保持条件判断一个映射是否线性，并指出失败条件。

## 4. 学习推进顺序
| 阶段 | 做什么 |
| --- | --- |
| 激活旧知 | 回忆函数、向量加法、数乘。 |
| 建立核心概念 | 写出两个保持条件。 |
| 例子/反例辨析 | 比较零映射和平移映射。 |
| Worked Example | 完整判断一个映射。 |
| 自检纠错 | 解释为什么 T(0)=0 不充分。 |

## 5. 掌握证据与诊断
| KC | 掌握证据 | 常见错误/误解 | 暴露的知识缺口 | 适合生成的练习/复盘问题 |
| --- | --- | --- | --- | --- |
| KC1 | 能同时检查加法保持和数乘保持。 | 只看 T(0)=0。 | 把必要条件当充分条件。 | 给一个 T(0)=0 但不线性的映射，要求定位失败条件。 |
`, '4-8', 1);

    expect(result.passed).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).not.toContain('learning-flow-thin');
  });

  it('accepts markdown-bold and table-style learning blueprint fields', () => {
    const result = validateOutlineStructure(`# 学习蓝图 — 示例（v1）

## 1. 学习目标与任务边界
- 终点能力：能判断线性变换是否保持加法和数乘。

## 2. 前置准备
- 必要前置：向量加法、数乘、函数。

## 3. 核心知识结构

### KC1: 线性变换的双保持性质
- **学习作用**：核心概念
- **认知动作**：理解
- **前置依赖**：无
- **核心关系**：线性变换必须同时保持向量加法和数乘。
- **推荐表征**：符号 / 反例表格
- **最小例子 / 关键反例**：零映射满足线性；平移映射通常不线性。
- **掌握证据**：能用两个保持条件判断一个映射是否线性，并指出失败条件。

### KC2: 定义判断流程
| 字段 | 内容 |
| 学习作用 | 判断策略 |
| 认知动作 | 应用 |
| 前置依赖 | KC1 |
| 核心关系 | 先验定义域和值域，再分别检查加法保持和数乘保持。 |
| 推荐表征 | 流程表 / 反例 |
| 常见误区 | 只检查一个条件就认为映射线性。 |
| 掌握证据 | 能对给定映射写出两步检查过程，并说明任一条件失败时为何不是线性变换。 |

## 4. 学习推进顺序
- 激活旧知：复述函数、向量加法和数乘。
- 建立核心概念：说明两个保持条件。
- 例子/反例辨析：比较线性映射和平移映射。
- Worked Example 演示：完整判断一个映射。
- 引导练习：给出三个映射判断。
- 迁移整合：联系矩阵表示。
- 自检纠错：解释一个错误判断。

## 5. 掌握证据与诊断
| KC | 掌握证据 | 常见错误/误解 | 暴露的知识缺口 | 适合生成的练习/复盘问题 |
| --- | --- | --- | --- | --- |
| KC1 | 能判断映射是否线性，答案中同时出现两个保持条件。 | 只检查零向量是否映到零向量。 | 把必要条件误当充分条件。 | 给出一个满足 T(0)=0 但不线性的映射，要求定位失败条件。 |
| KC2 | 能写出定义检查流程，并说明任一条件失败时为何不是线性变换。 | 跳过定义域和值域检查。 | 不理解线性变换判断的完整流程。 | 给三个映射，让学生按流程表逐项检查。 |
`, '4-8', 1);

    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).not.toContain('kc-count-soft');
  });

  it('accepts a practice and exercise blueprint without requiring KC field blocks', () => {
    const result = validateOutlineStructure(`# 实践与出题蓝图 — 示例（v2）

## 1. 实践目标与出题边界
- 实践目标：能持续生成覆盖核心 KC 的原型题、变式题和迁移题。
- 出题边界：只围绕当前节点，不引入后续章节。

## 2. KC × 题型矩阵
| KC | 原型题 | 变式题 | 反例/辨析题 | 错误诊断题 | 迁移/综合题 |
| --- | --- | --- | --- | --- | --- |
| KC1 | 判断定义是否满足 | 改变量条件 | 找反例 | 定位错误步骤 | 换场景解释 |

## 3. 题型模板库
### KC1: 线性变换判定
- 原型题模板：给一个映射，要求按两个保持条件判断。
- 变量变化维度：定义域、值域、是否含常数项。
- 难度阶梯：简单 → 中等 → 困难
- 可验证结果 / 评分维度：答案必须写出两个条件和失败原因。

## 4. 错误触发与补练规则
| 错误信号 | 关联 KC | 补练方向 | 复盘追问 |
| --- | --- | --- | --- |
| 只检查 T(0)=0 | KC1 | 补两个保持条件的辨析题 | 为什么必要条件不是充分条件？ |

## 5. 持续出题与下一轮练习规则
- 交错练习策略：定义判断、反例构造、迁移解释交替。
- 新题 / 复习题 / 迁移题比例：5:3:2。
- 用户自评掌握阈值：连续解释 3 题且能说清失败条件。
- 下一轮练习生成规则：错误多则先补辨析题，再做迁移题。
- 错题复盘问题接口：指出当时忽略了哪个定义条件。
`, '4-8', 2);

    expect(result.passed).toBe(true);
    expect(result.format).toBe('practice_blueprint');
  });

  it('accepts a review and deepening blueprint without requiring KC field blocks', () => {
    const result = validateOutlineStructure(`# 复盘与深化蓝图 — 示例（v3）

## 1. 复盘目标
- 复盘目标：能用自己的话解释核心概念、边界和常见错误。
- 自评边界：用户自查，不假装系统自动判定真实掌握。

## 2. 费曼复述问题
### KC1: 线性变换判定
- 用自己的话讲清楚：线性变换为什么必须同时保持加法和数乘？
- 解释为什么 / 何时成立：什么时候只看 T(0)=0 会误判？
- 解释一个边界或反例：给一个 T(0)=0 但不线性的例子。

## 3. 自检清单
- [ ] 我能写出两个保持条件。
- [ ] 我能构造至少一个非线性反例。

## 4. 常见误解解释路径
| 误解 | 解释路径 | 类比 / 表征 | 后续反思 |
| --- | --- | --- | --- |
| T(0)=0 足够 | 说明它只是必要条件 | 门票不是入场全过程 | 还缺哪个条件？ |

## 5. 错题复盘模板
- 我当时写了什么 / 做了什么？
- 它涉及哪个 KC？
- 错误背后的假设是什么？
- 正确解释是什么？
- 下一个相似情景该怎么试？

## 6. 迁移与深化问题
- 近迁移：换一个二维映射判断。
- 远迁移：联系矩阵表示解释。
- 总结提示：用一句话说明定义的核心限制。
`, '4-8', 3);

    expect(result.passed).toBe(true);
    expect(result.format).toBe('review_blueprint');
  });
});
