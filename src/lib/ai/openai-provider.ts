import OpenAI from "openai";
import { AIService, ParsedQuestion, DifficultyLevel, AIConfig, ReanswerQuestionResult, GeogebraAnalysisResult } from "./types";
import { generateAnalyzePrompt, generateSimilarQuestionPrompt, generateGeogebraPrompt } from './prompts';
import { getAppConfig } from '../config';
import { safeParseParsedQuestion } from './schema';
import { getMathTagsFromDB, getTagsFromDB } from './tag-service';
import { createLogger } from '../logger';
import { normalizeMistakeStatusForSave } from '../mistake-status';
import { getProxyFetch } from '../global-proxy';
import { detectLazy } from './similarity';

const logger = createLogger('ai:openai');

type OpenAIUserContent = string | Array<
    { type: "text"; text: string } |
    { type: "image_url"; image_url: { url: string } }
>;

export class OpenAIProvider implements AIService {
    private openai: OpenAI;
    private model: string;
    private textModel: string | null;
    private baseURL: string;
    private apiKey: string;
    private isLongCat: boolean;

    constructor(config?: AIConfig) {
        const apiKey = config?.apiKey;
        const baseURL = config?.baseUrl;

        if (!apiKey) {
            throw new Error("AI_AUTH_ERROR: OPENAI_API_KEY is required for OpenAI provider");
        }

        this.openai = new OpenAI({
            apiKey: apiKey,
            baseURL: baseURL || undefined,
            fetch: getProxyFetch() as any,
            defaultHeaders: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            },
        });

        this.model = config?.model || 'gpt-4o'; // Fallback for safety
        this.textModel = process.env.OPENAI_TEXT_MODEL?.trim() || null; // 解题用文本模型（两阶段模式）
        this.baseURL = baseURL || 'https://api.openai.com/v1';
        this.apiKey = apiKey;
        this.isLongCat = this.baseURL.includes('longcat.chat');

