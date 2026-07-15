---
title: "Running a service on your laptop, no VPN"
description: "Most services at a fintech lending platform could not boot without a VPN to shared dev infrastructure. One service could run its whole stack and its integration tests on a laptop with a few commands. Here is the pattern behind it, and why the tools do not matter."
pubDate: 2026-07-15
tags: ["local-development", "testing", "hermetic", "docker", "developer-experience", "microservices"]
draft: false
---

Most of the services I worked on at a fintech lending platform could not run on a laptop. To boot, they opened a connection to a shared development Postgres, a shared Kafka, and a shared Redis, and all of those lived behind a VPN. Turn the VPN off and the process died at startup. Want to run the integration tests? Same story: the tests reached for the same shared database and the same shared brokers, so they only passed when you were on the network and nobody else was stepping on the data.

One service was different. Clone it, run a few commands, and the whole dependency stack came up locally: Postgres, Kafka, Redis, Elasticsearch, and a stub for every external service it called. Both integration test tiers ran with nothing but Docker. No VPN, no shared environment, no waiting for a colleague to finish their test run.

This post is the pattern behind that one service, written so any service can adopt it. The point is not the specific tools. The point is a property called hermeticity, and the tools are interchangeable.

## Why the VPN-only setup is bad

This is not a matter of taste. The practices that make a service laptop-runnable are the same ones a few well-known sources have argued for over the last fifteen years.

Divergent, remote-only development environments slow delivery. The Twelve-Factor App names this in Factor X, "Dev/prod parity": "Keep development, staging, and production as similar as possible." It calls out the time, personnel, and tools gaps that open when you do not, and states the goal: a twelve-factor app is "designed for continuous deployment by keeping the gap between development and production small." A service that only runs against a shared environment has the widest possible tools gap, because the only place it runs is somewhere you do not control.

Config that bakes environment hostnames into the artifact is the anti-pattern. Factor III, "Config": "The twelve-factor app stores config in environment variables." Its litmus test is that config is factored out correctly when "the codebase could be made open source at any moment, without compromising any credentials." Factor IV, "Backing services", adds the property that makes local swap possible: "The code for a twelve-factor app makes no distinction between local and third party services... both are attached resources, accessed via a URL or other locator/credentials stored in the config", and a deploy "should be able to swap out a local MySQL database with one managed by a third party... without any changes to the app's code." Point the URL at localhost and you are local. Same binary.

Tests that depend on a shared environment are flaky by construction. From _Software Engineering at Google_, Chapter 14, "Larger Testing": a hermetic system under test "will not be at risk of the kinds of multiuser and real-world flakiness of production or a shared staging environment." Google spelled this out again in a 2023 workshop paper, "How we use Hermetic, Ephemeral Test Environments at Google to reduce Test Flakiness." When two engineers run the integration suite against the same shared database at the same time, they corrupt each other's data and both blame the code.

Trying to boot the entire topology locally is also wrong. This is the counter-argument, and it is a good one. Cindy Sridharan, in "Testing Microservices, the sane way", describes a team that tried to run every service on a laptop: "with a single Vagrant up you should be able to boot the entire cloud up on a laptop." Her verdict is that this is "almost like you're supporting the worst possible cloud provider ever." She is right, and the pattern here does not do that. It runs one service plus its own backing infrastructure, and it stubs the services it does not own.

Those two ideas look like they conflict. Dev/prod parity says be like production; Sridharan says do not clone production. The resolution is the line between them: run real backing services locally (a real Postgres in a container, not SQLite), and stub the external services you do not own. Parity where you own the thing, isolation where you do not.

## The north star: hermeticity, and why it feels good

Before any tool, name the property you are after. A service is pleasant to work on when it is _hermetic_: it provisions everything it needs itself, depends on nothing shared or remote, and produces the same result on every laptop and in CI. Hermeticity is what turns "connect the VPN, hope the shared environment is up, hope nobody is mid-test" into "run one command."

This is not only about speed. The 2023 ACM paper "DevEx: What Actually Drives Productivity" (Noda, Storey, Forsgren, Greiler) puts feedback loops first among the three dimensions of developer experience: fast feedback lets a developer work with minimal friction, and slow feedback interrupts and frustrates. The SPACE framework (Forsgren and colleagues, 2021) makes the same point from the other side, naming satisfaction and well-being as a first-class productivity dimension. "We enjoy doing it" is not a soft benefit tacked on at the end. It is a measured driver, and a hermetic local setup is one of the most direct ways to move it.

## The recipe: seven principles that remove the VPN

Each principle is stated first, then the interchangeable tools, then how the reference service happened to do it. Its choices are one instantiation, not the mandate.

**1. Run backing services locally as attached resources.** Your database, broker, and cache run on your machine, not in a shared cluster. Tools: docker-compose, Podman, a local Kubernetes (minikube, kind, k3d), Tilt, or a test library that manages containers. The reference service used one docker-compose file for Postgres, Kafka, Redis, and Elasticsearch. This is Twelve-Factor IV in practice.

**2. Load config from the environment, default to localhost, and keep remote hosts off the default path.** The same binary runs local or remote depending only on env vars. Tools: any twelve-factor config loader (Viper, envconfig, plain environment reads). The reference service set every infrastructure default to localhost in code and switched to a remote env file only when asked. This is Twelve-Factor III.

**3. Stub the external services you do not own.** Every upstream HTTP call, including the OAuth2 token endpoint, points at a local simulator with canned responses. Tools: WireMock, Mountebank, Hoverfly, MockServer, Prism, or a hand-written in-process fake. The reference service used WireMock and even stubbed the `client_credentials` token grant, so the real OAuth2 flow ran end to end against a fake issuer. This is Sridharan's "isolate and stub", and the test-double practice from _Building Microservices_ (Sam Newman) and Martin Fowler's writing on test doubles.

