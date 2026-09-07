"use client";

import React, { forwardRef } from "react";
import { ParsedQuestion } from "@/lib/ai";
import { MarkdownRenderer } from "@/components/markdown-renderer";

interface QuestionCardProps {
    data: ParsedQuestion;
    subjectName?: string | null;
    /** 带图题直接展示原图（AI 重绘 SVG 不可靠，不再使用） */
    imageUrl?: string | null;
}

/**
 * 题目卡片：渲染识图结果（文字 + 原题图片）。
 * 带图题（requiresImage=true）直接展示原图，不使用 AI 重绘的 SVG。
 */
export const QuestionCard = forwardRef<HTMLDivElement, QuestionCardProps>(
    ({ data, subjectName, imageUrl }, ref) => {
        const tags: string[] = Array.isArray(data.knowledgePoints)
            ? data.knowledgePoints
            : [];

        return (
            <div
                ref={ref}
                style={{
                    width: 800,
                    padding: 32,
                    background: "#ffffff",
                    color: "#1f2937",
                    fontFamily:
                        "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif",
                    boxSizing: "border-box",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        borderBottom: "2px solid #2563eb",
                        paddingBottom: 12,
                        marginBottom: 20,
                    }}
                >
                    <span style={{ fontSize: 20, fontWeight: 700, color: "#2563eb" }}>
                        智能错题本
                    </span>
                    <span style={{ fontSize: 14, color: "#6b7280" }}>
                        {subjectName || data.subject || ""}
                    </span>
                </div>

                {/* 题目：先显示几何图（如有），再显示文字 */}
                <div style={{ marginBottom: 18 }}>
                    <div style={{ fontSize: 15, fontWeight: 600, color: "#374151", marginBottom: 6 }}>
                        题目
                    </div>
                    {/* 带图题直接展示原图（原图本身包含纸面文字），跳过重复的识别文字 */}
                    {data.requiresImage && imageUrl ? (
                        <img
                            src={imageUrl}
                            alt="原题图片"
                            style={{ maxWidth: "100%", height: "auto", marginBottom: 12 }}
                        />
                    ) : (
                        data.questionText && (
                            <div style={{ fontSize: 15, lineHeight: 1.7 }}>
                                <MarkdownRenderer content={data.questionText} />
                            </div>
                        )
                    )}
                </div>

                <Section title="答案" content={data.answerText} />
                <Section title="解析" content={data.analysis} />

                {tags.length > 0 && (
                    <div style={{ marginTop: 16 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                            知识点
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                            {tags.map((t, i) => (
                                <span
                                    key={i}
                                    style={{
                                        fontSize: 13,
                                        background: "#eff6ff",
                                        color: "#1d4ed8",
                                        border: "1px solid #bfdbfe",
                                        borderRadius: 999,
                                        padding: "4px 12px",
                                    }}
                                >
                                    {t}
                                </span>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    }
);

QuestionCard.displayName = "QuestionCard";

function Section({ title, content }: { title: string; content?: string | null }) {
    if (!content) return null;
    return (
        <div style={{ marginBottom: 18 }}>
            <div
                style={{
                    fontSize: 15,
                    fontWeight: 600,
                    color: "#374151",
                    marginBottom: 6,
                }}
            >
                {title}
            </div>
            <div style={{ fontSize: 15, lineHeight: 1.7 }}>
                <MarkdownRenderer content={content} />
            </div>
        </div>
    );
}
