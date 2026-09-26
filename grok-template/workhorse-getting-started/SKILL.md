---
name: workhorse-getting-started
description: >-
  Use when the user wants to set up Grok Workhorse (sandboxed coding workers driven over MCP) on their
  Linux machine: choose a model provider, add repos, store the API key, install, connect, first task.
---
# Setting up Grok Workhorse

Purpose: after this, the user's agent can delegate coding tasks to sandboxed workers on the user's
machine. Workhorse is an unofficial community project, not affiliated with xAI.

Ask **one question at a time** and wait for each answer. Keep it short.

1. **Machine.** "Which Linux machine should run the workers?" You need shell access to it, with
   Node.js >= 22, git and sudo. If it runs Docker only, suggest a VM, because nested sandboxes fail in
   containers.
2. **Provider and model.** "Which model provider do you want to use: NVIDIA NIM, OpenRouter, or
   another OpenAI-compatible endpoint (vLLM, LiteLLM, Ollama, …)?" Then ask for the model if they have
   a preference. Otherwise use the example default for that provider. For a custom endpoint, ask for
   its base URL and model id.
3. **API key.** Never ask the user to paste the key into chat. Ask them to save it in the platform's
   secret store (or a secure prompt) under the env var name the provider uses (for example
   `NVIDIA_API_KEY` or `OPENROUTER_API_KEY`), and refer to it only by that name.
4. **Repos.** "Which repositories should workers be allowed to touch, and what command runs their
   tests?" Collect a git URL (or local path) and a test command for each.
5. **Install** (on the chosen machine):
   ```bash
   git clone https://github.com/mrchatam/Grok-workhorse.git grok-workhorse && cd grok-workhorse
   sudo --preserve-env=<KEY_NAME> bash scripts/install.sh --provider <nvidia|openrouter|custom>
   ```
   Add `--with-opencode` only if the user wants the OpenCode backend. For `custom`, fill in
   `/opt/grok-workhorse/config/profiles.json` first (unlock-config.sh, edit, `workhorse validate`,
   lock-config.sh). Show the installer's final summary to the user.
6. **Repos.** For each repo: `sudo workhorse add-repo <url> --test "<command>"`.
7. **Connector.** Register a stdio MCP connector: command `/usr/local/bin/workhorse-mcp`, no args,
   env `{ "<KEY_NAME>": <reference to the stored secret> }`.
8. **First task.** Run `workhorse health`, then `workhorse hello`, or call `delegate_task` on the
   hello-world repo and show the verdict. On failure, run `workhorse check-provider` and see
   docs/troubleshooting.md.
9. **Remember.** Save a short memory: the machine, profile names, allowlisted repos, the key's env var
   name (never the value), and that the workhorse-delegation skill is the playbook for later tasks.
