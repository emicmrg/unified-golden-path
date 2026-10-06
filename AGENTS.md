# AGENTS.md — Kiro CLI Harness (local to the project)

This project includes a Kiro agent harness in `.kiro/`, equivalent to the one available
for Copilot CLI, but in Kiro's native format (JSON).

## Structure
```
.kiro/
├── agents/        9 agents (.json)
│   ├── orchestrator  coordinates the cycle and delegates (tool subagent)
│   ├── researcher    researches official sources (web_fetch trusted + use_aws readonly)
│   ├── node-dev      Node/TS/React development
│   ├── python-dev    Python development
│   ├── aws-infra     IaC/AWS (use_aws readonly; confirms destructive/deploy actions)
│   ├── tester        creates and runs tests (run-once)
│   ├── reviewer      finds bugs (read-only; NEEDS CHANGES verdict)
│   ├── security      audits code + AWS infrastructure (read-only)
│   └── docs          documentation
├── skills/
│   ├── dev-cycle/SKILL.md     research→dev→test→review×2 workflow
│   └── aws-safe-ops/SKILL.md  safe vs. destructive AWS commands
└── steering/
    └── project-rules.md       global rules (cycle, anti-hang, security)
```

## How to use it
Agents are discovered automatically when running `kiro-cli chat` in this directory.

- List: `kiro-cli agent list`
- Validate: `kiro-cli agent validate --path .kiro/agents/<nombre>.json`
- Switch agents during a session: `/agent <nombre>`
- Start directly with an agent: `kiro-cli chat --agent orchestrator`

## Recommended workflow
```
kiro-cli chat --agent orchestrator
```
Then request the task; orchestrator follows the research → dev → test → review×2 cycle,
delegating to subagents through the `subagent` tool.

## Differences from the Copilot harness
- JSON format (not Markdown with frontmatter).
- `allowedTools` = auto-approval (equivalent to Copilot's permissions-config.json).
- `toolsSettings.shell.allowedCommands/deniedCommands` = regexes for auto-approving/denying commands.
- `use_aws` (Kiro's native tool) with `autoAllowReadonly: true` instead of AWS MCPs.
- Anti-hang rules are defined as `deniedCommands` (watch/dev/sudo/rm) for each agent + steering.

## Permissions and security
- Read-only and common dev/test commands are auto-approved per agent.
- `aws-infra` has deploy/destroy/bootstrap in `deniedCommands` → they require your confirmation.
- `use_aws` runs automatically in readonly mode; mutations require confirmation.
- Account: Slalom sandbox (Innovation Labs GDL), us-east-1, no real data.
