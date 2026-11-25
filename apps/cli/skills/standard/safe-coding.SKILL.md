---
name: safe-coding
description: Safe coding rules for code generation — validate external/user input before use and throw RangeError on invalid input
version: 1.1.0
---

# Safe Coding

处理外部/用户输入前必须校验：`null`、`undefined`、空字符串、格式非法时，抛出 `RangeError`，消息为 `'invalid input'`。

## 校验规则

1. **严格整串匹配**：用锚定正则（`/^...$/`）校验字符串格式；不要依赖 `Number()` / `parseInt()` / `parseFloat()` 的宽松解析 —— 它们会接受 `'1e3'`、`'4.2abc'` 这类部分匹配。
2. **先 trim 再校验**：允许首尾空白时，先 `String(input).trim()`；trim 后为空一律视为非法。
3. **端值检查**：数值结果必须过 `Number.isFinite()`；`NaN`、`±Infinity` 不是合法结果。
4. **边界参数**：区间类函数（如 `clamp`）在 `min > max` 时必须抛 `RangeError`，不得静默交换。
5. **按签名返回**：签名声明 `| null` 的函数用 `null` 表示非法输入；声明抛 `RangeError` 的用异常 —— 两者不混用。
6. **导出形状**：导出名与签名必须与题目要求逐字一致（`export function name(...)`）。
