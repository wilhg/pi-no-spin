# pi-no-spin

A [pi](https://pi.dev) extension that detects when the LLM **spins** — repeating the same string over and over — **interrupts the generation**, and **reminds the model to stop** — so you don't burn tokens while the model churns out the same segment on repeat.

> **Why it exists:** open-source / self-hosted models (DeepSeek, Qwen, Llama, GLM, …) have a non-negligible chance of falling into **output loops** — repeating the same sentence, code block, or token sequence continuously without making progress (`deepseek-reasoner` and quantized local models are especially prone). pi-no-spin cuts these off in real time.

## How it works

1. **Listen** — the extension hooks into pi's `message_update` event, which fires token-by-token while the assistant streams a response.
2. **Detect** — it accumulates the text and runs a **periodicity check** on the tail: if the last `period × threshold` characters satisfy `text[i] === text[i + period]` for all `i` (a periodic run), a repeated segment of length `period` has been output at least `threshold` times in a row. Period is scanned from `minUnit` (default 4) up to `maxUnit` (default 300) characters.
   - Period detection is used instead of block-aligned matching, so it still fires while the model is mid-way through streaming the next repeat (a partial segment) — no false negatives due to alignment jitter.
   - Pure-whitespace repetition (indentation / blank lines) is not treated as a loop.
3. **Interrupt** — on detection the extension calls `ctx.abort()` to stop generation immediately, shows a ⛔ notification, then queues a follow-up user message telling the model it is stuck in a loop and should re-assess instead of repeating.

## Install

```bash
pi install git:github.com/wilhg/pi-no-spin
```

or with SSH shorthand:

```bash
pi install git:git@github.com:wilhg/pi-no-spin.git
```

Then reload in a running pi session:

```
/reload
```

### Try without installing

```bash
pi -e git:github.com/wilhg/pi-no-spin
```

## Usage

Detection is **on by default**. Configure it with the `/nospin` command:

```
/nospin                Show status and current configuration
/nospin on|off         Enable / disable detection
/nospin threshold N    Reps of the same segment that count as a loop (default 10)
/nospin min N          Minimum segment length to consider (default 4)
/nospin max N          Maximum segment length to consider (default 300)
```

Examples:

```
/nospin                    →  pi-no-spin: 🟢 enabled | threshold=10 | minUnit=4 | maxUnit=300 | cooldown=10000ms
/nospin threshold 15       →  require 15 consecutive repeats
/nospin max 500            →  detect segments up to 500 chars
/nospin off                →  disable
```

Configuration is persisted per-session (`pi.appendEntry`) and restored automatically on the next `session_start`.

## Quick verification

Tell the model something like:

> Please repeat the same sentence 20 times in a row.

You should see it interrupted around the 10th repetition — a ⛔ notification appears and the model receives a reminder to stop repeating.

## Options & defaults

| Option            | Default | Meaning                              |
| ----------------- | ------- | ------------------------------------ |
| `threshold`       | 10      | Consecutive reps that count as a loop |
| `minUnit`         | 4       | Minimum segment length (chars)       |
| `maxUnit`         | 300     | Maximum segment length (chars)       |
| `cooldownMs`      | 10000   | Cooldown between triggers (ms)       |
| enabled           | true    | Detection on by default              |

## Known limitations

- **Non-streaming whole-message arrival:** if an entire response arrives at once (non-streaming provider) *and* the tail of that message happens to contain a few non-repeating closing characters, the tail-anchored periodic window can miss the run. In practice this never matters: with streaming, detection fires at the exact moment the 10th repetition completes — before the model gets a chance to emit any closing text.
- **Exact periodicity:** the check requires characters at distance `period` to be *exactly* equal. A model that repeats a segment with slight mutations each time will not trigger (returning the same string byte-for-byte is the common failure mode this targets).
- **Tool-call loops:** repeated identical tool calls are a different loop signature and are not covered (yet).

## Development

```bash
npm test     # runs tests/pi-no-spin.test.mts (Node 22.6+ / 23+, type stripping)
```

`npm test` does not require pi or a model — the detection algorithm is pure and unit-tested.

## License

MIT © wilhg
