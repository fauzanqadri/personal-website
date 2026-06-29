---
title: "Your first Kafka consumer with Redpanda Connect"
description: "A beginner tutorial: consume messages from a Kafka topic and print each one to stdout, with no code to compile. Just a short YAML file and rpk."
pubDate: 2026-06-28
tags: ["kafka", "redpanda-connect", "tutorial", "bloblang"]
draft: false
---

This tutorial builds a working Kafka consumer without writing or compiling any code. By the end you will have a Redpanda Connect pipeline that reads messages from a Kafka topic and prints each one to the terminal. It assumes no prior Redpanda Connect experience. You need about five minutes and Docker.

## What Redpanda Connect is

Redpanda Connect (formerly Benthos) is a stream processor you configure instead of program. A pipeline has three parts: an `input` that reads data, an optional `pipeline` of processors that transform it, and an `output` that writes it somewhere. You declare all three in a YAML file, and the runtime does the rest. There is no service to build and no dependency to manage.

## Prerequisites

You need two things:

- Docker, running.
- `rpk`, the Redpanda CLI. On macOS: `brew install redpanda-data/tap/redpanda`. Other platforms are covered in the Redpanda install docs.

`rpk` bundles both a local Redpanda broker and Redpanda Connect, so it is the only tool this tutorial uses.

## Step 1: Start a local broker

```bash
rpk container start
```

This starts a single-node Redpanda broker in Docker and points `rpk` at it. The output lists the broker address. For a single node it is usually `127.0.0.1:9092`. Note the address it prints, because you will use it in the config.

## Step 2: Create a topic

```bash
rpk topic create greetings
```

This creates a topic named `greetings` with one partition, which is enough for a consumer demo.

## Step 3: Write the consumer

Create a file named `connect.yaml`:

```yaml
input:
  redpanda:
    seed_brokers: ["localhost:9092"]
    topics: ["greetings"]
    consumer_group: "tutorial-consumer"
    start_offset: earliest

output:
  stdout:
    codec: lines
```

The input needs four settings, plus one on the output:

- `seed_brokers` is where the consumer connects. Use the address from step 1.
- `topics` is the list of topics to read. Here it is just `greetings`.
- `consumer_group` names the group. Redpanda tracks how far this group has read, so a restart resumes instead of starting over.
- `start_offset: earliest` tells a brand-new group to begin at the oldest available message. A group that has already committed an offset resumes from there instead.
- `codec: lines` on the output prints each message on its own line.

## Step 4: Run it

```bash
rpk connect run connect.yaml
```

Redpanda Connect starts, connects to the broker, and waits for messages. The startup log ends with a line saying the input is consuming. Leave this terminal running.

## Step 5: Send a message

Open a second terminal and produce a message:

```bash
echo '{"name":"world"}' | rpk topic produce greetings
```

Switch back to the first terminal. The consumer prints the message:

```
{"name":"world"}
```

That is the full path from producer to terminal: a producer writes to the topic, the consumer reads it, and the `stdout` output prints it. Send a few more messages and watch each one appear.

Stop the consumer with Ctrl+C and run it again. It does not reprint the old message, because the `tutorial-consumer` group already committed past it. To replay from the start, change `consumer_group` to a new name, or reset the group's offsets.

## Optional: Transform before logging

Right now the consumer prints the raw JSON. Add one processor to transform each message before it reaches the output. Put a `pipeline` block between the input and output:

```yaml
input:
  redpanda:
    seed_brokers: ["localhost:9092"]
    topics: ["greetings"]
    consumer_group: "tutorial-consumer-v2"
    start_offset: earliest

pipeline:
  processors:
    - mapping: 'root = "hello " + this.name'

output:
  stdout:
    codec: lines
```

The `mapping` processor runs a Bloblang expression on every message. This one reads the `name` field and replaces the whole message with a greeting. The `consumer_group` is a new name, so the consumer re-reads the topic from the start. Run it again, send `{"name":"world"}` once more, and the output is now:

```
hello world
```

The input reads, the pipeline transforms, the output writes. That is the structure of every Redpanda Connect pipeline, from this one to a production stream.

## Clean up

```bash
rpk container purge
```

This stops and removes the local Redpanda container.

## Where to go next

You changed the behavior of a Kafka consumer twice without compiling anything: once by pointing it at a topic, and once by adding a transform. Swap the `redpanda` input for a file or an HTTP source, or swap the `stdout` output for a database or another topic, and the same three-part structure holds. For deeper Kafka material, see the other posts on this [blog](/blog).
