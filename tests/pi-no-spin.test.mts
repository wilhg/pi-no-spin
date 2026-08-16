import {
  detectRepeatedTail,
  DEFAULT_CONFIG,
} from "../extensions/index.ts";

const cfg = { threshold: 10, minUnit: 4, maxUnit: 300 };

function check(name: string, text: string, expect: boolean) {
  const det = detectRepeatedTail(text, cfg);
  const ok = !!det === expect;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}` +
      (det ? `  -> unit="${det.unit.trim().slice(0, 30)}" period=${det.period} count=${det.repeatCount}` : ""),
  );
  if (!ok) process.exitCode = 1;
}

// --- Should detect loops ---

// User scenario: the same sentence repeated 12 times
const unit = "Please immediately stop repeating this exact sentence.";

// --- Default config regression: threshold must be 6 now ---
function checkDefault(name: string, cfg: unknown, expected: number) {
  const ok = (cfg as { threshold: number }).threshold === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  -> threshold=${(cfg as { threshold: number }).threshold}`);
  if (!ok) process.exitCode = 1;
}
checkDefault("DEFAULT_CONFIG.threshold === 6", DEFAULT_CONFIG, 6);

// The new default (threshold 6) must detect 6 reps but not 5
const cfg6 = { threshold: 6, minUnit: 4, maxUnit: 300 };
{
  const d6 = detectRepeatedTail(unit.repeat(6), cfg6);
  const ok = !!d6 && d6.repeatCount === 6;
  console.log(`${ok ? "PASS" : "FAIL"}  6 reps at default threshold  -> ` + (d6 ? `count=${d6.repeatCount}` : "none"));
  if (!ok) process.exitCode = 1;
}
{
  const d5 = detectRepeatedTail(unit.repeat(5), cfg6);
  const ok = !d5;
  console.log(`${ok ? "PASS" : "FAIL"}  5 reps at default threshold (should NOT fire)`);
  if (!ok) process.exitCode = 1;
}
check("12x repeated Chinese-length sentence", unit.repeat(12), true);

// 300-char segment repeated exactly 10 times
const unit300 = "A".repeat(300);
check("300-char segment x10", unit300.repeat(10), true);

// Segment longer than 300 chars: an internal sub-period will still be found
const unit500 = "X".repeat(500);
check(">300 chars x10 (sub-period still detected)", unit500.repeat(10), true);

// Short 6-char segment repeated 10 times
check("6-char segment x10", "abcdef".repeat(10), true);

// Streaming mid-repeat: 10 full reps + a partial 11th (alignment jitter)
check("10 full reps + partial 11th (alignment jitter)", unit.repeat(10) + unit.slice(0, 3), true);

// Segment containing newlines
check("Segment with newlines x10", "line content\n".repeat(10), true);

// Exactly at the threshold (10)
check("Exactly 10 reps", unit.repeat(10), true);

// 3-char word spammed 20x: sub-period (period 6 = "thethe"x10) is still a real loop
check("3-char word x20 (real loop, should fire)", "the".repeat(20), true);

// --- Should NOT trigger ---

// Normal prose with no repetition
check(
  "Normal long prose",
  "This is a normal assistant reply with several different sentences. The first sentence is one thing. The second sentence is different content. A third sentence continues the thought. Then a fourth, fifth and sixth sentence follow, each distinct and naturally flowing, with no repeated segment anywhere, long enough overall to pass through the detector.",
  false,
);

// Pure whitespace / blank-line repetition (formatting, not a loop)
check("Whitespace/newline repetition only", "\n".repeat(20) + " ".repeat(300) + "  ".repeat(30), false);

// Only 9 reps
check("Only 9 reps", unit.repeat(9), false);

// Text too short
check("Too short", "abc", false);

// Known limitation: whole message arrives at once AND tail has trailing closing
// text. With streaming this never matters — detection fires at the exact
// boundary when the 10th repetition completes.
check("10 reps + trailing text (single-shot arrival, known limitation)", unit.repeat(10) + "bye", false);

console.log("\nconfig used:", JSON.stringify(DEFAULT_CONFIG));

const det = detectRepeatedTail(unit.repeat(12), cfg)!;
console.log(
  "sample detection:",
  JSON.stringify({ period: det.period, repeatCount: det.repeatCount, matchedFrom: det.matchedFrom }, null, 2),
);
