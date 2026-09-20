/**
 * Every tunable for the chat assistant, in one place.
 *
 * Nothing in worker/ hardcodes a model id, a timeout or a limit. When the
 * demo misbehaves the first question is always "what settings was it running
 * with", and the answer has to be one file.
 *
 * THE API KEY IS NOT HERE. It arrives as env.SARVAM_API_KEY from .dev.vars
 * locally and from `wrangler secret put` on staging, and it never appears in
 * this repository, in dist/, or in a log line.
 */

export const SARVAM = {
  /**
   * Confirmed against docs.sarvam.ai, not from memory.
   *
   * /v1 rather than /v2: the v2 endpoint and its open-source models
   * (glm5.2, gemma4, deepseekv4-flash) are beta and gated per API key, and a
   * key without access gets a 400. Not something to discover during a demo.
   */
  chatUrl: "https://api.sarvam.ai/v1/chat/completions",
  translateUrl: "https://api.sarvam.ai/translate",
  lidUrl: "https://api.sarvam.ai/text-lid",

  /** The header Sarvam actually wants. It also accepts a Bearer token. */
  authHeader: "api-subscription-key",

  model: "sarvam-105b",
  translateModel: "mayura:v1",

  /** Deterministic. This answers safety questions; it is not here to be creative. */
  temperature: 0,

  /**
   * Generous on purpose, and both of these numbers were measured rather than
   * guessed.
   *
   * sarvam-105b emits `reasoning_content` BEFORE `content`. A test with
   * max_tokens 16 came back finish_reason "length" and content null, having
   * produced nothing but a half-finished thought.
   *
   * 1024 was not enough either. Reasoning on these prompts measured 400 to
   * 1000 tokens before the answer even starts, so a 1024 budget failed about
   * one turn in four with finish_reason "length" and nothing to show for it --
   * a failure that looks random from outside and is not. 3072 still lost about
   * one turn in nine once a long tool history was in the context. Anything that
   * budgets like an ordinary chat model will look broken at random.
   */
  maxTokens: 4096,

  /** Reasoning costs tokens and latency, and this task is lookup plus phrasing. */
  reasoningEffort: "low" as const,

  /**
   * wiki_grounding is deliberately OFF and must stay off.
   *
   * It improves general factual accuracy by grounding answers in Wikipedia,
   * which is exactly the leak this feature must not have: a number that came
   * from Wikipedia is a number that did not come from our bundle, and the
   * whole contract here is that every figure is traceable to a tool result.
   */
  wikiGrounding: false,

  /**
   * One call. A demo that hangs is worse than a demo that says it failed --
   * but 25 s was too tight: a slow Sarvam response aborted a turn that was
   * otherwise fine, and a turn can legitimately involve three calls.
   */
  requestTimeoutMs: 35000,
  /** The whole turn, tool round trips included. */
  turnTimeoutMs: 70000,
} as const;

/**
 * Languages sarvam-105b speaks natively.
 *
 * This list is why the translate-and-translate-back path is almost never
 * taken. The brief called for detecting the language, translating to English,
 * answering, and translating back -- but Malayalam, Tamil and Hindi are all in
 * here, so for every language this app's users actually speak that round trip
 * would add two API calls, two failure modes, and two chances to mistranslate
 * "DO NOT GO OUT" for no gain. Translation stays as the fallback for anything
 * outside this set.
 */
export const CHAT_LANGUAGES = new Set([
  "en-IN", "hi-IN", "ta-IN", "ml-IN", "bn-IN", "te-IN",
  "kn-IN", "mr-IN", "gu-IN", "pa-IN", "od-IN",
]);

export const DEFAULT_LANGUAGE = "en-IN";

export const LIMITS = {
  /** Turns the client may send. Older context is dropped by the client. */
  maxMessages: 10,
  /** Bytes. A safety chat does not need an essay, and a body limit is a cheap DoS guard. */
  maxBodyBytes: 16 * 1024,
  /** Characters of a single user message passed on to Sarvam. */
  maxMessageChars: 1000,
  /** Tool round trips before the Worker stops and answers with what it has. */
  maxToolRounds: 4,
  /** Retries when the model returns something that is not valid JSON. */
  jsonRetries: 1,
} as const;

/**
 * Per-IP rate limiting, in-memory.
 *
 * Worker isolates are per-colo and short-lived, so this is a speed bump rather
 * than a guarantee -- it stops one script hammering one colo, not a
 * distributed flood. Staging behind a flag does not warrant a Durable Object,
 * and saying what it is beats pretending it is more.
 */
export const RATE = {
  windowMs: 60_000,
  maxRequests: 12,
} as const;

/**
 * Origins allowed to call /api/*.
 *
 * The app is served from the same Worker, so in practice this is the staging
 * host plus local dev. Anything else gets no CORS headers and the browser
 * refuses the response.
 */
export const ALLOWED_ORIGINS = [
  // Staging: the Worker this feature actually runs on.
  "https://orcamarina-staging.office-11b.workers.dev",
  // The live demo, which serves the same app with the chat flag off.
  "https://orcamarinasih.office-11b.workers.dev",
  "http://localhost:5173",
  "http://localhost:4173",
  "http://localhost:8787",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8787",
];

/** The region whose bundle data the tools read. One region for staging. */
export const REGION_ID = "kerala-tn";
