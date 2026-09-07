import { ProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';
import { createLogger } from './logger';

const logger = createLogger('proxy');

// 捕获 ProxyAgent 实例，供 getProxyFetch() 将请求绑定到代理
let proxyAgent: ProxyAgent | undefined;

export function setupGlobalProxy() {
    // 优先级：项目专用变量 > 系统环境变量
    // AI_PROXY_URL 是本项目专用的代理地址，不会被系统级 HTTP_PROXY 覆盖
    // （系统变量可能被沙箱/IDE 等工具设为非代理端口，导致 Gemini 等外部 API 连不通）
    const aiProxy = process.env.AI_PROXY_URL;
    const httpProxy = aiProxy || process.env.http_proxy || process.env.HTTP_PROXY;
    const httpsProxy = aiProxy || process.env.https_proxy || process.env.HTTPS_PROXY;
    const allProxy = process.env.all_proxy || process.env.ALL_PROXY;

    // Logic: Specific proxy > All proxy > None
    const targetHttpProxy = httpProxy || allProxy;
    const targetHttpsProxy = httpsProxy || allProxy;

    if (targetHttpProxy || targetHttpsProxy) {
        if (process.env.NODE_ENV === 'development') {
            logger.info({ http: targetHttpProxy, https: targetHttpsProxy }, 'Configuring proxy');
        }

        // 1. Configure Undici (global fetch)
        // Undici accepts a single dispatcher.
        // For general usage (APIs, etc.), we usually care about the HTTPS proxy.
        // If only HTTP is available, fall back to that.
        const undiciProxy = targetHttpsProxy || targetHttpProxy;
        if (undiciProxy) {
            try {
                proxyAgent = new ProxyAgent(undiciProxy);
                setGlobalDispatcher(proxyAgent);
                if (process.env.NODE_ENV === 'development') {
                    logger.info({ proxy: undiciProxy }, 'Global Undici dispatcher set');
                }
            } catch (error) {
                logger.error({ error }, 'Failed to set global Undici dispatcher');
            }
        }

        // 2. Configure legacy http/https modules using global-agent
        try {
            // We set the environment variables that global-agent looks for
            if (targetHttpProxy) process.env.GLOBAL_AGENT_HTTP_PROXY = targetHttpProxy;
            if (targetHttpsProxy) process.env.GLOBAL_AGENT_HTTPS_PROXY = targetHttpsProxy;

            // Also set the global config object which global-agent uses
            // @ts-ignore
            global.GLOBAL_AGENT = {
                HTTP_PROXY: targetHttpProxy,
                HTTPS_PROXY: targetHttpsProxy,
            };

            // Import bootstrap to patch http/https
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('global-agent/bootstrap');

            if (process.env.NODE_ENV === 'development') {
                logger.info('global-agent/bootstrap initialized');
            }
        } catch (error) {
            logger.error({ error }, 'Failed to initialize global-agent');
        }
    }
}

/**
 * 返回"代理感知"的 fetch 函数，供各 AI Provider 的 SDK 使用。
 *
 * 背景：Node 内置的 `fetch`（被 @google/genai / openai SDK 使用）不会读取
 * npm 包 `undici` 的全局 dispatcher，导致即使配置了 HTTP(S)_PROXY，
 * SDK 仍然直连目标域名（在受限网络下会失败）。
 *
 * 这里直接把请求绑定到 ProxyAgent 实例，确保：
 * - 配置了代理时：请求经代理出口（解决上述直连失败问题）
 * - 未配置代理时：退化为 undici 原生 fetch（等同于直连，不影响国内服务）
 */
export function getProxyFetch(): (input: any, init?: any) => Promise<any> {
    if (proxyAgent) {
        const agent = proxyAgent;
        logger.info({ proxy: agent?.toString?.() }, 'Using proxy-aware fetch for AI SDK');
        return (input: any, init?: any) => undiciFetch(input, { ...init, dispatcher: agent });
    }
    return undiciFetch as unknown as (input: any, init?: any) => Promise<any>;
}
