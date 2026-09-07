import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { getAIService } from "@/lib/ai";
import { notFound, internalError, unauthorized } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";

const logger = createLogger('api:practice:generate');

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    try {
        const { errorItemId, language, difficulty } = await req.json();

        const validSubjects = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"] as const;

        const errorItemWithSubject = await prisma.errorItem.findUnique({
            where: { id: errorItemId },
            include: { subject: true }
        });

        if (!errorItemWithSubject) {
            return notFound("Item not found");
        }

        // 带图题（hasImage=true 或存有 figureSvg，兜底 requiresImage 漏判的旧数据）：
        // 不生成变式，直接返回原题（含原图），交由前端展示原图
        const isImageQuestion = errorItemWithSubject.hasImage || !!errorItemWithSubject.figureSvg;
        if (isImageQuestion) {
            logger.info({ errorItemId }, 'Item has image, returning original instead of generating similar question');
            const subjectName = errorItemWithSubject.subject?.name || "其他";
            return NextResponse.json({
                questionText: errorItemWithSubject.questionText || "",
                answerText: errorItemWithSubject.answerText || "",
                analysis: errorItemWithSubject.analysis || "",
                subject: validSubjects.includes(subjectName as any) ? subjectName as typeof validSubjects[number] : "其他",
                isOriginalImage: true,
                originalImageUrl: errorItemWithSubject.originalImageUrl,
                figureSvg: null,
            });
        }

        let tags: string[] = [];
        try {
            tags = JSON.parse(errorItemWithSubject.knowledgePoints || "[]");
        } catch (e) {
            tags = [];
        }

        const aiService = getAIService();

        // 把原题配图中的结构化数据转成文字，附在原题后面——
        // 原题的关键数值（如图上标注的距离）往往不在题目文字里，出题模型需要它们才能出同构的新题
        let questionForAI = errorItemWithSubject.questionText || "";
        if (errorItemWithSubject.geometryData) {
            try {
                const geo = JSON.parse(errorItemWithSubject.geometryData);
                const parts: string[] = [`图形类型：${geo.type || "未知"}`];
                if (Array.isArray(geo.points) && geo.points.length > 0) {
                    parts.push(`顶点：${geo.points.map((pt: any) => `${pt.label || "?"}(${pt.pos || "?"})`).join("、")}`);
                }
                if (geo.labels && typeof geo.labels === "object") {
                    parts.push(`标注：${Object.entries(geo.labels).map(([k, v]) => `${k}=${v}`).join(", ")}`);
                }
                questionForAI += `\n\n【原题配图信息（图中标注的数据，题目文字里可能没有）】\n${parts.join("\n")}`;
            } catch {
                // geometryData 不是合法 JSON，忽略
            }
        }

        // 原题配图代码（SVG）一并给模型参考：新题应自行生成全新的配图 SVG，
        // 参考原题的图形类型和风格，但数值、标注、布局都要按新题内容重新设计
        if (errorItemWithSubject.figureSvg) {
            questionForAI += `\n\n【原题配图代码（SVG，仅供参考图形类型与风格。你必须为新题生成全新的 SVG 配图，不要照搬原题的坐标和标注）】\n${errorItemWithSubject.figureSvg}`;
        }

        const similarQuestion = await aiService.generateSimilarQuestion(
            questionForAI,
            tags,
            language,
            difficulty || 'medium',
            errorItemWithSubject.gradeSemester,
            errorItemWithSubject.geometryData
        );

        // Inject the subject from the database with type safety
        const subjectName = errorItemWithSubject.subject?.name || "其他";
        similarQuestion.subject = validSubjects.includes(subjectName as any) ? subjectName as typeof validSubjects[number] : "其他";

        return NextResponse.json(similarQuestion);
    } catch (error) {
        logger.error({ error }, 'Error generating practice');
        const errorMessage = error instanceof Error ? error.message : "Failed to generate practice question";
        return internalError(errorMessage);
    }
}
