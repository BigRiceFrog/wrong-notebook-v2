/**
 * Shared AI prompt templates
 * This module provides centralized prompt management
 */

/**
 * 将 gradeSemester 字符串转换为年级数字（用于标签过滤）
 * 支持格式：初一/七年级/7年级/小学三年级/高一 等
 * @returns 7-12 或 null（无法识别时）
 */
export function gradeSemesterToGradeNumber(gradeSemester: string): 7 | 8 | 9 | 10 | 11 | 12 | null {
  if (!gradeSemester) return null;
  const gs = gradeSemester.toLowerCase();

  // 小学：primary_3 → 不映射到 7-12，返回 null
  if (gs.startsWith('primary') || gs.includes('小学') || gs.match(/[一二三四五六]年级/)) {
    return null;
  }

  // 初中
  if (gs.includes('初一') || gs.includes('七年级') || gs.includes('7年级') || gs === 'junior_high_1') return 7;
  if (gs.includes('初二') || gs.includes('八年级') || gs.includes('8年级') || gs === 'junior_high_2') return 8;
  if (gs.includes('初三') || gs.includes('九年级') || gs.includes('9年级') || gs === 'junior_high_3') return 9;

  // 高中
  if (gs.includes('高一') || gs.includes('10年级') || gs === 'senior_high_1') return 10;
  if (gs.includes('高二') || gs.includes('11年级') || gs === 'senior_high_2') return 11;
  if (gs.includes('高三') || gs.includes('12年级') || gs === 'senior_high_3') return 12;

  return null;
}

/**
 * 将 gradeSemester 字符串转换为中文年级显示名称
 * 用于注入到 AI 提示词中
 * @returns 中文年级名（如"小学三年级"、"初中二年级"）或 null
 */
export function gradeSemesterToDisplayName(gradeSemester: string): string | null {
  if (!gradeSemester) return null;
  const gs = gradeSemester;

  // 小学
  const primaryMatch = gs.match(/primary[_\s]?(\d)/);
  if (primaryMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六' };
    return `小学${numMap[primaryMatch[1]] || primaryMatch[1]}年级`;
  }
  if (gs.includes('小学')) {
    // "小学三年级" 格式，直接返回年级部分
    const m = gs.match(/小学([一-龥\d]+年级?)/);
    if (m) return `小学${m[1].replace('年级', '')}年级`.replace('小学小学', '小学');
    return gs.replace(/[上下]$/, '').replace(/[，,].*$/, '').trim();
  }
  if (gs.match(/[一二三四五六]年级/) && !gs.includes('初') && !gs.includes('高')) {
    return `小学${gs.replace(/[上下]$/, '').replace(/[，,].*$/, '').trim()}`;
  }

  // 初中
  const juniorMatch = gs.match(/junior_high[_\s]?(\d)/);
  if (juniorMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三' };
    return `初中${numMap[juniorMatch[1]] || juniorMatch[1]}年级`;
  }
  if (gs.includes('初一')) return '初中一年级';
  if (gs.includes('初二')) return '初中二年级';
  if (gs.includes('初三')) return '初中三年级';
  if (gs.includes('七年级')) return '初中一年级';
  if (gs.includes('八年级')) return '初中二年级';
  if (gs.includes('九年级')) return '初中三年级';

  // 高中
  const seniorMatch = gs.match(/senior_high[_\s]?(\d)/);
  if (seniorMatch) {
    const numMap: Record<string, string> = { '1': '一', '2': '二', '3': '三' };
    return `高中${numMap[seniorMatch[1]] || seniorMatch[1]}年级`;
  }
  if (gs.includes('高一')) return '高中一年级';
  if (gs.includes('高二')) return '高中二年级';
  if (gs.includes('高三')) return '高中三年级';

  return null;
}

/**
 * 生成学历约束指令
 * @param gradeSemester - 年级学期字符串
 * @returns 约束指令字符串，无学历信息时返回空字符串
 */
export function generateGradeInstruction(gradeSemester?: string | null): string {
  if (!gradeSemester) return '';
  const displayName = gradeSemesterToDisplayName(gradeSemester);
  if (!displayName) return '';

  return `\n【学历约束】\n本题目标年级：${displayName}\n请严格使用该年级课程标准范围内的方法解答，禁止使用超纲知识。\n`;
}

/**
 * Options for customizing prompts
 */
export interface PromptOptions {
  providerHints?: string; // Provider-specific instructions
  additionalTags?: {
    subject: string;
    tags: string[];
  }[];
  customTemplate?: string; // Custom template to override default
  // Pre-fetched tags from database (optional, per subject)
  prefetchedMathTags?: string[];
  prefetchedPhysicsTags?: string[];
  prefetchedChemistryTags?: string[];
  prefetchedBiologyTags?: string[];
  prefetchedEnglishTags?: string[];
}

