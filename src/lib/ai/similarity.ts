// 字符级相似度检测（用于反 AI 偷懒：校验变式题是否真变了）
// 去标点/空格/LaTeX $ 后，用 LCS 长度除以两串较长者长度得相似度

const PUNCT_RE = /[\s.,!?，。！？、；：;:()（）"'`\-\/\\|【】\{\}《》〈〉·…—\u00a0]/g;
const LATEX_RE = /\$\$?/g;

function normalize(s: string): string {
    return (s || '').replace(PUNCT_RE, '').replace(LATEX_RE, '');
}

// 最长公共子序列长度（字符级 O(n*m)，题面一般 <500 字足够用）
function lcsLen(a: string, b: string): number {
    if (!a || !b) return 0;
    const m = a.length, n = b.length;
    // 滚动数组
    let prev = new Uint16Array(n + 1);
    let cur = new Uint16Array(n + 1);
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (a.charCodeAt(i - 1) === b.charCodeAt(j - 1)) {
                cur[j] = prev[j - 1] + 1;
            } else {
                cur[j] = prev[j] > cur[j - 1] ? prev[j] : cur[j - 1];
            }
        }
        [prev, cur] = [cur, prev];
    }
    return prev[n];
}

/**
 * 计算两文本相似度（0-1，越高越像）。
 * 去空白/标点/LaTeX $ 后比较。
 */
export function textSimilarity(a: string, b: string): number {
    const na = normalize(a);
    const nb = normalize(b);
    if (!na || !nb) return 1; // 空字符串视为完全相同（避免误杀）
    const longer = Math.max(na.length, nb.length);
    const lcs = lcsLen(na, nb);
    return lcs / longer;
}

/**
 * AI 偷懒检测：相似度超过阈值视为"几乎没变"。
 * 阈值 0.72 兼顾：改了情境/结构的真变式能过，只改几个数字或名字过不了。
 */
export function detectLazy(originalQuestion: string, newQuestionText: string, threshold = 0.72) {
    const score = textSimilarity(originalQuestion, newQuestionText);
    return { similar: score >= threshold, score };
}
