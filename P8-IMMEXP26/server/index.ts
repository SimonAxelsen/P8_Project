import { serve } from "bun";
import { appendFileSync } from "fs";
import { join } from "path";

const PORT = 3000;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_GENERATE = `${OLLAMA_URL}/api/generate`;
const OLLAMA_CHAT = `${OLLAMA_URL}/api/chat`;
const LOG_FILE = join(import.meta.dir, "chat_log.jsonl");

function log(entry: Record<string, unknown>) {
  appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

// ── Types ───────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface NpcInfo {
  name: string;
  systemPrompt: string;
  model: string;
  options?: Record<string, number>;
}

interface Session {
  messages: ChatMessage[];
  npcs: NpcInfo[];
  lastSpeaker: string;
  lastActivity: number;
}

// ── Sessions ────────────────────────────────────────────────────

const sessions = new Map<string, Session>();

setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActivity > 5 * 60_000) {
      sessions.delete(id);
      console.log(`[session] Expired: ${id}`);
    }
  }
}, 60_000);

// ── Ollama helpers ──────────────────────────────────────────────

async function ollamaGenerate(body: { model: string; prompt: string; system?: string; options?: Record<string, number> }) {
  const res = await fetch(OLLAMA_GENERATE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: false }) });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { response?: string }).response ?? "";
}

async function ollamaChat(model: string, messages: ChatMessage[], options?: Record<string, number>) {
  const res = await fetch(OLLAMA_CHAT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, messages, stream: false, options }) });
  if (!res.ok) throw new Error(`Ollama chat ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { message?: { content?: string } }).message?.content ?? "";
}

// ── Heuristic router (no LLM call) ─────────────────────────────

function pickNpc(session: Session): NpcInfo {
  // Simple: alternate. Whoever did NOT speak last goes next.
  if (session.npcs.length < 2) return session.npcs[0];
  return session.npcs.find(n => n.name !== session.lastSpeaker) ?? session.npcs[0];
}

// ── Conversation turn ───────────────────────────────────────────

async function handleTurn(
  sessionId: string,
  playerText: string,
  npcs: NpcInfo[]
): Promise<{ npc: string; response: string }> {
  let session = sessions.get(sessionId);
  if (!session) {
    session = { messages: [], npcs, lastSpeaker: "", lastActivity: Date.now() };
    sessions.set(sessionId, session);
    console.log(`[session] Created: ${sessionId}`);
  }
  session.lastActivity = Date.now();
  session.npcs = npcs; // refresh profiles each turn

  // Append player message
  session.messages.push({ role: "user", content: `Candidate: ${playerText}` });

  // Pick responder
  const chosen = pickNpc(session);

  // Build /api/chat messages: system prompt + history (own lines = assistant, others = user)
  const chatMsgs: ChatMessage[] = [{ role: "system", content: chosen.systemPrompt }];
  for (const m of session.messages) {
    if (m.role === "assistant" && m.content.startsWith(`[${chosen.name}]`)) {
      chatMsgs.push({ role: "assistant", content: m.content.replace(`[${chosen.name}] `, "") });
    } else if (m.role === "assistant") {
      chatMsgs.push({ role: "user", content: m.content });
    } else {
      chatMsgs.push(m);
    }
  }

  console.log(`[turn] session=${sessionId} npc=${chosen.name} msgs=${chatMsgs.length}`);
  log({ type: "turn", session: sessionId, npc: chosen.name, historyLen: chatMsgs.length });

  const response = await ollamaChat(chosen.model, chatMsgs, chosen.options);

  session.messages.push({ role: "assistant", content: `[${chosen.name}] ${response}` });
  session.lastSpeaker = chosen.name;
  log({ role: "assistant", npc: chosen.name, session: sessionId, response });

  return { npc: chosen.name, response };
}

// ── WebSocket server ────────────────────────────────────────────

serve({
  port: PORT,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("LLM relay running — connect via WebSocket");
  },
  websocket: {
    open(ws) {
      console.log("Client connected");
      ws.send(JSON.stringify({ type: "connected" }));
    },
    async message(ws, raw) {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "llm") {
          // Legacy single-shot
          const fullPrompt = (msg.system_prompt ? `[NPC Profile: ${msg.system_prompt}]\n\n` : "") + msg.prompt;
          console.log(`[llm] npc=${msg.npc ?? "?"}  prompt=${fullPrompt.substring(0, 120)}…`);
          log({ role: "user", npc: msg.npc, prompt: fullPrompt });
          const response = await ollamaGenerate({ model: msg.model, prompt: fullPrompt, options: msg.options });
          log({ role: "assistant", npc: msg.npc, response });
          ws.send(JSON.stringify({ type: "llm", npc: msg.npc ?? "", response }));

        } else if (msg.type === "conversation_turn") {
          // Interview turn — server picks NPC + responds in one round trip
          // Unity sends npcs as flat fields (npc0_name, npc0_system, etc.)
          const npcs: NpcInfo[] = [
            { name: msg.npcs.npc0_name, systemPrompt: msg.npcs.npc0_system, model: msg.npcs.npc0_model,
              options: { temperature: msg.npcs.npc0_temp, repeat_penalty: msg.npcs.npc0_repeat } },
            { name: msg.npcs.npc1_name, systemPrompt: msg.npcs.npc1_system, model: msg.npcs.npc1_model,
              options: { temperature: msg.npcs.npc1_temp, repeat_penalty: msg.npcs.npc1_repeat } },
          ];
          const { npc, response } = await handleTurn(msg.session, msg.prompt, npcs);
          ws.send(JSON.stringify({ type: "conversation_turn", session: msg.session, npc, response }));

        } else {
          ws.send(JSON.stringify({ type: "echo", data: raw.toString() }));
        }
      } catch (e: any) {
        console.error("Error:", e.message);
        ws.send(JSON.stringify({ type: "error", message: e.message }));
      }
    },
    close() { console.log("Client disconnected"); },
  },
});

console.log(`LLM relay running on ws://0.0.0.0:${PORT}  →  ${OLLAMA_URL}`);
