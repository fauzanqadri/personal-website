---
title: "Killing a fat Kafka event at the byte level"
description: "How a high-volume loan-state consumer stopped running out of memory, with a two-pass byte strip in Bloblang and a thin-struct mirror in Go."
pubDate: 2026-05-29
tags: ["kafka", "go", "redpanda-connect", "performance", "memory"]
draft: false
---

A stream-processing pipeline in a debt-recovery service started to run out of memory on the worst-case events. The fix was small (two Bloblang mappings). The discovery was instructive.

## 1. The pager

A peer-to-peer lending platform funds a single loan from hundreds, sometimes thousands, of individual investors. The full ownership list lives on the loan record, and the core loan service publishes the full loan state on every transition as a Kafka event on the loan-state topic. The `{before, after}` envelope carries the entire Loan struct on each side. A downstream consumer registers or updates a collection case for delinquent loans.

A handful of loans triggered the consumer pod to run out of memory. The pipeline itself looked clean. The mapping that drives the upsert reads sixteen fields out of the envelope, all of them small scalars or one-level-nested objects. No suspicious queries. No suspicious branches. The dead-letter queue was not even firing, because the parser exhausted memory before any business logic ran.

## 2. Two ways to consume Kafka

Two technologies share this workload across the wider Kafka fleet.

The first is an internal golden-path Kafka library: a thin generic-typed Go wrapper around IBM/sarama. Handlers register with `WithConsumeEvent[E]` and receive a populated struct of type `E`. The framework calls `json.Unmarshal` inside its message processor and hands the result to the handler. Most production consumers run on it.

Redpanda Connect (formerly Benthos) handles a smaller fleet of stream-processing pipelines defined in YAML. Pipelines are declarative: input, processors, output, with Bloblang mappings in between. Where a config-as-data pipeline beats a handwritten Go consumer, Redpanda Connect is the tool to reach for.

For this story the relevant detail is that the collection-case consumer is one of the Redpanda Connect pipelines. The same trick that solves the memory problem here also has a Go-side mirror that applies to every consumer on the internal library. We look at both.

## 3. Where the bytes go

The first useful question was: what is in the payload? We captured a sample event from production and counted.

| | Bytes (compact JSON) | Share |
|---:|---:|---:|
| Whole envelope | 1,064,738 | 100% |
| `before.investors[]` | 518,586 | 48.7% |
| `after.investors[]` | 518,586 | 48.7% |
| Everything else | ~27,000 | ~2.5% |

The captured loan carried 833 investor entries on each side. The largest loans in the upper tail of the distribution carry several thousand. The pipeline never reads inside `investors[]`. The upsert does not care who the investors are. The strip starts here.

## 4. The mental model

Bloblang is an eager-DOM language. The first time a mapping evaluates `this.after.id`, the runtime parses the entire input into a tree of `map[string]interface{}`, `[]interface{}`, and string or numeric leaves. The walk is complete. Investors live in the same tree even when no processor names them. Each investor entry becomes a `map[string]interface{}`, plus a string header per field, plus a nested sub-object, plus a small slice for `tags`. Multiplied by the entry count, the DOM expands to many times the size of the input bytes.

The same lifecycle drives Go's `encoding/json`. The Decoder tokenizes the input, looks up each key against the struct field set, and either allocates a matching field's value or walks past the input value with no allocation. When the receiver struct declares `Investors []Investor`, the decoder allocates an 833-element slice and populates every entry. When the receiver struct omits the field, the decoder reads the array tokens to find the matching close-bracket and discards them.

Bytes are cheap. Objects are expensive. Stay in bytes-or-string-land for as long as possible. Delete first, parse second.

## 5. The Redpanda Connect side

Bloblang lets us touch the raw bytes through `content()`. Operations on `content().string()` are string operations, not object operations. Nothing builds a DOM until we explicitly call `.parse_json()`. We can rewrite the byte string to remove the heavy field before the parser ever sees it.

The first attempt looked like this:

```yaml
- mapping: |
    let stripped = content().string().re_replace_all(
      "\"investors\":\\s*\\[[^\\[]*\\]",
      "\"investors\":[]"
    )
    root = $stripped.parse_json()
```

It did not work. Investor entries contain two nested arrays of their own: `tags` (sometimes populated with strings) and a nested `investmentIds` list. The `[^\[]*` character class refuses to span a `[`, so the regex stopped at the first inner bracket and never matched.

The fix is a two-pass strip. Neutralize the known nested arrays inside an investor body first, then strip the outer block.

