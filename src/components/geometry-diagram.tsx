"use client";

import React, { useMemo } from "react";

/**
 * 几何图类型
 */
type GeometryType =
    | "right-triangle"      // 直角三角形
    | "triangle"            // 一般三角形
    | "coordinate"          // 坐标系/函数图像
    | "circle"              // 圆
    | "line-segment"        // 线段
    | "angle"               // 角度示意
    | "none";               // 无需配图

interface GeometryDiagramProps {
    /** 题目文字（用于分析需要画什么图） */
    questionText?: string | null;
    /** 答案文字（辅助判断数值） */
    answerText?: string | null;
    /** AI 返回的结构化几何数据（JSON 字符串），优先级高于从文字推断 */
    geometryData?: string | null;
    /** 宽度 */
    width?: number;
    /** 高度 */
    height?: number;
}

/**
 * 解析 AI 返回的 geometryData JSON
 */
interface ParsedGeometryData {
    type: string;
    points?: Array<{ label: string; pos: string }>;
    labels?: Record<string, string>;
    centerLabel?: string;
    radiusLabel?: string;
    elements?: string[];
}

function parseGeometryData(raw: string | null | undefined): ParsedGeometryData | null {
    if (!raw || !raw.trim()) return null;
    try {
        const parsed = JSON.parse(raw.trim());
        if (parsed && typeof parsed.type === 'string') return parsed;
    } catch { /* ignore parse error */ }
    return null;
}

/**
 * 从题目文字推断几何图形类型
 */
function inferGeometryType(text: string): GeometryType {
    if (!text) return "none";
    const t = text.toLowerCase();

    // 直角三角形（最常见）
    if (
        /直角三角形|直角|勾股|斜边|直角边|RT[△\s]|Rt[△\s]/.test(t) ||
        (/(三角形|△)/.test(t) && /直角/.test(t))
    ) {
        return "right-triangle";
    }

    // 一般三角形
    if (/三角形|△|三边|三个点.*构成|三点/.test(t)) {
        return "triangle";
    }

    // 坐标系 / 函数图像
    if (/坐标|坐标系|x轴|y轴|原点|象限|抛物线|一次函数|二次函数|正比例|反比例|函数.*图像|图像/.test(t)) {
        return "coordinate";
    }

    // 圆
    if (/圆|圆心|半径|直径|弧|切线|弦|周长|π|圆周率/.test(t) && !/坐标/.test(t)) {
        return "circle";
    }

    // 线段 / 距离
    if (/距离|线段|长度为|相距|AB\s*=\s*\d|长\s*\d+\.?\d*\s*(千米|米|cm|km)/.test(t)) {
        return "line-segment";
    }

    // 角
    if (/角度|∠|角.*度|°/.test(t) && !/三角/.test(t)) {
        return "angle";
    }

    return "none";
}

/**
 * 从文字中提取带单位的距离/长度（如 "0.9千米"、"2.8 km"）
 * 只取真正的边长数据，忽略年份、答案等无关数字
 */
function extractDistances(text: string): number[] {
    // 匹配带距离单位的数字：数字 + 可选小数 + 单位
    const unitPattern = /(\d+\.?\d*)\s*(千米|km|米|m|cm|厘米|毫米|mm)/gi;
    const matches = [...text.matchAll(unitPattern)];
    if (matches.length > 0) {
        return matches.map(m => parseFloat(m[1])).filter(n => n > 0 && n < 10000);
    }

    // fallback: 没有单位时，提取"距离/长/边长"附近的数字
    const contextPattern = /(?:距离|长|边长|长度|相距)\s*[为是]?\s*(\d+\.?\d*)/gi;
    const ctxMatches = [...text.matchAll(contextPattern)];
    if (ctxMatches.length > 0) {
        return ctxMatches.map(m => parseFloat(m[1])).filter(n => n > 0 && n < 10000);
    }

    return [];
}

/**
 * 判断一个4位数是否像年份（过滤掉 2020~2030 这类）
 */
