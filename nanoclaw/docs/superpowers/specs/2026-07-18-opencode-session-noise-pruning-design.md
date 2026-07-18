# OpenCode 会话「噪音剪枝」设计（存储级 / 缓存安全）

日期：2026-07-18
状态：已批准设计，待实现计划

## 背景与问题

NanoClaw 的每个群在容器内以 OpenCode 作为 LLM 运行时。OpenCode 每轮把整个 session
的历史 part 重新拼进 prompt。`container/agent-runner/src/index.ts:273-275` 显式关闭了
OpenCode 的自动 compaction（`compaction.auto = false`），因为其 summary 压缩会把真实历史
总结掉、丢失严重。

后果：session 只增不减。`war-room` 群积累到 26MB，某次发消息时 prompt 超过火山方舟
（ark-coding-plan / kimi-k2.6）实际端点的 token 限额，API 直接报
`The request exceeded model token limit`，agent 无任何输出，容器干等到超时被杀
（code 137）——表现为「发消息不回」。`main` 群因当日 WAL 损坏被重建为空库而侥幸避开。

## 目标

- 防止 session 无限膨胀撞 token 墙。
- **无损于真实回复**：保留每一条 `text`/`file`（真实回复），只丢弃对后续对话无用的
  `tool`（调用+结果）与 `reasoning`（思考）。
- **严格保证 prompt 前缀逐轮字节稳定**，不破坏 provider 前缀缓存（硬约束）。
- 不 fork OpenCode 内核；全部在 NanoClaw 宿主侧完成。

## 非目标

- 不替换 `compact-history`（它作为「彻底重置+摘要」的应急手段保留）。
- 不启用 OpenCode 自动 compaction。
- 不改变人类可见聊天记录（存于 NanoClaw 自有 `store/messages.db`，完全不动）。

## 已验证的数据事实

- part 唯一真源是每群 session 库 `data/sessions/{group}/.opencode/opencode/opencode-dev.db`
  的 `part` 表；`storage/session_diff/*.json` 为空/极小，无需处理。
- 表结构：`part(id, message_id, session_id, time_created, time_updated, data)`；
  part 类型位于 `data` JSON 的 `$.type`；`message(id, session_id, time_created, data)`，
  角色位于 `$.role`。
- 一个 `tool` part 行内同时含 `state.input`+`state.output`（调用+结果），整行删除
  **不产生悬空 tool_use/tool_result**（Anthropic 配对要求得以保持）。
- 轮次结构：1 条 user 消息 = 1 行；一个 assistant 轮次 = 多行，每个工具步骤是一条独立
  assistant message（`step-start,reasoning,tool,step-finish`），最后一步才带 `text`。
  剪掉旧轮的 `tool`+`reasoning` 后，中间纯工具步的 assistant 消息只剩 step 类，被
  `toModelMessages`（`packages/opencode/src/session/message-v2.ts:408`）当空消息滤掉，
  最终形态为 `user文本 → assistant文本`。

## 缓存安全设计（核心）

前缀缓存按逐字节前缀匹配；某位置一变，其后全部 miss。三条铁律：

1. **一次性、永久删除**：用 `DELETE` 物理删行，删完定型，绝不改写/重排/替换。保留的
   `text` part 不可变 → 后续各轮读到的旧历史逐字节一致 → 命中。
2. **确定性边界，按轮次而非 token 预算**：规则为「保留最近 K 个用户轮次不动，更早的一律
   剪」，边界 = 第 K 近 user 消息的 `time_created`。边界只随新消息单调前移一轮，不漂移。
   （这正是 OpenCode 内置 compaction 按 `preserve_recent_tokens` 动态算导致边界每轮
   漂移的坑，本设计规避之。）
3. **只删不重排**：只删噪音 part，`text` 原位保留，顺序不变。（对比：OpenCode summary
   compaction 会重排消息 `message-v2.ts:578`，会毁缓存。）

**成本（诚实记录）**：某轮首次从保留区滑出、以剪枝形态进入 prompt 的那一次，会在该轮位置
产生一次性 re-encode。纯文本轮零成本；仅带工具的轮有此一次性成本，此后永久命中；每轮最多
一个轮次跨界。此为任何剪枝的理论下界，已最小化。非「每轮 prompt 都不同」。

## 剪枝逻辑（确定性 SQL）

参数：`:sid` = 群聊 session id，`:K` = 保留最近 K 个用户轮次。

```sql
WITH boundary AS (
  SELECT time_created AS t
  FROM message
  WHERE session_id = :sid AND json_extract(data,'$.role') = 'user'
  ORDER BY time_created DESC, id DESC
  LIMIT 1 OFFSET (:K - 1)
)
DELETE FROM part
WHERE session_id = :sid
  AND json_extract(data,'$.type') IN ('tool','reasoning')
  AND message_id IN (
    SELECT id FROM message
    WHERE session_id = :sid AND time_created < (SELECT t FROM boundary)
  );
```

- user 消息不足 K 条 → `boundary` 为空 → 不删（小会话天然豁免）。
- 只删 `tool`/`reasoning`；`step-start/step-finish/text/file` 保留。
- 幂等：重复运行删同一批，已删为 no-op。

## 组件与集成

1. **`src/session-prune.ts`（新）**：导出 `pruneOpencodeSession(groupFolder, { keepUserTurns })`，
   用 `bun:sqlite` 打开宿主 session 库，事务内执行上述 DELETE。单一职责、可独立测试。
2. **每轮结束自动调用**：在 `src/index.ts` 容器完成、拿到 `newSessionId` 处调用。此刻容器
   已退出无锁竞争，per-group 队列保证串行，边界每轮前移一轮。
3. **配置**（`src/config.ts`）：
   - `SESSION_PRUNE_ENABLED`：默认 `true`。
   - `SESSION_PRUNE_KEEP_TURNS`：默认 **5**（保留最近 5 个用户轮次的工具/思考作为追问余量；
     可设更小，不建议 0）。
4. **回填命令**：`bun run prune-session <group> [--keep N] [--session <id>]`，对存量大会话
   手动剪一遍。不做 VACUUM——`DELETE` 后文件不缩小但空闲页会被复用，token 问题已由删行解决，
   为回收几 MB 磁盘引入更重的 VACUUM 步骤不划算，故不实现。

## 错误处理

- 库文件不存在 / session 不存在 → 记录 `logger.info` 并跳过，不影响主流程。
- DELETE 全程包在单事务中；异常回滚，不留半剪状态。
- 剪枝失败绝不阻塞消息回复（best-effort，异常仅记录）。

## 测试

- 单元：构造含多轮（含工具轮）的临时 session 库，断言剪枝后
  （a）旧轮 `tool`/`reasoning` 被删、`text` 保留；
  （b）最近 K 轮完整；
  （c）幂等（二次运行零变化）；
  （d）user < K 时不删。
- 集成/手工验证：
  - 正确性：剪枝后跑一轮，`tail` 该群 `opencode.log` 确认无 token limit / 无 dangling
    tool_use 报错、正常回复。
  - 缓存：连发 2~3 条，核对 usage 的 `cache_read` 逐轮为正且稳定。

## 回退

纯宿主侧、开关可关；关掉即恢复原行为。真实回复在两个 db 均在；不可逆的仅「旧的思考/工具
痕迹」——即目标丢弃物。
