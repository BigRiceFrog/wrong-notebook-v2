import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { authOptions } from "@/lib/auth";
import { getServerSession } from "next-auth";
import { getAIService } from "@/lib/ai";
import { unauthorized, internalError } from "@/lib/api-errors";
import { createLogger } from "@/lib/logger";
import type { ParsedQuestion } from "@/lib/ai/types";

const logger = createLogger('api:practice:generate-batch');

const VALID_SUBJECTS = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"] as const;

/**
 * 构建传给出题模型的原题文本：原题文字 + 配图结构化数据 + 原题 SVG 配图代码
 * （原题关键数值往往标在图上而非题面，出题模型需要它们才能出同构新题）
 */
function buildQuestionForAI(item: {
    questionText?: string | null;
    geometryData?: string | null;
    figureSvg?: string | null;
}): string {
    let questionForAI = item.questionText || "";

    if (item.geometryData) {
        try {
            const geo = JSON.parse(item.geometryData);
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

    if (item.figureSvg) {
        questionForAI += `\n\n【原题配图代码（SVG，仅供参考图形类型与风格。你必须为新题生成全新的 SVG 配图，不要照搬原题的坐标和标注）】\n${item.figureSvg}`;
    }

    return questionForAI;
}

/** 延迟等待（毫秒） */
function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * 带指数退避的重试：首次不等待，之后每次等待 baseDelay * 2^attempt 毫秒
 * 对 AI_QUOTA_EXCEEDED / 429 / 503 等限流错误特别有效
 */
async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    maxAttempts: number = 5,
    baseDelayMs: number = 4000
): Promise<{ result: T | null; error: unknown }> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const result = await fn();
            return { result, error: null };
        } catch (e) {
            lastErr = e;
            if (attempt < maxAttempts - 1) {
                const delay = baseDelayMs * Math.pow(2, attempt);
                logger.warn({ attempt, maxAttempts, delayMs: delay }, 'Retry with backoff after error');
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    return { result: null, error: lastErr };
}

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session?.user) {
        return unauthorized("Authentication required");
    }

    try {
        const body = await req.json();
        const errorItemIds: string[] = Array.isArray(body.errorItemIds) ? body.errorItemIds : [];
        const language = body.language || 'zh';  // 前端未传时默认中文
        const difficulty = body.difficulty || 'medium';

        if (errorItemIds.length === 0) {
            return internalError("errorItemIds is required");
        }
        // 限制单次批量上限，防止一次生成过多
        if (errorItemIds.length > 30) {
            return internalError("单次最多支持 30 道题");
        }

        const aiService = getAIService();

        // 小并发池（2 路）：单次 AI 生成本身要 10-30s，2 路并发稳态约 4-12 请求/分钟，
        // 低于 Gemini 免费层 RPM 限额，提速同时不会立刻撞限流。
        // 每个任务启动前 sleep 1s 节流，避免并发任务齐射触发 429/QUOTA_EXCEEDED；
        // 单道失败仍走 retryWithBackoff 指数退避（4s→8s→16s→32s）兜底限流。
        const CONCURRENCY = 2;
        const TASK_START_INTERVAL_MS = 1000;
        const results: any[] = [];
        let cursor = 0;

        const worker = async () => {
            while (true) {
                const i = cursor++;
                if (i >= errorItemIds.length) return;
                await sleep(TASK_START_INTERVAL_MS); // 节流：避免齐射

                const id = errorItemIds[i];
                try {
                const errorItemWithSubject = await prisma.errorItem.findUnique({
                    where: { id },
                    include: { subject: true }
                });

                if (!errorItemWithSubject) {
                    results.push({ errorItemId: id, question: null, error: "Item not found", sourceTitle: "" });
                    continue;
                }

                // 带图题（hasImage=true 或存有 figureSvg，兜底 requiresImage 漏判的旧数据）：
                // 不生成变式，直接返回原题（含原图），交由前端展示原图
                const isImageQuestion = errorItemWithSubject.hasImage || !!errorItemWithSubject.figureSvg;
                if (isImageQuestion) {
                    logger.info({ id }, 'Item has image, returning original instead of generating similar question');
                    const subjectName = errorItemWithSubject.subject?.name || "其他";
                    results.push({
                        errorItemId: id,
                        question: {
                            questionText: errorItemWithSubject.questionText || "",
                            answerText: errorItemWithSubject.answerText || "",
                            analysis: errorItemWithSubject.analysis || "",
                            subject: VALID_SUBJECTS.includes(subjectName as any) ? subjectName as typeof VALID_SUBJECTS[number] : "其他",
                            isOriginalImage: true,
                            originalImageUrl: errorItemWithSubject.originalImageUrl,
                            figureSvg: null,
                        },
                        error: null as string | null,
                        sourceTitle: (errorItemWithSubject.questionText || "").slice(0, 30),
                    });
                    continue;
                }

                let tags: string[] = [];
                try {
                    tags = JSON.parse(errorItemWithSubject.knowledgePoints || "[]");
                } catch {
                    tags = [];
                }

                const questionForAI = buildQuestionForAI(errorItemWithSubject);

                // 退避重试直到成功（封顶 5 次，累计等待约 60s 跨过配额窗口）
                const { result: similarQuestion, error: genErr } = await retryWithBackoff(
                    () => aiService.generateSimilarQuestion(
                        questionForAI,
                        tags,
                        language,
                        difficulty,
                        errorItemWithSubject.gradeSemester,
                        errorItemWithSubject.geometryData
                    )
                );

                if (!similarQuestion) {
                    results.push({
                        errorItemId: id,
                        question: null,
                        error: genErr instanceof Error ? genErr.message : "生成失败",
                        sourceTitle: (errorItemWithSubject.questionText || "").slice(0, 30)
                    });
                    continue;
                }

                const subjectName = errorItemWithSubject.subject?.name || "其他";
                similarQuestion.subject = VALID_SUBJECTS.includes(subjectName as any)
                    ? subjectName as typeof VALID_SUBJECTS[number]
                    : "其他";

                results.push({
                    errorItemId: id,
                    question: similarQuestion,
                    error: null as string | null,
                    sourceTitle: (errorItemWithSubject.questionText || "").slice(0, 30)
                });
                } catch (e) {
                    logger.error({ id, i, error: e }, 'Batch item generation error');
                    results.push({
                        errorItemId: id,
                        question: null,
                        error: e instanceof Error ? e.message : "生成失败",
                        sourceTitle: ""
                    });
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, errorItemIds.length) }, () => worker())
        );

        const successCount = results.filter(r => r.question).length;
        logger.info({ total: results.length, success: successCount }, 'Batch practice generation done');

        return NextResponse.json({ results });
    } catch (error) {
        logger.error({ error }, 'Error generating batch practice');
        const errorMessage = error instanceof Error ? error.message : "Failed to generate batch practice";
        return internalError(errorMessage);
    }
}
