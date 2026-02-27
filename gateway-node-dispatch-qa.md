# OpenClaw Gateway vs Node 任务分发策略 Q&A

> 讨论日期：2026-02-27
> 参与者：Chen Jian + Claude Opus 4.5

---

## 背景问题

**Q: OpenClaw Gateway 如何决定哪些任务自己处理，哪些需要 dispatch 给 Node？**

A: 这是一个关于**同步 vs 异步**、**轻量 vs 重量**任务边界的架构决策问题。核心思路是：

- **Gateway**：同步、轻量、快速响应
- **Node**：异步、重量、耗时任务

---

## Q1: 任务分发的决策流程是什么？

```
┌─────────────────────────────────────────────────────────────────┐
│                    Gateway 决策点                                │
│                                                                  │
│   Request ──▶ Gateway ──▶ 任务分类器 ──┬──▶ 本地处理 (同步返回) │
│                                         │                        │
│                                         └──▶ Dispatch (异步)     │
│                                              → EventBridge       │
│                                              → SQS → Node        │
└─────────────────────────────────────────────────────────────────┘
```

Gateway 接收到请求后，通过**任务分类器**判断：
1. 符合本地处理条件 → 直接处理，同步返回结果
2. 需要重量级处理 → 发布事件到 EventBridge → SQS → Node 异步执行

---

## Q2: 分类的标准是什么？

| 维度 | Gateway 本地处理 | Dispatch 给 Node |
|------|------------------|------------------|
| **执行时间** | < 3 秒 | > 3 秒 |
| **是否需要 Browser** | 否 | 是 |
| **是否需要 Agent Loop** | 否（单轮 LLM） | 是（多轮迭代） |
| **资源消耗** | 低（仅 API 调用） | 高（CPU/内存密集） |
| **状态** | 无状态 | 有状态（需要持久化） |

---

## Q3: 具体哪些任务由 Gateway 本地处理？

```yaml
LocalTasks:
  # 1. 简单 LLM 问答（单轮，无工具调用）
  - type: simple_chat
    example: "什么是 OpenClaw？"
    reason: 单次 Bedrock API 调用，3s 内返回

  # 2. 数据查询（已有缓存/DB）
  - type: task_status_query
    example: "查询任务 xxx 的状态"
    reason: 直接查 DynamoDB/Redis，毫秒级

  # 3. 配置/元数据操作
  - type: config_update
    example: "更新用户偏好设置"
    reason: 简单 DB 写操作

  # 4. 健康检查/心跳
  - type: health_check
    reason: 不涉及业务逻辑
```

**特点总结**：
- 无需工具调用
- 无需浏览器
- 单轮交互
- 3 秒内可完成

---

## Q4: 具体哪些任务需要 Dispatch 给 Node？

```yaml
DispatchTasks:
  # 1. 需要 Browser 的任务
  - type: web_automation
    example: "帮我登录 xxx 网站并下载报表"
    reason: 需要 Puppeteer/Playwright

  # 2. 需要多轮 Agent Loop 的任务
  - type: complex_reasoning
    example: "分析这份财报并生成投资建议"
    reason: 需要多轮 LLM + 工具调用迭代

  # 3. 需要执行外部工具的任务
  - type: tool_execution
    example: "调用 API 获取股票数据并分析"
    reason: 可能涉及网络 I/O、超时、重试

  # 4. 长时间运行的任务
  - type: batch_processing
    example: "批量处理 100 个 URL"
    reason: 耗时可能 10+ 分钟
```

**特点总结**：
- 需要浏览器自动化
- 需要多轮 Agent 循环（规划→执行→观察→调整）
- 需要调用外部工具/API
- 执行时间不可预测或超过 3 秒

---

## Q5: 如何实现任务分类器？

### 方案 A：静态规则（推荐先实现）

```python
class TaskRouter:
    """Gateway 中的任务分类器"""

    # 本地处理的任务类型
    LOCAL_TASK_TYPES = {
        "simple_chat",      # 单轮对话
        "task_query",       # 状态查询
        "config_update",    # 配置更新
    }

    # 需要 dispatch 的特征关键词
    DISPATCH_INDICATORS = [
        "browser", "浏览器",
        "网页", "登录", "下载",
        "批量", "batch",
        "分析", "研究", "调研",
        "自动化", "automation",
    ]

    def route(self, task: Task) -> str:
        """
        返回 'local' 或 'dispatch'
        """
        # 1. 显式类型匹配
        if task.type in self.LOCAL_TASK_TYPES:
            return "local"

        # 2. 关键词检测
        prompt_lower = task.prompt.lower()
        if any(kw in prompt_lower for kw in self.DISPATCH_INDICATORS):
            return "dispatch"

        # 3. 显式工具需求
        if task.requires_tools or task.requires_browser:
            return "dispatch"

        # 4. 默认：简短任务本地处理
        if len(task.prompt) < 100:
            return "local"

        return "dispatch"
```

**优点**：
- 简单、可预测、易调试
- 零延迟（无需额外 LLM 调用）
- 易于扩展规则

**缺点**：
- 可能误判边界情况
- 需要持续维护规则

---

### 方案 B：LLM 辅助分类（更智能）