        logger.info({
            provider: 'OpenAI',
            model: this.model,
            textModel: this.textModel || '(same as model)',
            baseURL: this.baseURL,
            apiKeyPrefix: apiKey.substring(0, 8) + '...'
        }, 'AI Provider initialized');
    }

    private adaptMessagesForLongCat(messages: Array<{ role: string; content: any }>): Array<{ role: string; content: any }> {
        return messages.map(msg => {
            if (typeof msg.content === 'string') {
                return { ...msg, content: [{ type: 'text', text: msg.content }] };
            }
            if (Array.isArray(msg.content)) {
                const adapted = msg.content.map((part: any) => {
                    if (part.type === 'image_url') {
                        return {
                            type: 'input_image',
                            input_image: { data: [part.image_url.url], type: 'url' }
                        };
                    }
                    return part;
                });
                return { ...msg, content: adapted };
            }
            return msg;
        });
    }

    private extractTag(text: string, tagName: string): string | null {
        const startTag = `<${tagName}>`;
        const endTag = `</${tagName}>`;
        const startIndex = text.indexOf(startTag);

        // 如果找不到开始标签，返回 null
        if (startIndex === -1) {
            return null;
        }

        const contentStartIndex = startIndex + startTag.length;
        const endIndex = text.lastIndexOf(endTag);

        // 特殊处理：如果闭合标签丢失（通常主要发生在最后的 analysis 标签被截断时）
        // 我们尝试读取到字符串末尾
        if (endIndex === -1 && tagName === 'analysis') {
            logger.warn({ tagName }, 'Tag was verified unclosed, treating as truncated and reading to end');
            return text.substring(contentStartIndex).trim();
        }

        if (endIndex === -1 || contentStartIndex >= endIndex) {
            return null;
        }

        return text.substring(contentStartIndex, endIndex).trim();
    }

    private parseResponse(text: string): ParsedQuestion {
        logger.debug({ textLength: text.length }, 'Parsing AI response');

        const questionText = this.extractTag(text, "question_text");
        const answerText = this.extractTag(text, "answer_text");
        const analysis = this.extractTag(text, "analysis");
        const subjectRaw = this.extractTag(text, "subject");
        const knowledgePointsRaw = this.extractTag(text, "knowledge_points");
        const requiresImageRaw = this.extractTag(text, "requires_image");
        const geometryDataRaw = this.extractTag(text, "geometry_data");
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
        const validSubjects: ParsedQuestion['subject'][] = ["数学", "物理", "化学", "生物", "英语", "语文", "历史", "地理", "政治", "其他"];
        if (subjectRaw && (validSubjects as string[]).includes(subjectRaw)) {
            subject = subjectRaw as ParsedQuestion['subject'];
        }

        // Process Knowledge Points
        let knowledgePoints: string[] = [];
        if (knowledgePointsRaw) {
            // Split by comma or newline, trim whitespaces
            knowledgePoints = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
        }

        // Process requiresImage (default to false if not present or unrecognized)
        const requiresImage = requiresImageRaw?.toLowerCase().trim() === 'true';

        // Process geometryData (optional structured geometry data for SVG rendering)
        let geometryData: string | undefined = undefined;
        if (geometryDataRaw && geometryDataRaw.trim() && geometryDataRaw.trim() !== '{' && geometryDataRaw.trim() !== '{}') {
            // Validate it's valid JSON
            try {
                JSON.parse(geometryDataRaw.trim());
                geometryData = geometryDataRaw.trim();
            } catch {
                // Invalid JSON, skip
                logger.warn({ geometryDataRaw: geometryDataRaw.substring(0, 200) }, 'geometry_data contains invalid JSON, skipping');
            }
        }

        // 兜底：原题没有图（requires_image=false）时严禁配图，即使模型违反指令输出了 geometry_data 也丢弃
        if (!requiresImage && geometryData) {
            logger.warn({ geometryData: geometryData.substring(0, 120) }, 'requires_image=false but geometry_data present, discarding');
            geometryData = undefined;
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
            geometryData
        };

        // Final Schema Validation (just to be safe, though likely compliant by now)
        const validation = safeParseParsedQuestion(result);
        if (validation.success) {
            logger.debug('Validated successfully via XML tags');
            return validation.data;
        } else {
            logger.warn({ validationError: validation.error.format() }, 'Schema validation warning');
            // We still return it as we trust our extraction more than the schema at this point (or we can throw)
            // Let's return the extracted data to be permissive
            return result;
        }
    }

    /**
     * 两阶段模式·第二阶段：用文本模型解题
     * 视觉免费模型（如 glm-4v-flash）看图尚可但推理弱，解题交给文本模型（如 glm-4-flash）。
     * 复用重新解题 prompt，返回 answer/analysis/knowledgePoints。
     */
    private async solveWithTextModel(
        questionText: string,
        subject?: string | null,
        gradeSemester?: string | null,
        language: 'zh' | 'en' = 'zh',
        figureDescription?: string
    ): Promise<{ answerText: string; analysis: string; knowledgePoints: string[] }> {
        if (!this.textModel) throw new Error('textModel not configured');

        const { generateReanswerPrompt } = await import('./prompts');

        // 图中信息可能包含题目文字里没有的数值（如图上标注的距离），必须传给文本模型
        const questionForSolve = figureDescription?.trim()
            ? `${questionText}\n\n【图中信息（视觉模型从图片中识别，若题目文字未包含这些数值，解题必须使用下面的图中信息）】\n${figureDescription.trim()}`
            : questionText;

        const prompt = generateReanswerPrompt(language, questionForSolve, subject, undefined, gradeSemester);

        logger.info({ textModel: this.textModel, questionLength: questionForSolve.length, hasFigureInfo: !!figureDescription?.trim() }, 'Two-stage: solving with text model');

        const response = await this.openai.chat.completions.create({
            model: this.textModel,
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: "请根据上述题目提供答案和解析。" }
            ],
            max_tokens: 4096,
        });

        const text = response?.choices?.[0]?.message?.content || "";
        if (!text) throw new Error('Empty response from text model');

        const answerText = this.extractTag(text, "answer_text") || "";
        const analysis = this.extractTag(text, "analysis") || "";
        const knowledgePointsRaw = this.extractTag(text, "knowledge_points") || "";
        const knowledgePoints = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);

        if (!answerText || !analysis) {
            throw new Error(`Text model response missing tags (answerText=${!!answerText}, analysis=${!!analysis})`);
        }

        logger.info({ answerLength: answerText.length, analysisLength: analysis.length }, 'Two-stage: text model solved successfully');
        return { answerText, analysis, knowledgePoints };
    }

    async generateDiagram(_questionText: string, _subject?: string | null): Promise<string | null> {
        // OpenAI 图片生成（DALL-E）暂未接入，返回 null
        // 如需支持可后续集成 OpenAI images/generations 接口
        logger.warn('OpenAIProvider.generateDiagram not implemented, returning null');
        return null;
    }

    async analyzeImage(imageBase64: string, mimeType: string = "image/jpeg", language: 'zh' | 'en' = 'zh', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestion> {
        const config = getAppConfig();

        // 从数据库获取各学科标签
        // 如果指定了学科，只获取该学科；否则获取所有学科标签供 AI 判断
        const prefetchedMathTags = (subject === '数学' || !subject) ? await getMathTagsFromDB(grade || null) : [];
        const prefetchedPhysicsTags = (subject === '物理' || !subject) ? await getTagsFromDB('physics') : [];
        const prefetchedChemistryTags = (subject === '化学' || !subject) ? await getTagsFromDB('chemistry') : [];
        const prefetchedBiologyTags = (subject === '生物' || !subject) ? await getTagsFromDB('biology') : [];
        const prefetchedEnglishTags = (subject === '英语' || !subject) ? await getTagsFromDB('english') : [];

        // 两阶段模式：配置了独立文本模型时，视觉模型只负责转录，解题交给文本模型
        const twoStage = !!(this.textModel && this.textModel !== this.model);
        const transcribeHints = twoStage ? `
【本次调用为「视觉转录」阶段，你不需要解题】
后续会有一个专门的文本模型根据你转录的题目解题。因此：
- question_text：忠实转录题目文字（填空括号留空，严禁预填答案）；
- requires_image / geometry_data：按上述规则描述图中的图形；
- figure_description：按上述规则用文字描述图中数值的归属关系（这一项非常重要，文本模型解题依赖它）；
- wrong_answer_text / mistake_status / mistake_analysis：按上述规则判断图中学生的作答痕迹；
- subject：正常判断；knowledge_points 可给出初步判断；
- answer_text 和 analysis：这两个标签仍然必须输出，但内容只填写四个字"待解答"（解题由后续文本模型完成，你只需专注把题目和图看准）。
` : undefined;

        const systemPrompt = generateAnalyzePrompt(language, grade, subject, {
            customTemplate: config.prompts?.analyze,
            prefetchedMathTags,
            prefetchedPhysicsTags,
            prefetchedChemistryTags,
            prefetchedBiologyTags,
            prefetchedEnglishTags,
            providerHints: transcribeHints,
        }, gradeSemester);

        logger.box('🔍 AI Image Analysis Request', {
            provider: 'OpenAI',
            endpoint: `${this.baseURL}/chat/completions`,
            imageSize: `${imageBase64.length} bytes`,
            mimeType,
            model: this.model,
            textModel: twoStage ? this.textModel : '(same as model)',
            mode: twoStage ? 'two-stage (vision transcribe + text solve)' : 'single-stage',
            language,
            grade: grade || 'all'
        });
        logger.box('📝 Full System Prompt', systemPrompt);

        try {
            // 构建请求参数（用于日志显示，图片数据截断）
            const requestParamsForLog = {
                model: this.model,
                messages: [
                    {
                        role: "system",
                        content: systemPrompt
                    },
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${mimeType};base64,[...${imageBase64.length} bytes base64 data...]`,
                                },
                            },
                        ],
                    },
                ],
                max_tokens: 1024,
            };

            logger.box('📤 API Request (发送给 AI 的原始请求)', JSON.stringify(requestParamsForLog, null, 2));

            let response: any;

            if (this.isLongCat) {
                // LongCat 使用不同的多模态格式，绕过 SDK 直接请求
                const messages = this.adaptMessagesForLongCat([
                    { role: "system", content: systemPrompt },
                    {
                        role: "user",
                        content: [
                            {
                                type: "image_url",
                                image_url: {
                                    url: `data:${mimeType};base64,${imageBase64}`,
                                },
                            },
                        ],
                    },
                ]);

                const res = await fetch(`${this.baseURL}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: this.model,
                        messages,
                        max_tokens: 1024,
                    }),
                });

                if (!res.ok) {
                    const errBody = await res.text();
                    logger.error({ status: res.status, body: errBody }, 'LongCat API error');
                    throw new Error(`${res.status} status code (${errBody})`);
                }

                response = await res.json();
            } else {
                response = await this.openai.chat.completions.create({
                    model: this.model,
                    messages: [
                        {
                            role: "system",
                            content: systemPrompt
                        },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${mimeType};base64,${imageBase64}`,
                                    },
                                },
                            ],
                        },
                    ],
                    // response_format: { type: "json_object" }, // Removing to improve compatibility with 3rd party providers
                    max_tokens: 1024,
                });
            }

            logger.box('📦 Full API Response', JSON.stringify(response, null, 2));

            // 检查响应是否有效
            if (!response || !response.choices || response.choices.length === 0) {
                logger.error({ response: JSON.stringify(response) }, 'Invalid API response - no choices array');
                throw new Error("AI_RESPONSE_ERROR: API returned empty or invalid response");
            }

            const text = response.choices[0]?.message?.content || "";

            // ===== 截断续传 =====
            // 免费模型（如 glm-4v-flash）max_tokens 上限仅 1024，长输出会被截断，
            // 导致尾部 XML 标签（如 </analysis>）丢失。检测到截断时发续写请求拼接。
            let fullText = text;
            let finishReason = response.choices[0]?.finish_reason;
            let contRounds = 0;
            while (contRounds < 3 && (finishReason === "length" || !fullText.includes("</analysis>"))) {
                logger.warn({ round: contRounds + 1, finishReason, textLength: fullText.length }, 'AI response truncated, requesting continuation');
                const contResponse: any = await this.openai.chat.completions.create({
                    model: this.model,
                    messages: [
                        { role: "system", content: systemPrompt },
                        {
                            role: "user",
                            content: [
                                {
                                    type: "image_url",
                                    image_url: {
                                        url: `data:${mimeType};base64,${imageBase64}`,
                                    },
                                },
                            ],
                        },
                        { role: "assistant", content: fullText },
                        {
                            role: "user",
                            content: "你的上一条回复在末尾被截断了。请从中断处直接继续输出剩余内容：不要重复已输出的内容，不要输出任何解释、道歉或开场白，直接续写剩余的标签内容，直到输出完整的 </analysis> 结束。",
                        },
                    ],
                    max_tokens: 1024,
                });
                if (!contResponse?.choices || contResponse.choices.length === 0) break;
                const contText = contResponse.choices[0]?.message?.content || "";
                if (!contText) break;
                fullText += contText;
                finishReason = contResponse.choices[0]?.finish_reason;
                contRounds++;
            }

            logger.box('🤖 AI Raw Response', fullText);

            if (!fullText) throw new Error("Empty response from AI");
            const parsedResult = this.parseResponse(fullText);

            // 提取图中的文字化描述（不进 schema，仅供文本解题阶段使用）
            const figureDescription = this.extractTag(fullText, "figure_description") || "";

            // ===== 两阶段模式·第二阶段：文本模型解题 =====
            if (twoStage) {
                try {
                    const solved = await this.solveWithTextModel(
                        parsedResult.questionText,
                        parsedResult.subject || subject,
                        gradeSemester,
                        language,
                        figureDescription
                    );
                    if (solved.answerText.trim()) parsedResult.answerText = solved.answerText;
                    if (solved.analysis.trim()) parsedResult.analysis = solved.analysis;
                    if (solved.knowledgePoints.length > 0) parsedResult.knowledgePoints = solved.knowledgePoints;
                } catch (solveErr) {
                    logger.warn({
                        error: solveErr instanceof Error ? solveErr.message : String(solveErr)
                    }, 'Two-stage solving failed, keeping vision model result');
                }
            }

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

    /**
     * 确定性路线题变式（快速通道）：识别「直角三角形 + 三顶点 + legA/legB」结构，
     * AI 只负责换皮（人名/地名/数值），题目文字、答案、解析、几何图数据全部由代码组装，
     * 数学上保证自洽（公共段抵消，差 = 两已知边之差）。结构不匹配时返回 null 走通用通道。
     */
    private async generateRouteVariantFast(geometryData: string | null | undefined): Promise<ParsedQuestion | null> {
        if (!this.textModel || !geometryData) return null;

        let geo: any;
        try { geo = JSON.parse(geometryData); } catch { return null; }
        if (geo?.type !== 'right-triangle' || !Array.isArray(geo.points) || geo.points.length !== 3) return null;

        const top = geo.points.find((p: any) => p?.pos === 'top')?.label;
        const rightAngle = geo.points.find((p: any) => p?.pos === 'rightAngle')?.label;
        const bottomRight = geo.points.find((p: any) => p?.pos === 'bottomRight')?.label;
        const legARaw = String(geo.labels?.legA ?? '');
        const legBRaw = String(geo.labels?.legB ?? '');
        const legA = parseFloat(legARaw);
        const legB = parseFloat(legBRaw);
        if (!top || !rightAngle || !bottomRight || !isFinite(legA) || !isFinite(legB) || legA <= 0 || legB <= 0) return null;

        const unit = legARaw.replace(/[\d.]/g, '').trim() || '千米';

        // AI 只做换皮：换人名、地名、数值（这是文本模型擅长的，不涉及推理）
        const renamePrompt = `你在给一道小学数学路线题做「换皮」改编，只改名称和数值，严禁改变题目结构。
原题地点：${rightAngle}（直角顶点）、${top}、${bottomRight}；原题数值：${top}~${rightAngle}=${legA}${unit}，${rightAngle}~${bottomRight}=${legB}${unit}（${top}~${bottomRight}为公共斜边，图中不标注数值）。
要求：三个地点换成互不相同的常见地点（如学校/公园/书店/图书馆/博物馆/车站/超市/医院）；两个人名自拟常见中文名；两个新数值为不相等的正数（保留一位小数，相差至少0.3）。
只输出如下 JSON（严禁 markdown 代码块、严禁任何其他文字）：
{"p1":"人名1","p2":"人名2","a":"直角顶点新地名","b":"顶点新地名","c":"另一顶点新地名","legA":新数值,"legB":新数值}`;

        const response = await this.openai.chat.completions.create({
            model: this.textModel,
            messages: [{ role: "user", content: renamePrompt }],
            max_tokens: 4096,
        });
        const raw = response?.choices?.[0]?.message?.content || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        let v: any;
        try { v = JSON.parse(jsonMatch[0]); } catch { return null; }

        const p1 = typeof v.p1 === 'string' && v.p1.trim() ? v.p1.trim() : '小明';
        const p2 = typeof v.p2 === 'string' && v.p2.trim() ? v.p2.trim() : '小红';
        const a = typeof v.a === 'string' && v.a.trim() ? v.a.trim() : rightAngle;
        const b = typeof v.b === 'string' && v.b.trim() ? v.b.trim() : top;
        const c = typeof v.c === 'string' && v.c.trim() ? v.c.trim() : bottomRight;
        let newLegA = parseFloat(v.legA);
        let newLegB = parseFloat(v.legB);
        if (!isFinite(newLegA) || !isFinite(newLegB) || newLegA <= 0 || newLegB <= 0 || Math.abs(newLegA - newLegB) < 0.05) {
            newLegA = Math.round((legA + 0.3) * 10) / 10;
            newLegB = Math.round((legB + 0.5) * 10) / 10;
        }
        // 保证 legB（a~c 边）> legA，使「p1 比 p2 少走」的差值为正
        if (newLegB < newLegA) { const t = newLegA; newLegA = newLegB; newLegB = t; }
        const diff = Math.round((newLegB - newLegA) * 10) / 10;

        const questionText = `${p1}从${a}出发，经过${b}到达${c}；${p2}从${b}出发，经过${a}到达${c}。${p1}走的路程比${p2}少（　）${unit}。已知${b}到${c}的距离是${newLegA}${unit}，${a}到${c}的距离是${newLegB}${unit}。`;

        const analysis = `两人都经过「${a}~${b}」这段公共路，求路程差时公共段抵消：

- ${p1}走的路程 = 公共段（${a}~${b}）+ ${b}~${c}的 ${newLegA}${unit}
- ${p2}走的路程 = 公共段（${a}~${b}）+ ${a}~${c}的 ${newLegB}${unit}

所以 ${p1}比${p2}少走：${newLegB} - ${newLegA} = ${diff}${unit}。`;

        return {
            questionText,
            answerText: `${diff}${unit}`,
            analysis,
            knowledgePoints: ['路程计算', '加减法应用'],
            requiresImage: true,
            geometryData: JSON.stringify({
                type: 'right-triangle',
                // 直角在目的地 c：垂直边 b~c 标 legA，水平边 c~a 标 legB，
                // 斜边 b~a 是两人共同经过的公共段（不标注），保证「公共段抵消做减法」与原题同一知识点
                points: [
                    { label: b, pos: 'top' },
                    { label: c, pos: 'rightAngle' },
                    { label: a, pos: 'bottomRight' },
                ],
                labels: { legA: `${newLegA}${unit}`, legB: `${newLegB}${unit}` },
            }),
            subject: '数学',
        } as ParsedQuestion;
    }

    async generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language: 'zh' | 'en' = 'zh', difficulty: DifficultyLevel = 'medium', gradeSemester?: string | null, geometryData?: string | null): Promise<ParsedQuestion> {
        // ===== 快速通道：直角三角形路线题走「AI 换皮 + 代码组装」，保证数值/答案/解析自洽 =====
        if (this.textModel && geometryData) {
            try {
                const fastResult = await this.generateRouteVariantFast(geometryData);
                if (fastResult) {
                    logger.info({ answer: fastResult.answerText }, 'Similar question generated via deterministic route-variant fast path');
                    return fastResult;
                }
            } catch (fastErr) {
                logger.warn({ error: fastErr }, 'Route-variant fast path failed, falling back to AI generation');
            }
        }

        const config = getAppConfig();
        // 两阶段：有文本模型时，本次调用只负责出题，解题交给文本模型
        const twoStage = !!this.textModel;
        const systemPrompt = generateSimilarQuestionPrompt(language, originalQuestion, knowledgePoints, difficulty, {
            customTemplate: config.prompts?.similar,
            providerHints: twoStage ? `
【本次调用为「出题」阶段，你不需要解题】
后续会有一个专门的文本模型解答你出的题目。因此：
- question_text：出题（题目必须自包含，所有数值写在题干文字里）；
- requires_image / geometry_data / figure_description：按上述规则为新题生成配图数据；
- knowledge_points：填写新题的真实考点；
- answer_text 和 analysis：这两个标签仍然必须输出，但内容只填写三个字"待解答"（解题由后续文本模型完成，你只需专注出一道结构合理、数值自洽、难度匹配的题）。
` : ''
        }, gradeSemester);
        const userPrompt = `\nOriginal Question: "${originalQuestion}"\nKnowledge Points: ${knowledgePoints.join(", ")}\n    `;

        logger.box('🎯 Generate Similar Question Request', {
            provider: 'OpenAI',
            endpoint: `${this.baseURL}/chat/completions`,
            model: this.textModel || this.model,
            originalQuestion: originalQuestion.substring(0, 100) + '...',
            knowledgePoints: knowledgePoints.join(', '),
            difficulty,
            language
        });
        logger.box('📝 System Prompt', systemPrompt);
        logger.box('📝 User Prompt', userPrompt);

        try {
            // 举一反三是纯文本任务：优先用文本模型（推理更强、输出上限更高），无文本模型时回退
            const genModel = this.textModel || this.model;
            const maxTokens = this.textModel ? 4096 : 1024;

            const response = await this.openai.chat.completions.create({
                model: genModel,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: userPrompt },
                ],
                // response_format: { type: "json_object" }, // Removing to improve compatibility with 3rd party providers
                max_tokens: maxTokens,
            });

            let text = response.choices[0]?.message?.content || "";
            let finishReason = response.choices[0]?.finish_reason;
            let contRounds = 0;

            // ===== 截断续传（同 analyzeImage）=====
            while (contRounds < 3 && (finishReason === "length" || !text.includes("</geometry_data>") && text.includes("<geometry_data>") || !text.includes("</analysis>"))) {
                logger.warn({ round: contRounds + 1, finishReason, textLength: text.length, model: genModel }, 'Similar question response truncated, requesting continuation');
                const contResponse: any = await this.openai.chat.completions.create({
                    model: genModel,
                    messages: [
                        { role: "system", content: systemPrompt },
                        { role: "user", content: userPrompt },
                        { role: "assistant", content: text },
                        { role: "user", content: "你的输出被截断了。请从中断处继续输出剩余内容，不要重复已有内容，不要输出其他说明。" },
                    ],
                    max_tokens: maxTokens,
                });
                const contText = contResponse.choices[0]?.message?.content || "";
                if (!contText) break;
                text += contText;
                finishReason = contResponse.choices[0]?.finish_reason;
                contRounds++;
                if (text.includes("</analysis>") && (!text.includes("<geometry_data>") || text.includes("</geometry_data>"))) break;
            }

            logger.box('🤖 AI Raw Response', text);

            if (!text) throw new Error("Empty response from AI");

            // 反偷懒校验：AI 是否直接抄了原题
            let parsedResult = this.parseResponse(text);
            let { similar, score } = detectLazy(originalQuestion, parsedResult.questionText);
            if (similar) {
                logger.warn({ score, original: originalQuestion.slice(0,80), got: parsedResult.questionText.slice(0,80) }, "AI 返回原题或仅微调，重试一次");
                const retryHints = "CRITICAL: Your previous attempt was too similar to the original question (similarity score: " + score.toFixed(2) + "). You MUST change at least 2 elements: scenario OR numbers OR question structure. Returning near-original is FORBIDDEN.";
                const retryPrompt = generateSimilarQuestionPrompt(language, originalQuestion, knowledgePoints, difficulty, { providerHints: retryHints, customTemplate: config.prompts?.similar }, gradeSemester);
                const retryUserPrompt = "\nOriginal Question: \"" + originalQuestion + "\"\nKnowledge Points: " + knowledgePoints.join(", ");
                try {
                    const retryResp = await this.openai.chat.completions.create({ model: this.textModel || this.model, messages: [{ role: "system", content: retryPrompt }, { role: "user", content: retryUserPrompt }], max_tokens: 2048 });
                    if (retryResp.choices[0]?.message?.content?.trim()) {
                        const retryParsed = this.parseResponse(retryResp.choices[0].message.content);
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

            // ===== 两阶段模式·第二阶段：文本模型解答新题 =====
            if (twoStage) {
                try {
                    const solved = await this.solveWithTextModel(
                        parsedResult.questionText,
                        parsedResult.subject,
                        gradeSemester,
                        language
                    );
                    parsedResult.answerText = solved.answerText;
                    parsedResult.analysis = solved.analysis;
                    if (solved.knowledgePoints.length > 0) parsedResult.knowledgePoints = solved.knowledgePoints;
                } catch (solveErr) {
                    logger.warn({ error: solveErr }, 'Two-stage solve failed, keeping stage-1 answer/analysis');
                }
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
            provider: 'OpenAI',
            endpoint: `${this.baseURL}/chat/completions`,
            model: this.model,
            questionLength: questionText.length,
            subject: subject || 'auto',
            hasImage: !!imageBase64
        }, 'Reanswer Question Request');
        logger.debug({ prompt }, 'Full prompt');

        try {
            // 根据是否有图片构建不同的消息内容
            let userContent: OpenAIUserContent = "请根据上述题目提供答案和解析。";
            if (imageBase64) {
                // 如果有图片，构建多模态消息
                const imageUrl = imageBase64.startsWith('data:') ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;
                logger.debug({ imageLength: imageUrl.length }, 'Image added to request');
                userContent = [
                    { type: "text", text: "请结合图片和题目描述提供答案和解析。" },
                    { type: "image_url", image_url: { url: imageUrl } }
                ];
            } else {
                logger.debug({ imageBase64Type: typeof imageBase64, hasValue: !!imageBase64 }, 'No image data');
            }

            // 打印请求参数
            const requestParams = {
                model: this.model,
                messages: [
                    { role: "system", content: prompt.substring(0, 200) + "..." },
                    { role: "user", content: typeof userContent === 'string' ? userContent : "[包含图片的多模态消息]" }
                ],
                max_tokens: 1024
            };
            logger.debug({ requestParams }, 'Request parameters');

            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: prompt },
                    { role: "user", content: userContent }
                ],
                max_tokens: 1024,
            });

            logger.debug({ response: JSON.stringify(response) }, 'Full API response');

            // 检查响应是否有效
            if (!response || !response.choices || response.choices.length === 0) {
                logger.error({ response: JSON.stringify(response) }, 'Invalid API response - no choices array');
                throw new Error("AI_RESPONSE_ERROR: API returned empty or invalid response");
            }

            const text = response.choices[0]?.message?.content || "";

            logger.debug({ rawResponse: text }, 'AI raw response');

            if (!text) throw new Error("Empty response from AI");

            // 解析响应
            const answerText = this.extractTag(text, "answer_text") || "";
            const analysis = this.extractTag(text, "analysis") || "";
            const knowledgePointsRaw = this.extractTag(text, "knowledge_points") || "";
            const knowledgePoints = knowledgePointsRaw.split(/[,，\n]/).map(k => k.trim()).filter(k => k.length > 0);
            const wrongAnswerText = this.extractTag(text, "wrong_answer_text") || "";
            const mistakeAnalysis = this.extractTag(text, "mistake_analysis") || "";
            const mistakeStatus = normalizeMistakeStatusForSave(
                this.extractTag(text, "mistake_status"),
                wrongAnswerText
            );

            logger.info('Reanswer parsed successfully');

            return { answerText, analysis, knowledgePoints, wrongAnswerText, mistakeAnalysis, mistakeStatus };

        } catch (error) {
            logger.error({ error, stack: error instanceof Error ? error.stack : undefined }, 'Error during reanswer');
            this.handleError(error);
            throw error;
        }
    }

    async analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult> {
        const prompt = generateGeogebraPrompt(questionText, answerText, analysis, previousErrors);

        logger.info({
            provider: 'OpenAI',
            model: this.model,
            questionLength: questionText.length,
        }, 'GeoGebra Analysis Request');

        try {
            const response = await this.openai.chat.completions.create({
                model: this.model,
                messages: [
                    { role: "system", content: prompt },
                    { role: "user", content: "请分析上述题目并生成 GeoGebra 演示命令。" }
                ],
                max_tokens: 1024,
            });

            const text = response.choices[0]?.message?.content || '';
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
        logger.error({ error }, 'OpenAI error');
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

