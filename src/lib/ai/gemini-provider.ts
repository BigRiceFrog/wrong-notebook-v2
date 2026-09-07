import { GoogleGenAI } from "@google/genai";
import { AIService, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult, GeogebraAnalysisResult } from "./types";
import { generateAnalyzePrompt, generateSimilarQuestionPrompt, generateGeogebraPrompt } from './prompts';
import { safeParseParsedQuestion } from './schema';
import { getAppConfig } from '../config';
import { getMathTagsFromDB, getTagsFromDB } from './tag-service';
import { createLogger } from '../logger';
import { normalizeMistakeStatusForSave } from '../mistake-status';
import { getProxyFetch } from '../global-proxy';
import { extractFigureSvg, figureSvgNumbersMatchQuestion } from './figure-svg';
import { detectLazy } from './similarity';

const logger = createLogger('ai:gemini');

type GeminiContent = string | Array<
    { text: string } |
    { inlineData: { mimeType: string; data: string } }
>;

export class GeminiProvider implements AIService {
    private ai: GoogleGenAI;
    private modelName: string;
    private baseUrl: string;

    constructor(config?: AIConfig) {
        const apiKey = config?.apiKey;
        const baseUrl = config?.baseUrl;

        if (!apiKey) {
            throw new Error("AI_AUTH_ERROR: GOOGLE_API_KEY is required for Gemini provider");
        }

        // 使用 httpOptions.baseUrl 来配置自定义 API 地址，避免全局 setDefaultBaseUrls 的竞态条件
        // 参考：@google/genai 的 GoogleGenAIOptions.httpOptions.baseUrl
        this.ai = new GoogleGenAI({
            apiKey,
            httpOptions: baseUrl ? {
                baseUrl: baseUrl
            } : undefined,
            // 让 SDK 的 fetch 走代理（Node 内置 fetch 不吃全局 dispatcher）
            fetch: getProxyFetch() as any
        } as any);

        this.modelName = config?.model || 'gemini-3.6-flash';
        this.baseUrl = baseUrl || 'https://generativelanguage.googleapis.com';

        logger.info({
            provider: 'Gemini',
            model: this.modelName,
            baseUrl: this.baseUrl,
            apiKeyPrefix: apiKey.substring(0, 8) + '...'
        }, 'AI Provider initialized');
    }

    private async retryOperation<T>(operation: () => Promise<T>, maxRetries: number = 3): Promise<T> {
        let lastError: unknown;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (error) {
                lastError = error;
                const msg = error instanceof Error ? error.message.toLowerCase() : String(error);

                // Identify retryable errors
                const isRetryable =
                    msg.includes('fetch failed') ||
                    msg.includes('network') ||
                    msg.includes('connect') ||
                    msg.includes('503') ||
                    msg.includes('502') ||  // Bad Gateway
                    msg.includes('504') ||  // Gateway Timeout
                    msg.includes('overloaded') ||
                    msg.includes('timeout') ||
                    msg.includes('etimedout') ||  // Connection timeout
                    msg.includes('enotfound') ||  // DNS resolution failed
                    msg.includes('econnreset') ||
                    msg.includes('econnrefused') ||  // Connection refused
                    msg.includes('unavailable');

                if (!isRetryable || attempt === maxRetries) {
                    throw error;
                }

                const delay = Math.pow(2, attempt - 1) * 1000; // Exponential backoff: 1s, 2s, 4s
                logger.warn({ attempt, maxRetries, error: msg, nextRetryDelayMs: delay }, 'Gemini operation failed, retrying...');
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    }

    private extractTag(text: string, tagName: string): string | null {
        const startTag = `<${tagName}>`;
        const endTag = `</${tagName}>`;
        const startIndex = text.indexOf(startTag);
        const endIndex = text.lastIndexOf(endTag);

        if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
            return null;
        }

        return text.substring(startIndex + startTag.length, endIndex).trim();
    }

