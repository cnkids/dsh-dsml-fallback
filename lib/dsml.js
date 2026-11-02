/**
 * DSML 文本工具调用解析。
 *
 * 部分 OpenAI 兼容网关（例如本地部署的 deepseek-flash-910b）不会返回结构化
 * tool_calls，而是把工具调用写进正文文本：
 *
 *   <｜DSML｜ calls>
 *     <｜DSML｜ invoke name="bash">
 *       <｜DSML｜ parameter name="command">pwd</｜DSML｜ parameter>
 *     </｜DSML｜ invoke>
 *   </｜DSML｜ calls>
 *
 * 本模块把这种文本解析成 {name, arguments(JSON 字符串)}，并把 DSML 之外的
 * 普通文字原样保留。解析保守：没有完整闭合、或没有有效 invoke 的块一律按
 * 普通文本保留，绝不让畸形输入变成工具调用。
 */

/** DSML 标签使用全角竖线 U+FF5C。 */
const PIPE = '\uFF5C';
const OPEN_CALLS = `<${PIPE}DSML${PIPE} calls>`;
const CLOSE_CALLS = `</${PIPE}DSML${PIPE} calls>`;
const CLOSE_INVOKE = `</${PIPE}DSML${PIPE} invoke>`;
const CLOSE_PARAM = `</${PIPE}DSML${PIPE} parameter>`;
/** 任意开标签的公共前缀：`<｜DSML｜ `。 */
const TAG_PREFIX = `<${PIPE}DSML${PIPE} `;

/**
 * 解析一段文本里的全部 DSML 工具调用。
 *
 * @param {string} text - 模型输出的正文文本。
 * @returns {{ calls: Array<{name: string, arguments: string}>, text: string }}
 *   calls 是解析出的工具调用；text 是剥离 DSML 块之后剩余的普通文本。
 */
export function parseDsmlCalls(text) {
  const calls = [];
  const plain = [];
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf(OPEN_CALLS, cursor);
    if (open === -1) {
      plain.push(text.slice(cursor));
      break;
    }
    plain.push(text.slice(cursor, open));
    const close = text.indexOf(CLOSE_CALLS, open + OPEN_CALLS.length);
    if (close === -1) {
      // 未闭合的 calls 块：保留原文，不当作工具调用。
      plain.push(text.slice(open));
      break;
    }
    const inner = text.slice(open + OPEN_CALLS.length, close);
    const invokes = parseInvokes(inner);
    if (invokes.length === 0) {
      // 块内没有有效 invoke：保留原文。
      plain.push(text.slice(open, close + CLOSE_CALLS.length));
    } else {
      calls.push(...invokes);
    }
    cursor = close + CLOSE_CALLS.length;
  }
  return { calls, text: plain.join('') };
}

/**
 * 解析一个开标签，返回工具名/参数名与标签结束位置。
 *
 * 兼容真实 DSML 的形状：`name="x"` 前后可能有其它属性（典型的是
 * `string="true"`），属性顺序也不固定；标签内的 `>` 若落在引号里不算结束。
 *
 * @param {string} text - 包含标签的文本。
 * @param {number} at - 标签起点（指向 `<`）。
 * @param {string} tag - 标签名，如 `invoke` / `parameter`。
 * @returns {{name: string, end: number} | null} 解析结果；不是该标签或缺 name 时为 null。
 */
function parseOpenTag(text, at, tag) {
  const head = `${TAG_PREFIX}${tag}`;
  if (!text.startsWith(head, at)) return null;
  const attrStart = at + head.length;
  const next = text[attrStart];
  if (next !== ' ' && next !== '>') return null;
  const end = findTagEnd(text, attrStart);
  if (end === -1) return null;
  const match = /name\s*=\s*"([^"]*)"/.exec(text.slice(attrStart, end));
  if (match === null) return null;
  return { name: match[1], end: end + 1 };
}

/**
 * 从 from 开始找不在引号内的 `>`。
 *
 * @param {string} text - 文本。
 * @param {number} from - 起始下标。
 * @returns {number} `>` 的下标；找不到返回 -1。
 */
function findTagEnd(text, from) {
  let quoted = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === '>' && !quoted) return i;
  }
  return -1;
}

/** 解析一个 calls 块内部的全部 invoke，跳过无法完整解析的那些。 */
function parseInvokes(inner) {
  const calls = [];
  let cursor = 0;
  while (cursor < inner.length) {
    const open = inner.indexOf(`${TAG_PREFIX}invoke`, cursor);
    if (open === -1) break;
    const tag = parseOpenTag(inner, open, 'invoke');
    if (tag === null) {
      cursor = open + 1;
      continue;
    }
    const close = inner.indexOf(CLOSE_INVOKE, tag.end);
    if (close === -1) break;
    const args = parseParams(inner.slice(tag.end, close));
    calls.push({ name: tag.name, arguments: JSON.stringify(args) });
    cursor = close + CLOSE_INVOKE.length;
  }
  return calls;
}

/** 解析一个 invoke 内部的全部 parameter；值去掉首尾空白，内部内容原样保留。 */
function parseParams(body) {
  const params = {};
  let cursor = 0;
  while (cursor < body.length) {
    const open = body.indexOf(`${TAG_PREFIX}parameter`, cursor);
    if (open === -1) break;
    const tag = parseOpenTag(body, open, 'parameter');
    if (tag === null) {
      cursor = open + 1;
      continue;
    }
    const close = body.indexOf(CLOSE_PARAM, tag.end);
    if (close === -1) break;
    params[tag.name] = body.slice(tag.end, close).trim();
    cursor = close + CLOSE_PARAM.length;
  }
  return params;
}
