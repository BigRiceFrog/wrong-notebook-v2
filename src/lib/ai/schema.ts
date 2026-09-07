import { z } from 'zod';

/**
 * Zod schema for validating AI-parsed questions
 * Ensures type safety and business rule compliance
 */
export const ParsedQuestionSchema = z.object({
    questionText: z.string().min(1, "题目文本不能为空"),
    answerText: z.string().min(1, "答案不能为空"),
    analysis: z.string().min(1, "解析不能为空"),
    wrongAnswerText: z.string().optional().default(""),
    mistakeAnalysis: z.string().optional().default(""),
    mistakeStatus: z.enum(["not_attempted", "wrong_attempt", "unknown"]).optional().default("unknown"),
    subject: z.enum([
        "数学", "物理", "化学", "生物",
        "英语", "语文", "历史", "地理",
        "政治", "其他"
    ]),
    knowledgePoints: z.array(z.string()).max(5, "知识点最多 5 个"),
    requiresImage: z.boolean().optional().default(false), // 题目是否依赖图片（如几何题）
    /** AI 生成的题目配图（几何图/函数图等），base64 Data URL，仅 requiresImage=true 时有值 */
    diagramImageBase64: z.string().optional(),
    /**
     * 结构化几何数据（JSON 字符串），用于前端精确渲染几何图形。
     * 当 requiresImage=true 时，AI 应同时返回此字段。
     *
     * 格式示例：
     * {
     *   "type": "right-triangle",        // 图形类型
     *   "points": [                       // 顶点列表
     *     { "label": "商店", "pos": "top" },
     *     { "label": "学校", "pos": "rightAngle" },
     *     { "label": "书店", "pos": "bottomRight" }
     *   ],
     *   "labels": {                       // 边长/角度标注
     *     "legA": "0.9千米",
     *     "legB": "2.8千米"
     *   }
     * }
     *
     * 支持的 type 值：right-triangle, triangle, coordinate, circle, line-segment, angle
     */
    geometryData: z.string().optional(),
    /**
     * AI 生成的题目配图：一段自包含的 SVG 代码。
     * 由 AI 按白名单规范输出，服务端做粗粒度安全校验，前端渲染前再用 DOMParser 严格消毒。
     * 只在题目确实带图时有值；无图题目为 undefined。
     */
    figureSvg: z.string().optional(),

    /**
     * 标记该题应直接展示原图（带图题走原图展示，不依赖 AI 生成的文字/变式）。
     * 由服务端在「举一反三」接口中、对 hasImage=true 的错题返回原题时置为 true。
     */
    isOriginalImage: z.boolean().optional(),
    /** 带图题的原图地址（originalImageUrl），供前端直接展示 */
    originalImageUrl: z.string().optional(),
});

/**
 * Type inference from Zod schema
 * Use this type instead of manually defining ParsedQuestion
 */
export type ParsedQuestionFromSchema = z.infer<typeof ParsedQuestionSchema>;

/**
 * Validates and parses AI response JSON
 * @param data - Raw JSON data from AI
 * @returns Validated ParsedQuestion object
 * @throws ZodError if validation fails
 */
export function validateParsedQuestion(data: unknown): ParsedQuestionFromSchema {
    return ParsedQuestionSchema.parse(data);
}

/**
 * Safe validation that returns success/error object
 * @param data - Raw JSON data from AI
 */
export function safeParseParsedQuestion(data: unknown) {
    return ParsedQuestionSchema.safeParse(data);
}
