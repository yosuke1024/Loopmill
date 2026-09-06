# Loopmill

## Subscription-native Loop Engineering OSS

## MVP Design v0.4

---

# 1. Overview

**Loopmill** is an open-source system for defining, running, monitoring, and optimizing the Engineering Loop
**Observe → Decide → Act → Verify → Retry**
by combining multiple AI agents with local tools.

Today a human copies artifacts from one AI to the next by hand:

* research with ChatGPT / Codex
* create a GitHub Issue
* ask Claude Code to implement it
* have a different AI review it
* if rejected, ask Claude Code again
* finally, create a PR

Loopmill removes the need to relay this work manually.

In Loopmill, this entire sequence of steps is itself defined as a **Loop**.

---

# 2. Problem

In today's AI Engineering, individual AI Agents have become extremely capable.

The work that connects them, however, is still done by humans.

```text
AI A
 ↓
Human checks result
 ↓
Copy into Issue
 ↓
Instruct AI B
 ↓
Human checks result
 ↓
Ask AI C to review
 ↓
Re-instruct if rejected
```

The problem is not that "AI cannot do the work."

The problem is that

> **the Engineering Process that connects AIs to each other is still manual human work.**

Loopmill automates this relay work as a Loop.

---

# 3. Product Definition

Loopmill is not:

* an AI Chat UI
* an AI Agent launcher
* an LLM API gateway
* a general-purpose automation platform
* an n8n replacement

Loopmill is

> **a system for building, running, and supervising Engineering Processes that include AI, as Loops.**

The central concept is the **Loop**, not the Agent.

---

# 4. Core Loop

The basic model Loopmill works with is the following.

```text
Observe
   ↓
Decide
   ↓
Act
   ↓
Verify
   ↓
Success?
 ↙       ↘
No       Yes
↓         ↓
Retry    Finish
 ↑
 └────────
```

Each step can be filled by:

* Codex
* Claude Code
* a future Google Agent Runtime
* Shell Command
* Condition
* Human

and so on.

---

# 5. Core Product Principles

Loopmill has the following four principles.

## 5.1 Subscription-native

Loopmill uses the AI subscriptions the user already pays for.

MVP:

```text
ChatGPT Subscription
        ↓
    Codex CLI
Claude Subscription
        ↓
   Claude Code
```

Future:

```text
Google AI Subscription
        ↓
Google Agent Runtime
```

Loopmill itself never calls metered, pay-per-use APIs such as the OpenAI API or the Anthropic API.

---

## 5.2 Local-first

AI Agents, Repositories, Git credentials, and AI CLI authentication all live on the user's PC.

Loopmill, as a rule, also runs locally.

There is no need to move the user's code or AI credentials to an external server just for Loopmill.

---

## 5.3 Daemonless / Zero-idle

No Loopmill process stays resident just to wait for a Workflow.

When nothing is running:

```text
Loopmill Runner    OFF
Loopmill UI        OFF
Background server  OFF
```

Scheduling is delegated to the OS.

As a result:

> **No always-on server is required just to use Loopmill.**

---

## 5.4 Observable

No step of the Loop is a black box.

For every Node, you can inspect:

* Prompt
* Input
* Output
* Runtime
* Logs
* Duration
* Files changed
* Git diff
* Token usage

In addition, the Token Efficiency of the Loop as a whole is visualized.

---

# 6. Why Subscription-native

Most AI orchestration systems assume:

```text
Workflow
 ↓
OpenAI API
Anthropic API
Gemini API
 ↓
Metered Billing
```

Many developers, however, already pay a monthly fee for:

* ChatGPT Plus / Pro
* Claude Pro / Max
* Google AI Pro / Ultra

and similar plans.

Loopmill takes the opposite approach:

```text
Existing Subscription
        ↓
Official Agent CLI
        ↓
      Loopmill
```

The concept is:

> **Use the AI tools you already pay for.**

---

# 7. Subscription Only Mode