function isYearLike(n: number): boolean {
    return n >= 1980 && n <= 2100;
}

/**
 * 从题目文字中提取地点/顶点名称
 * 只匹配中文/英文字符，排除标点数字
 */
function extractPointNames(text: string): string[] {
    // 中文名：2-4个连续汉字
    const chineseName = /[\u4e00-\u9fa5]{2,4}/g;

    // 策略1："从XX出发(，)?经(过)?YY到ZZ" 路线模式 —— 最常见
    const routePattern = /从([\u4e00-\u9fa5]{2,4})\s*(?:出发|出发，|出发，)\s*(?:经过?|，(?:经)?过?)\s*([\u4e00-\u9fa5]{2,4})\s*(?:到|，?\s*到)\s*([\u4e00-\u9fa5]{2,4})/;
    const routeMatch = routePattern.exec(text);
    if (routeMatch) {
        return [routeMatch[1], routeMatch[2], routeMatch[3]];
    }

    // 策略2："XX在YY的ZZ方向"
    const dirPattern = /([\u4e00-\u9fa5]{2,4})\s*在\s*([\u4e00-\u9fa5]{2,4})\s*的/;
    const dirMatch = dirPattern.exec(text);
    if (dirMatch) {
        return [dirMatch[1], dirMatch[2]];
    }

    // 策略3：找 "XX距YY"/"XX到YY" 模式中的成对名称
    const nameCandidates = new Set<string>();
    const distPattern = /([\u4e00-\u9fa5]{2,4})\s*(?:距|到|至)\s*([\u4e00-\u9fa5]{2,4})/g;
    let m;
    while ((m = distPattern.exec(text)) !== null) {
        // 排除常见非地名词汇
        const exclude = ['距离', '直线', '之间', '连接', '延长', '相交', '垂直', '平行'];
        if (!exclude.includes(m[1])) nameCandidates.add(m[1]);
        if (!exclude.includes(m[2])) nameCandidates.add(m[2]);
    }
    if (nameCandidates.size >= 2) {
        return [...nameCandidates].slice(0, 3);
    }

    // fallback: 不提取，使用默认 A/B/C
    return [];
}

// ──────────────────────────────────────────────
// SVG 渲染器：各种几何图形
// ──────────────────────────────────────────────

/** 样式常量 */
const STROKE = "#1f2937";       // 深灰线条
const STROKE_WIDTH = 2;
const FONT_SIZE = 14;
const FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const POINT_RADIUS = 4;
const LABEL_COLOR = "#374151";
const HIGHLIGHT = "#2563eb";   // 蓝色高亮

/**
 * 直角三角形渲染
 * 优先使用 AI 返回的结构化数据（geo），fallback 到从文字正则提取
 */
