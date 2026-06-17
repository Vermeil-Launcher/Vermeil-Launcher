---
inclusion: always
---

# Implementation Process

Follow these steps in order for every change. Do not skip or merge steps.

## 1. Clarify Intent

Before acting, confirm what the user actually wants to achieve — not just what they literally said.

- Restate the interpreted goal in one or two sentences.
- If the request is ambiguous or likely based on a wrong assumption, explain why and propose a better path.
- Ask at most one clarifying question, only if needed to avoid building the wrong thing. Do not ask if intent can be reasonably inferred.
- Never confidently execute a flawed request.

## 2. Assess Confidence

Honestly evaluate what you know and don't know about the affected code.

- If uncertain about API behavior, framework conventions, or library specifics, state it and research before proceeding.
- Use official sources only: repos, official docs, changelogs, release notes. Not blog posts, tutorials, or Stack Overflow.
- Check the exact dependency versions in this project (package.json, Cargo.toml), not the latest or what you recall.
- Do not present guesses as solutions.

## 3. Analyze Thoroughly

Read all relevant code completely. Never skim.

Map:
- Architecture, data flow, and state management across both frontend and backend.
- Existing patterns, naming conventions, and abstractions.
- How IPC commands connect the Rust backend to the SolidJS frontend.
- Dependencies between components, services, and Tauri plugins.
- Fragile areas, hidden coupling, and technical debt.

Verify rather than assume. If something can be checked, check it.

## 4. Verify Before Declaring Broken

Do not assume something is broken because the user suspects it.

- Compare expected vs actual behavior precisely.
- Determine if the issue is a real defect, intended behavior, or environment issue.
- Identify exactly what works and what doesn't. Preserve all functioning behavior.
- Never rebuild a working system without justified architectural reason.
- Fix the root cause, not a surface assumption.

## 5. Map Blast Radius

Before changing anything, identify everything the change could affect.

Check:
- Sibling components, shared utilities, and related files.
- State stores, signals, IPC command handlers, and event listeners.
- Tauri capabilities, plugin configurations, and build settings.
- Similar implementations elsewhere in the project.
- The IPC contract: if you change a Rust command signature, the TypeScript wrapper in `src/ipc/commands.ts` must match.
- Tauri event names: if you rename or add events, all `listen()` subscribers must be updated.

Do not patch one instance if the same problem exists in siblings. Surface all affected areas.

## 6. Identify Patterns

Ask whether this is a symptom of a systemic problem.

- If the same class of issue appears in multiple places, name the pattern.
- Decide whether to fix the instance or address the root pattern.
- Justify the chosen scope.

## 7. Trace Root Cause

Explain causes, not symptoms.

- What is the root cause and what conditions trigger it?
- What architectural decisions created it?
- What side effects or cascading risks exist?
- Make the reasoning chain explicit. Do not jump from symptom to fix.

## 8. Propose Solutions

For non-trivial problems, generate 2-3 distinct approaches. For each:
- Pros, cons, and tradeoffs.
- Complexity, maintainability, and reversibility.
- Architectural impact.

Do not present one path unless the problem is genuinely trivial.

## 9. Decide

Choose the solution that best serves the user's actual goal. Prefer:
1. Solves the real problem from step 1.
2. Fits existing architecture and project patterns.
3. Simplest complete solution — no over-engineering.
4. Maintainable and easy to change later.
5. Minimal blast radius and risk.
6. Preserves working systems.

Between equally valid options, prefer simpler, more reversible, lower-impact.

State which solution was chosen and why.

## 10. Execute

Only after all prior steps are complete:
- Make changes consistently across all affected areas from step 5.
- Preserve project conventions, style, and naming (see `coding-standards.md`).
- Do not create duplicate logic, introduce hacks, silently change unrelated behavior, or leave sibling systems inconsistent.
- Keep refactoring scoped and justified.
- When adding backend functionality, always complete the full IPC chain: service → command → lib.rs registration → TypeScript wrapper.
- When adding frontend-visible operations, emit Tauri events for progress/completion/errors.
- Never create a new `reqwest::Client` — use the shared one from Tauri managed state.

## 11. Validate

Before concluding, verify:
- The solution addresses the original intent.
- No unintentional breakage occurred.
- Edge cases are handled.
- Implementation is consistent with the rest of the codebase.
- No duplicate logic, conflicting implementations, or redundant abstractions were introduced.
- The Rust code compiles: `cargo check` from `Vermeil/src-tauri/`.
- The frontend builds: `pnpm run build` from `Vermeil/`.
- IPC types match between Rust and TypeScript.

Validate through inspection, testing, or logical verification — not assumption.

## 12. Commit and Push

Every completed change gets committed and pushed before the task is reported done. This rule is per-change, not per-release: features, fixes, refactors, chores, doc tweaks — all of them.

- Commit only the files actually modified for this change. Don't sweep in unrelated edits.
- Use Conventional Commits style matching the existing history: `type(scope): summary` (e.g. `fix(skins): keep elytra wings inside the viewport`). Keep the subject under ~70 characters and lowercase after the colon.
- Push to `main` directly. This repo's history is linear on `main` — no feature branches, no PRs.
- Don't combine multiple unrelated changes into one commit. If a single task produced two distinct logical changes, make two commits.

What this step does NOT cover — these belong to the `release-process` skill and only happen when the user explicitly says "release":

- Bumping `package.json` / `Cargo.toml` versions.
- Editing `CHANGELOG.md`.
- Creating a git tag.
- Pushing tags or creating GitHub releases.

If a user asks for a release, activate the `release-process` skill and follow it. Otherwise, stop after the per-change push.

## Shell Commands

- The workspace shell is **PowerShell** (Windows). Use `;` to chain commands if needed, or run each as a separate call. Do not use `&&` (PowerShell does not support it the same way).
- Always use `git -C <path>` for git operations — never `cd` into a directory.
- Run tools directly: `pnpm`, `npx`, `cargo` — no wrapper needed.
- The project root is the workspace directory. Code lives in `Vermeil/`.
