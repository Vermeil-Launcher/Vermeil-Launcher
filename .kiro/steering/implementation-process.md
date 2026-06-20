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
- Dependency and environment footprint: if the change adds, removes, or version-bumps a dependency or a required tool (Rust crate, npm package, Gradle/Java mod dep, JDK, Build Tools, system lib), the manifests **and** the docs that list prerequisites must move with it — `docs/DEVELOPMENT.md` Prerequisites and the relevant skill. A stale "what to install" list is a bug. See the `dependencies` skill.
- Cross-platform impact: will this behave the same on both Windows and Linux? Watch for platform-specific code (`#[cfg(...)]`, Win32/DWM calls, `navigator.userAgent` branches) and for behavior that relies on the OS/WM/webview to enforce something (window sizing, focus, z-order, TLS, file locking). See **Cross-Platform Parity** in `coding-standards.md`. If you can't run the Linux build, reason about its path explicitly and flag what needs a Linux smoke-test.

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
- Dependency and prerequisite docs match reality — any added, removed, or version-bumped dependency or tool is reflected in the manifests/lockfiles **and** in `docs/DEVELOPMENT.md` (and the relevant skill).
- The Rust code compiles: `cargo check` from `Vermeil/src-tauri/`.
- The frontend builds: `pnpm run build` from `Vermeil/`.
- IPC types match between Rust and TypeScript.

Validate through inspection, testing, or logical verification — not assumption.

## 12. Commit and Push

Every completed change gets committed and pushed before the task is reported done. This rule is per-change, not per-release: features, fixes, refactors, chores, doc tweaks — all of them.

- Commit only the files actually modified for this change. Don't sweep in unrelated edits.
- Use Conventional Commits style matching the existing history: `type(scope): summary` (e.g. `fix(skins): keep elytra wings inside the viewport`). Keep the subject under ~70 characters and lowercase after the colon.
- Match the repo's brevity. Most existing commits are subject-only — the scope and summary already say what changed. Add a body only when the *why* genuinely isn't obvious from the diff or the subject, and even then keep it to one or two short sentences. Don't write multi-paragraph essays. The chat reply is the place for full reasoning; the commit message is just a label.
- Push to `main` directly. This repo's history is linear on `main` — no feature branches, no PRs.
- Don't combine multiple unrelated changes into one commit. If a single task produced two distinct logical changes, make two commits.
- Conversely, don't *over-split* one logical change into a stream of tiny commits — that floods the history. A change and the docs that describe it are the **same** logical change: commit a feature together with its own research/`progress.md`/doc update, not as a separate `docs:` commit. Batch related doc edits (e.g. reconciling several files for the same drift) into one commit too. One logical change → one commit.

What this step does NOT cover — these belong to the `release-process` skill and only happen when the user explicitly says "release":

- Bumping `package.json` / `Cargo.toml` versions.
- Editing `CHANGELOG.md`.
- Creating a git tag.
- Pushing tags or creating GitHub releases.

If a user asks for a release, activate the `release-process` skill and follow it. Otherwise, stop after the per-change push.

## Definition of Done — Don't Drop the Small Things

A change is not done when the code works. It is done when every obligation it
creates is handled. The recurring failure mode on this project is shipping the
main edit and silently dropping a small-but-important ripple — a stale doc, an
un-updated prerequisite, an unhandled parallel surface. Those omissions hinder
development as much as a bug does.

Before calling any change done, walk this list and handle every item that
applies. Skip the ones that genuinely don't — but decide consciously, don't
overlook:

- **Docs that describe what changed** — `docs/DEVELOPMENT.md`, READMEs, and any
  guide that now contradicts reality, including prerequisites/setup steps.
- **Dependency & toolchain manifests + their docs** — a new/removed/bumped dep or
  tool ripples into manifests *and* the "what to install" lists. See the
  `dependencies` skill.
- **Research notes** — `docs/research/<feature>/` is living; update it and add a
  `progress.md` milestone entry (see "Research Docs Are Living").
- **Parallel surfaces** — every other place that does the same thing for a
  different variant (content sources, loaders, account types, launch entry
  points, per-platform code). See "Parallel Implementations" in
  `coding-standards.md`.
- **The IPC/event contract** — Rust signature ↔ TS wrapper, `emit()` ↔ `listen()`.
- **Cross-platform parity** — confirmed on both, or flagged for a Linux smoke-test.
- **Build/verify** — the relevant build ran clean with zero new warnings; tests
  where applicable; temp files cleaned up.
- **Commit & push** — committed in logical units and pushed (step 12).

If you're unsure whether something ripples, check it rather than assume it
doesn't. The cost of checking is small; the cost of a silent omission is a
half-finished change the user has to catch.

## Research Docs Are Living

Feature notes live in `docs/research/<feature>/` (`research.md`, `poc.md`,
`progress.md`). Committed for transparency — living, not write-once.

Write them to be **token-cheap**. This is mandatory, not a preference:

- Bullet points, not prose. Short fragments, not full sentences. No restating the
  same fact across files or bullets.
- Record only what **IS** — decisions made, what was built, how it was verified.
- **No roadmaps, no "still next", no "planned" lists.** Plans change; stale plans
  are worse than none. A one-line pointer to the immediate next step is the max.
- Split of concern: `research.md` = findings + the why; `poc.md` = what the proof
  established; `progress.md` = terse dated journal, a few bullets per milestone
  (what changed · key decision · how verified). Exact diffs live in git, not here.
- Update the affected note in the **same change** that makes it real; a stale note
  (old JDK/mappings/version) is a bug. Fix drift when you see it, not "later".
- Originality: describe only what we found and what our code does; never reference
  another launcher's/client's/mod's source.

## Shell Commands

- The workspace shell is **PowerShell** (Windows). Use `;` to chain commands if needed, or run each as a separate call. Do not use `&&` (PowerShell does not support it the same way).
- Always use `git -C <path>` for git operations — never `cd` into a directory.
- Run tools directly: `pnpm`, `npx`, `cargo` — no wrapper needed.
- The project root is the workspace directory. Code lives in `Vermeil/`.
