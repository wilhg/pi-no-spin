/**
 * pi-no-spin — LLM repetition (spinning) detection extension
 *
 * Monitors the assistant's streaming output and detects when it repeatedly
 * outputs the same string segment over and over (by default: the same segment
 * 10+ consecutive times, with a segment length of 4–300 characters).
 *
 * When spinning is detected the extension:
 *   1. Interrupts the current generation immediately (ctx.abort())
 *   2. Injects a reminder message into the conversation telling the LLM it is
 *      stuck repeating itself and should stop and reassess.
 *
 * Motivation: open-source models (DeepSeek, Qwen, Llama, …) occasionally fall
 * into output loops where they repeat the same string continuously, burning
 * tokens without making progress. pi-no-spin cuts these off early.
 *
 * Usage:
 *   /nospin                Show status and configuration
 *   /nospin on|off         Enable / disable detection
 *   /nospin threshold N    Set the repeat-count threshold (default 10)
 *   /nospin min N          Set the minimum segment length (default 4)
 *   /nospin max N          Set the maximum segment length (default 300)
 *
 * Configuration is persisted to the session file via pi.appendEntry() and is
 * restored automatically on the next session_start.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Detection configuration */
export interface NoSpinConfig {
  /** Whether detection is enabled */
  enabled: boolean;
  /** How many consecutive repetitions of the same segment count as a loop */
  threshold: number;
  /** Minimum segment length to consider (characters) */
  minUnit: number;
  /** Maximum segment length to consider (characters) */
  maxUnit: number;
  /** Cooldown after firing (ms) — prevents repeated triggering */
  cooldownMs: number;
}

export const DEFAULT_CONFIG: NoSpinConfig = {
  enabled: true,
  threshold: 10,
  minUnit: 4,
  maxUnit: 300,
  cooldownMs: 10_000,
};

export interface LoopDetection {
  /** The repeating segment. Taken from the last maxUnit chars of the scan
   *  window (may be the half-segment currently being streamed). */
  unit: string;
  /** The smallest repeat period found (characters) */
  period: number;
  /** The number of consecutive repetitions provable within the tail window (>= threshold) */
  repeatCount: number;
  /** Character offset in the full text where the repeating tail begins */
  matchedFrom: number;
}

/**
 * Detect whether the tail of `text` contains a run of the same segment
 * repeated >= threshold consecutive times.
 *
 * Uses period detection instead of block-aligned matching: we check whether a
 * window of length period*threshold at the end of the text satisfies
 * `tail[i] == tail[i + period]` for every pair (i.e. is p-periodic). This works
 * even while the model is mid-way through streaming the next repeat (a partial
 * segment), so detection does not miss on alignment jitter.
 */
export function detectRepeatedTail(
  text: string,
  cfg: Pick<NoSpinConfig, "threshold" | "minUnit" | "maxUnit">,
): LoopDetection | null {
  const { threshold, minUnit, maxUnit } = cfg;
  if (text.length < minUnit * threshold) return null;

  // Only scan a bounded tail window to keep cost low
  const windowLen = maxUnit * (threshold + 1);
  const tailStart = Math.max(0, text.length - windowLen);
  const tail = text.slice(tailStart);

  for (let p = minUnit; p <= maxUnit; p++) {
    const need = p * threshold;
    if (tail.length < need) continue;

    const unit = tail.slice(-p);
    // Repetition of pure whitespace/newlines is most likely indentation or
    // formatting, not a loop.
    if (!/\S/.test(unit)) continue;

    // p-periodicity check: for the last `need` characters, verify
    // tail[i] === tail[i + p] for every i in range.
    const start = tail.length - need;
    const end = tail.length - p;
    let periodic = true;
    for (let i = start; i < end; i++) {
      if (tail.charCodeAt(i) !== tail.charCodeAt(i + p)) {
        periodic = false;
        break;
      }
    }
    if (!periodic) continue;

    // The periodic window already proves at least `threshold` full repeats;
    // extend backwards to count the exact number.
    let count = threshold;
    let pos = start;
    while (pos - p >= 0 && tail.slice(pos - p, pos) === unit) {
      count++;
      pos -= p;
    }

    return {
      unit,
      period: p,
      repeatCount: count,
      matchedFrom: tailStart + pos,
    };
  }
  return null;
}

/** Extract plain text (including thinking) from an assistant message for accumulation */
export function extractAssistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown[] } | undefined;
  if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return "";
  const parts: string[] = [];
  for (const c of m.content) {
    const part = c as { type?: string; text?: string; thinking?: string };
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      parts.push(part.thinking);
    }
  }
  return parts.join("");
}

const CONFIG_ENTRY = "pinospin-config";