function RightTriangleSVG({ text, w, h, geo }: { text: string; w: number; h: number; geo?: ParsedGeometryData | null }) {
    // 优先用结构化数据
    const useGeo = geo && geo.type === 'right-triangle';

    const distances = extractDistances(text);
    const pointNames = extractPointNames(text);

    // 边长：结构化数据 > 正则提取 > 默认值
    const legA = useGeo && geo.labels?.legA
        ? parseFloat(geo.labels.legA) || distances[0] || 0.9
        : distances[0] || 0.9;
    const legB = useGeo && geo.labels?.legB
        ? parseFloat(geo.labels.legB) || distances[1] || 2.8
        : distances[1] || 2.8;
    const hypotenuse = useGeo && geo.labels?.hypotenuse
        ? geo.labels.hypotenuse
        : (distances[2] || undefined);

    // 顶点名称：结构化数据 > 正则提取 > 默认值
    const topLabel = useGeo && geo.points?.[0]?.label ? geo.points[0].label : (pointNames[0] || "A");
    const rightLabel = useGeo && geo.points?.[1]?.label ? geo.points[1].label : (pointNames[1] || "B");
    const bottomLabel = useGeo && geo.points?.[2]?.label ? geo.points[2].label : (pointNames[2] || "C");

    // 三角形顶点坐标（留出标签空间）
    const pad = 50;
    const rightX = pad + 40;           // 直角顶点 x
    const rightY = h - pad - 20;       // 直角顶点 y
    const topX = rightX;                // 上方顶点 x（与直角同 x）
    const topY = pad + 30;              // 上方顶点 y
    const vertLegPx = Math.min(h - pad * 2 - 50, (rightY - topY) * 0.85); // 垂直直角边像素长
    const horizLegPx = Math.min(w - pad * 2 - 80, vertLegPx * (legB / legA)); // 水平直角边像素长
    const bottomX = rightX + horizLegPx; // 右下顶点 x
    const bottomY = rightY;             // 右下顶点 y（与直角同 y）

    // 直角标记
    const markSize = 14;

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            {/* 主三角形 */}
            <polygon
                points={`${topX},${topY} ${rightX},${rightY} ${bottomX},${bottomY}`}
                fill="none"
                stroke={STROKE}
                strokeWidth={STROKE_WIDTH}
                strokeLinejoin="round"
            />

            {/* 直角标记 */}
            <polyline
                points={`${rightX + markSize},${rightY} ${rightX + markSize},${rightY - markSize} ${rightX},${rightY - markSize}`}
                fill="none"
                stroke={STROKE}
                strokeWidth={1.5}
            />

            {/* 顶点 */}
            <circle cx={topX} cy={topY} r={POINT_RADIUS} fill={HIGHLIGHT} />
            <circle cx={rightX} cy={rightY} r={POINT_RADIUS} fill={HIGHLIGHT} />
            <circle cx={bottomX} cy={bottomY} r={POINT_RADIUS} fill={HIGHLIGHT} />

            {/* 顶点标签 */}
            <text x={topX - 18} y={topY + 4} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>{topLabel}</text>
            <text x={rightX - 28} y={rightY + 20} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>{rightLabel}</text>
            <text x={bottomX + 8} y={bottomY + 18} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>{bottomLabel}</text>

            {/* 边长标注（带单位） */}
            {legA > 0 && (
                <text x={rightX - 38} y={(topY + rightY) / 2 + 4} fontSize={12} fontFamily={FONT_FAMILY} fill="#6b7280">{legA}</text>
            )}
            {legB > 0 && (
                <text x={(rightX + bottomX) / 2 - 10} y={rightY + 18} fontSize={12} fontFamily={FONT_FAMILY} fill="#6b7280">{legB}</text>
            )}
            {hypotenuse && (
                <text x={(topX + bottomX) / 2 + 12} y={(topY + bottomY) / 2 - 8} fontSize={12} fontFamily={FONT_FAMILY} fill="#6b7280">{hypotenuse}</text>
            )}
        </svg>
    );
}

/**
 * 一般三角形渲染
 */
function TriangleSVG({ text, w, h, geo }: { text: string; w: number; h: number; geo?: ParsedGeometryData | null }) {
    const useGeo = geo && geo.type === 'triangle';
    const pointNames = extractPointNames(text);
    const pad = 50;

    const labelA = useGeo && geo.points?.[0]?.label ? geo.points[0].label : (pointNames[0] || "A");
    const labelB = useGeo && geo.points?.[1]?.label ? geo.points[1].label : (pointNames[1] || "B");
    const labelC = useGeo && geo.points?.[2]?.label ? geo.points[2].label : (pointNames[2] || "C");

    const ax = w / 2, ay = pad + 20;          // 顶点 A（上）
    const bx = pad + 40, by = h - pad - 10;    // 左下 B
    const cx = w - pad - 40, cy = h - pad - 10; // 右下 C

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            <polygon
                points={`${ax},${ay} ${bx},${by} ${cx},${cy}`}
                fill="none"
                stroke={STROKE}
                strokeWidth={STROKE_WIDTH}
                strokeLinejoin="round"
            />
            <circle cx={ax} cy={ay} r={POINT_RADIUS} fill={HIGHLIGHT} />
            <circle cx={bx} cy={by} r={POINT_RADIUS} fill={HIGHLIGHT} />
            <circle cx={cx} cy={cy} r={POINT_RADIUS} fill={HIGHLIGHT} />
            <text x={ax - 5} y={ay - 10} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>{labelA}</text>
            <text x={bx - 16} y={by + 18} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>{labelB}</text>
            <text x={cx + 8} y={cy + 18} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>{labelC}</text>
        </svg>
    );
}

