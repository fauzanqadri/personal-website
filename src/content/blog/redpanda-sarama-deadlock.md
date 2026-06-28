---
title: "Eight hours frozen: a Redpanda Connect and sarama deadlock"
description: "A stream-processing consumer stopped consuming for eight hours with no crash and a green health probe. The cause was a deadlock between Benthos's autoretry mutex and sarama's synchronous checkpointer on a consumer-group rebalance."
pubDate: 2026-06-28
tags: ["kafka", "redpanda-connect", "go", "incident", "debugging"]
draft: false
---

A stream-processing pipeline at a fintech lending platform stopped consuming. No crash. No panic. No error in the logs. The Kubernetes liveness probe stayed green the whole time. The only signal was consumer-group lag, which climbed for eight hours while input throughput sat at zero. A restart cleared it, and the same pipeline then ran for days before it happened again.

This is the story of why it froze, told from a goroutine dump.

## The symptom

The pipeline reads from Kafka with Redpanda Connect (Benthos v4.62.0) and writes downstream. Under normal load it processes steadily. During the incident it processed nothing, and every health signal a platform usually trusts said the pod was fine.

That combination is the worst kind. A crash pages someone. A green probe over a dead consumer pages no one. We found it because lag alerting fired, not because the pod looked unhealthy.

## The goroutine dump

A frozen Go process tells you everything if you ask it for a stack dump. This one held about 500 goroutines. 394 of them were parked in the same state: `select`, blocked for 480 minutes. Another 320 output writer workers sat idle with no work to pull. Eight hours of paralysis, captured in one file.

Two goroutines mattered more than the rest. One was an ack callback, 480 minutes old, blocked sending on a channel. The other was the input read loop, waiting on a condition variable that nothing would ever signal. The age gap told the order of events: the live consumer sessions were 417 to 418 minutes old, younger than the stuck ack. The ack had started, then a rebalance created new sessions, and the ack never finished.

## Defect 1: an orphaned ack channel in sarama

Redpanda Connect's legacy `kafka` input is built on IBM/sarama. When you set `checkpoint_limit: 1`, which is the setting the documentation prescribes for strict per-partition ordering, sarama selects a synchronous checkpointer. That checkpointer creates one unbuffered channel per partition session to carry the ack result back.

An unbuffered channel send blocks until a reader receives. That is fine while the session is alive, because a reader is waiting on the other end. It stops being fine when a consumer-group rebalance ends the partition session while a message is still in flight. The session goes away. The reader goes away. The ack callback, running on a long-lived context that does not cancel on rebalance, is left sending on a channel that no one will ever read. It blocks forever.

## Defect 2: a mutex held across the blocking ack

One stuck goroutine is a leak, not a freeze. The freeze needs a second defect, and Benthos supplies it.

Benthos wraps every input in an autoretry list guarded by a single mutex. It calls the underlying ack while holding that mutex. So when the ack from Defect 1 blocks forever, the mutex is never released. Every other operation on that input, the next read, the next ack, the dispatch loop, waits on the same lock. A single stuck channel send becomes a full-input deadlock.

That is the 394 parked goroutines. They are all waiting, directly or indirectly, on a mutex that the orphaned ack will never give back.

## Why it never self-healed

A consumer that breaks should fall out of its group and let a healthy member take over. This one did not, for two reasons.

Sarama runs its heartbeat on a separate goroutine from message processing. The processing path was frozen, but the heartbeat kept beating, so the group coordinator saw a healthy member and never evicted it. This path also has no `max.poll.interval.ms` equivalent, so there was no watchdog to force out a member that stopped making progress. Because the member was never evicted and nothing else changed in the group, no new rebalance fired to break the deadlock. The pipeline could sit frozen indefinitely. Eight hours was just when we restarted it.

## The fix

The restart was mitigation, not a fix. The bug waits for the next in-flight rebalance.

The durable fix is to move off the deprecated sarama input to the franz-go-based `redpanda` input. Franz-go does not use a per-partition-session unbuffered channel for acks. It marks records as consumed with a non-blocking call and commits on a timer. There is no channel to orphan. A late ack for a partition that was just revoked degrades to reprocessing that record later, a duplicate, which an idempotent consumer already tolerates. A duplicate is a far better failure mode than a freeze.

We also added the alert that would have caught this in minutes instead of hours: input throughput at zero while consumer-group lag is positive. That one rule turns a silent eight-hour stall into an immediate page.

## What this leaves you with

The configuration was correct. `checkpoint_limit: 1` is what the vendor recommends for strict ordering. The defect lives in how a deprecated component handles a routine event, a rebalance, and a healthy-looking heartbeat hid it from every probe that should have caught it.

Two lessons carry past this one incident. An unbuffered channel that crosses a lifecycle boundary is a deadlock waiting for the boundary to move: the session ended, and the channel outlived its reader. And liveness is not the same as progress. A heartbeat that runs on its own goroutine proves the process is alive, not that it is doing work. Alert on the work.
