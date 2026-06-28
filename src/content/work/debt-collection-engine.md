---
title: "Rule-driven debt-collection engine"
summary: "Worked on the orchestration core for a multi-channel debt-collection engine on a Southeast-Asian fintech lending platform. A rule-driven pipeline decides which collection action each delinquent loan should receive, on which day, across desk-call, field-visit, and messaging channels."
role: "Architecture and backend engineering"
stack: ["Go", "Temporal", "Kafka", "PostgreSQL", "CQRS", "Redpanda Connect"]
outcome: "A deterministic, auditable evaluation pipeline that converts delinquency facts into scheduled collection actions, with per-stream priority ordering and a daily re-evaluation sweep over a multi-million-case book."
featured: true
order: 1
---

A lending platform with a large delinquent book needs to decide, every day, what to do about each overdue loan. Call the borrower. Send a field agent. Send a reminder. Do nothing yet. Doing this by hand does not scale past a few thousand cases, and a hardcoded cron does not survive contact with changing collection policy.

## The problem

The book holds millions of open collection cases. Each case has a delinquency profile (days past due, outstanding amount, repayment history, prior contact attempts) that changes daily as payments land and time passes. The business wanted to express collection policy as rules, not as code deploys, and wanted every produced action to be explainable after the fact: which rule fired, against which facts, on which day.

## My role

I worked on the evaluation core and its data contracts: how a case becomes a set of facts, how rules match those facts, how a match becomes a scheduled action, and how the system avoids firing the same action twice.

## Approach

- **Facts, then rules.** Each case is reduced to a flat set of facts. Rules match against facts only, never against raw service state, so a rule is a pure function of the facts it reads. This makes every decision reproducible and testable in isolation.
- **A daily evaluation sweep.** A scheduled worker re-evaluates open cases against the active rule set. A per-channel day-gate fires each action only on the day that channel is due, so a field-visit, a reminder, and a desk-call land on the right calendar days rather than all at once.
- **A priority-ordered action ledger.** Produced actions land in an append-only ledger ordered by a composite key (priority class, ready-at time, action id). Downstream dispatch drains the ledger in that order, so the most urgent work is always at the front without re-sorting the whole table.
- **Idempotency by construction.** A daily dedup key (case, date, action type) makes re-runs safe. A re-fired sweep produces no duplicate actions, which matters when the same case can be touched by more than one path.
- **CQRS read side.** Heavy read patterns (audit, reporting, operator tooling) run off a separate read store fed by change-data-capture, so analytical reads never contend with the write path that produces actions.
- **Durable orchestration where state must survive.** Long-running, resumable steps run on a durable workflow engine, so a worker restart does not lose an in-flight action or fire it twice.

## Outcome

The engine turns collection policy into scheduled, auditable actions across multiple channels, on a multi-million-case book, without a code deploy per policy change. Every action carries the rule and the facts that produced it, so an operator can answer "why did this case get this action today" from data.
