# ACT · Vera — counsel & care

**Live: https://act.heros-agent.space** · English / 中文

Vera is one AI companion that works in law and medicine together. She takes
intake, researches, drafts, triages, reasons through a differential, computes
deadlines and follows up for weeks. **Licensed attorneys and physicians sign off
on everything that needs a licence**: appearing in court, filing, ordering tests,
prescribing. Vera is not a lawyer or a doctor, and the product never says she is.
See [docs/01-intents-tools-skills.md](docs/01-intents-tools-skills.md) for the
boundary and how it is enforced.

```
User goal ─► Router ─► Planner ─► Durable task store (Postgres) ─► Queue / scheduler
   ▲                                                                   │
   │                                                                   ▼
Timeline ◄── Checkpoint ◄── Verification ◄── Tools (typed, gated) ◄── Worker (bounded LLM loop)
```

> A long-running agent is not a long-running LLM call. It is a durable
> workflow: the model wakes up, rebuilds its state from the database, does a
> bounded amount of work, persists the result, and continues later.

## What's in the box

| Deliverable | Where |
|---|---|
| Durable agent engine: goals, task DAGs, leased queue, scheduler, planner/replanner, workers | `internal/engine` |
| 25 tools with strict contracts (legal, medical, shared) | `internal/tools` |
| 22 skills (playbook DAGs) | `internal/skills` |
| Intents, tools and skills spec | [docs/01-intents-tools-skills.md](docs/01-intents-tools-skills.md) |
| Vera's avatar and soul | [docs/02-soul.md](docs/02-soul.md), `internal/persona`, `web/public/vera/` |
| Auth: sign in, sign up, verify email, forgot/reset password, sessions | `internal/auth`, `web/src/pages/auth` |
| Chat UI: streaming, live case cards, inline approvals, uploads, Vera's moods | `web/src/app/Chat.tsx` |
| 5-section landing page with the 3D erosion sphere and full-body Vera | `web/src/pages/Landing.tsx`, `web/src/components/ErosionSphere.tsx` |
| Settings: profile, Vera & language, notifications, privacy & memory, security, limits & usage, professional licence, appearance, admin | `web/src/app/Settings.tsx` |
| Bilingual (English / 中文) across the site, emails and Vera's replies | `web/src/lib/i18n.tsx`, `internal/auth` mail templates |
| Docker + k8s on the heros-prod k3s node | `Dockerfile`, `deploy/` |

## The principles, and where each one lives