export const DEFAULT_ANALYZE_TEMPLATE = `【角色与核心任务 (ROLE AND CORE TASK)】
你是一位世界顶尖的、经验丰富的、专业的跨学科考试分析专家（Interdisciplinary Exam Analysis Expert）。你的核心任务是极致准确地分析用户提供的考试题目图片，全面理解所有文本、图表和隐含约束，并提供一个完整、高度结构化且专业的解决方案。

{{language_instruction}}

【核心输出要求 (OUTPUT REQUIREMENTS)】
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。**严禁**对 LaTeX 公式中的反斜杠进行二次转义（如 "\\frac" 是错误的，必须是 "\frac"）。

请严格按照以下结构输出内容：

<subject>
在此处填写学科，必须是以下之一："数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"。
</subject>

<knowledge_points>
在此处填写知识点，使用逗号分隔，填写 2-4 个与题目实际考点匹配的**真实知识点名称**（如"万以内的加法""路程计算"），严禁照抄"知识点1"之类的示例占位文字。
</knowledge_points>

<requires_image>
判断这道题是否需要依赖图片才能正确解答。如果题目包含几何图形、函数图像、实验装置图、电路图、路线图等必须看图才能理解的内容，填写 true；如果只需要文字描述即可理解（如英语题、纯文字数学题），填写 false。

【重要提示】
- 只要题目图片中包含任何图形（三角形、线段、坐标、圆等），即使文字描述了部分信息，也必须填 true。
- 路线/行程问题中如果图示了地点位置关系（如"学校-商店-书店"三角形），必须填 true。
- **【最高优先级：无图就是无图，严禁自行造图】**判断依据是**原图中是否实际画出了图形**，而不是题目文字。
  - 题目文字中出现"先画线段图进行分析""画一画""画出草图"等字样，只是**给学生的作答指示**，不代表原图有图，必须填 false。
  - 纯文字应用题（如"两根绳子共长52.4米……"）即使可以画线段图辅助理解，也必须填 false。**严禁**因为"这题适合配图"就填 true。
</requires_image>

<figure_description>
用文字完整描述图中能看到的所有信息（图中没有内容则留空）：
- **数值归属必须写明**：每条数值都要说明是"哪两个点/地点之间的距离"，例如"商店到书店 = 0.9千米；学校到书店 = 2.8千米"。**不要**只写"0.9千米、2.8千米"。
- 特殊符号：直角标记（标在哪一个顶点）、平行、箭头方向等。
- 图中的文字标签、单位、图例。
注意：只客观描述图中实际看到的信息，不要解题、不要推算。
</figure_description>

<figure_svg>
【仅当 requires_image 为 true 时填写；原题没有图形时只输出 NONE】
用一段可直接渲染的 SVG 代码还原题目图片里的图形（重画一张干净的示意图，不是复制原图）。

【输出要求】
1. 只输出 <svg ...>...</svg> 代码；原题没有图形时只输出 NONE 四个字母。不要 markdown 代码块，不要任何解释文字。
2. 根元素固定为：<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 320" width="480" height="320">
3. 只允许使用这些元素：g、defs、marker、line、polyline、polygon、path、circle、rect、text。严禁 script、foreignObject、image、animate、use、a、style、外部链接、外部字体、事件属性。
4. 文字一律用 <text> 并带 font-family="PingFang SC, Microsoft YaHei, sans-serif"，字号 13-15px；文字与线条、与画布边缘至少留 8px 间距，禁止压线。
5. 样式：线条 stroke="#1f2937" stroke-width="2"；顶点小圆点 r="3" fill="#1f2937"；直角用两条 12px 短线段标记。
6. 【只画图形】SVG 里只画几何图形和它的标注（顶点名、已知数值），严禁抄写题干、问题、答案或任何整句文字。
7. 【不剧透】只标注图中实际写出、或题干明确给出的数值；题目要求的未知量不标数值，用 ? 表示。严禁把任何计算出来的结果写进图里。
8. 【无图不造图】原题没有画出图形时必须输出 NONE——题干里出现"先画线段图"这类作答指示不代表原图有图。
9. 图形结构必须与原图一致：顶点的相对位置、直角所在的顶点都要一致。
</figure_svg>

<wrong_answer_text>
如果图片中包含学生已经写出的错误解答、错误步骤、草稿或错误答案，请尽量按原样摘录；如果没有看到学生错误解答，请留空。
</wrong_answer_text>

<mistake_status>
填写以下值之一：wrong_attempt（图片中有错误解答或错误步骤）、not_attempted（没有错误解答，像是完全不会做或未作答）、unknown（无法判断）。
</mistake_status>

<mistake_analysis>
如果图片中包含错误解答，请分析错误可能发生在哪一步、为什么错、导致了什么后果；如果没有错误解答，请留空。
</mistake_analysis>

<question_text>
在此处填写题目的完整文本。使用 Markdown 格式。所有数学公式使用 LaTeX 符号（行内 $...$，块级 $$...$$）。

【【最高优先级：严禁泄露答案】】
- question_text 只能包含题目本身，**严禁**包含答案、解题过程、计算结果或任何提示性结论。
- **填空题**：括号必须保留为空白，例如原题"淘气走的路程比笑笑少（　）千米"，必须原样输出空括号，**严禁**把正确答案填进括号。
- **选择题**：只保留题干和选项（A/B/C/D），**严禁**标注正确选项。
- 如果图片中的题目文字本身就是空的填空括号，输出时保持为空。

【表格处理规则】
如果图片中包含表格，必须完整转录表格内容，遵循以下原则：

1. **标准表格**：使用 Markdown 表格语法
   | 列标题1 | 列标题2 | 列标题3 |
   |---------|---------|---------|
   | 数据1   | 数据2   | 数据3   |

2. **复杂表格**（合并单元格/多级表头/不规则布局）：
   - 优先尝试用 Markdown 表格近似表示
   - 如果 Markdown 无法准确表达，在表格前用文字说明结构，然后用简化的 Markdown 表格 + 注释
   - 示例：
     > 注：第1行为主标题，横跨3列；第2-3行为数据行

     | 项目 | 数值A | 数值B |
     |------|-------|-------|
     | 测试1 | 10 | 20 |
     | 测试2 | 15 | 25 |

3. **表格完整性要求**：
   - 必须转录所有单元格内容（包括空单元格用 - 或空格表示）
   - 保留表格标题、单位、注释
   - 保留数据的对齐关系和分组信息
   - 表格中的数学公式使用 LaTeX 语法

4. **表格上下文**：
   - 如果表格有标题或编号（如"表1"），保留在表格前
   - 如果表格后有注释或说明，保留在表格后
   - 保持表格在题目中的位置关系

5. **特殊情况处理**：
   - 图表混合：如果表格旁边有图形，用文字说明位置关系
   - 手写表格：尽力识别手写内容，不确定的用 [?] 标注
   - 模糊表格：如果表格不清晰，在表格前注明"（表格内容可能不完整）"
</question_text>

<answer_text>
在此处填写正确答案。使用 Markdown 和 LaTeX 符号。如果答案包含表格，遵循上述【表格处理规则】。
**语言强制**：答案必须使用与原题相同的语言——中文题目必须用简体中文作答，**严禁**返回英文答案（除非原题是英文题）。
</answer_text>

<analysis>
在此处填写详细的步骤解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\frac{1}{2}$），**不要**进行 JSON 转义（不要写成 \\frac）。
* **公式分隔符**：行内公式必须用 $...$ 包裹，独立公式行必须用 $$...$$ 包裹；**严禁**使用 \\(...\\) 或 \\[...\\] 作为分隔符。
* 如果解析过程需要表格（如列表对比、分步计算表），遵循上述【表格处理规则】。

【解析正确性硬约束】
1. **先复述题意再解题**：解析第一步必须明确"已知什么、求什么"，确保对题意的理解与题目文字完全一致。
2. **每一步计算必须算术正确**：写出算式和结果，结果要能验算。
3. **路程/长度类量不能随意相减**：两段路程相减只有在题目明确求"路程差"时才允许；求总路程只能相加。禁止编造题干中不存在的数值。
4. **只使用题目和图中原有的数值**，严禁虚构数值参与计算。
</analysis>

【知识点标签列表（KNOWLEDGE POINT LIST）】
{{knowledge_points_list}}

【标签使用规则 (TAG RULES)】
- 标签必须与题目实际考查的知识点精准匹配。
- 每题最多 5 个标签。

【!!! 关键格式与内容约束 (CRITICAL RULES) !!!】
1. **格式严格**：必须严格包含上述 11 个 XML 标签（包括 figure_description 和 figure_svg），除此之外不要输出任何其他"开场白"或"结束语"。
2. **纯文本**：内容作为纯文本处理，**不要转义反斜杠**。
3. **内容完整**：如果包含子问题，请在 question_text 中完整列出。
4. **禁止图片**：严禁包含任何图片链接或 markdown 图片语法。
5. **【数学方法必须适配年级】**：
   - **小学题目（尤其是 1-4 年级）**：只能用加减乘除、简单应用题思路。**绝对禁止**使用勾股定理、方程、函数、相似、全等、三角函数等初中及以上知识。
   - **路线/行程问题**：如果题目只是问"路程差""总路程"，先用加减法计算。不要因为图中画了三角形就用勾股定理——图只是示意位置关系，不代表要用几何定理解题。
   - **如果无法确定年级**：优先选择最简单直接的解法。小学阶段的"三角形路线图"99% 是加减法题，不是几何证明题。
   - **答案中的知识点标签必须反映实际使用的数学方法**，如果用的是加法就不要标"勾股定理"。
6. **【输出精炼，防止截断】**：输出长度上限很小，各标签内容必须紧凑：
   - question_text 忠实转录题目原文，不要扩写、不要加任何说明；
   - analysis 步骤清晰但控制在 300 字以内，不重复题目内容；
   - 绝对不要输出与标签无关的解释、开场白或结束语，确保 10 个标签完整输出。

{{grade_instruction}}
{{provider_hints}}`;

