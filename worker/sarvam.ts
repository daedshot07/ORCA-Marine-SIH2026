/**
 * The Sarvam client. Three endpoints, all confirmed against docs.sarvam.ai.
 *
 * THE KEY ONLY EXISTS HERE, AS A FUNCTION ARGUMENT. It comes from
 * env.SARVAM_API_KEY, is used to set one header, and is never logged, never
 * returned, and never put in an error message. Every throw below reports a
 * status code and nothing else.
 */

import { SARVAM } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatChoice {
  finish_reason: string;
  message: {
    role: string;
    content: string | null;
    /** sarvam-105b thinks before it answers; this is that, and it is not the answer. */
    reasoning_content?: string | null;
    tool_calls?: ToolCall[] | null;
  };
}

async function post(
  url: string, key: string, body: unknown, timeoutMs: number,
): Promise<unknown> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        [SARVAM.authHeader]: key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok) {
      // The status, and nothing from the request. A 403 here means the key is
      // missing or wrong; saying so is useful, echoing the key is not.
      throw new Error(`sarvam ${new URL(url).pathname}: HTTP ${res.status}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(
  key: string,
  messages: ChatMessage[],
  tools?: readonly unknown[],
): Promise<ChatChoice> {
  const body: Record<string, unknown> = {
    model: SARVAM.model,
    messages,
    temperature: SARVAM.temperature,
    max_tokens: SARVAM.maxTokens,
    reasoning_effort: SARVAM.reasoningEffort,
  };
  if (tools !== undefined && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  // wiki_grounding is deliberately never set. See the note in config.ts.
  const raw = await post(SARVAM.chatUrl, key, body, SARVAM.requestTimeoutMs) as {
    choices?: ChatChoice[];
  };
  const choice = raw.choices?.[0];
  if (choice === undefined) throw new Error("sarvam chat: no choices in response");
  return choice;
}

/** Detect the language of a piece of text. Returns a BCP-47 code. */
export async function identifyLanguage(key: string, input: string): Promise<string | null> {
  try {
    const raw = await post(
      SARVAM.lidUrl, key, { input: input.slice(0, 1000) }, SARVAM.requestTimeoutMs,
    ) as { language_code?: string };
    return raw.language_code ?? null;
  } catch {
    // Detection is a nicety. The script check in chat.ts has already made a
    // decision, and a failed LID must not cost the user their answer.
    return null;
  }
}

export async function translate(
  key: string, input: string, from: string, to: string,
): Promise<string> {
  const raw = await post(SARVAM.translateUrl, key, {
    input: input.slice(0, 1000),
    source_language_code: from,
    target_language_code: to,
    model: SARVAM.translateModel,
  }, SARVAM.requestTimeoutMs) as { translated_text?: string };
  return raw.translated_text ?? input;
}

/**
 * Which language a piece of text is in, by script, before any API call.
 *
 * A Unicode range test is free, instant, offline, and correct for exactly the
 * case that matters here: the three scripts this app's users write in are
 * mutually exclusive and unmistakable. Sarvam's LID is the fallback for Latin
 * script, where the script alone cannot tell English from romanised Tamil.
 */
export function scriptLanguage(text: string): string | null {
  if (/[ഀ-ൿ]/.test(text)) return "ml-IN"; // Malayalam
  if (/[஀-௿]/.test(text)) return "ta-IN"; // Tamil
  if (/[ऀ-ॿ]/.test(text)) return "hi-IN"; // Devanagari
  if (/[ঀ-৿]/.test(text)) return "bn-IN"; // Bengali
  if (/[ఀ-౿]/.test(text)) return "te-IN"; // Telugu
  if (/[ಀ-೿]/.test(text)) return "kn-IN"; // Kannada
  if (/[઀-૿]/.test(text)) return "gu-IN"; // Gujarati
  if (/[਀-੿]/.test(text)) return "pa-IN"; // Gurmukhi
  if (/[଀-୿]/.test(text)) return "od-IN"; // Odia
  return null;
}
