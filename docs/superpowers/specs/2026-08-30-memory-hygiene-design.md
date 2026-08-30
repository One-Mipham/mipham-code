# 记忆卫生设计 — 治「越存越乱」

> **日期**: 2026-08-30
> **作者**: Guohua Zhang · One Mipham Corporation
> **术语**: 记忆卫生 = 让持久记忆「存得下去、不膨胀、该淘汰的淘汰」。对标 Recuris「记忆要验证过才值得长期存」的思想，但作用在**通用记忆库**（`~/.mipham/memory/`），与 CRSI 教训库（`crsi-lessons.md`）是两条独立存储。
> **前情**: 承接 [[2026-08-30-recuris-memory-evolution-design]] 的 ② 工作记忆（已落地 Phase 1）；本件是它的姊妹件，治用户主痛点「越存越乱」。

## 一、背景：三个卫生缺口（已读码定位）

| #   | 缺口                                                                                                     | 位置                                                            | 后果                         |
| --- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------- |
| 1   | `distillFromSession` 每次会话把 summary 切成 bullet，各写一条 `auto-<sessionId>-<n>`，**跨会话从不合并** | `memory-manager.ts:215`                                         | 最大膨胀源，`auto-*` 无限堆  |
| 2   | `write` 只按 **name** 去重（同名 update，异名 append）                                                   | `memory-manager.ts:78`                                          | 内容一样的记忆换名就重复存   |
| 3   | 无 GC、无质量信号                                                                                        | 只有 30 天 ×0.5 降权（`recall:155`）+ 显式 `delete()`（`:178`） | 「从没帮上忙」的记忆永远占位 |

## 二、目标与非目标

**目标**：① 写时内容去重 ② 会话记忆合并 ③ 召回效果统计 + 淘汰。
**非目标**：不碰 TF-IDF 召回算法本身；不引入 LLM 判定（A1 铁律）；**不自动删用户手写的记忆**（只归档 `auto-*`，手写只报告待人工确认）。

## 三、Lever 3（先做）：召回统计 + 淘汰

**为什么先做**：它是另外两件的「质量信号」地基——没有召回计数，就无法判断「谁该合并/淘汰」。

**最小改动**：

1. sidecar `recall-stats.json`（对齐现有 `links.json` 模式，`memory-manager.ts:30`）：`{ [name]: { recallCount, lastRecalledAt } }`。
2. `recall()` 对返回的条目 `recordRecall(names)`（increment + 更新时间戳）。
3. `gc()`：归档「`recallCount===0` 且 mtime > 60 天」的 **`auto-*`** 记忆（移到 `archive/` 子目录，`loadAll` 天然跳过子目录）；用户手写的只进 `candidates` 报告，不自动动。

```ts
// MemoryManager
gc(): { archived: string[]; candidates: string[] }   // archived = auto-* 已归档；candidates = 手写待确认
```

**测试**：① recall 后 sidecar 计数正确；② `gc` 归档「0 召回 + 过期」的 auto-_；③ 召回过的 auto-_ 不归档；④ 手写记忆不进 archived 只进 candidates。

## 四、Lever 2：会话记忆合并

**目标**：把 `auto-*` 合并成「持久化教训」，重叠的聚成一簇、去重、union evidence，删原 `auto-*`。

**最小改动**：`consolidateAutoMemories()` —— 扫所有 `auto-*`，按 TF-IDF 余弦 > 0.5 聚簇，每簇合并成一条 `lesson-<stableSlug>`。**手动触发**（`/memory` 命令），不自动跑（对齐「受约束、最小干预」）。

```ts
consolidateAutoMemories(): { merged: number; removed: number }
```

**测试**：① 两条重叠 `auto-*` 合并成一条、去重；② 不重叠的保留；③ 非 `auto-` 前缀不动。

## 五、Lever 1：写时内容去重

**目标**：`write` 时，若与现有**同 type** 记忆内容高度重叠，合并进现有（union relevance + 保留较新 content），不新增。

**最小改动**：`write` 的「新建」分支前，用 `similarities()`（复用 tfidf）算 content 与同 type 记忆的余弦，`> DEDUP_THRESHOLD(0.65)` 则合并。

```ts
// 抽纯函数便于测：
function findNearDuplicate(
  candidates: MemoryEntry[],
  content: string,
  type: string,
): MemoryEntry | null
```

**测试**：① 异名近重复（余弦>阈值）→ 只存一条；② 明显不同 → 都存；③ 不同 type 近重复 → 不合并。

## 六、落地顺序与一句话总结

| 顺序 | 件                       | 价值/代价 | 一句话                                         |
| ---- | ------------------------ | --------- | ---------------------------------------------- |
| 1    | Lever 3（召回统计 + GC） | 高/中     | 先有质量信号，才能谈淘汰；sidecar 模式已有先例 |
| 2    | Lever 2（会话合并）      | 最高/中   | 直接治最大膨胀源 `auto-*`                      |
| 3    | Lever 1（写时去重）      | 低/低     | 风险最高（假合并），放最后                     |

**关键安全线**：三件都不自动删用户手写记忆——只归档 `auto-*`，手写只报告。GC/合并都手动触发（`/memory` 命令），不后台自动跑。