**4. Own your schema and make it reproducible into a fresh database.** A brand-new local Postgres must reach the current schema with one command. Tools: golang-migrate, goose, Atlas, dbmate, Flyway, Liquibase. The reference service used versioned SQL migrations, applied both by a make target and by a migration init container inside the compose stack, so the database was ready before anything else started.

**5. Make integration tests hermetic: the test provisions its own dependencies.** The test spins up its own ephemeral infrastructure and tears it down after, so it needs nothing but Docker and never touches a shared environment. Tools: Testcontainers, docker-compose driven from CI, ephemeral Kubernetes namespaces. The reference service had two tiers. One needed only the local Postgres. The other used Testcontainers to start Kafka, WireMock, Redis, Postgres, and a storage emulator, ran the pipeline against them, and cleaned up. Testcontainers describes itself for exactly this: "throwaway, lightweight instances of databases, message brokers... No more need for mocks or complicated environment configurations."

**6. Keep secrets at deploy time, and use plain or stub values locally.** No secret manager should be required to boot on a laptop. Tools: a secret store in production, a plain env file locally. Every service I looked at already satisfied this one.

**7. Let boot tolerate local doubles.** No client should crash the process on an unreachable remote at startup when a local target would do. This is the principle the reference service itself only half-satisfied, and I cover it under rough edges below. Name it anyway, because it is the difference between "the stack came up" and "the process exited before the HTTP server bound."

One more, wrapping the rest: a single front-door command runner, so the whole thing is a few commands and not a wiki page of steps. Tools: Make, Task, just, npm scripts.

## Reality check: transferable is not free

The pattern transfers, but transferable is not the same as effortless. Two sibling services on the same platform were a long way from laptop-runnable. Here is each principle graded across the reference service and the two siblings.

| Principle | Reference service | Sibling A | Sibling B |
|---|---|---|---|
| 1. Local backing services | Yes | No compose at all | No compose at all |
| 2. Env config, localhost default | Yes | Partial | Partial |
| 3. External deps stubbed | Yes | No, around thirty upstreams | No, two dozen upstreams |
| 4. Owned, reproducible schema | Yes | No migrations in repo | No, shared monolith database |
| 5. Hermetic integration tests | Yes, two tiers | Disabled placeholder | Commented out |
| 6. Secrets at deploy time | Yes | Yes | Yes |
| 7. Boot tolerates local doubles | Mostly | No | No |

Sibling A had no migrations in the repository, so a fresh local Postgres had no tables and the schema lived somewhere else. Boot was gated by around twenty message-queue producers plus cloud clients that crashed the process on failure, so the HTTP server never bound without them. Around thirty upstreams were pinned to internal hostnames, with no stubs.

Sibling B was worse in one specific way: its data lived in a shared monolith database, and the repo shipped a single trivial schema change, so you could not build a fresh local database from the repo at all. Its database host, cache, broker, and identity provider were all pinned to internal addresses and all crashed on connect at boot.

The honest takeaway: the two hard principles are owning your schema (hardest for a service whose data lives in a shared monolith) and stubbing a large fan-out of upstreams. Secrets were already handled everywhere. The env-override plumbing partly existed. Nobody was starting from zero, but the shared-schema services had real structural work to do before a fresh local database was even possible.

## Adoption path, cheapest first

1. Make config fully env-overridable with localhost defaults, and move every hardcoded remote host off the default path.
2. Stand up your backing services locally, with compose, a local Kubernetes, or a test library that manages containers.
3. Get your schema into the repo as reproducible migrations. For a shared-monolith service this is the structural step, and it may need a schema carve-out first.
4. Stand up an API stub for every external upstream and for the token endpoint, then point the base URLs at it by config.
5. Make the crash-on-boot clients targetable locally, or gate them so the process starts without them.
6. Add one hermetic integration tier and wire it into CI so it stays green.
7. Wrap the whole thing in one command runner: `up`, `migrate`, `test`.

## Known rough edges

The reference service's own host API did not fully boot against stubs. A handful of upstream URLs were required and shipped blank, and the app waited on a feature-flag service at startup, so the fully-local path was the pipelines plus the two test tiers, not the host API against stubs. That is principle seven half-done: the pipelines and tests tolerated local doubles, the host API did not yet. A fixable gap, and naming it is the point.

And "no VPN" is not "no internet." The first run still pulls container images and a binary from the network. You need egress, just not the corporate VPN.

## References

- The Twelve-Factor App, Factors III, IV, X. <https://12factor.net/config>, <https://12factor.net/backing-services>, <https://12factor.net/dev-prod-parity>
- Cindy Sridharan, "Testing Microservices, the sane way" (2017), and the talk "Testing Microservices: A Sane Approach" (2018). <https://www.youtube.com/watch?v=XBDfsiKDpFo>
- _Software Engineering at Google_, Ch. 13 and 14. <https://abseil.io/resources/swe-book/html/ch14.html>
- Carlos Arguelles et al., "How we use Hermetic, Ephemeral Test Environments at Google to reduce Test Flakiness" (CCIW 2023). <https://ieeexplore.ieee.org/document/10132239/>
- "DevEx: What Actually Drives Productivity" (Noda, Storey, Forsgren, Greiler, 2023). <https://queue.acm.org/detail.cfm?id=3595878>
- Testcontainers <https://testcontainers.com/>, WireMock <https://wiremock.org/>, and _Building Microservices_ (Sam Newman).
