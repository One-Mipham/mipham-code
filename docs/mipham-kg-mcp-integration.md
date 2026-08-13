# mipham-kg MCP server 接入指南

`mipham-kg` 是 MegaSystem **Forge** 子系统暴露的知识图谱 MCP server（JSON-RPC 2.0），聚合 Ontology 的确定性能力（search / reasoning / provenance）与 Forge 的接入质量能力（conflict / dedup / decision）。

- **9 tools**：`ask_question`、`list_domains`、`search_graph`、`run_reasoning`、`get_provenance`、`record_decision`、`find_similar_decisions`、`detect_conflicts`、`detect_duplicates`
- **4 resources**：`mipham://graph/summary`、`/domains`、`/schema`、`/cross-links`
- **双传输**：stdio（子进程）+ Streamable HTTP/SSE（网络服务）

Mipham Code 终端可通过这两种方式之一接入。配置写入 `.mcp.json`（项目级）或 `~/.mipham/mcp.json`（用户级），也可写入 `config.yml` 的 `skills.mcpServers`。

---

## 方式一：stdio（终端与 Forge 同机）

适用于本地开发——终端直接 spawn `forge_poc.mcp_server` 子进程，无需网络服务。

```json
{
  "mcpServers": {
    "mipham-kg": {
      "command": "python",
      "args": ["-m", "forge_poc.mcp_server"]
    }
  }
}
```

> 若 forge 使用独立 venv，把 `command` 指向该 venv 的 python，例如
> `"command": "/path/to/megasystem/forge/.venv/bin/python"`。

## 方式二：Streamable HTTP（Forge 作为网络服务）

适用于 Forge 已部署为 FastAPI 服务（`POST /mcp`），终端通过网络连接。

```json
{
  "mcpServers": {
    "mipham-kg": {
      "url": "http://localhost:8004/mcp",
      "env": { "FORGE_API_KEY": "<your-key>" }
    }
  }
}
```

- `FORGE_API_KEY` 从 `env` 注入，客户端自动映射为 `Authorization: Bearer <key>` 请求头（对齐 Forge 的 `verify_api_key`），**密钥不落配置文件明文**。
- 也可用显式 `headers` 覆盖：`"headers": { "Authorization": "Bearer <key>" }`（显式 `headers` 优先于 `env` 派生）。

## 连接

在 Mipham Code 终端中：

```
/mcp connect mipham-kg
/mcp            # 查看连接状态与已发现的 tools
```

连接成功后，9 个 tools 会以 `mcp__mipham_kg__<tool>` 命名注册到工具注册表，可直接在对话中调用（如 `search_graph`、`ask_question`）。

## 安全

- stdio 传输默认对子进程环境做**敏感变量剥离**（`*_API_KEY` / `*_TOKEN` 等），如需传密钥需显式 `env` 覆盖。
- HTTP 传输的鉴权密钥仅经 `env` 注入，禁止硬编码到 `command` / `url` / `headers` 字面量。
- Forge `/mcp` 端点需 `FORGE_API_KEY`；未设 key 时为 dev 模式（auth 关闭），生产必须设置。
