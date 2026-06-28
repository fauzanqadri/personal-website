---
title: "Taming memory in a high-volume event pipeline"
summary: "Stopped a stream-processing consumer from running out of memory on the heaviest events, by stripping an unused multi-megabyte field at the byte level before any JSON parser allocated it. The same idea applies to every Go consumer in the fleet."
role: "Backend engineering and performance"
stack: ["Go", "Redpanda Connect", "Bloblang", "Kafka", "IBM/sarama"]
outcome: "Up to 22.7% lower peak memory on the worst-case events, with a fail-graceful design that degrades to correct-but-unoptimized on schema drift rather than halting the pipeline."
featured: true
order: 2
---

A consumer pod kept running out of memory on a small number of unusually large Kafka events. The pipeline read sixteen small fields and never touched the heavy part of the payload, yet it died before any business logic ran. The cause was the JSON parser, not the pipeline.

## The problem

The producer published the full record state on every transition. On a lending book, a single loan can be funded by thousands of investors, and the full investor list rode along on every event. One captured event was 1 MB on the wire, and the investor arrays were 97% of it. The consumer never read inside those arrays, but the parser materialized all of them into objects before the pipeline could discard them. The object tree cost several times the raw byte size, and the heaviest events exhausted the pod.

## My role

I root-caused the allocation, designed the byte-level fix on both the stream-processing runtime and the Go consumer fleet, and built the fixtures and benchmarks that measured it.

## Approach

- **Delete first, parse second.** Bytes are cheap; objects are expensive. The fix removes the unused field from the raw byte string before the parser ever builds a tree, so the heavy data never becomes objects.
- **A two-pass strip that fails graceful.** Nested arrays inside each entry defeat a naive single regex. A two-pass strip neutralizes the known inner arrays first, then removes the outer block. If an unknown nested array appears after a schema change, the strip becomes a no-op and the original bytes flow through unchanged: correct output, no crash, savings lost only on that message.
- **A symmetric Go fix.** The Go consumer fleet gets the same result by dropping the unused fields from the receiver struct, so `encoding/json` walks past those keys without allocating. A raw-bytes consume mode pushes this to 100% of the avoidable allocations.

## Outcome

Peak memory fell by up to 22.7% on the worst-case events, exactly the events that triggered the failures, with no change to the produced output. A separate Go benchmark cut allocations by 99.99% on the same payload shape.

The full write-up, with the byte tables, the Bloblang mappings, and the benchmark numbers, is in the blog post [Killing a fat Kafka event at the byte level](/blog/killing-a-fat-event/).
