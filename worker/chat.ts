/**
 * One turn of conversation.
 *
 * The shape of this is deliberate and it is the whole safety argument:
 *
 *   1. The Worker decides the language.
 *   2. The MODEL decides which tools to call.
 *   3. The WORKER runs them, against our own bundle.
 *   4. The WORKER builds the evidence list from what those tools returned.
 *   5. The model writes prose, and that prose is CHECKED against the tool
 *      results before it is allowed out.
 *
 * The model never supplies a number that reaches the client. It cannot: the
 * evidence array is assembled in step 4 from tool output, and step 5 rejects
 * an answer containing a figure that no tool produced. A model that invents a
 * wave height gets its answer thrown away and retried, and if it does it twice
 * the user gets a safe fallback instead.
 */

import { CHAT_LANGUAGES, DEFAULT_LANGUAGE, LIMITS, SARVAM } from "./config.ts";
import {
  chat, identifyLanguage, scriptLanguage, translate,
  type ChatChoice, type ChatMessage, type ToolCall,
} from "./sarvam.ts";
import { TOOL_SCHEMAS, loadData, runTool, type Env, type Evidence } from "./tools.ts";

export interface ChatReply {
  answer: string;
  language: string;
  verdict: string | null;
  evidence: Evidence[];
  map_layers?: unknown[];
  /** True when the answer is the canned fallback rather than the model's. */
  fallback?: boolean;
}

const SYSTEM = `You are ORCA, a coastal safety assistant for fishermen on the Kerala and Tamil Nadu coast.

RULES YOU MUST FOLLOW:
1. You may ONLY state facts and numbers that came back from a tool call in this conversation. Never estimate, never round from memory, never fill a gap with general knowledge about the sea or the weather.
2. If a tool says data is missing, stale, or that the place is not covered, say exactly that. Do not soften it and do not substitute a nearby place without saying you did.
3. Always call a tool before answering a question about safety, tides, shelters or boundaries. If the user asks about a place, pass it to the tool.
4. Quote the data age when a tool gives you one. If a tool says the data is stale, say so in your first sentence.
5. Boundaries are advisory open data and carry no legal authority. Never tell anyone they are legally clear of a maritime boundary.
6. Tides are astronomical only; storm surge adds on top. Tide heights are not depths.
7. Keep answers short. Three sentences is usually enough. You are read on a phone, at sea, possibly in a hurry.
8. Answer in the same language the user wrote in.`;

const FALLBACKS: Record<string, string> = {
  "en-IN": "I could not answer that safely just now. Use the offline screens: the verdict on the home screen, ESCAPE for shelter on land, SEA MODE to return to harbour.",
  "ta-IN": "இப்போது பாதுகாப்பாக பதிலளிக்க முடியவில்லை. ஆஃப்லைன் திரைகளைப் பயன்படுத்துங்கள்: முகப்புத் திரையில் உள்ள தீர்ப்பு, நிலத்தில் தங்க ESCAPE, துறைமுகம் திரும்ப SEA MODE.",
  "hi-IN": "अभी सुरक्षित उत्तर नहीं दे सका। ऑफ़लाइन स्क्रीन का उपयोग करें: होम स्क्रीन का फैसला, ज़मीन पर शरण के लिए ESCAPE, बंदरगाह लौटने के लिए SEA MODE.",
  "ml-IN": "ഇപ്പോൾ സുരക്ഷിതമായി ഉത്തരം നൽകാനായില്ല. ഓഫ്‌ലൈൻ സ്ക്രീനുകൾ ഉപയോഗിക്കുക: ഹോം സ്ക്രീനിലെ വിധി, കരയിൽ അഭയത്തിന് ESCAPE, തുറമുഖത്തേക്ക് മടങ്ങാൻ SEA MODE.",
};

/**
 * Every number a set of tool results actually produced.
 *
 * Used to check the model's prose. Digits are pulled out of the JSON rather
 * than parsed semantically, because the question is only "did this figure come
 * from somewhere real", and a string match answers it without needing to know
 * which field meant what.
 */
