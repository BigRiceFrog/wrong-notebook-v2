import { toPng } from "html-to-image";

/**
 * 将题目卡片 DOM 节点截图生成为 PNG data URL。
 * 多次重试以等待 KaTeX 公式与字体渲染完成，避免截到空白卡片。
 */
export async function generateCardPng(node: HTMLElement, maxRetries = 15): Promise<string> {
    let lastErr: unknown;
    for (let i = 0; i < maxRetries; i++) {
        try {
            const url = await toPng(node, {
                pixelRatio: 2,
                cacheBust: true,
                backgroundColor: "#ffffff",
            });
            if (url && url.startsWith("data:image")) {
                console.log(`[CardImage] toPng 成功(第${i + 1}次尝试), length=${url.length}`);
                return url;
            }
        } catch (e) {
            lastErr = e;
            if (i < 3) console.log(`[CardImage] toPng 第${i + 1}次失败:`, e);
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw lastErr ?? new Error("generateCardPng: 无法生成题目卡片图");
}