/**
 * 坐标系渲染
 */
function CoordinateSVG({ text, w, h }: { text: string; w: number; h: number }) {
    const pad = 45;
    const originX = pad + 20;
    const originY = h - pad - 20;
    const axisLenX = w - pad * 2 - 20;
    const axisLenY = h - pad * 2 - 30;

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            {/* 网格 */}
            <defs>
                <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">
                    <path d="M 30 0 L 0 0 0 30" fill="none" stroke="#e5e7eb" strokeWidth="0.5" />
                </pattern>
            </defs>
            <rect x={originX} y={pad + 10} width={axisLenX} height={axisLenY} fill="url(#grid)" />

            {/* X 轴 */}
            <line x1={originX - 15} y1={originY} x2={originX + axisLenX} y2={originY} stroke={STROKE} strokeWidth={STROKE_WIDTH} markerEnd="url(#arrow)" />
            {/* Y 轴 */}
            <line x1={originX} y1={originY + 15} x2={originX} y2={originY - axisLenY} stroke={STROKE} strokeWidth={STROKE_WIDTH} markerEnd="url(#arrow)" />

            {/* 箭头定义 */}
            <defs>
                <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">
                    <path d="M0,0 L0,6 L8,3 z" fill={STROKE} />
                </marker>
            </defs>

            {/* 原点标签 */}
            <text x={originX - 14} y={originY + 16} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>O</text>
            <text x={originX + axisLenX - 4} y={originY + 18} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>x</text>
            <text x={originX + 6} y={originY - axisLenY + 6} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>y</text>
        </svg>
    );
}

/**
 * 圆渲染
 */
function CircleSVG({ text, w, h, geo }: { text: string; w: number; h: number; geo?: ParsedGeometryData | null }) {
    const useGeo = geo && geo.type === 'circle';
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) / 2 - 55;

    const centerL = useGeo && geo.centerLabel ? geo.centerLabel : "O";
    const radiusL = useGeo && geo.radiusLabel ? geo.radiusLabel : "r";

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            <circle cx={cx} cy={cy} r={r} fill="none" stroke={STROKE} strokeWidth={STROKE_WIDTH} />
            <circle cx={cx} cy={cy} r={POINT_RADIUS} fill={HIGHLIGHT} />
            {/* 圆心十字 */}
            <line x1={cx - 8} y1={cy} x2={cx + 8} y2={cy} stroke={STROKE} strokeWidth={1} opacity={0.5} />
            <line x1={cx} y1={cy - 8} x2={cx} y2={cy + 8} stroke={STROKE} strokeWidth={1} opacity={0.5} />
            <text x={cx - 4} y={cy + 20} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>{centerL}</text>
            {/* 半径示意 */}
            <line x1={cx} y1={cy} x2={cx + r} y2={cy} stroke={HIGHLIGHT} strokeWidth={1.5} strokeDasharray="4,3" />
            <text x={cx + r / 2 - 8} y={cy - 6} fontSize={12} fontFamily={FONT_FAMILY} fill={HIGHLIGHT}>{radiusL}</text>
        </svg>
    );
}

/**
 * 线段渲染
 */
