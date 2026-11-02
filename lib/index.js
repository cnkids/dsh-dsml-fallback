/**
 * dsh-dsml-fallback —— DSH host 插件。
 *
 * 拦截 `llm/stream` 的 chunk 流，把模型正文里的 DSML 文本工具调用
 * （`<｜DSML｜ calls>…</｜DSML｜ calls>`）解析成结构化 tool-call 块。
 * 对正常返回 tool_calls 的模型完全透明：没有 DSML 文本时流按原样透传。
 */
import { createRequire } from 'node:module';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dsmlFallbackStream } from './stream.js';

const pkg = createRequire(import.meta.url)('../package.json');

/** Cordis 插件名（Loader 诊断用）。 */
export const name = 'dsml-toolcall-fallback';
/** 依赖的 DSH 服务：只监听 llm 流，不注册新 provider。 */
export const inject = ['llm'];

/**
 * 注册 llm/stream 拦截。
 *
 * @param {object} ctx - 插件上下文。
 * @param {{enabled?: boolean}} [config] - 插件配置；enabled 默认 true。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) {
    ctx.logger?.info?.('[dsh-dsml-fallback] 已禁用（config.enabled === false）');
    return;
  }
  ctx.on('llm/stream', (_options, next) => lazyWrap(next, logEmptyArgsSample));
  ctx.logger?.info?.(`[dsh-dsml-fallback] v${pkg.version} 已启用：DSML 文本工具调用兜底解析`);
}

/**
 * 包一层惰性生成器：下游流要等第一次消费才开始，避免提前发起模型请求。
 *
 * @param {() => AsyncIterable<object>} next - 下游 llm/stream 链。
 * @returns {AsyncGenerator<object>} 兜底改写后的流。
 */
function lazyWrap(next, onParsed) {
  return (async function* () {
    yield* dsmlFallbackStream(next(), { onParsed });
  })();
}

/**
 * 诊断：解析出了工具调用但参数全空时，把模型原文落盘。
 * 只在异常样本上写，正常对话不产生日志。
 *
 * @param {{text: string, calls: Array<{name: string, arguments: string}>}} parsed - 解析结果。
 */
function logEmptyArgsSample(parsed) {
  if (parsed.calls.length === 0) return;
  if (!parsed.calls.every((call) => call.arguments === '{}')) return;
  const file = join(process.env.HOME ?? '.', '.dsh', 'logs', 'dsml-fallback-raw.log');
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `\n=== ${new Date().toISOString()} ${parsed.calls.map((c) => c.name).join(',')} ===\n${parsed.text.slice(0, 8000)}\n`);
  } catch {
    // 诊断日志写不进去不影响主流程。
  }
}