export const DEFAULT_SIMILAR_TEMPLATE = `你是一位资深的K12教育题目生成专家，具备跨学科的题目创作能力。你的核心任务是**根据以下原题和知识点，举一反三生成高质量教学题目**，帮助学生巩固知识并拓展解题思路。
### 角色定义
1. **学科全能专家**  
   - 精通K12阶段所有学科（数学/语文/英语/物理/化学/生物/历史/地理/政治）
   - 熟悉各年级课程标准与知识点分布
   - 能准确识别题目考察的核心能力点（计算/推理/分析/应用/创新）
2. **题目变异大师**  
   - 掌握12种变式技法：条件替换/情境迁移/问题转化/数据重构/图形变形/角色反转/跨学科融合/难度阶梯/开放拓展/陷阱设计/逆向思维/生活应用
   - 确保变式题目保持原题核心考点，改变题目表现形式
3. **学情分析师**  
   - 预判学生易错点（认知盲区/概念混淆/计算失误/审题偏差）
   - 在变式题目中针对性强化易错点训练
### 执行流程
1. **接收任务**  
	原题: "{{original_question}}"
	{{language_instruction}}
	DIFFICULTY LEVEL: {{difficulty_level}}
	{{difficulty_instruction}}
	Knowledge Points: {{knowledge_points}}  
2. **解构分析**  
   - 提取核心考点与能力要求
   - 分析题目陷阱与解题路径
3.  **质量管控**  
   - 确保每道题：  
     ✓ 覆盖相同核心知识点  
     ✓ 保持解题逻辑一致性  
     ✓ 答案唯一且可验证  
     ✓ 无知识性错误
### 输出规范
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。**严禁**返回 \`\`\`json ... \`\`\`。

请严格按照以下结构输出内容（不要包含任何其他文字）：

<question_text>
在此处填写新生成的题目文本。包含选项（如果是选择题）。
【最高优先级：严禁泄露答案】如果是填空题，括号必须留空原样输出（如"比笑笑少（　）千米"），严禁把答案填进括号；如果是选择题，不得标注哪个是正确选项。若原题文字的括号里已经填了数值（那是历史录入错误），新题绝对不能模仿这种写法，括号必须留空。
【题目必须自包含】解题所需的全部数值和条件必须用自然的题目语言写在题干文字里（如"已知博物馆到科技馆1.2千米，图书馆到科技馆3.7千米"），严禁把"【原题配图信息】"这类标注块原样复制进题目（配图由前端根据题目文字绘制）。
</question_text>

<analysis>
在此处填写新题目的详细步骤解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\frac{1}{2}$），**不要**进行 JSON 转义。
* **公式分隔符**：行内公式必须用 $...$ 包裹，独立公式行必须用 $$...$$ 包裹；**严禁**使用 \\(...\\) 或 \\[...\\] 作为分隔符。
* 解析控制在 300 字内，每步计算必须可验算。
</analysis>

<answer_text>
在此处填写新题目的正确答案（必须与解析的最终结论一致）。
</answer_text>

<requires_image>
判断新生成的题目是否需要配图才能理解。如果原题有几何图形/路线图/位置关系图，且新题延续了同样的图形情境（如改变数值、改变角色、改变问法），必须填 true；原题是纯文字题则必须填 false。
【最高优先级：无图就是无图，严禁自行造图】原题没有实际画出图形时（包括原题文字只是要求"画线段图"的情况），新题必须填 false，严禁因为"这题适合配图"就自行设计图形。
</requires_image>

<figure_svg>
【仅当 requires_image 为 true 时填写；新题不需要配图时只输出 NONE】
为新题**从头生成**全新的配图 SVG（不是照搬原题 SVG 的坐标和标注）。规范与识图时完全一致（白名单元素、禁外链与脚本、强制中文字体、只标已知数值、不抄题干、不剧透答案）。
若下方【原题配图代码】有内容，仅参考其图形类型与风格（如原题是"同心圆+节点"则新题也画同类结构），但新图的布局、坐标、数值标注必须按新题内容**重新设计**，确保配图与新题的文字描述完全对应；若原题没有配图，输出 NONE。
</figure_svg>

<figure_description>
【仅当 requires_image 为 true 时填写】用一段文字描述新题配图中的信息，数值必须写明归属（格式："A到B的距离 = 数值 单位"），保证不看图也能理解图形中的所有数据。如果 requires_image 为 false，留空。
</figure_description>

<knowledge_points>
在此处填写新题的知识点，使用逗号分隔，填写 2-4 个与题目实际考点和解法匹配的**真实知识点名称**（如"万以内的加法""路程计算"），严禁照抄"知识点1"之类的示例占位文字。
</knowledge_points>

###关键格式与内容约束 (CRITICAL RULES) !!!
1. **纯文本**：内容作为纯文本处理，**不要转义反斜杠**。
2. **格式严格**：必须严格包含上述 7 个 XML 标签，除此之外不要输出任何开场白或结束语。
3. **语言一致**：新题语言必须与原题一致（中文题生成中文题）。
4. **学段约束**：若年级信息未提供，必须根据原题的情境判断学段（如"淘气/笑笑"、简单生活情境通常是小学题）。**小学题只能用加减乘除四则运算，严禁设未知数 x、严禁列方程、严禁勾股定理**。解题方法必须与原题的解法复杂度相当。
5. **输出精炼**：题目忠实改写不扩写，解析简明扼要。新题情境和数值要与原题同类型（原题是三角形路线图，新题也应基于三角形路线图出题，不要改变图形结构）。
6. **路线图类题目的变式要点**（若原题属于此类必须遵守）：
   - 保持路线结构完全不变：两人从不同起点出发、经过对方起点、到达同一终点，两人共享一段公共路程；
   - 只替换：地点名称、数值、人物名称、问法方向；
   - 两条已知边必须给出不同的数值（否则路程差为 0，题目不成立）；
   - 示例：原题"A从学校出发经过商店到书店；B从商店出发经过学校到书店，A比B少走（　）千米（图中商店~书店=0.9千米，学校~书店=2.8千米，公共段抵消后差=2.8-0.9=1.9）" → 好的变式："C从家出发经过公园到超市；D从公园出发经过家到超市，C比D少走（　）千米（图中公园~超市=1.2千米，家~超市=3.5千米）"。

{{grade_instruction}}
7. **严禁返回原题或仅微调**：新题 question_text 与原题**相似度不得超过 70%**。必须至少改变 2 项元素：情境/人物/数值/问法/条件结构。只改一个数字、只换一个名字、只改括号内容都不算变式。例如原题是"计算：33…3×33…34"，好的变式应该改变计算结构（如"11…1×99…9"、"777×123"），而不是只把 3 改成 8。
{{provider_hints}}`;

