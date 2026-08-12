# SIS 架构不变式 — 设计和修改时必须遵守的约束

> **定位**：此文档定义 SIS 自免疫系统的**不可变架构约束**。任何涉及 SIS 相关文件的修改，必须先对照此文档，确认不违反约束。
> **创建日期**：2026-08-12
> **关联设计**：`2026-08-12-mipham-code-vision-crsi-roadmap.md`
> **审核周期**：每季度复审一次，或在重大 SIS 修改后即时复审

---

## 一、三道防线顺序不变式

```
PreFlightChecker → 工具执行 → AutoCorrector → ImmuneMemoryGC
   (执行前)          |           (执行后)         (周期性)
                     |
                ErrorSignatureDB (共享状态)
```

**不可变规则**：

1. PreFlightChecker 必须在工具执行**之前**运行，不可后移
2. AutoCorrector 必须在工具执行**失败后**运行，不可前移
3. 任何新的拦截逻辑必须插入正确位置：预防类→P0 层，修复类→P2 层
4. 三道防线共享同一个 ErrorSignatureDB 实例（engine.ts 的 lazy-init 单例保证）

## 二、数据流方向不变式

```
ErrorSignatureDB (持久化存储)
    ↑ 写入           ↓ 读取
AutoMemoryEngine   PreFlightChecker
    ↑               AutoCorrector
PatternAnalyzer    ImmuneMemoryGC
                   MetaRuleEngine (读+分析，不写)
```

**不可变规则**：

1. ErrorSignatureDB 是 SIS 的**唯一真实数据源**（single source of truth）
2. MetaRuleEngine **只读不写** ErrorSignatureDB——它分析数据、生成建议，但不直接修改签名
3. ErrorSignatureDB 的 JSON 文件格式（`~/.mipham/sis/error-signatures.json`）是公共接口，修改 schema 必须向后兼容
4. `successRate` 初始值始终为 0（悲观主义原则：签名必须证明自己）

## 三、关键阈值定义

| 常量                       | 值   | 位置                   | 含义                        |
| -------------------------- | ---- | ---------------------- | --------------------------- |
| `AUTO_RETRY_THRESHOLD`     | 0.7  | auto-corrector.ts      | 成功率≥70%才自动重试        |
| `MAX_RETRIES`              | 1    | auto-corrector.ts      | 最多重试1次防止死循环       |
| `ZERO_SUCCESS_THRESHOLD`   | 10   | immune-memory-gc.ts    | 0成功率且出现≥10次→自动退役 |
| `MAX_CONSECUTIVE_FAILURES` | 5    | hooks.ts               | Hook连续失败5次→自动禁用    |
| `COOLDOWN_MS`              | 5min | hooks.ts               | Hook禁用冷却时间            |
| `STUCK_TIMEOUT_MS`         | 30s  | compaction-progress.ts | 压缩卡住检测阈值            |

**不可变规则**：

1. 修改任何阈值必须在 commit message 中说明理由
2. MetaRuleEngine 可以**建议**阈值调整（通过 `/crsi meta`），但不可自动修改
3. 安全相关阈值（MAX_RETRIES、AUTO_RETRY_THRESHOLD）的修改需要 code review

## 四、模块间接口契约

### ErrorSignatureDB ↔ 外部

```
insert(sig) → ErrorSignature     // 去重：同 pattern+toolName+category → 增加 occurrence
match(toolName, params) → ErrorSignature | null  // 子串匹配，返回最佳
recordResult(id, success) → void  // 更新成功率，可能自动降级/退役
getActive() → ErrorSignature[]    // 排除 retired
getStats() → ErrorSignatureStats
```

### PreFlightChecker → Engine

```
check(toolName, params) → PreFlightResult {
  action: 'allow' | 'warn' | 'fix' | 'block'  // 优先级 block > fix > warn > allow
}
```

### AutoCorrector → Engine

```
analyze(toolName, params, error, retryCount) → CorrectionResult {
  action: 'retry' | 'suggest' | 'record-only'
}
```

**不可变规则**：

1. 上述函数签名不可删除参数或改变返回类型的语义
2. 新增参数只能追加为可选参数（向后兼容）

## 五、代码组织不变式

| 目录                             | 用途             | 不可放入     |
| -------------------------------- | ---------------- | ------------ |
| `src/core/error-signature-db.ts` | SIS 数据层       | UI 逻辑      |
| `src/core/preflight-checker.ts`  | 第一道防线       | 执行后逻辑   |
| `src/core/auto-corrector.ts`     | 第二道防线       | 执行前逻辑   |
| `src/core/immune-memory-gc.ts`   | 第三道防线       | 实时执行路径 |
| `src/core/meta-rule-engine.ts`   | 元认知层         | 直接修改签名 |
| `src/core/engine.ts`             | 编排层（集成点） | SIS 业务逻辑 |

**不可变规则**：

1. SIS 业务逻辑不放在 engine.ts 中，engine.ts 只负责编排（init → check → execute → correct → record）
2. 每个 SIS 模块可独立单元测试，不依赖 engine.ts

## 六、测试覆盖不变式

- ErrorSignatureDB: CRUD + match + recordResult + cleanup → 16 tests
- PreFlightChecker: 4 action states + RuleEngine 协同 → 12 tests
- AutoCorrector: retry/suggest/record-only/max-retries → 7 tests
- ImmuneMemoryGC: retire/zero-success/dedup → 6 tests
- MetaRuleEngine: 4 phases + systemHealth → 14 tests

**不可变规则**：

1. 新增 SIS 功能必须同步新增测试
2. 修改 SIS 行为时必须先更新测试（TDD）
3. 全量测试（`pnpm test`）必须在 SIS 改动后保持绿色

---

## 修改检查清单

在修改任何 SIS 相关文件之前，逐项确认：

- [ ] 是否违反三道防线顺序？
- [ ] 是否改变了 ErrorSignatureDB 的数据格式？
- [ ] 是否修改了关键阈值？如是，commit message 中说明了理由吗？
- [ ] 是否改变了模块间接口契约？
- [ ] 是否把 SIS 业务逻辑放到了 engine.ts？
- [ ] 是否更新了对应测试？
- [ ] 全量测试是否仍然通过？