function numbersIn(value: unknown, into = new Set<string>()): Set<string> {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  for (const m of text.matchAll(/\d+(?:\.\d+)?/g)) {
    into.add(m[0]);
    // 27.2 should also vouch for "27", since prose rounds.
    if (m[0].includes(".")) into.add(m[0].split(".")[0]!);
  }
  return into;
}

/**
 * Is every figure in the answer backed by a tool result?
 *
 * Times of day, years and one- or two-digit numbers are let through: "three
 * sentences", "channel 16" and "2 km" inside a quoted tool string all produce
 * noise, and the figures that matter here -- probabilities, distances, heights,
 * hours -- are the ones that appear verbatim in the tool output.
 */
function ungrounded(answer: string, allowed: Set<string>): string[] {
  const bad: string[] = [];
  for (const m of answer.matchAll(/\d+(?:\.\d+)?/g)) {
    const n = m[0];
    if (allowed.has(n)) continue;
    // Small integers are almost always list positions or "channel 16".
    if (!n.includes(".") && n.length <= 2) continue;
    bad.push(n);
  }
  return bad;
}

interface Incoming {
  messages?: Array<{ role: string; content: string }>;
  location?: { lat?: number; lon?: number; place?: string };
  lang_hint?: string;
}

export async function handleChat(env: Env, body: unknown): Promise<ChatReply> {
  const key = env.SARVAM_API_KEY!;
  const input = body as Incoming;
  const turns = (input.messages ?? []).slice(-LIMITS.maxMessages);
  const last = [...turns].reverse().find((m) => m.role === "user");
  const question = (last?.content ?? "").slice(0, LIMITS.maxMessageChars).trim();

  if (question === "") {
    return {
      answer: FALLBACKS[DEFAULT_LANGUAGE]!,
      language: DEFAULT_LANGUAGE,
      verdict: null, evidence: [], fallback: true,
    };
  }

  // --- 1. what language is this? -----------------------------------------
  //
  // Script first because it is free and certain for the scripts that matter.
  // LID only for Latin text, where script cannot separate English from
  // romanised Tamil. A hint from the client is a hint, not an override.
  let language = scriptLanguage(question)
    ?? (await identifyLanguage(key, question))
    ?? (input.lang_hint && CHAT_LANGUAGES.has(input.lang_hint) ? input.lang_hint : null)
    ?? DEFAULT_LANGUAGE;
  if (!CHAT_LANGUAGES.has(language)) language = DEFAULT_LANGUAGE;

  // --- 2. translate in, only if we have to --------------------------------
  //
  // For Malayalam, Tamil and Hindi this never runs: sarvam-105b speaks them.
  // The round trip exists for a language outside the model's eleven, where
  // the choice is between a translated answer and none.
  const detected = scriptLanguage(question) ?? language;
  const needsTranslation = !CHAT_LANGUAGES.has(detected);
  const asked = needsTranslation
    ? await translate(key, question, "auto", "en-IN")
    : question;

  // --- 3. let the model pick tools, run them here -------------------------
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM },
    ...turns.slice(0, -1).map((m) => ({
      role: (m.role === "assistant" ? "assistant" : "user") as "assistant" | "user",
      content: String(m.content).slice(0, LIMITS.maxMessageChars),
    })),
    {
      role: "user",
      content: input.location?.lat !== undefined && input.location?.lon !== undefined
        ? `${asked}\n\n(The user is at ${input.location.lat}, ${input.location.lon}.)`
        : input.location?.place !== undefined
          ? `${asked}\n\n(The user is at ${input.location.place}.)`
          : asked,
    },
  ];

  const evidence: Evidence[] = [];
  const mapLayers: unknown[] = [];
  const grounded = new Set<string>();
  let verdict: string | null = null;
  const startedAt = Date.now();

  /**
   * Run whatever tools the model asked for, until it stops asking.
   *
   * A function rather than a loop in line, because the RETRY has to be able to
   * do this too. A nudge like "answer now using the tool results" is itself a
   * turn the model may respond to with another tool call, and the first
   * version treated that as an empty answer and fell back -- a real failure in
   * testing, on a Hindi follow-up, where the model was doing exactly the right
   * thing and being punished for it.
   */
  async function drainTools(start: ChatChoice): Promise<ChatChoice> {
    let current = start;
    for (let round = 0; round < LIMITS.maxToolRounds; round++) {
      const calls = current.message.tool_calls;
      if (current.finish_reason !== "tool_calls" || !calls || calls.length === 0) break;
      if (Date.now() - startedAt > SARVAM.turnTimeoutMs) break;
      await runCalls(calls);
      current = await chat(key, messages, TOOL_SCHEMAS);
    }
    return current;
  }

  async function runCalls(calls: ToolCall[]): Promise<void> {

    messages.push({
      role: "assistant",
      content: "",
      tool_calls: calls,
    });

    for (const call of calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      // A tool call with no place falls back to the client's own location,
      // which is the thing the user meant by "near me".
      if (args.place === undefined && args.lat === undefined) {
        if (input.location?.lat !== undefined) {
          args.lat = input.location.lat;
          args.lon = input.location.lon;
        } else if (input.location?.place !== undefined) {
          args.place = input.location.place;
        }
      }

      const result = await runTool(env, call.function.name, args, Date.now());
      evidence.push(...result.evidence);
      numbersIn(result.forModel, grounded);
      for (const e of result.evidence) numbersIn(e.value, grounded);
      if (result.mapLayers) mapLayers.push(...result.mapLayers);
      const v = (result.forModel as { verdict?: string }).verdict;
      if (typeof v === "string") verdict = v;

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result.forModel),
      });
    }
  }

  let choice = await drainTools(await chat(key, messages, TOOL_SCHEMAS));

  // --- 4. check the prose against the tool results ------------------------
  let answer = (choice.message.content ?? "").trim();
  let bad = ungrounded(answer, grounded);

  for (let retry = 0; retry < LIMITS.jsonRetries && (answer === "" || bad.length > 0); retry++) {
    messages.push({
      role: "user",
      content: answer === ""
        ? "Give the answer now, in plain sentences, using only the tool results above."
        : `These figures are not in any tool result: ${bad.join(", ")}. ` +
          `Rewrite the answer using ONLY numbers that appear in the tool results, ` +
          `or drop the number entirely.`,
    });
    // TOOLS MUST STAY ON THE RETRY. Sarvam rejects a request whose history
    // contains tool messages when `tools` is absent:
    //   "Tool messages found but no tools provided."
    // Dropping them here returned HTTP 400 on a third of the turns that had
    // used a tool, which surfaced as a 502 and looked like the model failing.
    choice = await drainTools(await chat(key, messages, TOOL_SCHEMAS));
    answer = (choice.message.content ?? "").trim();
    bad = ungrounded(answer, grounded);
  }

  if (answer === "" || bad.length > 0) {
    // Two tries and it still quoted a number nobody computed, or said nothing
    // at all. Both are the case this feature must not ship past the user.
    //
    // finish_reason is logged because the two failures look identical from
    // outside and are not: "length" means the token budget went on reasoning
    // and the answer never started, while "stop" with empty content means the
    // model genuinely had nothing to say.
    console.error(
      "[chat] refusing model output.",
      "finish_reason=", choice.finish_reason,
      "empty=", answer === "",
      "ungrounded=", bad.join(",") || "none",
      "tools_run=", String(evidence.length),
    );
    return {
      answer: FALLBACKS[language] ?? FALLBACKS[DEFAULT_LANGUAGE]!,
      language, verdict, evidence, fallback: true,
      ...(mapLayers.length > 0 ? { map_layers: mapLayers } : {}),
    };
  }

  // --- 5. translate back, only if we had to translate in ------------------
  if (needsTranslation) {
    answer = await translate(key, answer, "en-IN", detected);
    language = detected;
  }

  return {
    answer, language, verdict, evidence,
    ...(mapLayers.length > 0 ? { map_layers: mapLayers } : {}),
  };
}

/** Exposed so a test can confirm the data loads without a Sarvam key. */
export { loadData };
