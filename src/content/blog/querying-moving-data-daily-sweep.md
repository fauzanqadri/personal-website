---
title: "Querying moving data: keyset pagination for a daily sweep"
description: "A daily job re-evaluated 1.87 million rows and silently skipped some, because it paginated with OFFSET on a column it was updating mid-scan. Keyset pagination fixed it."
pubDate: 2026-06-26
tags: ["postgres", "sql", "pagination", "go", "data"]
draft: false
---

A daily job re-evaluated every open case in the book. One morning we noticed some cases had not been evaluated in days, even though the job reported success every night. The job was not crashing. It was skipping rows, quietly, and the cause was the way it paginated.

## The setup

The job walks a large table. Each row is a case that needs re-evaluation once per day. At the time, the table held about 1.87 million open cases, and the job had a four-hour window to process all of them.

To page through that many rows, it used the obvious approach:

```sql
SELECT id, ...
FROM cases
WHERE state = 'OPEN'
  AND (last_evaluated_at IS NULL OR last_evaluated_at < :today)
ORDER BY last_evaluated_at ASC NULLS FIRST
LIMIT 100 OFFSET :offset;
```

It read 100 rows, processed them, advanced the offset by 100, and repeated. Each processed case had its `last_evaluated_at` set to now as part of evaluation. That last detail is the whole problem.

## Why OFFSET breaks on moving data

`OFFSET n` does not remember which rows you have already seen. It re-runs the query, orders the full result set, counts off n rows from the front, and discards them. It trusts that the row at position n on this query is the same row that was at position n on the previous query.

That trust holds only if the ordering is stable between pages. Here it is not. The job orders by `last_evaluated_at` and updates `last_evaluated_at` on every row it processes. Each processed row gets a fresh timestamp of now, later than every un-processed row's value, so a row the job just handled does not keep its place near the front. It jumps to the back of the order.

Walk one cycle. The job reads offset 0 to 99, the hundred rows with the oldest `last_evaluated_at`. It processes them, and all hundred now carry a timestamp of now, which sorts them to the end of the result set. Those hundred rows leave the front. The rows that were at positions 100 to 199 slide forward into positions 0 to 99. Then the job asks for offset 100. It steps over the hundred rows that just slid into the 0-to-99 range and never reads them. They stay un-evaluated until some later day when the shifting happens to line up. On a 1.87 million row table, that later day can be weeks away.

The query was correct in isolation. It was wrong as a sequence, because the sort key moved under the scan.

## OFFSET has a second problem

Even without the moving-key bug, `OFFSET` on a large table is slow. The database cannot jump to row 50,000. It has to produce and discard the first 50,000 rows to reach the next 100. Page one is cheap, page five hundred is not, and the cost grows with every page. A four-hour window spent re-scanning the same prefix again and again is a window you can blow through.

## The fix: keyset pagination

Keyset pagination, also called seek pagination, does not count rows from the front. It remembers the last row it saw and asks for rows after that one, by value.

```sql
SELECT id, last_evaluated_at, ...
FROM cases
WHERE state = 'OPEN'
  AND (last_evaluated_at IS NULL OR last_evaluated_at < :today)
  AND (last_evaluated_at, id) > (:last_seen_at, :last_seen_id)
ORDER BY last_evaluated_at ASC, id ASC
LIMIT 100;
```

Each page carries forward the `(last_evaluated_at, id)` of its final row. The next page starts strictly after that value. There is no offset to drift. A row whose timestamp jumps to the back of the order does not pull an un-scanned row over a boundary, because the boundary is a value the scan has already passed, not a count it has to recompute.

This also fixes the speed problem. With an index on `(last_evaluated_at, id)`, the database seeks straight to the boundary value and reads the next 100 rows. Every page costs the same. There is no growing prefix to discard.

## Why the tiebreaker is not optional

The composite key matters. `last_evaluated_at` alone is not unique. Many rows can share a timestamp, and the un-evaluated rows all start at NULL. If you seek on the timestamp alone, two rows with the same value sit on the boundary with no defined order between them, and the `>` comparison can either skip one or read it twice.

Adding `id`, a unique column, gives a total order. `(last_evaluated_at, id)` is distinct for every row, so "the row after this one" is never ambiguous. The tiebreaker is what turns "roughly in order" into "exactly once".

## Exactly once per run

The point of all this is a guarantee: every eligible case is evaluated exactly once per daily run, even though the job mutates the column it sorts on while it scans.

Keyset pagination gives the once. A re-run safety net gives the rest. Each evaluation bumps a `version` column and stamps `last_evaluated_at` to now, so the eligibility predicate (`last_evaluated_at < today`) excludes a case that was already handled this cycle. If the job restarts mid-run, it resumes from cases that still match the predicate and passes over the ones it already touched today. The work is idempotent within a calendar day by construction.

## The lesson

If you paginate with `OFFSET`, you are assuming the rows hold still between pages. Any concurrent writer that changes a row's position breaks that assumption, and the breakage is silent: no error, no crash, just rows that quietly never get read. It is worst when the job paginating the table is the same job writing to the sort key, because then the disturbance is guaranteed, not occasional.

Keyset pagination removes the assumption. It anchors each page to a value the scan has already passed, on a key with a unique tiebreaker, and reads forward from there. You get correctness over a moving dataset and constant per-page cost in the same change.
