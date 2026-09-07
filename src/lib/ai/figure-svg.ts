/**
 * AI 生成的配图 SVG：提取与服务端安全校验。
 *
 * 安全模型（两层，缺一不可）：
 * 1. 服务端这里做**粗粒度**校验：剥掉 markdown 围栏、截取 <svg>...</svg>、
 *    命中禁用元素/事件属性/外部引用/外链字体就整段丢弃。
 * 2. 前端渲染前用 DOMParser 做**严格**白名单消毒（见 components/figure-svg.tsx），
 *    最终以 <img src="data:image/svg+xml"> 渲染——该上下文里脚本不会执行。
 *
 * 任何一层不通过都返回 null（不渲染），保证"宁可不显示，也不能出事"。
 */

/** 允许出现的 SVG 元素（白名单，服务端只做粗查，前端会严格执行） */
export const FIGURE_SVG_ALLOWED_TAGS = [
    'svg', 'g', 'defs', 'marker', 'line', 'polyline', 'polygon', 'path',
    'circle', 'ellipse', 'rect', 'text', 'tspan', 'title', 'desc',
] as const;

/** 危险内容：脚本、外部实体、事件属性、外链、外部字体、data: 文本 */
const FORBIDDEN_PATTERNS: RegExp[] = [
    /<\s*(script|foreignObject|image|animate|animateTransform|animateMotion|set|use|a|iframe|style|link|meta|filter|pattern|linearGradient|radialGradient)\b/i,
    /\son[a-z-]+\s*=/i,                    // 事件属性 onclick / onload / onbegin ...
    /xlink:href|href\s*=/i,                // 外链引用（<a>/<use>/<image> 走这条）
    /javascript:/i,
    /data:text\/html/i,
    /url\(\s*['"]?\s*(https?:)?\/\//i,     // 外部资源引用
    /url\(\s*['"]?\s*data:/i,
    /@import/i,
    /entity\s|<!ENTITY|<!DOCTYPE/i,        // XML 外部实体（XXE）
];

/** 非白名单标签（<svg 之外出现的任何其它元素名都拒绝） */
const DISALLOWED_TAG = new RegExp(
    `<\\s*/?\\s*(?!/?(?:${FIGURE_SVG_ALLOWED_TAGS.join('|')})\\b)[a-zA-Z][a-zA-Z0-9-]*`,
    'i'
);

/**
 * 从 AI 原始输出中提取可用的 SVG 代码。
 * @returns 安全的 SVG 字符串；无图（NONE）、无内容、或校验不通过时返回 null
 */
export function extractFigureSvg(raw: string | null | undefined): string | null {
    if (!raw || typeof raw !== 'string') return null;

    let s = raw.trim();
    if (!s) return null;

    // 模型判定"无图"
    if (/^NONE\b/i.test(s)) return null;

    // 剥掉可能的 markdown 代码围栏
    s = s.replace(/^```(?:svg|xml|html|markdown)?\s*/i, '').replace(/\s*```\s*$/, '');

    // 截取 svg 片段
    const start = s.indexOf('<svg');
    const end = s.lastIndexOf('</svg>');
    if (start === -1 || end === -1 || end <= start) return null;
    s = s.slice(start, end + 6).trim();

    if (!s) return null;

    // 长度上限：正常示意图 SVG 远小于此，超长基本是异常输出
    if (s.length > 20000) return null;

    for (const re of FORBIDDEN_PATTERNS) {
        if (re.test(s)) return null;
    }
    if (DISALLOWED_TAG.test(s)) return null;

    // 生成质量兜底：一张可用的配图必须至少包含一个图形元素。
    // 只有 <text>/<defs>/<marker> 等、没有任何实际图形的输出视为废图（例如模型只画了标注文字），
    // 宁可不显示也不能显示一张错误的图。
    if (!/(?:<line\b|<polyline\b|<polygon\b|<path\b|<circle\b|<ellipse\b|<rect\b)/i.test(s)) return null;

    // 必须有 viewBox，否则缩放会失控
    if (!/viewBox\s*=\s*"/.test(s)) return null;

    // 补齐 xmlns（序列化为 data URL 时必须有）
    if (!/xmlns\s*=\s*"http:\/\/www\.w3\.org\/2000\/svg"/.test(s)) {
        s = s.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    }

    return s;
}

/**
 * 一致性抽查：SVG 里标注的数值是否都能在新题目文字里找到。
 * 用于举一反三——防止模型出的图和题目数值对不上（图不对题比没图更糟）。
 * 只校验带单位的数值（如 0.9千米），纯顶点名不参与。
 */
export function figureSvgNumbersMatchQuestion(svg: string, questionText: string): boolean {
    const labels = svg.match(/<text[^>]*>([^<]*)<\/text>/gi) || [];
    const numbers: string[] = [];
    for (const label of labels) {
        const inner = label.replace(/<[^>]*>/g, '').trim();
        const m = inner.match(/\d+(?:\.\d+)?/g);
        if (m) numbers.push(...m);
    }
    if (numbers.length === 0) return true; // 图里没有数值标注，不做判断
    const normalized = (questionText || '').replace(/\s/g, '');
    return numbers.every(n => normalized.includes(n));
}