```python
ROUTING_PROMPT = """
判断以下用户任务应该如何处理：

任务内容: {task_prompt}

判断标准:
- LOCAL（本地处理）: 单轮简单问答、状态查询、配置操作、3秒内能完成
- DISPATCH（分发处理）: 需要浏览器、需要多步推理、需要工具调用、耗时较长

只输出一个词: LOCAL 或 DISPATCH
"""

async def smart_route(task: Task) -> str:
    """
    使用快速模型做智能分类
    """
    response = await bedrock.invoke(
        model="anthropic.claude-3-haiku",  # 用最快的模型
        prompt=ROUTING_PROMPT.format(task_prompt=task.prompt),
        max_tokens=10
    )
    return "local" if "LOCAL" in response.upper() else "dispatch"
```

**优点**：
- 更智能，能理解语义
- 能处理边界情况
- 规则自动进化（换更好的模型即可）

**缺点**：
- 增加 ~200ms 延迟（Haiku 调用）
- 增加成本（每次分类消耗 tokens）
- 分类结果可能不稳定

---

### 方案 C：混合方案（推荐）

```python
class HybridTaskRouter:
    """静态规则优先，不确定时用 LLM"""

    def __init__(self):
        self.static_router = TaskRouter()

    async def route(self, task: Task) -> str:
        # 1. 先用静态规则
        static_result = self.static_router.route(task)

        # 2. 如果静态规则有明确结论，直接返回
        if self._is_confident(task, static_result):
            return static_result

        # 3. 不确定的情况，用 LLM 辅助
        return await smart_route(task)

    def _is_confident(self, task: Task, result: str) -> bool:
        """判断静态规则是否足够自信"""
        # 显式类型匹配 → 高置信度
        if task.type in self.static_router.LOCAL_TASK_TYPES:
            return True
        # 显式需要浏览器 → 高置信度
        if task.requires_browser:
            return True
        # 其他情况 → 低置信度，交给 LLM
        return False
```

---

## Q6: 为什么不把所有任务都 Dispatch 给 Node？

**性能考虑**：
- Gateway 本地处理：延迟 ~500ms（直接调 Bedrock）
- Dispatch 给 Node：延迟 ~2-5s（EventBridge → SQS → Node 冷启动/拉取）

**成本考虑**：
- 本地处理：仅 LLM API 成本
- Dispatch：额外的 SQS、EventBridge、Fargate 计算成本

**用户体验**：
- 简单问题秒回 vs 所有请求都要等待异步结果

---

## Q7: 为什么不让 Gateway 处理所有任务？

**资源限制**：
- Gateway 是轻量级服务，不适合运行 Puppeteer/Playwright（需要 2+ GB 内存）
- 长时间任务会阻塞 Gateway，影响其他请求

**超时限制**：
- API Gateway / ALB 默认 30s 超时
- Agent Loop 可能需要数分钟

**扩缩容粒度**：
- Gateway 按 QPS 扩缩容
- Node 按任务队列深度扩缩容
- 分开后可以独立优化

---

## Q8: 边界情况如何处理？

### Case 1: 单轮 LLM + 1 次工具调用

```
用户: "现在几点了？"
→ 需要调用 time 工具，但只需 1 次
```

**建议**：本地处理
- 虽然需要工具，但是单次、快速
- 可以在 Gateway 内置简单工具（time、weather 等）

### Case 2: 用户显式要求异步

```
用户: "这个任务比较复杂，后台帮我处理，完成后通知我"
```

**建议**：尊重用户意图，Dispatch
- API 可以提供 `async: true` 参数

### Case 3: 不确定是否需要浏览器

```
用户: "帮我查一下 xxx 公司的最新新闻"
→ 可能需要搜索引擎（工具），也可能需要浏览器
```

**建议**：先尝试本地（用搜索工具），如果需要更深入再 Dispatch
- 或者用 LLM 辅助判断

---

## Q9: 实现优先级建议

```
Phase 1: 静态规则（MVP）
├── 实现 TaskRouter 静态分类
├── 明确的类型走本地/Dispatch
└── 记录分类日志，收集数据

Phase 2: 规则优化
├── 分析日志，找出误判 case
├── 补充关键词和规则
└── 调整阈值（如 3s → 5s）

Phase 3: LLM 辅助（可选）
├── 对不确定 case 引入 LLM 分类
├── A/B 测试效果
└── 评估成本 vs 准确率
```

---

## Q10: 待确认的开放问题

1. **Gateway 是否已经内置 LLM 调用能力？**
   - 如果有，简单问答可以本地处理
   - 如果没有，需要先实现

2. **"简单"的边界在哪？**
   - 3 秒？5 秒？
   - 单轮 + 1 次工具调用算简单吗？

3. **是否需要用户显式指定？**
   - API 参数 `sync: true/false`
   - 让用户选择同步/异步

4. **Gateway 内置哪些轻量工具？**
   - time、weather、calculator？
   - 还是完全不内置，有工具就 Dispatch？

---

## 总结

| 决策 | 结论 |
|------|------|
| Gateway 处理什么 | 单轮 LLM、状态查询、配置操作 |
| Node 处理什么 | Browser、多轮 Agent Loop、工具调用、长任务 |
| 分类方案 | 静态规则优先，可选 LLM 辅助 |
| 关键阈值 | 3 秒执行时间、100 字符 prompt 长度 |

---

*Generated from architecture discussion on 2026-02-27*
