/**
 * The chat screen. STAGING ONLY, behind VITE_FLAG_CHAT.
 *
 * THIS IS THE ONE SCREEN THAT NEEDS THE INTERNET, and it is the only one. It
 * is deliberately a separate layer reached from a small button, so nothing
 * about it can affect the offline screens: if the flag is off, or the network
 * is gone, or the Worker is down, the verdict, ESCAPE, SEA MODE, the tide and
 * the text view all behave exactly as they do today.
 *
 * WHAT THE USER IS SHOWN, AND WHY IT IS ARRANGED THIS WAY. The answer comes
 * first because it is what was asked for. The verdict badge sits under it
 * because a verdict is the one thing that must never be buried in prose. The
 * evidence is collapsed but always present: every figure the assistant quotes
 * came from a tool, and the reader can see which tool, from which source, with
 * what timestamp. An assistant that cannot show its working has no business
 * answering a safety question.
 */

const API = "/api/chat";
/** The Worker also caps this; the client trims so the request stays small. */
const MAX_TURNS = 10;

interface Evidence {
  claim: string;
  value: string;
  unit: string;
  source: string;
  timestamp: string;
}

interface Reply {
  answer: string;
  language: string;
  verdict: string | null;
  evidence: Evidence[];
  map_layers?: unknown[];
  fallback?: boolean;
  error?: string;
}

interface Turn {
  role: "user" | "assistant";
  content: string;
}

interface State {
  open: boolean;
  busy: boolean;
  history: Turn[];
  location: { lat?: number; lon?: number; place?: string };
}

const state: State = { open: false, busy: false, history: [], location: {} };

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`missing element #${id}`);
  return node as T;
}

export function chatEnabled(): boolean {
  return import.meta.env.VITE_FLAG_CHAT === "true";
}

export function setChatLocation(location: { lat?: number; lon?: number; place?: string }): void {
  state.location = location;
}

export function isChatOpen(): boolean {
  return state.open;
}

export function openChat(): void {
  state.open = true;
  el("chat").hidden = false;
  document.body.classList.add("body--escape");
  renderOffline();
  el<HTMLInputElement>("chatInput").focus();
}

export function closeChat(): void {
  state.open = false;
  el("chat").hidden = true;
  document.body.classList.remove("body--escape");
}

/**
 * Say plainly that this screen is the one that needs a network.
 *
 * navigator.onLine is a weak signal -- it means "there is an interface", not
 * "there is internet" -- so it is used only to warn early. A request that
 * fails says the same thing again, for real.
 */
function renderOffline(): void {
  const banner = el("chatOffline");
  const offline = navigator.onLine === false;
  banner.hidden = !offline;
  if (offline) {
    banner.textContent =
      "Chat needs internet. Offline safety features still work: the verdict " +
      "on the home screen, ESCAPE, SEA MODE, and Text only.";
  }
  el<HTMLButtonElement>("chatSend").disabled = offline || state.busy;
}

function bubble(role: "user" | "assistant", text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = role === "user" ? "chat__you" : "chat__them";
  p.textContent = text;
  return p;
}

export async function send(): Promise<void> {
  const input = el<HTMLInputElement>("chatInput");
  const text = input.value.trim();
  if (text === "" || state.busy) return;

  const log = el("chatLog");
  state.history.push({ role: "user", content: text });
  log.append(bubble("user", text));
  input.value = "";

  state.busy = true;
  el<HTMLButtonElement>("chatSend").disabled = true;
  const thinking = bubble("assistant", "…");
  log.append(thinking);
  log.scrollTop = log.scrollHeight;

  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.history.slice(-MAX_TURNS),
        location: state.location,
      }),
    });
    const reply = await res.json() as Reply;
    thinking.remove();
    render(reply);
    if (typeof reply.answer === "string" && reply.answer !== "") {
      state.history.push({ role: "assistant", content: reply.answer });
    }
  } catch {
    thinking.remove();
    log.append(bubble("assistant",
      "Could not reach the assistant. It needs internet. The offline screens " +
      "still work: the verdict, ESCAPE, SEA MODE and Text only."));
  } finally {
    state.busy = false;
    renderOffline();
    log.scrollTop = log.scrollHeight;
  }
}

function render(reply: Reply): void {
  const log = el("chatLog");
  log.append(bubble("assistant", reply.answer || "No answer."));

  // The verdict badge. Never inside the prose, never without its number --
  // the Worker sends the whole verdict line, word and figure together, which
  // is the same string the home screen shows.
  if (typeof reply.verdict === "string" && reply.verdict !== "") {
    const badge = document.createElement("p");
    badge.className = "chat__verdict";
    badge.textContent = reply.verdict;
    log.append(badge);
  }

  if (reply.fallback === true) {
    const note = document.createElement("p");
    note.className = "chat__fallback";
    note.textContent =
      "The assistant declined to answer rather than guess. Use the offline screens.";
    log.append(note);
  }

  if (Array.isArray(reply.evidence) && reply.evidence.length > 0) {
    const details = document.createElement("details");
    details.className = "chat__why";
    const summary = document.createElement("summary");
    summary.className = "chat__whysummary";
    summary.textContent = `Why / Evidence (${reply.evidence.length})`;
    details.append(summary);
    for (const e of reply.evidence) {
      const row = document.createElement("p");
      row.className = "chat__evidence";
      const claim = document.createElement("span");
      claim.className = "chat__claim";
      claim.textContent = `${e.claim}: `;
      row.append(claim);
      row.append(document.createTextNode(
        `${e.value}${e.unit ? " " + e.unit : ""} — ${e.source} (${e.timestamp})`));
      details.append(row);
    }
    log.append(details);
  }
}

/** Wire the screen up. Called once, only when the flag is on. */
export function mountChat(): void {
  el("chatSend").addEventListener("click", () => { void send(); });
  el("chatInput").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void send();
  });
  el("chatClose").addEventListener("click", closeChat);
  window.addEventListener("online", renderOffline);
  window.addEventListener("offline", renderOffline);
}
