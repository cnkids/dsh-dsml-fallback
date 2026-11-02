import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsmlCalls } from '../lib/dsml.js';

/** 全角竖线 U+FF5C，DSML 标签用它。 */
const P = '\uFF5C';
const open = (tag) => `<${P}DSML${P} ${tag}>`;
const close = (tag) => `</${P}DSML${P} ${tag}>`;

function callsBlock(invokes) {
  return open('calls') + invokes.join('') + close('calls');
}

function invoke(name, params) {
  const body = Object.entries(params)
    .map(([key, value]) => `${open(`parameter name="${key}"`)}${value}${close('parameter')}`)
    .join('');
  return `${open(`invoke name="${name}"`)}${body}${close('invoke')}`;
}

test('解析两个 invoke（用户真实样本形状）', () => {
  const text = callsBlock([
    invoke('bash', { command: 'cd /Users/cnkids/Work/Agent && pwd && ls -la', description: '查看工作目录内容' }),
    invoke('glob', { pattern: '**/*.xlsx' }),
  ]);
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 2);
  assert.deepEqual(JSON.parse(result.calls[0].arguments), {
    command: 'cd /Users/cnkids/Work/Agent && pwd && ls -la',
    description: '查看工作目录内容',
  });
  assert.deepEqual(JSON.parse(result.calls[1].arguments), { pattern: '**/*.xlsx' });
  assert.equal(result.text.trim(), '');
});

test('DSML 块前后的普通文本原样保留', () => {
  const text = `先看看文件。${callsBlock([invoke('bash', { command: 'ls' })])}完成。`;
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.text, '先看看文件。完成。');
});

test('参数值保留多行内容，只去掉首尾空白', () => {
  const text = callsBlock([invoke('write', { content: '\n第一行\n第二行\n' })]);
  const result = parseDsmlCalls(text);
  assert.equal(result.calls[0].name, 'write');
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { content: '第一行\n第二行' });
});

test('没有 DSML 时 calls 为空、文本不变', () => {
  const text = '普通回复，没有工具调用。';
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 0);
  assert.equal(result.text, text);
});

test('未闭合的 calls 块按普通文本保留', () => {
  const text = `${open('calls')} ${open('invoke name="bash"')} ${open('parameter name="command"')}pwd${close('parameter')} ${close('invoke')}`;
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 0);
  assert.equal(result.text, text);
});

test('块内没有有效 invoke 时整块当文本保留', () => {
  const text = callsBlock(['没有 invoke 标签']);
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 0);
  assert.equal(result.text, text);
});

test('多个 calls 块分别解析', () => {
  const text = callsBlock([invoke('a', { x: '1' })]) + '中间' + callsBlock([invoke('b', { y: '2' })]);
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 2);
  assert.equal(result.calls[0].name, 'a');
  assert.equal(result.calls[1].name, 'b');
  assert.equal(result.text, '中间');
});

test('参数名带特殊字符（如 path）也解析', () => {
  const text = callsBlock([invoke('read', { 'file_path': '/tmp/a.txt', 'offset': '10' })]);
  const result = parseDsmlCalls(text);
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { file_path: '/tmp/a.txt', offset: '10' });
});

test('参数开标签带 string="true" 属性时参数不丢失（真实 DSML 形状）', () => {
  const text =
    open('calls') +
    `${open('invoke name="glob"')}` +
    `${open('parameter name="pattern" string="true"')}**/*.xlsx${close('parameter')}` +
    `${open('parameter name="limit" string="false"')}20${close('parameter')}` +
    `${close('invoke')}` +
    close('calls');
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'glob');
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { pattern: '**/*.xlsx', limit: '20' });
});

test('invoke 开标签带额外属性时仍解析出工具名', () => {
  const text =
    open('calls') +
    `${open('invoke name="bash" string="true"')}` +
    `${open('parameter name="command" string="true"')}pwd${close('parameter')}` +
    `${close('invoke')}` +
    close('calls');
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'bash');
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { command: 'pwd' });
});

test('属性顺序变化（string 在 name 之前）也能解析', () => {
  const text =
    open('calls') +
    `${open('invoke string="true" name="read"')}` +
    `${open('parameter string="true" name="file_path"')}/tmp/a.txt${close('parameter')}` +
    `${close('invoke')}` +
    close('calls');
  const result = parseDsmlCalls(text);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].name, 'read');
  assert.deepEqual(JSON.parse(result.calls[0].arguments), { file_path: '/tmp/a.txt' });
});
