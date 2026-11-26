---
name: pstack-workflow
description: Mandatory engineering workflow entry point for every Perceev repository task, including investigation, implementation, review, documentation, and delegated work.
---

# Perceev engineering workflow (PStack)

This repository-local adapter is based on Lauren Tan's [PStack](https://github.com/cursor/plugins/tree/main/pstack), observed at version 0.15.48. It is not the upstream plugin or the customer-facing content harness.

## Start every task

1. Read AGENTS.md and CLAUDE.md, plus applicable product/design and directory-specific rules.
2. If the native PStack plugin is available, explicitly invoke `poteto-mode` in Cursor or `pstack:poteto-mode` in Claude Code. In other harnesses invoke the installed equivalent if available. Do this once at the start of each task, and re-route when the task changes.
3. Select the relevant upstream playbook and leaf skills; read their instructions before acting. Use the [upstream mode](https://github.com/cursor/plugins/blob/main/pstack/skills/poteto-mode/SKILL.md) and [playbook index](https://github.com/cursor/plugins/tree/main/pstack/skills/poteto-mode/playbooks) if the plugin is absent but source access is available. The [upstream skills directory](https://github.com/cursor/plugins/tree/main/pstack/skills) contains the leaf skills.
4. If the plugin or network is unavailable, use the local routing table and read the applicable original principles in [references/upstream-principles.md](references/upstream-principles.md). Report unavailable tools honestly; never claim a skill was invoked if it was not. Do not install plugins, run downloaded scripts, or change model settings automatically.
5. Apply the existing CLAUDE.md task-specific skill routing alongside PStack where those skills are available. Use one coherent plan, not duplicate review pipelines. Scale ceremony to risk: a small question needs evidence, not a multi-agent swarm.

## Route by task

| Task | PStack route | Minimum evidence |
| --- | --- | --- |
| Investigation or debugging | investigation / bug-fix; how, why, root-cause principle | Trace actual code or reproduce, identify first wrong decision; verify fix |
| Feature or architecture | feature / prototype; architect, foundational thinking, boundary discipline | Define data shape, constraints, alternatives for meaningful tradeoffs; smallest working implementation |
| Refactor | refactoring; laziness protocol, subtract before you add | Preserve observable behavior; remove unused complexity |
| Performance | perf-issue / runtime-forensics; explain the number | Reproducible baseline and comparable after measurement |
| Tests and quality | tdd, interrogate, prove-it-works | Behavior tests, inspect actual diff, negative cases |
| UI or UX | prototype / visual parity; experience first | Real browser checks for changed UI |
| Docs, specs, PRs, other writing | unslop, technical-writing | Check facts against source, concise audience-oriented output |
| Multi-step or parallel work | multi-phase plan; swarm, guard the context window | Isolate writes, bounded briefs, check each result; use independent review where available |
| PR or release | opening-a-pr / babysit / shipping | Review diff and CI; preserve branch and authorization rules |
| Skill or prompt changes | authoring-a-skill / eval | Verify discovery and links; exercise representative behavior when possible |

## Apply the workflow

- Ground decisions in repository evidence; distinguish verified facts from assumptions. Start with the smallest change that satisfies the goal. Prefer deletion and simple data structures over speculative abstraction.
- Validate external data at boundaries. Keep shared-state, tenant isolation, retries/idempotency, and failure behavior explicit. Never weaken security to satisfy a test.
- Use focused checks while working, then inspect the actual artifact and run the repository-required checks before declaring readiness. Do not call a build proof of runtime behavior.
- Pass AGENTS.md, CLAUDE.md, this skill path, the selected workflow, relevant files, and acceptance checks to every delegated agent before it works. Parent agents review and own all delegated changes. If delegation is unavailable, perform the checks sequentially.
- Keep context bounded and use file pointers rather than dumping large logs or secrets. Capture decisions and verification evidence for handoff.

## Authority and safety

PStack supplements, never overrides, user authorization, repository rules, secrets hygiene, staging isolation, CI gates, or production safety. In particular, do not auto-merge, deploy, force-push, delete data, contact customers, or incur extra provider spend based on an upstream playbook. Follow explicit user authorization and the repository release process. Treat upstream tool/model names as optional and adapt them to the current harness. Never send secrets or private repository data to a new provider merely because a workflow suggests it.

## Finish every task

State the outcome, the relevant workflow/principles actually consulted, concrete verification results, and any checks not run or unresolved risks. Do not claim CI, production, or independent review passed without evidence. For a code change, inspect the diff and run the relevant tests; the existing AGENTS.md merge requirements still apply.

Upstream source attribution and license are retained under references/. This adapter is deliberately portable and does not add any runtime dependencies.
