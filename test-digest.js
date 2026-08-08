/* Local test rig for DIGEST_PROMPT — the Charles commentary.

   Generates the digest TEXT only. It never calls ElevenLabs, so running it
   costs no voice credits; you are testing the words, not the delivery.

   Usage (from the repo root):
     node test-digest.js              one sample
     node test-digest.js --runs 3     three samples, same headlines
     node test-digest.js --local      headlines from a local `wrangler dev`

   The key is read from GEMINI_API_KEY, or from .dev.vars / gemini_key.txt in
   this folder (all three are gitignored — nothing here writes a key to disk).

   The prompt is READ OUT OF src/worker.js at run time, so what you test is
   always exactly what is in the file. There is no second copy to fall behind. */

const fs = require("fs");
const path = require("path");

const WORKER = path.join(__dirname, "src", "worker.js");
const LIVE = "https://eire-daily-dashboard.gav-s-may.workers.dev";
const LOCAL = "http://localhost:8787";

/* ---------- pull constants straight out of the Worker source ----------
   Scans forward from `const NAME =` to the semicolon that ends the statement,
   skipping over any semicolon that sits inside a string literal. That is the
   whole trick: the prompt is a chain of "..." + "..." parts, and a naive
   search for the first ";" would stop inside the text. */
function readConst(src, name) {
  const start = src.indexOf("const " + name + " =");
  if (start === -1) throw new Error("Could not find " + name + " in worker.js");
  let i = src.indexOf("=", start) + 1;
  let quote = null;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === ";") {
      break;
    }
  }
  const expr = src.slice(src.indexOf("=", start) + 1, i);
  return eval("(" + expr + ")"); // local dev script, reading our own source
}

function findKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const devVars = path.join(__dirname, ".dev.vars");
  if (fs.existsSync(devVars)) {
    const m = fs.readFileSync(devVars, "utf8").match(/^\s*GEMINI_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
    if (m) return m[1].trim();
  }
  const keyFile = path.join(__dirname, "gemini_key.txt");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile, "utf8").trim();
  return null;
}

async function getHeadlines(base, count) {
  const res = await fetch(base + "/api/news");
  if (!res.ok) throw new Error("Headlines HTTP " + res.status);
  const data = await res.json();
  const items = data.items || data.stories || data;
  if (!Array.isArray(items)) throw new Error("Unexpected /api/news shape");
  return items.slice(0, count).map((s) => String(s.title || "").trim()).filter(Boolean);
}

async function generate(prompt, schema, model, headlines, key) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";
  const list = headlines.map((t) => "- " + t).join("\n");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt + list }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: schema },
    }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error("Gemini HTTP " + res.status + (t ? ": " + t.slice(0, 300) : ""));
  }

  const body = await res.json();
  const raw =
    ((((body.candidates || [])[0] || {}).content || {}).parts || [])
      .map((p) => p.text || "")
      .join("") || "";
  if (!raw) throw new Error("Gemini returned no text (finishReason: " +
    (((body.candidates || [])[0] || {}).finishReason || "unknown") + ")");
  return JSON.parse(raw);
}

const words = (s) => (String(s).trim().match(/\S+/g) || []).length;
const sentences = (s) => (String(s).match(/[.!?]+(\s|$)/g) || []).length;

/* The checks mirror the prompt's own numbers. A FAIL is not automatically bad —
   Gemini drifts a word or two — but several FAILs in a row means the prompt is
   not holding, which is the thing you actually want to know before deploying. */
function check(label, ok, detail) {
  console.log((ok ? "  PASS  " : "  FAIL  ") + label + (detail ? " — " + detail : ""));
  return ok;
}

function review(out) {
  const opening = String(out.opening || "");
  const take = String(out.take || "");
  const both = opening + " " + take;
  let fails = 0;
  const t = (label, ok, detail) => { if (!check(label, ok, detail)) fails++; };

  console.log("\n  --- checks ---");
  t("opening is 8-14 words", words(opening) >= 8 && words(opening) <= 14, words(opening) + " words");
  t("opening begins with Gav", /^gav\b/i.test(opening.trim()), JSON.stringify(opening.trim().slice(0, 20)));
  t("take is 90-120 words", words(take) >= 90 && words(take) <= 120, words(take) + " words");
  t("take is 4-5 sentences", sentences(take) >= 4 && sentences(take) <= 5, sentences(take) + " sentences");
  t("at most one ellipsis", (take.match(/\.\.\.|…/g) || []).length <= 1,
    (take.match(/\.\.\.|…/g) || []).length + " found");
  t("no stage directions", !/\[[^\]]*\]|\*[^*]*\*|\([^)]*\)/.test(both),
    (both.match(/\[[^\]]*\]|\*[^*]*\*|\([^)]*\)/g) || []).join(" ") || "clean");
  t("no quotation marks", !/["“”]/.test(both), "");
  t("no digits (numbers should be words)", !/\d/.test(both),
    (both.match(/\d+/g) || []).join(" ") || "clean");
  return fails;
}

async function main() {
  const args = process.argv.slice(2);
  const runs = Math.max(1, Number((args[args.indexOf("--runs") + 1]) || 1) || 1);
  const base = args.includes("--local") ? LOCAL : LIVE;

  const key = findKey();
  if (!key) {
    console.error(
      "No Gemini key found.\n" +
        "Set one for this terminal only:  $env:GEMINI_API_KEY = \"your-key\"\n" +
        "or put it in .dev.vars as:       GEMINI_API_KEY=\"your-key\"\n" +
        "(both are gitignored)"
    );
    process.exit(1);
  }

  const src = fs.readFileSync(WORKER, "utf8");
  const prompt = readConst(src, "DIGEST_PROMPT");
  const schema = readConst(src, "DIGEST_SCHEMA");
  const model = readConst(src, "MOOD_MODEL");
  const storyCount = readConst(src, "DIGEST_STORY_COUNT");

  console.log("Model: " + model + "   Prompt: " + prompt.length + " chars   Source: " + base);
  const headlines = await getHeadlines(base, storyCount);
  console.log("\nHeadlines sent (" + headlines.length + "):");
  headlines.forEach((h) => console.log("  - " + h));

  let totalFails = 0;
  for (let i = 1; i <= runs; i++) {
    console.log("\n" + "=".repeat(70) + "\nRUN " + i + " of " + runs + "\n" + "=".repeat(70));
    try {
      const out = await generate(prompt, schema, model, headlines, key);
      console.log("\nOPENING:\n  " + out.opening);
      console.log("\nTAKE:\n  " + String(out.take).replace(/(.{1,90})(\s|$)/g, "$1\n  ").trim());
      totalFails += review(out);
    } catch (e) {
      console.log("\n  ERROR: " + e.message);
      totalFails++;
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log(totalFails === 0
    ? "All checks passed across " + runs + " run(s)."
    : totalFails + " check(s) failed across " + runs + " run(s).");
}

main().catch((e) => {
  console.error("Fatal: " + e.message);
  process.exit(1);
});