Loopmill provides a **Subscription Only Mode**.

In this mode, metered API credentials are excluded from the Agent subprocess environment.

At a minimum:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
GOOGLE_API_KEY
```

If API credentials are present, Loopmill warns.

Loopmill itself is forbidden from:

* falling back to API billing
* falling back to another Provider
* falling back to another Account

When the subscription quota is reached, the execution is not treated as

```text
FAILED
```

but as

```text
WAITING_FOR_QUOTA
```

---

# 8. Agent Runtime

Loopmill treats AI not as a "Model Provider" but as an
**Agent Runtime**.

MVP:

```text
CodexRuntime
ClaudeCodeRuntime
```

Future:

```text
GoogleRuntime
OtherAgentRuntime
```

Conceptual interface:

```typescript
interface AgentRuntime {
  id: string;
  displayName: string;
  detect(): Promise<RuntimeStatus>;
  authStatus(): Promise<AuthStatus>;
  execute(
    request: AgentRequest
  ): AsyncIterable<AgentEvent>;
  cancel(runId: string): Promise<void>;
}
```

---

# 9. Authentication Model

Loopmill itself does not manage AI account credentials.

Not managed:

* User ID
* Password
* Browser cookies
* Its own handling of OAuth refresh tokens
* Private API credentials

The user logs in to each official CLI as usual.

```bash
codex
```

```bash
claude
```

Loopmill does nothing more than

> **run the official Agent CLIs that are already authenticated in the user's environment.**

It does not implement its own OAuth and does not reverse-engineer private APIs.

---

# 10. Runtime Health

Runtime status can be checked from the Settings screen.

Example:

```text
Agent Runtimes
Codex
✓ Installed
✓ Authenticated
Version  ...
Claude Code
✓ Installed
✓ Authenticated
Version  ...
Google
Not installed
```

Displayed items:

* Installed
* Executable path
* Version
* Authentication status
* Last successful execution
* Usage collection capability

---

# 11. Visual Loop Builder

Loops are built as a Node Graph in the browser.

Example:

```text
┌─────────────┐
│ Daily 06:00 │
└──────┬──────┘
       ↓
┌─────────────┐
│ Codex       │
│ Review      │
└──────┬──────┘
       ↓
┌─────────────┐
│ Condition   │
└───┬─────┬───┘
    │ No  │ Yes
    ↓     ↓
   End   Issue
           ↓
      Claude Code
           ↓
          Test
           ↓
         Codex
         Review
           ↓
          Pass?
       ↙         ↘
      No          Yes
      ↓            ↓
 Claude Code      PR
      ↑
      └──── Loop
```

From the UI, the user can:

* add Nodes
* remove Nodes
* connect Edges
* select a Runtime
* edit Prompts
* configure Conditions
* configure Schedules
* set the Loop iteration count

---

# 12. MVP Node Types

The MVP narrows the set of Node types.

## Manual Trigger

Starts a Loop manually from the UI.

---

## Scheduled Trigger

Starts a Workflow at a specified time.

Example:

```text
Every day at 06:00
```

Loopmill itself does not wait.

The OS Scheduler invokes:

```bash
loopmill run <workflow-id>
```

---

## Agent Node

Executes an AI Runtime.

Settings:

```text
Runtime
Prompt
Working Directory
Timeout
Expected Structured Output
```

Example:

```text
Runtime: Codex
Prompt:
Review today's published articles.
Return a structured judgment.
```

---

## Condition Node

Evaluates the previous Node's Structured Output and branches.

Example:

```json
{
  "needs_issue": true
}
```

Condition:

```text
needs_issue == true
```

---

## Command Node

Executes a local shell command.

Example:

```bash
npm test
git status
gh issue create
gh pr create
```

Recorded:

* Command
* cwd
* stdout
* stderr
* Exit code
* Duration

---

## Human Approval Node

Puts the Workflow into a persistent wait state.

```text
Approve
Reject
```

The Runner is not kept running just to wait for approval.

---

## Loop Edge

Sends execution back to an earlier Node.

Example:

```text
Claude Implementation
       ↓