    private parseResponse(text: string): ParsedQuestion {
        logger.debug({ textLength: text.length }, 'Parsing AI response');

        const questionText = this.extractTag(text, "question_text");
        const answerText = this.extractTag(text, "answer_text");
        const analysis = this.extractTag(text, "analysis");
        const subjectRaw = this.extractTag(text, "subject");
        const knowledgePointsRaw = this.extractTag(text, "knowledge_points");
        const requiresImageRaw = this.extractTag(text, "requires_image");
        const figureSvgRaw = this.extractTag(text, "figure_svg");
        const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
        const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
        const mistakeStatusRaw = this.extractTag(text, "mistake_status");

        // Basic Validation
        if (!questionText || !answerText || !analysis) {
            logger.error({ rawTextSample: text.substring(0, 500) }, 'Missing critical XML tags');
            throw new Error("Invalid AI response: Missing critical XML tags (<question_text>, <answer_text>, or <analysis>)");
        }

        // Process Subject
        let subject: ParsedQuestion['subject'] = '其他';
        const validSubjects = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"];
        if (subjectRaw && validSubjects.includes(subjectRaw)) {
            subject = subjectRaw as ParsedQuestion['subject'];
        }

        // Process Knowledge Points
        let knowledgePoints: string[] = [];
        if (knowledgePointsRaw) {
            knowledgePoints = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
        }

        // Process requiresImage
        const requiresImage = requiresImageRaw?.toLowerCase().trim() === 'true';

        // Process figureSvg（AI 生成的配图 SVG 代码，过安全校验后才保留）
        const figureSvg = extractFigureSvg(figureSvgRaw);
        if (figureSvgRaw && figureSvgRaw.trim() && !figureSvg) {
            logger.warn({ figureSvgRaw: figureSvgRaw.substring(0, 200) }, 'figure_svg 未通过安全校验或无图(NONE)，已丢弃');
        }

        const mistakeStatus = normalizeMistakeStatusForSave(mistakeStatusRaw, wrongAnswerText);

        // Construct Result
        const result: ParsedQuestion = {
            questionText,
            answerText,
            analysis,
            wrongAnswerText,
            mistakeAnalysis,
            mistakeStatus,
            subject,
            knowledgePoints,
            requiresImage,
            figureSvg: figureSvg ?? undefined
        };

        // Final Schema Validation
        const validation = safeParseParsedQuestion(result);
        if (validation.success) {
            logger.debug('Validated successfully via XML tags');
            return validation.data;
        } else {
            logger.warn({ validationError: validation.error.format() }, 'Schema validation warning');
            return result;
        }
    }

    async generateDiagram(questionText: string, subject?: string | null): Promise<string | null> {
        /**
         * 使用 Gemini 原生图片生成能力，根据题目文字生成干净的配图。
         * 适用于几何图形、函数图像、物理示意图等需要配图的题目。
         * 返回 base64 Data URL（如 "data:image/png;base64,..."），失败返回 null。
         *
         * 注意：图片生成需要使用支持 responseModalities 的模型（如 gemini-2.0-flash-exp），
         * 默认的 gemini-2.5-flash 不支持原生图片输出，会自动降级返回 null。
         */
        const diagramPrompt = `你是一位专业的数学/理科插图绘制专家。请根据以下题目内容，生成一张清晰、准确的配图。

【题目】
${questionText}

【学科】${subject || '数学'}

【绘图要求】
1. 根据题目描述，画出对应的几何图形、函数图像或示意图
2. 图形必须准确反映题目的数量关系（边长、角度、坐标等）
3. 图上标注关键信息（点名称、长度数值、角度等）
4. 使用白底黑线风格，简洁专业，适合打印
5. 只输出图片，不要添加任何文字说明或标题
6. 图片尺寸约 800x400 像素，横版布局`;

        // 图片生成专用模型（必须支持 responseModalities: ["image"]）
        // 可选: gemini-2.5-flash-image, gemini-3.1-flash-image, gemini-3-pro-image
        const imageModel = 'gemini-2.5-flash-image';

        logger.info({ questionLength: questionText.length, subject, imageModel }, 'Generating diagram via Gemini image generation');

        try {
            const response = await this.retryOperation(() =>
                this.ai.models.generateContent({
                    model: imageModel,  // 使用支持图片生成的模型
                    contents: diagramPrompt,
                    config: {
                        responseModalities: ["image", "text"],  // SDK 要求小写
                    },
                })
            );

            logger.debug({
                hasCandidates: !!response.candidates,
                partsCount: response.candidates?.[0]?.content?.parts?.length || 0,
            }, 'Diagram generation response structure');

            // 遍历 response parts 找到图片
            if (response.candidates && response.candidates[0]?.content?.parts) {
                for (let i = 0; i < response.candidates[0].content.parts.length; i++) {
                    const part = response.candidates[0].content.parts[i];
                    logger.debug({ partIndex: i, keys: Object.keys(part), hasInlineData: !!part.inlineData }, 'Checking response part');

                    if (part.inlineData?.data) {
                        const { mimeType, data } = part.inlineData;
                        const dataUrl = `data:${mimeType};base64,${data}`;
                        logger.info({ mimeType, size: data.length }, '✅ Diagram generated successfully');
                        return dataUrl;
                    }
                }
            }

            // 没有图片部分——模型可能不支持图片生成，或题目不需要图
            logger.warn({
                modelUsed: imageModel,
                candidateCount: response.candidates?.length || 0,
                textPreview: response.text?.substring(0, 200) || '(no text)',
            }, '⚠️ Gemini returned no image part — model may not support image generation, or fallback to text-only response');
            return null;

        } catch (error) {
            logger.error({
                error: error instanceof Error ? error.message : String(error),
                modelAttempted: imageModel,
            }, '❌ Diagram generation failed — image generation may not be available with current API key or model');
            return null; // 配图生成失败不阻塞主流程
        }
    }

