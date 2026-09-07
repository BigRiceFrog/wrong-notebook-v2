// Re-export the Zod-validated type from schema.ts
export type { ParsedQuestionFromSchema as ParsedQuestion } from './schema';
import type { ParsedQuestionFromSchema } from './schema';

// Import and re-export MistakeStatus from the single source of truth
import type { MistakeStatus } from '../mistake-status';
export type { MistakeStatus };

export type DifficultyLevel = 'easy' | 'medium' | 'hard' | 'harder';

export interface ReanswerQuestionResult {
    answerText: string;
    analysis: string;
    knowledgePoints: string[];
    wrongAnswerText: string;
    mistakeAnalysis: string;
    mistakeStatus: MistakeStatus;
}

export interface GeogebraAnalysisResult {
    suitable: boolean;
    commands: string[];
    description: string;
}

export interface AIService {
    analyzeImage(imageBase64: string, mimeType?: string, language?: 'zh' | 'en', grade?: 7 | 8 | 9 | 10 | 11 | 12 | null, subject?: string | null, gradeSemester?: string | null): Promise<ParsedQuestionFromSchema>;
    /** 根据题目文字生成配图（几何图形/函数图像等），返回 base64 Data URL */
    generateDiagram(questionText: string, subject?: string | null): Promise<string | null>;
    /** geometryData: 原题的结构化几何数据（JSON 字符串），供确定性变式快速通道使用（可选） */
    generateSimilarQuestion(originalQuestion: string, knowledgePoints: string[], language?: 'zh' | 'en', difficulty?: DifficultyLevel, gradeSemester?: string | null, geometryData?: string | null): Promise<ParsedQuestionFromSchema>;
    reanswerQuestion(questionText: string, language?: 'zh' | 'en', subject?: string | null, imageBase64?: string, gradeSemester?: string | null): Promise<ReanswerQuestionResult>;
    analyzeForGeogebra(questionText: string, answerText: string, analysis: string, previousErrors?: string): Promise<GeogebraAnalysisResult>;
}

export interface AIConfig {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    // Azure OpenAI 特有字段
    azureDeployment?: string;   // Azure 部署名称
    azureApiVersion?: string;   // API 版本 (如 2024-02-15-preview)
}