Codex Review
       ↓
     Pass?
       │
       └── No
            ↓
Claude Implementation
```

A Loop Edge always has a maximum iteration count.

```text
maxIterations = 3
```

Unbounded loops are prohibited in the MVP.

---

# 13. Execution Hierarchy

Loopmill's execution model:

```text
Workflow
  ↓
Run
  ↓
Cycle
  ↓
Node Execution
```

## Workflow

A persistently stored Loop Definition.

## Run

One launch of a Workflow.

## Cycle

One pass through the improvement Loop.

## Node Execution

One execution of a single Node.

Token Usage can be aggregated at every level of this hierarchy.

---

# 14. Execution States

A Node Execution has the following states.

```text
PENDING
RUNNING
SUCCEEDED
FAILED
WAITING_APPROVAL
WAITING_FOR_QUOTA
PAUSED
CANCELLED
SKIPPED
```

---

# 15. Live Run Monitor

The current Workflow execution status can be viewed from the browser.

Example:

```text
Daily Content Improvement
✓ Observe       Codex
✓ Evaluate      Codex
✓ Create Issue  Command
✓ Implement     Claude Code
✓ Test          Shell
✗ Review        Codex
● Fix           Claude Code
○ Review
○ Create PR
```

Displayed information:

* Current Node
* Completed Nodes
* Failed Nodes
* Loop iteration
* Elapsed time
* Current Runtime

---

# 16. Node Inspector

Clicking a Node Execution shows its details.

```text
Runtime
Prompt
Input
Output
Started at
Completed at
Duration
stdout
stderr
Structured Output
Files Changed
Git Diff
Exit Code
Token Usage
Usage Source
```

---

# 17. Human Intervention

The following actions can be performed on a Run.

```text
Pause
Resume
Cancel
Retry Node
Retry From Here
Skip Node
Approve
Reject
```

After the MVP,

```text
Inject Instruction
```

will be added.

Example:

```text
Re-implement this without changing the DB schema.
```

---

# 18. Persistent Waiting

Loopmill does not keep a process around just to wait.

## Human Approval

```text
Agent
 ↓
Human Approval
 ↓
WAITING_APPROVAL
 ↓
Persist State
 ↓
Runner Exit
```

After approval:

```text
Resume Run
 ↓
Runner Start
```

---

## Subscription Quota

```text
Agent
 ↓
Quota Reached
 ↓
WAITING_FOR_QUOTA
 ↓
Persist State
 ↓
Runner Exit
```

The MVP provides Manual Resume.

---

# 19. Token Observability

Token Usage is a core feature of the MVP.

It is not an analytics add-on.

Usage is stored for every Agent Node Execution.

```typescript
interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  reasoningTokens?: number;
  outputTokens?: number;
  totalTokens: number;
  source:
    | "reported"
    | "derived"
    | "estimated";
}
```

---

# 20. Usage Reliability

How token information is obtained differs from Runtime to Runtime.

The Usage source is therefore always recorded.

```text
Reported
Values reported by the CLI itself
Derived
Aggregated by Loopmill from multiple CLI Events
Estimated
Estimated by Loopmill
```

Estimated values are never presented as if they were measured values.

---

# 21. Node Token Usage

Consumption can be checked for each Agent Node.

Example:

```text
Claude Code
Implementation
Input              486,210
Cache read         420,102
Cache creation      21,442
Output              18,928
─────────────────────────
Total              526,682
Source            Reported
```

---

# 22. Cycle Token Usage

Aggregates usage across one full improvement Cycle.

Example:

```text
Cycle #128
Codex Review             132K
Claude Implementation    527K
Codex Code Review         92K
────────────────────────────
Total                     751K
```

Loopmill treats

> **the number of tokens spent to land a single improvement**

as a key metric.

---

# 23. Workflow Token Analytics

The Workflow Dashboard shows Token Usage over time.

At a minimum:

```text
Last Cycle
Average / Cycle
Total Tokens
Total Cycles
```

Breakdown:

```text
By Runtime
By Node
```

Time-series chart:

```text
Tokens / Cycle
1.2M ┤             ╭─╮
1.0M ┤       ╭╮    │ │
800K ┤  ╭╮ ╭─╯╰─╮  │ ╰╮
600K ┤──╯╰─╯    ╰──╯  ╰─
     └────────────────────