export default function (pi: ExtensionAPI) {
  let cfg: NoSpinConfig = { ...DEFAULT_CONFIG };

  // Session-scoped state
  let currentText = ""; // accumulated text of the current assistant message
  let lastTextLen = 0; // text length at last check (throttling)
  let lastDetect: LoopDetection | null = null; // most recent detection
  let lastFiredAt = 0; // timestamp of the last fired reminder (cooldown)

  // Restore config from the session file
  pi.on("session_start", async (_event, ctx) => {
    currentText = "";
    lastDetect = null;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === CONFIG_ENTRY) {
        const data = entry.data as Partial<NoSpinConfig>;
        cfg = { ...DEFAULT_CONFIG, ...data };
      }
    }
  });

  /** Action on detection: abort + inject a reminder */
  function fire(det: LoopDetection, ctx: { abort(): void; ui: { notify(msg: string, type?: string): void } }) {
    lastFiredAt = Date.now();
    lastDetect = det;
    const preview = det.unit.trim().replace(/\s+/g, " ").slice(0, 60);
    try {
      ctx.ui.notify(
        `🚫 pi-no-spin: spinning detected! Repeated "${preview}…" ${det.repeatCount} times. ` +
          "Generation interrupted, reminder sent.",
        "warning",
      );
    } catch {
      /* no UI available — ignore */
    }

    // Interrupt the current generation
    try {
      ctx.abort();
    } catch {
      /* ignore */
    }

    // Queue a user message that tells the LLM it is stuck in a loop.
    // deliverAs "followUp" is safe: it is delivered once the aborted run ends,
    // then triggers a fresh turn.
    const reminder =
      `[pi-no-spin] You are stuck spinning: you have output the same string ` +
      `${det.repeatCount} consecutive times (segment length ${det.period} chars). ` +
      `Your generation was interrupted.\n` +
      `Please immediately stop producing identical content, re-assess the current task, ` +
      `and continue with a conclusion or the next concrete action instead of repeating ` +
      `anything you have already output.`;
    try {
      pi.sendUserMessage(reminder, { deliverAs: "followUp" });
    } catch {
      /* ignore */
    }
  }

  // A new message starts: reset the accumulator
  pi.on("message_start", (event, _ctx) => {
    const m = event.message as { role?: string };
    if (m.role === "assistant") {
      currentText = extractAssistantText(event.message);
      lastTextLen = currentText.length;
    }
  });

  // Streaming update: accumulate text and run throttled detection
  pi.on("message_update", (event, ctx) => {
    if (!cfg.enabled) return;
    const m = event.message as { role?: string };
    if (m.role !== "assistant") return;

    currentText = extractAssistantText(event.message);
    if (currentText.length - lastTextLen < 40) return; // check every ~40 new chars
    lastTextLen = currentText.length;

    if (Date.now() - lastFiredAt < cfg.cooldownMs) return; // in cooldown

    const det = detectRepeatedTail(currentText, cfg);
    if (det) fire(det, ctx as unknown as { abort(): void; ui: { notify(msg: string, type?: string): void } });
  });

  // Message end: fallback check (non-streaming providers, or streaming misses)
  pi.on("message_end", (event, ctx) => {
    if (!cfg.enabled) return;
    const m = event.message as { role?: string };
    if (m.role !== "assistant") return;
    if (Date.now() - lastFiredAt < cfg.cooldownMs) return;

    const text = extractAssistantText(event.message);
    const det = detectRepeatedTail(text, cfg);
    if (det) fire(det, ctx as unknown as { abort(): void; ui: { notify(msg: string, type?: string): void } });
  });

  // Persist config to the session file
  function persist() {
    pi.appendEntry(CONFIG_ENTRY, { ...cfg });
  }

  // /nospin command: view status / toggle / tune parameters
  pi.registerCommand("nospin", {
    description:
      "Repetition (spinning) detection: view status or configure (on|off|threshold|min|max). e.g. /nospin threshold 15",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const status = () =>
        `pi-no-spin: ${cfg.enabled ? "🟢 enabled" : "⚪ disabled"} | threshold=${cfg.threshold} | ` +
        `minUnit=${cfg.minUnit} | maxUnit=${cfg.maxUnit} | cooldown=${cfg.cooldownMs}ms` +
        (lastDetect ? ` | last: "${lastDetect.unit.trim().slice(0, 40)}…" x${lastDetect.repeatCount}` : "");

      if (parts.length === 0) {
        ctx.ui.notify(status(), "info");
        return;
      }

      const [key, value] = parts;
      switch (key) {
        case "on":
          cfg.enabled = true;
          persist();
          ctx.ui.notify("pi-no-spin: enabled", "success");
          break;
        case "off":
          cfg.enabled = false;
          persist();
          ctx.ui.notify("pi-no-spin: disabled", "info");
          break;
        case "threshold": {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 2) {
            ctx.ui.notify("Usage: /nospin threshold <integer>=2", "warning");
            return;
          }
          cfg.threshold = n;
          persist();
          ctx.ui.notify(status(), "success");
          break;
        }
        case "min":
        case "max": {
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1) {
            ctx.ui.notify(`Usage: /nospin ${key} <integer>=1`, "warning");
            return;
          }
          if (key === "min") {
            cfg.minUnit = Math.min(n, cfg.maxUnit);
          } else {
            cfg.maxUnit = Math.max(n, cfg.minUnit);
          }
          persist();
          ctx.ui.notify(status(), "success");
          break;
        }
        default:
          ctx.ui.notify(status(), "info");
      }
    },
  });
}