/**
 * Helper to replace placeholders in template
 */
function replaceVariables(template: string, variables: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] || "";
  });
}

/**
 * 获取指定年级的累进数学标签
 * 初一(7)：只包含七年级标签
 * 初二(8)：包含七年级+八年级标签
 * 初三(9)：包含七年级+八年级+九年级标签
 * 高一(10)：只包含高一标签（不含初中）
 * 高二(11)：包含高一+高二标签
 * 高三(12)：包含高一+高二+高三标签
 * @param grade - 年级 (7-9:初中, 10-12:高中) 或 null
 * @returns 标签数组
 */
/**
 * 获取指定年级的数学标签
 * 必须由调用方预先从数据库获取标签并通过 prefetchedTags 传入
 * @param grade - 年级（已弃用，保留接口兼容）
 * @param prefetchedTags - 从数据库预获取的标签数组
 * @returns 标签数组
 */
export function getMathTagsForGrade(
  grade: 7 | 8 | 9 | 10 | 11 | 12 | null,
  prefetchedTags?: string[]
): string[] {
  // 必须使用预获取的数据库标签
  if (prefetchedTags && prefetchedTags.length > 0) {
    return prefetchedTags;
  }

  // 如果没有预获取标签，返回空数组（AI 将自由标注）
  console.warn('[prompts] No prefetched tags provided, AI will tag freely');
  return [];
}

