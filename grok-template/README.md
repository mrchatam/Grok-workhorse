# Grok Bot template skills (drafts)

Two optional skills for Grok Bot (or any agent platform with a similar skill format). Copy the folders
into your agent's skills. Nothing here is installed automatically.

| Skill | Use it when |
|---|---|
| [`workhorse-getting-started/`](workhorse-getting-started/SKILL.md) | A user wants to set up Grok Workhorse (provider and model, repos, key, install, connector, first task). |
| [`workhorse-delegation/`](workhorse-delegation/SKILL.md) | The agent has the workhorse MCP tools and a coding task could be delegated. |

Both assume the MCP connector is registered as a stdio server running `workhorse-mcp`.

Both skills teach the v0.3 flow — long-poll `wait_task` and the ~0.5–1 KB `brief` result view instead
of polling `task_status`, plus automatic fix rounds and cheap reviews. In the project's own benchmark
that cut supervisor tokens read per successful task from ~3,060 to ~360 (about −88%); see
[Measured savings](https://github.com/mrchatam/Grok-workhorse#measured-savings) in the main README.
