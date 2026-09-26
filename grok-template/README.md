# Grok Bot template skills (drafts)

Two optional skills for Grok Bot (or any agent platform with a similar skill format). Copy the folders
into your agent's skills. Nothing here is installed automatically.

| Skill | Use it when |
|---|---|
| [`workhorse-getting-started/`](workhorse-getting-started/SKILL.md) | A user wants to set up Grok Workhorse (provider and model, repos, key, install, connector, first task). |
| [`workhorse-delegation/`](workhorse-delegation/SKILL.md) | The agent has the workhorse MCP tools and a coding task could be delegated. |

Both assume the MCP connector is registered as a stdio server running `workhorse-mcp`.