    async analyzeImage(imageBase64: string, mimeType: string = "image/jpeg", language: 'zh' | 'en' = 'zh', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();

        // 从数据库获取各学科标签
        const prefetchedMathTags = (subject === '数学' || !subject) ? await getMathTagsFromDB(grade || null) : [];
        const prefetchedPhysicsTags = (subject === '物理' || !subject) ? await getTagsFromDB('physics') : [];
        const prefetchedChemistryTags = (subject === '化学' || !subject) ? await getTagsFromDB('chemistry') : [];
        const prefetchedBiologyTags = (subject === '生物' || !subject) ? await getTagsFromDB('biology') : [];
        const prefetchedEnglishTags = (subject === '英语' || !subject) ? await getTagsFromDB('english') : [];

        const prompt = generateAnalyzePrompt(language, grade, subject, {
            customTemplate: config.prompts?.analyze,
            prefetchedMathTags,
            prefetchedPhysicsTags,
            prefetchedChemistryTags,
            prefetchedBiologyTags,
            prefetchedEnglishTags,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.modelName,
            language,
            grade: grade || 'all'
        });
        logger.box('📝 Full Prompt', prompt);

        try {
            // 构建请求参数（用于日志显示）
            const requestParamsForLog = {
                model: this.modelName,
                contents: [
                    {
                        text: prompt
                    },
                    {
                        inlineData: {
                            data: `[...${imageBase64.length} bytes base64 data...]`,
                            mimeType: mimeType
                        }
                    }
                ]
            };

            logger.box('📤 API Request (发送给 AI 的原始请求)', JSON.stringify(requestParamsForLog, null, 2));

            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                contents: [
                    {
                        text: prompt
                    },
                    {
                        inlineData: {
                            data: imageBase64,
                            mimeType: mimeType
                        }
                    }
                ],
                config: {
                    // 配图 SVG 代码较长，且要容纳完整解析，给足输出空间
                    maxOutputTokens: 8192,
                    temperature: 0.2,
                }
            }));

            logger.box('📦 Full API Response Metadata', {
                usageMetadata: response.usageMetadata
            });

            const text = response.text || '';

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(text);

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during AI analysis', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language: 'zh' | 'en' = 'zh', difficulty: DifficultyLevel = 'medium', gradeSemester?: string | null, _geometryData?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();
        const prompt = generateSimilarQuestionPrompt(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: config.prompts?.similar
        }, gradeSemester);

        logger.box('🎯 Generate Similar Question Request', {
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            originalQuestion: originalQuestion.substring(0, 100) + '...',
            knowledgePoints: knowledgePoints.join(', '),
            difficulty,
            language
        });
        logger.box('📝 Full Prompt', prompt);

        try {
            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                contents: prompt,
                config: {
                    maxOutputTokens: 8192,
                    temperature: 0.7,
                }
            }));

            const text = response.text || '';

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");

            // 反偷懒校验：AI 是否直接抄了原题（只改了几个数字或名字）
            let parsedResult = this.parseResponse(text);
            let { similar, score } = detectLazy(originalQuestion, parsedResult.questionText);
            if (similar) {
                logger.warn({ score, original: originalQuestion.slice(0,80), got: parsedResult.questionText.slice(0,80) }, "AI 返回原题或仅微调，重试一次");
                const retryHints = "CRITICAL: Your previous attempt was too similar to the original question (similarity score: " + score.toFixed(2) + "). You MUST change at least 2 elements: scenario OR numbers OR question structure. Returning near-original is FORBIDDEN.";
                const retryPrompt = generateSimilarQuestionPrompt(language, originalQuestion, knowledgePoints, difficulty, { providerHints: retryHints, customTemplate: config.prompts?.similar }, gradeSemester);
                try {
                    const retryResp = await this.retryOperation(() => this.ai.models.generateContent({ model: this.modelName, contents: retryPrompt, config: { maxOutputTokens: 8192, temperature: 0.9 } }));
                    if (retryResp.text && retryResp.text.trim()) {
                        const retryParsed = this.parseResponse(retryResp.text);
                        const retry2 = detectLazy(originalQuestion, retryParsed.questionText);
                        logger.info({ score: retry2.score }, retry2.similar ? "反偷懒重试仍然相似，使用第二次结果" : "反偷懒重试成功");
                        parsedResult = retryParsed;
                    }
                } catch (retryErr) {
                    logger.warn({ err: retryErr instanceof Error ? retryErr.message : String(retryErr) }, "反偷懒重试失败，使用第一次结果");
                }
            }

            // 兜底清洗：生成的题目里"（数字+单位）"几乎必然是模型泄露的答案（如"少(1.5)千米"），
            // 替换为空括号；不影响"(2023·温江)"这类不带单位的前缀标注
            parsedResult.questionText = parsedResult.questionText.replace(
                /([（(])\s*[\d.]+\s*([）)])(?=\s*(千米|米|元|千克|克|升|毫升|小时|分钟|秒|千米\/时|米\/秒))/g,
                '（　）'
            );

            // 一致性抽查：配图标注的数值必须能在该题的完整内容里找到，否则宁可不显示图。
            // 注意：很多几何/行程题的数值是"标在图上"而非写在题面里的（如本题 0.9/2.8 千米只在
            // 图与解析中出现），若只核对题面会把必要的配图误删。故对 题干+解析+答案 整体核对。
            const problemText = [parsedResult.questionText, parsedResult.analysis, parsedResult.answerText]
                .filter(Boolean).join(' ');
            if (parsedResult.figureSvg && !figureSvgNumbersMatchQuestion(parsedResult.figureSvg, problemText)) {
                logger.warn('figure_svg 数值与新题内容不一致，已丢弃配图');
                parsedResult.figureSvg = undefined;
            }

            logger.box('✅ Parsed & Validated Result', JSON.stringify(parsedResult, null, 2));

            return parsedResult;

        } catch (error) {
            logger.box('❌ Error during question generation', {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined
            });
            this.handleError(error);
            throw error;
        }
    }

    async reanswerQuestion(questionText: string, language: 'zh' | 'en' = 'zh', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult> {
        const { generateReanswerPrompt } = await import('./prompts');
        const prompt = generateReanswerPrompt(language, questionText, subject, undefined, gradeSemester);

        logger.info({
            provider: 'Gemini',
            endpoint: `${this.baseUrl}/v1beta/models/${this.modelName}:generateContent`,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        }, 'Reanswer Question Request');
        logger.debug({ prompt }, 'Full prompt');

        try {
            // 根据是否有图片构建不同的请求内容
            let contents: GeminiContent;
            if (imageBase64) {
                // 移除 data:image/xxx;base64, 前缀（如果存在）
                const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
                contents = [
                    { text: prompt },
                    { inlineData: { mimeType: 'image/jpeg', data: base64Data } }
                ];
            } else {
                contents = prompt;
            }

            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                contents,
                config: { maxOutputTokens: 8192, temperature: 0.2 }
            }));

            const text = response.text || '';

            logger.debug({ rawResponse: text }, 'AI raw response');

            if (!text) throw new Error("Empty response from AI");

            // 解析响应
            const answerText = this.extractTag(text, "answer_text") || "";
            const analysis = this.extractTag(text, "analysis") || "";
            const knowledgePointsRaw = this.extractTag(text, "knowledge_points") || "";
            const knowledgePointsParsed = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
            const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
            const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
            const mistakeStatus = normalizeMistakeStatusForSave(
                this.extractTag(text, "mistake_status"),
                wrongAnswerText
            );

            logger.info('Reanswer parsed successfully');

            return { answerText, analysis, knowledgePoints: knowledgePointsParsed, wrongAnswerText, mistakeAnalysis, mistakeStatus };

        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during reanswer');
            this.handleError(error);
            throw error;
        }
    }

    async analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult> {
        const prompt = generateGeogebraPrompt(questionText, answerText, analysis, previousErrors);

        logger.info({
            provider: 'Gemini',
            model: this.modelName,
            questionLength: questionText.length,
        }, 'GeoGebra Analysis Request');

        try {
            const response = await this.retryOperation(() => this.ai.models.generateContent({
                model: this.modelName,
                contents: prompt,
                config: { maxOutputTokens: 8192, temperature: 0.2 }
            }));

            const text = response.text || '';
            logger.debug({ rawResponse: text }, 'GeoGebra AI raw response');

            if (!text) throw new Error("Empty response from AI");

            // Extract JSON from response (handle possible markdown code blocks)
            let jsonStr = text.trim();
            const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
            if (jsonMatch) {
                jsonStr = jsonMatch[1].trim();
            }

            // Try to find JSON object
            const objStart = jsonStr.indexOf('{');
            const objEnd = jsonStr.lastIndexOf('}');
            if (objStart !== -1 && objEnd !== -1) {
                jsonStr = jsonStr.substring(objStart, objEnd + 1);
            }

            const parsed = JSON.parse(jsonStr);

            return {
                suitable: Boolean(parsed.suitable),
                commands: Array.isArray(parsed.commands) ? parsed.commands : [],
                description: parsed.description || "",
            };
        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during GeoGebra analysis');
            this.handleError(error);
            throw error;
        }
    }

    private handleError(error: unknown) {
        logger.error({ error }, 'Gemini error');
        if (error instanceof Error) {
            const msg = error.message.toLowerCase();
            if (msg.includes('fetch failed') || msg.includes('network') || msg.includes('connect')) {
                throw new Error("AI_CONNECTION_FAILED");
            }
            // 超时错误 (包括 408 Request Timeout)
            if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted') || msg.includes('408')) {
                throw new Error("AI_TIMEOUT_ERROR");
            }
            // 配额/频率限制错误
            if (msg.includes('quota') || msg.includes('额度') || msg.includes('rate limit') || msg.includes('429') || msg.includes('too many')) {
                throw new Error("AI_QUOTA_EXCEEDED");
            }
            // 权限/403 错误
            if (msg.includes('403') || msg.includes('forbidden') || msg.includes('permission')) {
                throw new Error("AI_PERMISSION_DENIED");
            }
            // 资源不存在/404 错误
            if (msg.includes('404') || msg.includes('not found') || msg.includes('does not exist')) {
                throw new Error("AI_NOT_FOUND");
            }
            // 服务器错误 (500/502/503/504)
            if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') ||
                msg.includes('无可用') || msg.includes('overloaded') || msg.includes('unavailable')) {
                throw new Error("AI_SERVICE_UNAVAILABLE");
            }
            if (msg.includes('invalid json') || msg.includes('parse')) {
                throw new Error("AI_RESPONSE_ERROR");
            }
            if (msg.includes('api key') || msg.includes('unauthorized') || msg.includes('401')) {
                throw new Error("AI_AUTH_ERROR");
            }
        }
        throw new Error("AI_UNKNOWN_ERROR");
    }
}
