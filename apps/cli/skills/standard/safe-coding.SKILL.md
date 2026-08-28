---
name: safe-coding
description: Safe coding rules for code generation — validate external/user input before use and throw RangeError on invalid input
version: 1.0.0
---

# Safe Coding

处理外部/用户输入前必须校验：`null`、`undefined`、空字符串、格式非法时，抛出 `RangeError`，消息为 `'invalid input'`。