```

---

# 24. Loop Efficiency

Loopmill does not treat Token Observability as a mere "cost display."

Its purpose is

**measuring Engineering Loop Efficiency.**

For example:

| Node           | Runtime | Runs | Avg Tokens | Last |
| -------------- | ------- | ---: | ---------: | ---: |
| Article Review | Codex   |   30 |       126K | 131K |
| Implementation | Claude  |    8 |       512K | 621K |
| Code Review    | Codex   |    8 |        94K |  89K |

From this, one can tell that:

* Prompts are bloating
* Context has grown too large
* Implementation is becoming expensive
* Reviews are causing more Retries
* Runtime selection is inefficient

and so on.

---

# 25. Subscription Quota

What the MVP records is

```text
Token Consumption
```

The MVP does not force the following:

```text
Claude Remaining 37%
Codex Remaining 52%
Quota Reset Countdown
Estimated Cycles Remaining
```

These will be added in the future only where reliable information can be obtained from the Runtime side.

---

# 26. Daemonless Scheduling

Loopmill itself has no Scheduler daemon.

It uses the OS-native scheduler.

```text
macOS
 → launchd
Linux
 → systemd timer
Windows
 → Task Scheduler
```

What gets registered is essentially just:

```bash
loopmill run <workflow-id>
```

---

# 27. Zero-idle Architecture

Normal state:

```text
Nothing Scheduled Right Now
         ↓
No Loopmill Process
```

At the scheduled time:

```text
OS Scheduler
     ↓
Loopmill Runner starts
     ↓
Workflow executes
     ↓
Results persisted
     ↓
Runner exits
```

When checking the UI:

```text
loopmill ui
     ↓
Local Web Server
     ↓
Browser
```

Once you are done checking the UI, it can be stopped.

---

# 28. Missed Schedule Reconciliation

Handles the case where a scheduled time was missed because the PC was shut down or asleep.

CLI:

```bash
loopmill reconcile
```

Example:

```text
Workflow
Daily 06:00
Last Run
Sep 5 06:02
Current Time
Sep 6 10:31
Sep 6 execution missing.
→ Run now
```

Missed Schedule Policy:

```text
RUN_ON_NEXT_START
SKIP
```

Default:

```text
RUN_ON_NEXT_START
```

`reconcile` can be run once at boot / login.

It exits after it finishes.

---

# 29. Runner / UI Separation

Loopmill separates the following.

```text
Loopmill Core
    │
    ├── Runner
    │
    └── UI Server
```

Runner:

```bash
loopmill run
```

UI:

```bash
loopmill ui
```

No always-on Web Server is required.

---

# 30. Persistence

The MVP uses SQLite.

Stored:

```text
Workflow
Workflow Version
Schedule
Run
Cycle
Node Execution
Agent Log
Token Usage
Human Action
Control Command
Runtime Settings
```

No external database is required.

---

# 31. Runner / UI Coordination

The Runner and the UI use SQLite as shared state.

```text
Runner
 ↓
SQLite
 ↑
