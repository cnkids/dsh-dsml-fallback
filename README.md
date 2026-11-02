# dsh-dsml-fallback

DSH 兜底插件：把模型输出里的 **DSML 文本工具调用**解析成 DSH 的结构化 `tool-call` 块。

## 解决什么问题

部分 OpenAI 兼容网关（例如公司本地部署的 `deepseek-flash-910b`）不返回结构化
`tool_calls`，而是把工具调用写进正文文本：

```
<｜DSML｜ calls>
  <｜DSML｜ invoke name="bash">
    <｜DSML｜ parameter name="command" string="true">pwd</｜DSML｜ parameter>
  </｜DSML｜ invoke>
</｜DSML｜ calls>
```

DSH 只认结构化的 `tool_calls`，这种文本会被当成普通回复显示、工具不会执行。
本插件拦截 DSH 的 `llm/stream` 流：

- 正文里出现**完整** DSML 调用块 → 剥掉文本、重建为 `tool-call` 块，工具正常执行；
- 正常模型（返回结构化 `tool_calls`）→ 流原样透传，**行为零变化**；
- 未闭合 / 没有有效 invoke 的 DSML 文本 → 按普通文本保留，不会误触发工具；
- 参数开标签带 `string="true"` 等属性、属性顺序任意，都能正确取到值。

## 安装

```bash
dsh plugin --profile web add dsh-dsml-fallback   # 发布到 npm 后
# 或本地目录：
dsh plugin --profile web add /path/to/dsh-dsml-fallback
```

装完重启 `dsh web` 生效。

## 配置

```yml
- id: dsh-dsml-fallback
  name: 'dsh-dsml-fallback'
  config:
    enabled: false   # 默认 true
```

## 已知边界

- 只有出现 DSML 文本时才缓冲整条流再改写，因此**触发兜底的那条回复**会失去逐 token
  流式显示；正常模型的流不受影响。
- 只处理 DSML 格式，不猜测其它文本工具调用写法（避免把正文里的 JSON 示例误当调用）。
- `finish` 的 `reason` 若是 `stop`，有工具调用时会改为 `tool-calls`；其它 reason 原样保留。

## 更新记录

- **0.1.1** — 修复参数开标签带 `string="true"` 等属性时参数被丢弃、工具只能收到 `{}`
  的问题（表现为 `missing required property`）。开标签属性顺序也不再影响解析。
- **0.1.0** — 首个版本。

## 测试

```bash
npm test
```