function LineSegmentSVG({ text, w, h }: { text: string; w: number; h: number }) {
    const nums = extractDistances(text);
    const label = nums.length > 0 ? `${nums[0]} 千米` : "";
    const pad = 60;
    const y = h / 2;

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            <line x1={pad} y1={y} x2={w - pad} y2={y} stroke={STROKE} strokeWidth={STROKE_WIDTH} markerStart="url(#dot)" markerEnd="url(#dot)" />
            <defs>
                <marker id="dot" markerWidth="8" markerHeight="8" refX="4" refY="4">
                    <circle cx="4" cy="4" r={POINT_RADIUS} fill={HIGHLIGHT} />
                </marker>
            </defs>
            <text x={pad - 10} y={y + 5} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>A</text>
            <text x={w - pad + 8} y={y + 5} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>B</text>
            {label && (
                <text x={w / 2 - 25} y={y - 10} fontSize={13} fontFamily={FONT_FAMILY} fill={HIGHLIGHT}>{label}</text>
            )}
        </svg>
    );
}

/**
 * 角度示意图渲染
 */
function AngleSVG({ text, w, h }: { text: string; w: number; h: number }) {
    const cx = w / 3;
    const cy = h / 2 + 20;
    const rayLen = Math.min(w, h) / 2.5;

    return (
        <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
            {/* 两条射线 */}
            <line x1={cx} y1={cy} x2={cx + rayLen} y2={cy} stroke={STROKE} strokeWidth={STROKE_WIDTH} />
            <line x1={cx} y1={cy} x2={cx + rayLen * 0.65} y2={cy - rayLen * 0.75} stroke={STROKE} strokeWidth={STROKE_WIDTH} />
            {/* 角度弧 */}
            <path d={`M ${cx + 35} ${cy} A 35 35 0 0 0 ${cx + 27} ${cy - 23}`} fill="none" stroke={HIGHLIGHT} strokeWidth={1.5} />
            <circle cx={cx} cy={cy} r={POINT_RADIUS} fill={HIGHLIGHT} />
            <text x={cx - 4} y={cy + 20} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>O</text>
            <text x={cx + rayLen + 6} y={cy + 5} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>A</text>
            <text x={cx + rayLen * 0.65 + 8} y={cy - rayLen * 0.75 - 6} fontSize={FONT_SIZE} fontFamily={FONT_FAMILY} fill={LABEL_COLOR}>B</text>
        </svg>
    );
}

// ──────────────────────────────────────────────
// 主组件
// ──────────────────────────────────────────────

export function GeometryDiagram({ questionText, answerText, geometryData, width = 400, height = 260 }: GeometryDiagramProps) {
    // 重要：只用 questionText 提取数值，不用 answerText！
    // 答案中可能包含 AI 计算出的中间结果（如勾股定理算出的 2.7），会污染原图数值
    const textForExtraction = questionText || "";

    // 优先使用 AI 返回的结构化数据，fallback 到文字推断
    const parsedGeo = useMemo(() => parseGeometryData(geometryData), [geometryData]);
    const geoType = parsedGeo?.type as GeometryType || useMemo(() => inferGeometryType(textForExtraction), [textForExtraction]);

    // 不需要配图时返回 null
    if (geoType === "none") return null;

    const renderSVG = () => {
        switch (geoType) {
            case "right-triangle":
                return <RightTriangleSVG text={textForExtraction} w={width} h={height} geo={parsedGeo} />;
            case "triangle":
                return <TriangleSVG text={textForExtraction} w={width} h={height} geo={parsedGeo} />;
            case "coordinate":
                return <CoordinateSVG text={textForExtraction} w={width} h={height} />;
            case "circle":
                return <CircleSVG text={textForExtraction} w={width} h={height} geo={parsedGeo} />;
            case "line-segment":
                return <LineSegmentSVG text={textForExtraction} w={width} h={height} />;
            case "angle":
                return <AngleSVG text={textForExtraction} w={width} h={height} />;
            default:
                return null;
        }
    };

    return (
        <div style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            padding: "8px 0",
            background: "#fafafa",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
        }}>
            {renderSVG()}
        </div>
    );
}

export type { GeometryType };
