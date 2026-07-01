---
title: "The dead-letter that could not deliver"
description: "How a missing dead-letter topic froze two Kafka partitions in a strict-ordered Redpanda Connect pipeline, and the bounded fallback that fixes the class."
pubDate: 2026-07-01
tags: ["kafka", "redpanda-connect", "benthos", "dlq", "reliability"]
draft: false
---

A stream-processing pipeline stopped committing on two of its thirty partitions and stayed that way for fifteen hours. No pod crashed, no alert fired, and total consumer-group lag looked almost normal because twenty-eight partitions were fine. The fix was two small changes. The interesting part is why one bad message could freeze an entire partition and never let go.

## 1. The lag that only hit two partitions

A debt-recovery service at a peer-to-peer lending platform keeps a collection case in step with each delinquent loan. One Redpanda Connect (formerly Benthos) pipeline consumes repayment events from a repayment-event topic and posts each repayment to the collection-case API, so a case can close when the borrower pays.

The pager did not go off. What showed up was consumer-group lag, and the shape was strange. Of thirty partitions on the topic, twenty-eight were caught up and two were not. Partition 4 and partition 24 each sat at about 33,000 messages of lag and climbing, while their committed offsets had not moved since 19:07 the previous evening. Five pods, zero restarts, no error log, no crash. Whatever was wrong, it was wrong on exactly two partitions and invisible everywhere else.

## 2. Why one message can freeze a whole partition

Redpanda Connect is at-least-once. It commits a Kafka offset only when a message reaches an output that succeeds, or when a mapping explicitly drops it. There is no third option. A message that is neither delivered nor dropped is never acknowledged, and its offset never advances.

This pipeline preserves strict per-partition order. It sets no `checkpoint_limit`, so the input processes one message at a time per partition and commits contiguously. That is a deliberate choice: a repayment for a loan must apply in order. The cost is that a partition cannot skip its head. If the message at the head of partition 4 never acknowledges, every message behind it waits forever.

The consumer also stayed a healthy group member the entire time. The franz-go client heartbeats on its own goroutine, decoupled from message processing, so the broker never saw a dead consumer and never triggered a rebalance to hand those partitions to someone else. The partition was frozen, and the group thought everything was fine.

So the whole incident reduces to one question: what was the head message on those two partitions, and why would it not acknowledge?

## 3. The 413

The head message was a repayment for a loan with a long bill history. Following it through the pipeline, the `PUT` to the collection-case API came back `413 Request Entity Too Large` from the nginx in front of the gateway. Every retry returned the same 413, because the body was the same size every time.

The body was large for a reason that has nothing to do with the repayment. The pipeline copies a `forwardRepayments` array onto every bill in the request. That array records amounts the billing engine applied ahead of a due date. The receiving API does not read it. Its request struct has no `forwardRepayments` field, so `json.Unmarshal` on the other side skips the bytes and moves on. The field is dead weight on the wire. On a loan with dozens of bills and a dense forward-repayment history, that dead weight pushed the compact JSON past the gateway body limit of 1 MB, and nginx rejected it before the application ever saw it.

413 is not in the pipeline's list of acceptable responses, so it counts as a hard failure. After the configured retries, the message was handed to the dead-letter path.

## 4. The dead-letter that could not deliver

A dead-letter path exists so a message that cannot be processed gets set aside on a DLQ topic instead of blocking the stream. This one could not set anything aside. The DLQ produce came back with a single line, repeated:

```
Failed to send message to redpanda: UNKNOWN_TOPIC_OR_PARTITION: This server does not host this topic-partition.
```

The DLQ topic did not exist. These brokers do not auto-create topics, so producing to a name that was never provisioned returns `UNKNOWN_TOPIC_OR_PARTITION`. The `redpanda` output, which is franz-go under the hood, treats that as retryable and keeps refreshing metadata waiting for the topic to appear. It never appears. There is no delivery deadline on that output in the version in use, so the produce retries forever.

Now the trap is complete. The message cannot `PUT` (413 every time) and cannot dead-letter (no such topic, retry forever). It is never acknowledged. The partition, held in strict order with no `checkpoint_limit`, cannot move past it. Both partitions froze because both happened to have an oversized message at their head within the same minute.

## 5. The fix, part one: stop sending the field nobody reads

An earlier post here stripped a fat investors array out of a different pipeline to stop it running out of memory. This is the same lesson on a different field and a different limit. `forwardRepayments` is consumed by nobody on the receiving side, so removing it from the outgoing body changes no behavior on the API and cannot break a caller that never looked at it. The mapping that copied it was deleted.

