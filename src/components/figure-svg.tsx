"use client";

import { useMemo } from "react";

/**
 * AI 生成配图的安全渲染组件。
 *
 * 为什么不能直接 innerHTML：AI 返回的 SVG 可能包含 <script>、onload 事件、
 * foreignObject、外链资源等，直接插入 DOM 就是一个 XSS 入口。
 *
 * 两道防线：
 * 1. 用 DOMParser 解析成独立文档，按白名单剔除元素与属性（不合法直接不渲染）
 * 2. 序列化后以 <img src="data:image/svg+xml"> 渲染——浏览器在该上下文里
 *    不会执行 SVG 内的脚本、不加载外部资源，等于再加一层沙箱
 */

const ALLOWED_TAGS = new Set([
    'svg', 'g', 'defs', 'marker', 'line', 'polyline', 'polygon', 'path',
    'circle', 'ellipse', 'rect', 'text', 'tspan', 'title', 'desc',
]);

const ALLOWED_ATTRS = new Set([
    'xmlns', 'viewBox', 'width', 'height', 'preserveAspectRatio',
    'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
    'points', 'd', 'transform', 'opacity',
    'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width',
    'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray',
    'font-family', 'font-size', 'font-weight', 'text-anchor', 'dominant-baseline',
    'marker-end', 'marker-start', 'marker-mid',
    'id', 'refX', 'refY', 'markerWidth', 'markerHeight', 'orient',
]);

function sanitize(raw: string): string | null {
    if (typeof window === "undefined" || typeof window.DOMParser === "undefined") return null;

    const doc = new DOMParser().parseFromString(raw, "image/svg+xml");
    if (doc.getElementsByTagName("parsererror").length > 0) return null;

    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== "svg") return null;

    // 深度优先清理：先处理子节点，再处理自身属性
    const clean = (node: Element) => {
        for (const child of Array.from(node.children)) {
            const tag = child.tagName.toLowerCase();
            if (!ALLOWED_TAGS.has(tag)) {
                child.remove(); // 非白名单元素整棵移除，不做解包
                continue;
            }
            clean(child);
        }
        for (const attr of Array.from(node.attributes)) {
            const name = attr.name.toLowerCase();
            if (name.startsWith("on") || !ALLOWED_ATTRS.has(name)) {
                node.removeAttribute(attr.name);
            }
        }
    };
    clean(root);

    root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    if (!root.getAttribute("viewBox")) root.setAttribute("viewBox", "0 0 480 320");

    return new XMLSerializer().serializeToString(root);
}

interface FigureSvgProps {
    svg?: string | null;
    width?: number;
    className?: string;
}

export function FigureSvg({ svg, width = 480, className }: FigureSvgProps) {
    const dataUrl = useMemo(() => {
        if (!svg || !svg.includes("<svg")) return null;
        const clean = sanitize(svg);
        if (!clean) return null;
        return `data:image/svg+xml;utf8,${encodeURIComponent(clean)}`;
    }, [svg]);

    if (!dataUrl) return null;

    return (
        <img
            src={dataUrl}
            alt="题目配图"
            className={className}
            style={{ maxWidth: "100%", width, height: "auto", display: "block", margin: "0 auto" }}
        />
    );
}