| Principle | Implementation |
|---|---|
| Long-running goal with completion criteria | `goals` row: objective, `completion_criteria`, `milestones`, `limits`. The `finish` task judges the criteria against what was actually produced, with a deterministic floor |
| Durable, decomposed tasks | `tasks` + `task_deps` (DAG). Each task has instructions, allowed tools and verifiers |
| observe → plan → execute → verify → persist → continue | `Worker.runLLM`: context rebuilt from the DB → model with tools → step verifiers → checkpoint per step → next |
| Planner separate from executor | `Planner.Initial/Replan/Finish` run as their own queued `plan`/`finish` tasks; workers execute `llm`/`wait` tasks |
| Persist everything; never rely on model context | every message, tool call (input, output, status, latency), event, checkpoint, approval and LLM call is a row. `BuildTaskContext` rebuilds the prompt each cycle |
| Checkpoints | `checkpoints` row per step (fenced). A crashed task resumes at its last step. Tested: `TestCrashResumesFromCheckpoint`, and live by killing the server mid-task |
| Idempotent side effects | external tools must declare `IdemKey`. A unique index on `tool_calls.idempotency_key` means a replay returns the recorded result. An in-flight attempt with no outcome stops as *ambiguous*, not retried. Tested: `TestApprovalGateAndIdempotentSend` |
| Durable job queue; leases/locks | `Claim`: `FOR UPDATE SKIP LOCKED` + lease expiry + **fencing epoch**. Stale workers cannot write. Tested: `TestClaimIsExclusiveUnderConcurrency`, `TestFencingRejectsStaleWorker` |
| Pause / resume / safe cancellation | goal status gates claiming. Workers stop at step boundaries and release. Cancel supersedes pending approvals in the same transaction; external calls already made stay recorded. Tested: `TestCancellationIsSafe` |
| Scheduling & wake-ups | `Scheduler` (leader-elected via advisory lock): lease reclaim, dependency promotion, `wait` timers, reminders, daily reviews, completion checks. `LISTEN/NOTIFY` wakes idle workers |
| Dependencies | tasks start `blocked`. `promoteTx` readies them when every dependency succeeded or was skipped. Tested: `TestDAGPromotionAndWait` |
| Context engineering | goal + current task + dependency outputs + plan at a glance + compressed history + client memories + retrieved documents + remaining budget. Nothing else |
| Tools with strict contracts | JSON-Schema input and output validation, timeout, retry-on-transient only, gate class (G0–G3), idempotency, verifier. See `tools/contract.go` |
| Verify every step | tool-level verifiers (read back what was saved, check the relay accepted the mail, check the filing was accepted) and step-level verifiers (`document_saved`, `citations_verified` against CourtListener, `signed_off`). Tested: `TestVerifierRejectsUnverifiedCitation` |
| Retry & recovery | model client: exponential backoff with jitter, then a fallback model. Tasks: backoff up to 10 minutes and bounded attempts. Then the **replanner** retries differently, routes around the failure, or asks a person |
| Partial failure | a failed task never fails the goal; only its dependents wait. The replanner decides |
| Replanning | on failure, on unmet criteria, when the client changes something, and in a daily review. Ops are validated one by one; safety steps cannot be dropped |
| Prevent infinite execution | per-goal limits on iterations, tool calls, tokens, estimated cost, days, DAG depth, tasks per plan, total tasks and replans; per-account and deployment daily token caps; a per-task step budget with forced wrap-up. Tested: `TestBudgetStopsTheGoal` |
| Separate memory types | task state (`tasks`/`checkpoints`), episodic (`events` + `episode_summaries`), knowledge (`documents` + `knowledge_chunks`), preferences (`user_preferences`), facts (`memories`, visible and deletable in Settings) |
| Summarise history | the scheduler folds old events into episode summaries once a goal passes 60 events. The last 20 always stay raw |
| Human approval gates | G1 client, G2 licensed professional with a **verified** licence, G3 never automated (controlled substances, appearing as counsel). The exact call is stored and replayed on approval; declined calls are fed back to the model. Tested: `TestRejectedApprovalIsReportedNotExecuted`, `TestControlledSubstanceIsNeverAutomated` |
| Observability & timeline | `events` (append-only, with *why*), `tool_calls`, `llm_calls` (tokens, latency, errors), goal usage. The case page answers what happened, why, when, and what happens next |
| Evaluation scenarios & recovery tests | `internal/engine/engine_test.go`: 14 scenarios against real Postgres (concurrency, fencing, crash/resume, duplicates, approvals, G3, DAG timers, budget, cancel, verifier, plan validation, idempotent scheduling, one-time reminders, planner fallback) |
| Continuous improvement | failures found in live runs became fixes with tests: step-budget exhaustion is not retryable, budget-aware wrap-up, tolerant replan parsing, a truthful emergency paging line |

## Run it locally

```bash
docker run -d --name act-pg -e POSTGRES_USER=act -e POSTGRES_PASSWORD=act_dev_pw -e POSTGRES_DB=act -p 127.0.0.1:55850:5432 postgres:17
```

```bash
(cd web && npm ci && npm run build) && go build -o bin/act ./cmd/act
```

```bash
ACT_DATABASE_URL='postgres://act:act_dev_pw@127.0.0.1:55850/act?sslmode=disable' ACT_LLM_API_KEY=… ACT_COOKIE_SECURE=false ACT_PUBLIC_ORIGIN=http://localhost:8080 ./bin/act serve
```

Without SMTP settings, verification and reset links are printed to the log.
`npm --prefix web run dev` serves the UI with hot reload and proxies `/api` to `:8080`.

## Test

```bash
ACT_TEST_DATABASE_URL='postgres://act:act_dev_pw@127.0.0.1:55850/act?sslmode=disable' go test ./... -p 1
```

## Deploy

See [deploy/README.md](deploy/README.md). In short: `INSTANCE=i-05f4712279b04fac5 deploy/release.sh`.

## Operating it

- **Licensed professionals.** A user adds their bar or medical licence in Settings → Professional. An admin (`ACT_ADMIN_EMAILS`) verifies it in Settings → Admin. Only then can that user approve G2 actions. Nothing that needs a licence proceeds without one.
- **On-call clinician.** Set `ACT_ONCALL_EMAIL` to page a clinician when red flags appear. Until it is set, Vera never claims anyone was alerted.
- **Adapters.** `court_efile`, `rx_submit`, `lab_order` and `referral_send` are **sandbox** adapters. They record and verify the action, but nothing reaches a court, pharmacy or lab until an e-filing provider, Surescripts/DoseSpot or lab-network integration is contracted.