UI Server
```

The Runner never needs to host a persistent WebSocket server.

Only while the UI is open does the UI Server push updates to the Browser via SSE or similar.

---

# 32. Control Queue

Human operations are also stored as persistent state.

Example:

```text
ControlCommand
runId
command
payload
createdAt
processedAt
```

Commands:

```text
PAUSE
RESUME
CANCEL
SKIP
APPROVE
REJECT
```

The Runner checks the Control Queue at safe points.

---

# 33. Git / GitHub

The MVP does not build out a GitHub API abstraction.

It uses the user's

```text
git
gh
```

CLIs.

Example:

```bash
gh issue create
gh issue view
gh pr create
gh pr comment
```

They are invoked from Command Nodes or Agent Nodes.

---

# 34. Workspace

MVP:

```text
Shared Workspace
```

Concurrent Agents:

```text
1
```

When parallel execution is added in the future,

```text
git worktree
```

will be used.

---

# 35. Safety Limits

At a minimum, the following limits are configured.

```text
Max Runtime
Max Loop Iterations
Max Concurrent Agents
Allowed Workspace
```

Default:

```text
Max Loop Iterations: 3
Concurrent Agents: 1
```

Critical operations can be gated with a Human Approval Node.

---

# 36. CLI

The MVP provides at least the following.

```bash
loopmill run <workflow-id>
loopmill resume <run-id>
loopmill reconcile
loopmill ui
loopmill doctor
```

---

# 37. Doctor

Makes diagnosing the environment easy.

```text
Loopmill Doctor
Codex
✓ Installed
✓ Authenticated
Claude Code
✓ Installed
✓ Authenticated
git
✓ Installed
gh
✓ Installed
✓ Authenticated
Scheduler
✓ launchd available
Database
✓ Healthy
```

Because a Subscription-native OSS depends heavily on the local environment, `doctor` is a core MVP feature.

---

# 38. Technology

The MVP is TypeScript-centric.

```text
Monorepo
Frontend
 React
 React Flow
Core / Backend
 Node.js
 TypeScript
CLI
 TypeScript
Agent Execution
 child_process / execa
 node-pty when required
Database
 SQLite
 Drizzle ORM
Realtime UI
 SSE
Charts
 React-compatible chart library
```

---

# 39. Deployment

Standard MVP usage:

```text
Developer's Local Machine
```

That PC already has:

* Repository
* Codex
* Claude Code
* Git
* GitHub CLI
* Subscription authentication

There is no need to provision Railway, a VPS, or the like just for Loopmill.

---

# 40. Future Remote Mode

An optional Remote Dashboard may be considered in the future.

```text
Local Loopmill Runner
        ↓
   Optional Sync
        ↓
Loopmill Remote Dashboard
```

Sync candidates:

* Run status
* Workflow metadata
* Token usage
* Notifications

Prompts / Code / Git Diffs and the like are opt-in.

AI execution itself can stay local.

Out of scope for the MVP.

---

# 41. Runtime Roadmap

Priority:

```text
P0
Codex
Claude Code
P1
Google subscription-backed agent runtime
P2
Other official AI agent CLIs
```

The Adapter architecture needed for Google support is kept in place from the MVP onward.

---

# 42. Reference Workflow

The first dogfooding target:

## Daily Content Improvement Loop

```text
Daily Schedule
      ↓
    Codex
      ↓
Review today's published content
      ↓
 Problem?
 ↙          ↘
No          Yes
↓            ↓
End       Create Issue
              ↓
         Claude Code
              ↓
          Implement
              ↓
             Test
              ↓
            Codex
           Code Review
              ↓
             Pass?
          ↙         ↘
        No           Yes
        ↓             ↓
 Claude Code       Create PR
        ↑
        └── Retry
```

Maximum Retries:

```text
3
```

No automatic merge.

---

# 43. Reference Use Case

The work a human currently does by hand,

```text
Check articles with ChatGPT every day
 ↓
Judge whether there is a problem
 ↓
GitHub Issue
 ↓
Separately ask Claude Code to implement
 ↓
Check the result
```

is moved into Loopmill.

After completion:

```text
Daily Schedule
 ↓
Codex Review
 ↓
Issue
 ↓
Claude Code
 ↓
Test
 ↓
Codex Review
 ↓
Retry if needed
 ↓
