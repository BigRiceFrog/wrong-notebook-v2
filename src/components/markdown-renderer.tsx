import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

/**
 * 把正文中"裸露的 LaTeX 命令（带花括号参数，如 \underline{\hspace{1cm}}、\frac{1}{2}）"
 * 自动包进 $...$ 交给 KaTeX 渲染，避免源码外泄。
 * - 已用 $...$ / $$...$$ 包裹的公式原样跳过，不会二次包裹；
 * - 仅当命令后紧跟 { 才包裹，避免误伤 Windows 路径（C:\temp）等。
 */
function wrapBareLatex(content: string): string {
    let out = '';
    let i = 0;
    const n = content.length;
    while (i < n) {
        const ch = content[i];
        // 已用 $$...$$ 包裹的公式：原样跳过
        if (ch === '$' && content[i + 1] === '$') {
            const end = content.indexOf('$$', i + 2);
            if (end === -1) { out += '$'; i++; continue; }
            out += content.slice(i, end + 2);
            i = end + 2;
            continue;
        }
        // 已用 $...$ 包裹的公式：原样跳过
        if (ch === '$') {
            const end = content.indexOf('$', i + 1);
            if (end === -1) { out += '$'; i++; continue; }
            out += content.slice(i, end + 1);
            i = end + 1;
            continue;
        }
        // 反斜杠：LaTeX 命令
        if (ch === '\\') {
            const next = content[i + 1];
            if (next && /[A-Za-z]/.test(next)) {
                let j = i + 1;
                while (j < n && /[A-Za-z]/.test(content[j])) j++;
                // 仅当命令后紧跟 { 才视为需包裹的数学命令，避免误伤 C:\path 等
                let wrapped = false;
                while (j < n && content[j] === '{') {
                    let depth = 0;
                    while (j < n) {
                        if (content[j] === '{') depth++;
                        else if (content[j] === '}') { depth--; if (depth === 0) { j++; break; } }
                        j++;
                    }
                    wrapped = true;
                }
                if (wrapped) {
                    out += '$' + content.slice(i, j) + '$';
                    i = j;
                    continue;
                }
            }
            // 不是需要包裹的命令：原样保留（含反斜杠）
            out += '\\';
            i++;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

interface MarkdownRendererProps {
    content: string;
    className?: string;
}

export function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
    // Preprocess content to ensure proper paragraph breaks and LaTeX rendering
    // Convert single line breaks to double line breaks for better readability
    const processedContent = content
        // First, convert literal \n sequences to actual newlines (fix for AI responses)
        .replace(/\\n/g, '\n')
        // Normalize LaTeX delimiters: some models return \(...\) / \[...\] instead of $...$ / $$...$$
        // (use function replacements to avoid $$ escaping pitfalls in .replace strings)
        .replace(/\\\[([\s\S]*?)\\\]/g, (_m, inner) => `\n\n$$${inner}$$\n\n`)
        .replace(/\\\(([\s\S]*?)\\\)/g, (_m, inner) => `$${inner}$`)
        // 填空下划线归一化：连续下划线（≥3个半角 / ≥2个全角）转为 KaTeX 下划线空白，
        // 长度随下划线个数自适应（每个约0.5em，上限4em）。不处理的话 Markdown 会把
        // 连续下划线解析成 emphasis/strong 定界符，把填空横线"吃掉"导致显示残缺。
        .replace(/_{3,}/g, (m) => `$\\underline{\\hspace{${Math.min(m.length * 0.5, 4)}em}}$`)
        .replace(/＿{2,}/g, (m) => `$\\underline{\\hspace{${Math.min(m.length * 0.5, 4)}em}}$`)
        // Preserve existing double line breaks with a unique marker
        .replace(/\n\n/g, '\n\n###PRESERVE_BREAK###\n\n')
        // Convert patterns that should be new paragraphs
        .replace(/([。！？；])\n(?!\n)/g, '$1\n\n')  // Chinese punctuation followed by single newline
        .replace(/([.!?;])\s*\n(?!\n)/g, '$1\n\n')   // English punctuation followed by single newline
        .replace(/(\d+\))\s*\n(?!\n)/g, '$1\n\n')    // Numbered items like (1), (2)
        .replace(/([\u2460-\u2473])\s*\n(?!\n)/g, '$1\n\n')  // Circled numbers ①②③
        // Fix: Remove indentation for lines starting with circled numbers or (n) to prevent code block rendering
        .replace(/\n\s+([\u2460-\u2473])/g, '\n$1')
        .replace(/\n\s+(\d+\))/g, '\n$1')
        // Fix LaTeX formulas: Ensure proper spacing around $ delimiters
        // This handles cases where $ might be directly adjacent to text
        .replace(/([^\s$])(\$[^$]+\$)([^\s$])/g, '$1 $2 $3')
        // Restore preserved double line breaks (use flexible whitespace matching)
        .replace(/\s*###PRESERVE_BREAK###\s*/g, '\n\n');

    // 把正文中裸露的 LaTeX 命令（如 \underline{\hspace{1cm}}）包进 $...$ 交给 KaTeX 渲染，
    // 并给新生成的公式两侧补空格以兼容 KaTeX 定界符解析。
    const finalContent = wrapBareLatex(processedContent)
        .replace(/([^\s$])(\$[^$]+\$)([^\s$])/g, '$1 $2 $3');

    return (
        <div className={`markdown-content overflow-x-auto min-w-0 ${className}`}>
            <ReactMarkdown
                remarkPlugins={[remarkMath, remarkGfm]}
                rehypePlugins={[rehypeKatex]}
                components={{
                    // 自定义样式
                    h1: ({ node, ...props }) => <h1 className="text-2xl font-bold mt-6 mb-4" {...props} />,
                    h2: ({ node, ...props }) => <h2 className="text-xl font-bold mt-5 mb-3" {...props} />,
                    h3: ({ node, ...props }) => <h3 className="text-lg font-bold mt-4 mb-2" {...props} />,
                    p: ({ node, ...props }) => <p className="mb-3 leading-relaxed" {...props} />,
                    ul: ({ node, ...props }) => <ul className="list-disc list-inside mb-3 space-y-1" {...props} />,
                    ol: ({ node, ...props }) => <ol className="list-decimal list-inside mb-3 space-y-1" {...props} />,
                    li: ({ node, ...props }) => <li className="ml-4" {...props} />,
                    blockquote: ({ node, ...props }) => (
                        <blockquote className="border-l-4 border-primary pl-4 italic my-4 text-muted-foreground" {...props} />
                    ),
                    code: ({ node, inline, className, children, ...props }: any) => {
                        if (inline) {
                            return <code className="bg-muted px-1.5 py-0.5 rounded text-sm font-mono text-foreground" {...props}>{children}</code>;
                        }
                        return (
                            <code className="block bg-muted p-4 rounded-lg overflow-x-auto my-3 font-mono text-sm" {...props}>
                                {children}
                            </code>
                        );
                    },
                    table: ({ node, ...props }) => (
                        <div className="overflow-x-auto my-4">
                            <table className="min-w-full border-collapse border border-border" {...props} />
                        </div>
                    ),
                    th: ({ node, ...props }) => (
                        <th className="border border-border px-4 py-2 bg-muted font-semibold text-left" {...props} />
                    ),
                    td: ({ node, ...props }) => (
                        <td className="border border-border px-4 py-2" {...props} />
                    ),
                    strong: ({ node, ...props }) => <strong className="font-bold text-foreground" {...props} />,
                    em: ({ node, ...props }) => <em className="italic" {...props} />,
                }}
            >
                {finalContent}
            </ReactMarkdown>
        </div>
    );
}