That alone unblocks the incident. A restart would not, because the 413 is deterministic: a restarted consumer rebuilds the same oversized body and re-freezes at the same offset. Deploying the smaller body lets the `PUT` return 200, the message acknowledges, and the two frozen heads drain on the next redelivery. It is also time-sensitive. The pipeline only applies allocations dated in the current week, so the stuck messages had to reach production before that week rolled over, or they would be skipped as out-of-week and lost.

## 6. The fix, part two: a dead-letter that fails instead of hanging

Stripping the field removes this trigger. It does not remove the trap. Any future message that genuinely needs to dead-letter would hit the same wall the moment a DLQ topic is missing or a broker is briefly unreachable. The real defect is a dead-letter output that can retry forever and therefore never acknowledge.

The obvious fix is to bound the produce and, if it still fails, drop the message with a loud metric rather than freeze the partition. Redpanda Connect has the piece for this: the `fallback` output tries a primary output and, if it returns an error, routes the message to a second output. The catch is that the second arm only runs if the first arm actually returns an error. The `redpanda` output on the version in use (4.77.0) exposes no way to bound its produce retries. Those fields, `record_retries` and `record_delivery_timeout`, arrived in 4.92.0, fifteen minor versions ahead, and bumping the runtime for every pipeline was more blast radius than this fix is worth.

The sarama-based `kafka` output does bound retries on that same version. It exposes `max_retries` and `backoff.max_elapsed_time`, and it returns an error once they are spent. So the DLQ now goes through the `kafka` output wrapped in a `fallback`:

```yaml
output:
  fallback:
    - kafka:
        addresses: [ "${KAFKA_SEED_BROKERS}" ]
        topic: ${KAFKA_DLQ_TOPIC:...}
        key: ${! meta("loan_id") }
        max_retries: ${KAFKA_DLQ_MAX_RETRIES:5}
        backoff:
          max_elapsed_time: ${KAFKA_DLQ_MAX_ELAPSED_TIME:30s}
    - drop: {}
      processors:
        - log:
            level: ERROR
            message: DLQ publish failed after retries; dropping to avoid partition wedge
        - metric:
            name: dlq_publish_dropped_count
            type: counter
            value: "1"
```

If the DLQ produce cannot complete within the bound, the produce errors, the `fallback` moves to the `drop`, the message is acknowledged, and the partition keeps moving. The same guard went onto every dead-letter output in the service. One pipeline was left alone, because its `redpanda` output is the primary data path rather than a dead-letter, and a drop there would lose real events.

The trade-off is stated plainly in the change. A DLQ that stays unreachable past the bound now drops the message, counted by `dlq_publish_dropped_count` and logged at ERROR, instead of freezing a partition and blocking every other loan on it. Losing one message loudly beats stalling a partition silently. Creating the missing topics remains the primary fix; the fallback is the seatbelt.

## 7. Proving it

The claim worth proving is the last one: that the new output drops and acknowledges where the old one hangs. A local reproduction settles it. Start a single Redpanda broker with `auto_create_topics_enabled=false`, so producing to a missing topic fails the way production did. Point one pipeline at a topic that does not exist, using the original `redpanda` output. Feed it one message.

It hangs. The log fills with `UNKNOWN_TOPIC_OR_PARTITION`, the message never acknowledges, and the process has to be killed. That is the wedge, reproduced in isolation. A healthy run exits in about two seconds; this one ran until the timeout.

Swap the output for the `kafka`-plus-`fallback` block above and feed it the same message against the same missing topic. It logs `DLQ publish failed after retries; dropping to avoid partition wedge`, then `Pipeline has terminated`, and exits cleanly in about five seconds. Same broker, same missing topic, same binary version. The old output freezes; the new one drops and moves on.

## 8. What we learned

A field that nobody reads is not free. `forwardRepayments` cost nothing in logic and everything in bytes, and bytes decided whether a real-money sync completed, because they moved the payload across a transport limit the code never checks.

A dead-letter queue is not a safety net until its topic exists. A dead-letter path that cannot itself deliver turns one bad message into a stalled partition. On a strict-ordered consumer with no `checkpoint_limit`, every terminal output that can fail permanently has to be bounded, or a single message wedges the stream.

Total consumer-group lag is the wrong alarm. It stayed near normal while two partitions were frozen for fifteen hours. Per-partition committed-offset staleness, measured against a moving producer offset, is the signal that would have paged on minute one.
