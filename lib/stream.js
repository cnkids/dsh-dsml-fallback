/**
 * 把一条 DSH assistant chunk 流转换成兜底后的流。
 *
 * 策略：整条流缓冲到结束（遇到 DSML 文本需要撤回已流出的文字，只能如此），
 * 然后看拼接后的正文里有没有完整的 DSML 工具调用：
 *   - 没有 → 原样返回全部 chunk，行为与未安装插件完全一致；
 *   - 有   → 重建块序列：reasoning（如有）+ 纯文本（如有）+ 每个工具调用一个
 *            tool-call 块，finish 从 stop 改为 tool-calls。
 *
 * DSH 的 agent-loop 只按「最终消息里有没有 tool-call 块」决定是否执行工具，
 * 因此重建出的 tool-call 块会被正常分发。
 */
import { parseDsmlCalls } from './dsml.js';

/**
 * 包装下游流：先收集全部 chunk，再决定是否改写。
 *
 * @param {AsyncIterable<object>} source - 下游 llm/stream 产生的 chunk 流。
 * @returns {AsyncGenerator<object>} 兜底改写后的 chunk 流。
 */
export async function* dsmlFallbackStream(source, hooks = {}) {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  if (typeof hooks.onParsed === 'function') {
    const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
    hooks.onParsed({ text, calls: parseDsmlCalls(text).calls });
  }
  yield* rebuildStream(chunks);
}

/**
 * 纯函数：给定完整 chunk 列表，返回应发出的 chunk 列表。
 * 没有 DSML 时直接返回原列表（同一个数组），保证正常模型零改动。
 *
 * @param {object[]} chunks - 一整条 assistant chunk 流。
 * @returns {object[]} 要发出的 chunk 列表。
 */
export function rebuildStream(chunks) {
  const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  const parsed = parseDsmlCalls(text);
  if (parsed.calls.length === 0) return chunks;

  const reasoning = chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('');
  const usage = chunks.find((chunk) => chunk.type === 'usage');
  const finish = chunks.find((chunk) => chunk.type === 'finish');
  const out = [];
  let index = 0;

  if (reasoning.length > 0) {
    out.push(
      { type: 'block-start', index, blockType: 'reasoning' },
      { type: 'reasoning-delta', index, text: reasoning },
      { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } },
    );
    index += 1;
  }

  const cleaned = parsed.text.trim();
  if (cleaned.length > 0) {
    out.push(
      { type: 'block-start', index, blockType: 'text' },
      { type: 'text-delta', index, text: cleaned },
      { type: 'block-end', index, block: { type: 'text', text: cleaned } },
    );
    index += 1;
  }

  let callNo = 0;
  for (const call of parsed.calls) {
    callNo += 1;
    const id = `dsml-${callNo}`;
    out.push(
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name: call.name, argumentsDelta: call.arguments },
      { type: 'block-end', index, block: { type: 'tool-call', id, name: call.name, arguments: call.arguments } },
    );
    index += 1;
  }

  if (usage !== undefined) out.push(usage);
  if (finish !== undefined) {
    const reason = finish.reason?.kind === 'stop' ? { kind: 'tool-calls' } : finish.reason;
    out.push({
      type: 'finish',
      reason,
      ...(finish.replayState === undefined ? {} : { replayState: finish.replayState }),
    });
  }
  return out;
}