```yaml
- mapping: |
    let raw      = content().string()
    let no_tags  = $raw.re_replace_all("\"tags\":\\s*\\[[^\\]]*\\]", "\"tags\":null")
    let no_ids   = $no_tags.re_replace_all("\"investmentIds\":\\s*\\[[^\\]]*\\]", "\"investmentIds\":null")
    let stripped = $no_ids.re_replace_all("\"investors\":\\s*\\[[^\\[]*\\]", "\"investors\":[]")
    root = $stripped.parse_json()
```

The `[^\[]*` is also the safety net. If a future schema change adds an unknown nested array inside an investor body, the outer match yields no replacement and the original bytes flow through to `parse_json` unchanged. The pipeline still produces the correct projection. It just loses the memory savings on that message until the first two passes are updated. We chose fail-graceful over fail-loud, because a schema drift should not halt a production pipeline.

The change added one more mapping immediately after the strip: a thin projection that rebuilds `root` with only the sixteen consumed fields. Every other field becomes GC-eligible the moment that mapping completes. Downstream processors walk a minimal tree.

The measured peak-RSS deltas across fixture scales:

| Investors per side | Wire payload | Baseline RSS | Patched RSS | Delta |
|---:|---:|---:|---:|---:|
| 833 | 1.06 MB | 153.7 MB | 155.3 MB | inside noise floor |
| 9,996 | 12.5 MB | 260.2 MB | 239.0 MB | 21.2 MB (8.1%) |
| 41,650 | 52 MB | 662.8 MB | 512.0 MB | 150.8 MB (22.7%) |

The 1x row sits inside the noise floor of the runtime's binary footprint (about 150 MB). The payoff shows up on the high-investor-count loans, exactly the events that triggered the failures.

## 6. The Go side

Most other consumers in the fleet run on the internal library. They register a handler with `WithConsumeEvent[E]`, and the framework calls `json.Unmarshal(msg.Value, &event)` for them inside its message processor before invoking the handler. The receiver struct `E` is per-consumer.

The cheapest fix on this side is symmetric to the Redpanda Connect strip: delete the unused heavy fields from the receiver struct. `encoding/json` walks past those input keys without allocating because there is no matching struct field. A separate benchmark ran 10,000 dispatches of the 833-investor envelope and reported the deltas:

| | `json.Unmarshal` full struct | `gjson.GetBytes` path reads |
|---|---:|---:|
| Total bytes allocated | 30,595 MB | 3 MB |
| Heap in use after run | 1,656 KB | 616 KB |
| GC cycles during run | 10,403 | 2 |

A second benchmark added a third mode: a raw-bytes handler that receives the message bytes and uses gjson directly. The thin-struct mode saved 99.99% of the allocations. The raw-bytes mode saved 100.00%. Both rest on the same idea the Bloblang byte-strip rests on. The parser does the same tokenizing work in either case, but the choice of receiver decides what becomes a Go object.

## 7. What about the Kafka layer

A reasonable question: if the message is too big, can the Kafka client stream it? The answer is no, and the answer is structural.

Sarama receives a Fetch response from the broker as a binary blob holding one or more record batches. It reads the response into memory, validates the batch CRC, decompresses if needed, and parses out individual records. For each record sarama allocates a `[]byte` and copies the value into it. By the time the handler sees the bytes, the whole message is a contiguous slice in memory. There is no `io.Reader`. Kafka's record format is batch-framed: every record knows its length up front, the batch knows its CRC up front, and you cannot validate a record without reading it whole. Streaming a record byte-by-byte is not how the protocol works. This is true of franz-go and kafka-go as well, not a sarama limitation.

So the 1 MB `[]byte` per fat message is a transport-level cost we pay regardless. The savings live above the transport, at the JSON parse step. That is where the byte-strip and the thin receiver work.

## 8. What we learned

The DOM is the cost, not the bytes. A 1 MB JSON payload becomes a 3 MB Go heap when the struct mirrors the producer one-to-one. The fix is to keep the original `[]byte` (or string, in Bloblang) as the single backing allocation and decide what to materialize.

Byte-level edits are RE2-friendly only with care. A nested `[` defeats `[^\[]*`. A two-pass approach works when the inner nesting is known. The failure mode should be graceful: a no-op replacement is preferable to a malformed substring that breaks the next processor.

Producer-side fixes (drop the field at publish, split the topic, denormalize via change-data-capture) remain real options. They have the best memory math (zero work for any consumer) and the worst delivery math (one cross-team rollout, every consumer rebinds, a quarter on the calendar). We held them in reserve while the consumer-side fix shipped.

Same idea, two runtimes. Stay in bytes for as long as you can. Parse with intent. The same approach extends across the rest of the consumer fleet, and a raw-bytes consume mode on the internal library turns it into a one-line consumer change.