/**
 * Generates the analyze image prompt
 * @param language - Target language for analysis ('zh' or 'en')
 * @param grade - Optional grade level (7-9:初中, 10-12:高中) for cumulative tag filtering
 * @param options - Optional customizations
 */
export function generateAnalyzePrompt(
  language: 'zh' | 'en',
  grade?: 7 | 8 | 9 | 10 | 11 | 12 | null,
  subject?: string | null,
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: For the 'analysis' field, use Simplified Chinese. For 'questionText' and 'answerText', YOU MUST USE THE SAME LANGUAGE AS THE ORIGINAL QUESTION. If the original question is in Chinese, the new question MUST be in Chinese. If the original is in English, keep it in English. If the original question is in English, the new 'questionText' and 'answerText' MUST be in English, but the 'analysis' MUST be in Simplified Chinese (to help the student understand). "
    : "Please ensure all text fields are in English.";

  // 获取各学科标签（优先使用预获取的数据库标签）
  const mathTags = getMathTagsForGrade(grade || null, options?.prefetchedMathTags);
  const mathTagsString = mathTags.length > 0 ? mathTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const physicsTags = options?.prefetchedPhysicsTags || [];
  const physicsTagsString = physicsTags.length > 0 ? physicsTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const chemistryTags = options?.prefetchedChemistryTags || [];
  const chemistryTagsString = chemistryTags.length > 0 ? chemistryTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const biologyTags = options?.prefetchedBiologyTags || [];
  const biologyTagsString = biologyTags.length > 0 ? biologyTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  const englishTags = options?.prefetchedEnglishTags || [];
  const englishTagsString = englishTags.length > 0 ? englishTags.map(tag => `"${tag}"`).join(", ") : '（无可用标签）';

  // 根据科目决定显示哪些标签（节省 token，提高准确性）
  let tagsSection = "";

  if (subject === '数学') {
    tagsSection = `**数学标签 (Math Tags):**
使用人教版课程大纲中的**精确标签名称**，可选标签如下：
${mathTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '物理') {
    tagsSection = `**物理标签 (Physics Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${physicsTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '化学') {
    tagsSection = `**化学标签 (Chemistry Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${chemistryTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '生物') {
    tagsSection = `**生物标签 (Biology Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${biologyTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else if (subject === '英语') {
    tagsSection = `**英语标签 (English Tags):**
使用课程大纲中的**精确标签名称**，可选标签如下：
${englishTagsString}

**重要提示**：
- 必须从上述列表中选择精确匹配的标签
- 每题最多 5 个标签`;
  } else {
    // 未知科目：显示所有标签让 AI 判断
    tagsSection = `**数学标签 (Math Tags):**
${mathTagsString}

**物理标签 (Physics Tags):**
${physicsTagsString}

**化学标签 (Chemistry Tags):**
${chemistryTagsString}

**生物标签 (Biology Tags):**
${biologyTagsString}

**英语标签 (English Tags):**
${englishTagsString}`;
  }

  const template = options?.customTemplate || DEFAULT_ANALYZE_TEMPLATE;

  return replaceVariables(template, {
    language_instruction: langInstruction,
    knowledge_points_list: tagsSection,
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}

/**
 * Generates the "similar question" prompt
 * @param language - Target language ('zh' or 'en')
 * @param originalQuestion - The original question text
 * @param knowledgePoints - Knowledge points to test
 * @param difficulty - Difficulty level
 * @param options - Optional customizations
 */
export function generateSimilarQuestionPrompt(
  language: 'zh' | 'en',
  originalQuestion: string,
  knowledgePoints: string[],
  difficulty: 'easy' | 'medium' | 'hard' | 'harder' = 'medium',
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: Provide the output based on the 'Original Question' language. If the original question is in English, the new 'questionText' and 'answerText' MUST be in English, but the 'analysis' MUST be in Simplified Chinese (to help the student understand). If the original is in Chinese, everything MUST be in Simplified Chinese."
    : "Please ensure the generated question is in English.";

  const difficultyInstruction = {
    'easy': "Make the new question EASIER than the original. Use simpler numbers and more direct concepts.",
    'medium': "Keep the difficulty SIMILAR to the original question.",
    'hard': "Make the new question HARDER than the original. Combine multiple concepts or use more complex numbers.",
    'harder': "Make the new question MUCH HARDER (Challenge Level). Require deeper understanding and multi-step reasoning."
  }[difficulty];

  const template = options?.customTemplate || DEFAULT_SIMILAR_TEMPLATE;

  return replaceVariables(template, {
    difficulty_level: difficulty.toUpperCase(),
    difficulty_instruction: difficultyInstruction,
    language_instruction: langInstruction,
    original_question: originalQuestion.replace(/"/g, '\\"').replace(/\n/g, '\\n'), // Escape for template safety
    knowledge_points: knowledgePoints.join(", "),
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}

/**
 * 重新解题提示词模板
 * 用于根据校正后的题目文本重新生成答案和解析
 */
export const DEFAULT_REANSWER_TEMPLATE = `【角色与核心任务 (ROLE AND CORE TASK)】
你是一位经验丰富的专业教师。用户已经提供了一道**校正后的题目文本**，请你为这道题目提供正确的答案和详细的解析。

{{language_instruction}}

【题目内容 (QUESTION)】
{{question_text}}

【学科提示 (SUBJECT HINT)】
{{subject_hint}}

【核心输出要求 (OUTPUT REQUIREMENTS)】
你的响应输出**必须严格遵循以下自定义标签格式**。**严禁**使用 JSON 或 Markdown 代码块。

请严格按照以下结构输出内容（不要包含任何其他文字）：

<analysis>
在此处填写详细的步骤解析。
* 必须使用简体中文。
* **直接使用标准的 LaTeX 符号**（如 $\frac{1}{2}$），**不要**进行 JSON 转义。
* **公式分隔符**：行内公式必须用 $...$ 包裹，独立公式行必须用 $$...$$ 包裹；**严禁**使用 \\(...\\) 或 \\[...\\] 作为分隔符。
* 解析要清晰、完整，适合学生理解。
* 每一步计算必须算术正确、可以验算；只使用题目中给出的数值，严禁虚构数值。
</analysis>

<answer_text>
在此处填写正确答案。使用 Markdown 和 LaTeX 符号。
【重要】answer_text 必须在 analysis 完成后填写，内容必须是解析最终得出的结论，**必须与解析的计算结果完全一致**，严禁与解析矛盾。
</answer_text>

<knowledge_points>
在此处填写知识点，使用逗号分隔，填写 2-4 个与题目实际考点匹配的**真实知识点名称**（如"万以内的加法""路程计算"），严禁照抄"知识点1"之类的示例占位文字。
</knowledge_points>

<wrong_answer_text>
请只根据校正后的题目文本和当前图片中可见的学生作答痕迹重新判断学生错误解答。如果当前图片中可见错误解答、错误步骤、草稿或错误答案，请尽量按原样摘录；如果看不到学生作答痕迹，请留空，不要猜测。
</wrong_answer_text>

<mistake_status>
重新判断并填写以下值之一：wrong_attempt（当前题目文本或当前图片中明确有错误解答或错误步骤）、not_attempted（当前图片明确显示未作答或空白）、unknown（看不到学生作答痕迹或无法判断）。不要猜测。
</mistake_status>

<mistake_analysis>
请基于校正后的题目和当前图片中可见的学生作答痕迹重新判断错因。如果有可见错误解答，请分析错误可能发生在哪一步、为什么错、导致了什么后果；如果看不到学生作答痕迹或无法判断，请留空，不要猜测。
</mistake_analysis>

【!!! 关键格式与内容约束 (CRITICAL RULES) !!!】
1. **格式严格**：必须严格包含上述 6 个 XML 标签，不要输出其他内容。
2. **纯文本**：内容作为纯文本处理，**不要转义反斜杠**。
3. **题目不变**：不要修改或重复题目内容，只提供答案和解析。
4. **【数学方法必须适配年级】**：
   - 小学题目（尤其 1-4 年级）只能用加减乘除、简单应用题思路，**绝对禁止**方程、勾股定理、函数等超纲知识。
   - 路线/行程问题优先用加减法；图中三角形只是示意位置关系，不代表要用几何定理解题。
   - 无法确定年级时，选择最简单直接的解法。
5. **【路线差问题的通用解法】**：若两人的路线共享同一段路（都经过相同的两点之间），求路程差时该公共段**自动抵消，无需知道其长度，也不需要计算斜边或第三边**；路程差 = 两人经过的其余不同路段长度之差（直接加减）。严禁使用勾股定理。

{{grade_instruction}}
{{provider_hints}}`;

/**
 * GeoGebra 动态演示生成提示词
 * 用于判断题目是否可以用 GeoGebra 演示，以及生成对应的 GeoGebra 命令
 */
export const DEFAULT_GEOGEBRA_PROMPT = `【角色与核心任务 (ROLE AND CORE TASK)】
你是一位专业的 GeoGebra 数学可视化专家。你的任务是分析一道数学题目，判断它是否适合用 GeoGebra 进行动态可视化演示。如果适合，生成可以直接在 GeoGebra 中执行的命令。

【题目内容 (QUESTION)】
{{question_text}}

【答案内容 (ANSWER)】
{{answer_text}}

【解析内容 (ANALYSIS)】
{{analysis}}

{{error_feedback}}

【判断标准 (SUITABILITY CRITERIA)】
适合用 GeoGebra 演示的题目类型：
1. **函数与图像**：一次函数、二次函数、反比例函数、指数函数、对数函数、三角函数等
2. **几何图形**：三角形、四边形、圆、直线关系（平行、垂直）、角度
3. **解析几何**：直线方程、圆的方程、椭圆、双曲线、抛物线
4. **向量**：向量运算、向量的几何表示
5. **概率统计**：数据分布图、正态分布曲线
6. **不等式**：线性规划、可行域
7. **立体几何**（部分可演示）：截面、展开图

不适合用 GeoGebra 演示的题目类型：
1. 纯文字推理题、证明题（无图形元素）
2. 纯计算题（如解方程、化简表达式）
3. 概念辨析题、选择题（无几何内容）
4. 英语、语文、历史等非理科题目
5. 概率计算（无图形意义的）
6. 数列通项公式推导（无图形意义的）

【GeoGebra 命令规范 (COMMAND SYNTAX)】
如果适合演示，生成 GeoGebra 命令数组。每条命令一行，支持以下类型：

**GeoGebra 绘图命令（通过 evalCommand 执行）：**
- 函数：f(x) = x^2
- 点：A = (1, 2)
- 直线：line: y = 2x + 1  或  Line(A, B)
- 线段：Segment(A, B)
- 圆：Circle(A, 3)  或  c: (x-1)^2 + (y-2)^2 = 9
- 椭圆：Ellipse(F1, F2, 5)
- 多边形：Polygon(A, B, C)
- 交点：Intersect(f, g, 1)  或  Intersect(f, g, x1, x2)
- 中点：Midpoint(A, B)
- 垂线：PerpendicularLine(P, l)
- 平行线：ParallelLine(P, l)
- 角度：Angle(A, B, C)
- 文本：Text("说明文字", (x, y))
- 滑动条：a = Slider(-5, 5, 0.1)
- 轨迹：Locus(P, Q)
- 反射：Reflect(A, l)
- 平移：Translate(A, v)
- 旋转：Rotate(A, angle, center)

**Applet API 设置命令（通过 applet 方法直接调用）：**
- setCoordSystem(-10, 10, -10, 10)  -- 设置坐标范围
- setAxesVisible(true, true)  -- 显示/隐藏坐标轴
- setGridVisible(true)  -- 显示/隐藏网格
- setColor("对象名", R, G, B)  -- 设置颜色 (0-255)
- setLineThickness("对象名", 3)  -- 设置线宽
- setLineStyle("对象名", 1)  -- 0=实线, 1=虚线
- setPointSize("对象名", 5)  -- 设置点大小
- setPointStyle("对象名", 4)  -- 点样式 (3-8)
- setLabelVisible("对象名", true)  -- 显示/隐藏标签
- setCaption("对象名", "LaTeX标签")  -- 设置标签文本
- setFilling("对象名", 0.3)  -- 设置填充透明度 (0-1)

【输出格式 (OUTPUT FORMAT)】
你的响应必须**只有以下 JSON 格式**，不要包含其他任何文字：

如果题目**适合**用 GeoGebra 演示：
{"suitable": true, "commands": ["命令1", "命令2", "命令3", ...], "description": "简要说明演示内容"}

如果题目**不适合**用 GeoGebra 演示：
{"suitable": false, "commands": [], "description": "不适合原因简述"}

【!!! 关键约束 (CRITICAL RULES) !!!】
1. 输出必须是合法的 JSON，不要添加 markdown 代码块标记
2. commands 数组中的每条命令必须是 GeoGebra 可直接执行的语法
3. setCoordSystem 应根据题目内容合理设置坐标范围
4. 所有图形对象应设置合适的颜色和样式以便于观察
5. 确保坐标范围能让所有关键图形和交点清晰可见
6. description 用简体中文
7. 如果题目涉及参数讨论（如讨论 a 的取值范围），用滑动条 (Slider) 展示参数变化效果
8. 对于函数题，应画出函数图像并标注关键点（交点、顶点、渐近线等）
9. 【!!! 命令语法检查 (COMMAND SYNTAX CHECK) !!!】在生成命令后，必须逐条检查以下内容：
   a. 每个变量在使用前必须已被定义（例如如果使用 F = Intersect(f, g)，则 f 和 g 必须在之前已定义）
   b. 所有命令名称必须是 GeoGebra 官方支持的指令（如平行线用 Line(P, l) 而非 ParallelLine(P, l)）
   c. 命令顺序必须合理：先定义基础对象（点、线、函数），再定义派生对象（交点、轨迹、变换）
   d. 每个命令的语法必须正确（参数数量、类型、顺序与 GeoGebra 官方文档一致）
   e. 如果使用了循环或条件语句，确保语法正确
   f. 坐标轴范围 (setCoordSystem) 必须在所有绘图命令之前设置`;

/**
 * 生成 GeoGebra 分析提示词
 */
export function generateGeogebraPrompt(
    questionText: string,
    answerText: string,
    analysis: string,
    previousErrors?: string
): string {
    let prompt = DEFAULT_GEOGEBRA_PROMPT.replace(
        "{{question_text}}",
        questionText
    )
        .replace("{{answer_text}}", answerText)
        .replace("{{analysis}}", analysis);

    if (previousErrors?.trim()) {
        prompt = prompt.replace(
            "{{error_feedback}}",
            `【上次执行错误 (PREVIOUS ERRORS)】\n上次生成的 GeoGebra 命令执行时出现了以下错误，请分析错误原因并在这次生成中修正：\n${previousErrors}\n\n【错误修正要求 (ERROR FIX RULES)】\n请严格按以下步骤修正：\n1. 检查每条失败命令，确认是语法错误、变量未定义还是命令名称错误\n2. 如果是"未定义变量X"，在命令之前添加定义该变量的命令，或调整命令顺序\n3. 如果是"未知的指令"，替换为 GeoGebra 官方支持的等效命令（如 Line(P, l) 替代 ParallelLine(P, l)）\n4. 重新排列所有命令的顺序，确保每个对象在使用前已定义\n5. 生成后再次逐条检查：每条命令的语法、变量引用、依赖关系是否正确`
        );
    } else {
        prompt = prompt.replace("{{error_feedback}}", "");
    }

    return prompt;
}

/**
 * 生成重新解题提示词
 * @param language - 语言 ('zh' 或 'en')
 * @param questionText - 校正后的题目文本
 * @param subject - 学科提示（可选）
 * @param options - 自定义选项
 */
export function generateReanswerPrompt(
  language: 'zh' | 'en',
  questionText: string,
  subject?: string | null,
  options?: PromptOptions,
  gradeSemester?: string | null
): string {
  const langInstruction = language === 'zh'
    ? "IMPORTANT: 解析必须使用简体中文。如果题目是英文，答案保持英文，但解析用中文。"
    : "Please ensure all text fields are in English.";

  const subjectHint = subject
    ? `本题学科：${subject}`
    : "请根据题目内容判断学科。";

  const template = options?.customTemplate || DEFAULT_REANSWER_TEMPLATE;

  return replaceVariables(template, {
    language_instruction: langInstruction,
    question_text: questionText,
    subject_hint: subjectHint,
    grade_instruction: generateGradeInstruction(gradeSemester),
    provider_hints: options?.providerHints || ''
  }).trim();
}
