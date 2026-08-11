import { v } from "convex/values";
import { generateText } from "ai";
import { internal } from "./_generated/api.js";
import { internalMutation, internalQuery } from "./_generated/server.js";
import type { ActionCtx } from "./_generated/server.js";

// ---------------------------------------------------------------------------
// Ensure-English pass for console text.
//
// EverOS Cloud's extraction can drift language: English conversations have
// produced Chinese profile facts, and nothing pins the output language (the
// v2 API has no locale field — cloud-side fix is tracked separately). The
// console is an English product surface, so before memory text is stored for
// display we (1) fast-pass obvious English, (2) run everything else through a
// small translation call. Results are cached by source text, so each string
// costs at most one LLM call ever.
//
// TODO: remove once EverOS Cloud pins extraction language to the input
// language (or grows a locale parameter).
// ---------------------------------------------------------------------------

// Conservative fast-pass: only skip translation when the text is plainly
// English. Anything with non-ASCII letters (Chinese, German umlauts/ß,
// accents, Cyrillic…) goes to the model, and so does pure-Latin text that
// doesn't read as English (German "Der Nutzer nutzt REST-API und Webhooks"
// is ASCII-clean but matches no English function word). False negatives just
// cost one cached LLM round-trip that returns the text unchanged.
const NON_ASCII = /[^\x20-\x7E]/;
const EN_FUNCTION_WORDS =
  /\b(the|is|are|was|were|and|to|of|for|on|with|said|says|has|have|had|by|from|their|they|he|she|his|her|it|its|a|an|that|this|prefers?|uses?|asked|no|not)\b/i;

export function looksEnglish(text: string): boolean {
  // Strip typographic punctuation the extractor likes before the ASCII test.
  const plain = text.replace(/[‘’“”–—…]/g, "");
  if (NON_ASCII.test(plain)) return false;
  return EN_FUNCTION_WORDS.test(plain);
}

export const lookupTranslations = internalQuery({
  args: { sources: v.array(v.string()) },
  returns: v.array(v.union(v.string(), v.null())),
  handler: async (ctx, args) => {
    const out: (string | null)[] = [];
    for (const source of args.sources) {
      const row = await ctx.db
        .query("translations")
        .withIndex("by_source", (q) => q.eq("source", source))
        .unique();
      out.push(row?.translated ?? null);
    }
    return out;
  },
});

export const storeTranslations = internalMutation({
  args: {
    entries: v.array(v.object({ source: v.string(), translated: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    for (const e of args.entries) {
      const existing = await ctx.db
        .query("translations")
        .withIndex("by_source", (q) => q.eq("source", e.source))
        .unique();
      if (!existing) await ctx.db.insert("translations", e);
    }
    return null;
  },
});

/**
 * Return `texts` with every non-English entry translated to English.
 * Order-preserving; fails open (on any error the original text is kept, so a
 * translation hiccup can never blank the console).
 */
export async function ensureEnglish(
  ctx: ActionCtx,
  model: Parameters<typeof generateText>[0]["model"],
  texts: string[],
): Promise<string[]> {
  const out = [...texts];
  const candidates: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim() && !looksEnglish(texts[i])) candidates.push(i);
  }
  if (candidates.length === 0) return out;

  // Cache first — each distinct string is translated at most once, ever.
  const sources = candidates.map((i) => texts[i]);
  const cached: (string | null)[] = await ctx.runQuery(
    internal.translate.lookupTranslations,
    { sources },
  );
  const missIdx: number[] = [];
  for (let c = 0; c < candidates.length; c++) {
    if (cached[c] !== null) out[candidates[c]] = cached[c]!;
    else missIdx.push(c);
  }
  if (missIdx.length === 0) return out;

  const missTexts = missIdx.map((c) => sources[c]);
  try {
    const result = await generateText({
      model,
      prompt:
        "You are a translator. Below is a JSON array of strings. For each " +
        "string: if it is already English, return it unchanged; otherwise " +
        "translate it to natural English, preserving names, numbers, dates " +
        "and technical terms exactly. Reply with ONLY a JSON array of the " +
        "resulting strings, in the same order and of the same length.\n\n" +
        JSON.stringify(missTexts),
    });
    const raw = result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
    const parsed = JSON.parse(raw);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== missTexts.length ||
      !parsed.every((s) => typeof s === "string")
    ) {
      throw new Error("translator returned an unexpected shape");
    }
    const entries: { source: string; translated: string }[] = [];
    for (let m = 0; m < missIdx.length; m++) {
      const c = missIdx[m];
      out[candidates[c]] = parsed[m];
      entries.push({ source: sources[c], translated: parsed[m] });
    }
    await ctx.runMutation(internal.translate.storeTranslations, { entries });
  } catch (e) {
    // Fail open: better an untranslated line than a broken console.
    console.warn(
      `ensureEnglish: translation failed, keeping originals: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  return out;
}
