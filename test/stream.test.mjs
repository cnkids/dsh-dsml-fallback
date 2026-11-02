import test from 'node:test';
import assert from 'node:assert/strict';
import { rebuildStream, dsmlFallbackStream } from '../lib/stream.js';

const P = '\uFF5C';
const open = (tag) => `<${P}DSML${P} ${tag}>`;
const close = (tag) => `</${P}DSML${P} ${tag}>`;
const CALLS = `${open('calls')}${open('invoke name="bash"')}${open('parameter name="command"')}pwd${close('parameter')}${close('invoke')}${close('calls')}`;

/** 正常模型的一段流：纯文本 + stop。 */
function plainStream() {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '你好，' },
    { type: 'text-delta', index: 0, text: '世界' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '你好，世界' } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
}

test('没有 DSML 的流原样返回（同一个数组）', () => {
  const chunks = plainStream();
  assert.equal(rebuildStream(chunks), chunks);
});

test('有 DSML 时重建出 tool-call 块，finish 改为 tool-calls', () => {
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: `我先查一下。${CALLS}` },
    { type: 'block-end', index: 0, block: { type: 'text', text: `我先查一下。${CALLS}` } },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = rebuildStream(chunks);
  const toolCall = out.find((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call');
  assert.ok(toolCall, '应生成 tool-call 块');
  assert.equal(toolCall.block.name, 'bash');
  assert.deepEqual(JSON.parse(toolCall.block.arguments), { command: 'pwd' });
  const text = out.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
  assert.equal(text, '我先查一下。');
  const finish = out.find((chunk) => chunk.type === 'finish');
  assert.deepEqual(finish.reason, { kind: 'tool-calls' });
});

test('reasoning 段保留', () => {
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: '先想想' },
    { type: 'text-delta', index: 1, text: CALLS },
    { type: 'finish', reason: { kind: 'stop' } },
  ];
  const out = rebuildStream(chunks);
  const reasoning = out.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join('');
  assert.equal(reasoning, '先想想');
  assert.ok(out.some((chunk) => chunk.type === 'block-end' && chunk.block.type === 'tool-call'));
});

test('usage 与 replayState 保留', () => {
  const replayState = { provider: 'local', model: 'flash-910b' };
  const chunks = [
    { type: 'text-delta', index: 0, text: CALLS },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' }, replayState },
  ];
  const out = rebuildStream(chunks);
  assert.ok(out.some((chunk) => chunk.type === 'usage'));
  const finish = out.find((chunk) => chunk.type === 'finish');
  assert.deepEqual(finish.replayState, replayState);
});

test('非 stop 的 finish 保持原 reason', () => {
  const chunks = [{ type: 'text-delta', index: 0, text: CALLS }, { type: 'finish', reason: { kind: 'max-tokens' } }];
  const out = rebuildStream(chunks);
  const finish = out.find((chunk) => chunk.type === 'finish');
  assert.deepEqual(finish.reason, { kind: 'max-tokens' });
});

test('异步流：DSML 被改写，普通流透传', async () => {
  async function* plain() {
    yield { type: 'text-delta', index: 0, text: 'ok' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  async function* withDsml() {
    yield { type: 'text-delta', index: 0, text: CALLS };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
  const plainOut = [];
  for await (const chunk of dsmlFallbackStream(plain())) plainOut.push(chunk);
  assert.equal(plainOut.length, 2);
  assert.equal(plainOut[0].text, 'ok');

  const dsmlOut = [];
  for await (const chunk of dsmlFallbackStream(withDsml())) dsmlOut.push(chunk);
  assert.ok(dsmlOut.some((chunk) => chunk.type === 'block-end' && chunk.block?.type === 'tool-call'));
});

test('onParsed 回调收到模型原文与解析结果（诊断开关）', async () => {
  const P = '\uFF5C';
  const text = `<${P}DSML${P} calls><${P}DSML${P} invoke name="bash"><${P}DSML${P} parameter name="command" string="true">pwd</${P}DSML${P} parameter></${P}DSML${P} invoke></${P}DSML${P} calls>`;
  const source = (async function* () {
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
  const seen = [];
  for await (const _ of dsmlFallbackStream(source, { onParsed: (p) => seen.push(p) })) { /* 消费完 */ }
  assert.equal(seen.length, 1);
  assert.ok(seen[0].text.includes('parameter name="command"'));
  assert.equal(seen[0].calls.length, 1);
  assert.equal(seen[0].calls[0].name, 'bash');
});
