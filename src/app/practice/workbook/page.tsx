"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { FigureSvg } from "@/components/figure-svg";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { Printer, ArrowLeft, AlertTriangle, RefreshCw } from "lucide-react";
import { apiClient } from "@/lib/api-client";

interface PracticeQuestion {
    questionText?: string;
    answerText?: string;
    analysis?: string;
    knowledgePoints?: string[] | string;
    requiresImage?: boolean;
    figureSvg?: string | null;
    subject?: string;
    isOriginalImage?: boolean;
    originalImageUrl?: string | null;
}

interface PracticeItem {
    errorItemId: string;
    question: PracticeQuestion | null;
    error?: string | null;
    sourceTitle?: string;
}

interface WorkbookPayload {
    difficulty?: string;
    generatedAt?: string;
    source?: string;
    items?: PracticeItem[];
}

const DIFFICULTY_LABEL: Record<string, string> = {
    easy: "简单",
    medium: "中等",
    hard: "较难",
    harder: "困难",
};

export default function PracticeWorkbookPage() {
    const router = useRouter();
    const [payload, setPayload] = useState<WorkbookPayload | null>(null);
    const [loaded, setLoaded] = useState(false);
    const [showAnswer, setShowAnswer] = useState(false);
    const [isRetrying, setIsRetrying] = useState(false);

    useEffect(() => {
        try {
            const raw = sessionStorage.getItem("practice-workbook");
            if (raw) {
                setPayload(JSON.parse(raw));
            }
        } catch {
            setPayload(null);
        }
        setLoaded(true);
    }, []);

    const items = payload?.items || [];
    const successItems = items.filter((it) => it.question);
    const failedItems = items.filter((it) => !it.question);

    const handlePrint = () => {
        window.print();
    };

    // 重试生成失败的题（只重试失败项，成功的不动）
    const handleRetryFailed = async () => {
        if (!payload || failedItems.length === 0) return;
        setIsRetrying(true);
        try {
            const res = await apiClient.post<{ results: PracticeItem[] }>("/api/practice/generate-batch", {
                errorItemIds: failedItems.map(it => it.errorItemId),
                difficulty: payload.difficulty || "medium",
            });
            const newResults = res.results || [];
            // 把重试结果合并回 payload（用 errorItemId 匹配替换）
            setPayload(prev => {
                if (!prev) return prev;
                const resultMap = new Map(newResults.map(r => [r.errorItemId, r]));
                const mergedItems = (prev.items || []).map(item =>
                    (item.question === null && resultMap.has(item.errorItemId))
                        ? resultMap.get(item.errorItemId)!
                        : item
                );
                return { ...prev, items: mergedItems };
            });
        } catch (error) {
            console.error(error);
            alert("重试失败，请稍后再试");
        } finally {
            setIsRetrying(false);
        }
    };

    if (loaded && items.length === 0) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-8 text-center">
                <AlertTriangle className="h-10 w-10 text-muted-foreground" />
                <p className="text-lg">还没有生成练习卷</p>
                <p className="text-sm text-muted-foreground">
                    请先到错题本勾选多道错题，点击底部「举一反三」生成练习卷。
                </p>
                <Button onClick={() => router.push("/")}>返回首页</Button>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background">
            {/* 控制栏（打印时隐藏） */}
            <div className="print:hidden sticky top-0 z-10 bg-background border-b p-3 sm:p-4 shadow-sm">
                <div className="max-w-4xl mx-auto flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                        <Button variant="outline" size="sm" onClick={() => router.back()}>
                            <ArrowLeft className="mr-2 h-4 w-4" />
                            返回
                        </Button>
                        <span className="text-sm text-muted-foreground">
                            练习卷 · 共 {successItems.length} 题
                            {failedItems.length > 0 && `（${failedItems.length} 题生成失败）`}
                            {payload?.difficulty && ` · ${DIFFICULTY_LABEL[payload.difficulty] || payload.difficulty}`}
                        </span>
                    </div>
                    <div className="flex items-center gap-2">
                        {failedItems.length > 0 && (
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={handleRetryFailed}
                                disabled={isRetrying}
                            >
                                {isRetrying ? (
                                    <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                                ) : (
                                    <RefreshCw className="mr-2 h-4 w-4" />
                                )}
                                重试失败项（{failedItems.length}）
                            </Button>
                        )}
                        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
                            <input
                                type="checkbox"
                                checked={showAnswer}
                                onChange={(e) => setShowAnswer(e.target.checked)}
                            />
                            显示答案/解析
                        </label>
                        <Button size="sm" onClick={handlePrint}>
                            <Printer className="mr-2 h-4 w-4" />
                            打印 / 导出 PDF
                        </Button>
                    </div>
                </div>
            </div>

            {/* 练习卷主体 */}
            <div className="max-w-4xl mx-auto p-8 print:p-0">
                <h1 className="text-xl font-bold text-center mb-1 print:mb-2">举一反三练习卷</h1>
                {payload?.difficulty && (
                    <p className="text-center text-xs text-muted-foreground mb-4 print:mb-3">
                        难度：{DIFFICULTY_LABEL[payload.difficulty] || payload.difficulty}
                    </p>
                )}

                {successItems.map((it, idx) => {
                    const q = it.question!;
                    return (
                        <section
                            key={it.errorItemId}
                            className="mb-4 pb-4 border-b border-muted last:border-b-0 print:break-inside-avoid"
                        >
                            <h2 className="font-semibold mb-2 text-base">第 {idx + 1} 题</h2>
                            {q.isOriginalImage && q.originalImageUrl ? (
                                <img
                                    src={q.originalImageUrl}
                                    alt="原题"
                                    className="h-auto border rounded max-w-full"
                                />
                            ) : (
                                <>
                                    <MarkdownRenderer content={q.questionText || ""} className="font-medium" />
                                    {q.figureSvg && (
                                        <div className="mt-3">
                                            <FigureSvg svg={q.figureSvg} />
                                        </div>
                                    )}
                                </>
                            )}
                            {/* 作答留白 */}
                            <div className="mt-4 h-[80px] print:h-[90px]" />
                            {showAnswer && (
                                <div className="mt-4 pl-4 border-l-2 border-muted">
                                    {q.answerText && (
                                        <>
                                            <h3 className="font-semibold mb-1">参考答案：</h3>
                                            <MarkdownRenderer content={q.answerText} />
                                        </>
                                    )}
                                    {q.analysis && (
                                        <>
                                            <h3 className="font-semibold mb-1 mt-3">解析：</h3>
                                            <MarkdownRenderer content={q.analysis} />
                                        </>
                                    )}
                                </div>
                            )}
                        </section>
                    );
                })}

                {failedItems.length > 0 && (
                    <section className="mt-8 pt-4 border-t">
                        <h2 className="font-semibold mb-3 text-muted-foreground">生成失败的题（{failedItems.length}）</h2>
                        {failedItems.map((it) => (
                            <p key={it.errorItemId} className="text-sm text-muted-foreground mb-1">
                                · {it.sourceTitle || it.errorItemId}：{it.error || "生成失败"}
                            </p>
                        ))}
                    </section>
                )}
            </div>
        </div>
    );
}