PR
```

The human supervises the state from the browser.

---

# 44. MVP Acceptance Criteria

The MVP is complete when:

1. A Loop can be created in the Visual Builder
2. A Manual Run can be executed
3. A Scheduled Run can be registered with the OS scheduler
4. A Scheduled Run starts without a resident daemon
5. Codex can be executed with a ChatGPT subscription
6. Claude Code can be executed with a Claude subscription
7. No API key is required
8. Branching works via Conditions
9. Commands can be executed
10. Re-execution works via Loop Edges
11. Max Iterations is enforced
12. Human Approval can wait persistently
13. When a quota is reached, state is saved and the Runner exits
14. A GitHub Issue can be created
15. Claude Code can implement an Issue
16. Tests can be executed
17. Codex can review
18. If rejected, control returns to Claude Code
19. If approved, a PR can be created
20. The current state can be checked in the Browser
21. Node Input / Output / Logs can be inspected
22. Token Usage per Node can be checked
23. Token Usage per Cycle can be checked
24. Token Usage trends per Workflow can be checked
25. Token Usage by Runtime can be checked
26. Token Usage by Node can be checked
27. Run History can be viewed
28. Missed Schedules can be reconciled
29. No Loopmill process exists while idle
30. The environment can be checked with `loopmill doctor`

---

# 45. MVP Non-goals

The following will not be built in the MVP.

```text
OpenAI API integration
Anthropic API integration
Gemini API integration
Google Runtime
SaaS
Multi-tenancy
Organization
RBAC
Billing
Marketplace
Slack integration
Telegram integration
Hundreds of integrations
Kubernetes
Distributed runners
Parallel multi-agent execution
Automatic PR merge
Subscription quota percentage
Generic no-code automation
```

In particular,

> **we are not building n8n.**

Loopmill focuses on Engineering Loops.

---

# 46. MVP Feature Pillars

The MVP stands on the following five pillars.

## 1. Visual Engineering Loops

Define Engineering Processes as Node Graphs.

## 2. Subscription-backed Agent Runtimes

Use Codex + Claude Code with existing subscriptions.

## 3. Loop Execution

Combine Conditions / Commands / Retries / Humans.

## 4. Daemonless Local Execution

Use the OS Scheduler and bring idle compute to zero.

## 5. Token Observability

Measure AI consumption per Node / Cycle / Workflow.

---

# 47. Product Differentiation

The combination that characterizes Loopmill is:

```text
Subscription-native
        ×
Visual Engineering Loop
        ×
Token Observability
        ×
Daemonless Local Execution
```

Product positioning rests on this combination, not on any single feature.

---

# 48. Product Identity

Loopmill's four principles:

```text
Subscription-native
Local-first
Daemonless
Observable
```

Central concept:

```text
Loop
```

AI Agents are the components that make up a Loop.

---

# 49. Name

## Loopmill

A `Mill` is a machine into which material is fed and which continuously processes and produces it through a fixed series of stages.

Loopmill takes as input

```text
Observation
Issue
Code
Feedback
```

runs them through the stages

```text
Codex
Claude Code
Shell
Human
```

as a Loop, and turns them into

```text
Verified Change
PR
```

The name itself expresses the product philosophy:

> **a machine that turns Engineering Loops.**

---

# 50. Short Description

> **Loopmill turns your existing AI subscriptions into observable, repeatable engineering loops.**

---

# 51. Longer Description

> **Build, run, monitor, and optimize engineering loops across Codex, Claude Code, shell commands, conditions, and humans — using the AI subscriptions you already pay for, without keeping another server alive.**

---

# 52. Core Message

The problem Loopmill solves is not

> How can I run multiple AI agents?

What it sets out to solve is

> **Why am I still manually carrying work from one AI to another?**

Loopmill defines

```text
Observe
 ↓
Decide
 ↓
Act
 ↓
Verify
 ↓
Retry
```

as an Engineering Loop.

And then, it

> **makes visible not only whether that Loop is running correctly, but also how efficiently it is using AI resources.**

That is Loopmill.
