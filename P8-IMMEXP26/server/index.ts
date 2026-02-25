import { serve } from "bun";
import { appendFileSync } from "fs";
import { join } from "path";

const PORT = 3000;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
const LOG_FILE = join(import.meta.dir, "chat_log.jsonl");

// Append one JSON line to the log file (sync is fine for small writes)
function log(entry: Record<string, unknown>) {
  appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

// ── Ollama relay ────────────────────────────────────────────────
// Unity sends:  { model, prompt, options? }
// Server calls Ollama, returns:  { type:"llm", response }  or  { type:"error", message }

async function queryOllama(body: { model: string; prompt: string; system?: string; options?: Record<string, number> }) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: false }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { response?: string };
  return json.response ?? "";
}

// ── WebSocket server ────────────────────────────────────────────

serve({
  port: PORT,

  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("LLM relay running — connect via WebSocket", { status: 200 });
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
          // NPC profile gets prepended to prompt so Modelfile SYSTEM (META contract) stays intact
          const npcContext = msg.system_prompt ? `[NPC Profile: ${msg.system_prompt}]\n\n` : "";
          const fullPrompt = npcContext + msg.prompt;
          console.log(`[llm] npc=${msg.npc ?? "?"}  model=${msg.model}  prompt=${fullPrompt.substring(0, 120)}…`);
          log({ role: "user", npc: msg.npc, prompt: fullPrompt });
          const response = await queryOllama({
            model: msg.model,
            prompt: fullPrompt,
            options: msg.options,
          });
          log({ role: "assistant", npc: msg.npc, response });
          ws.send(JSON.stringify({ type: "llm", npc: msg.npc ?? "", response }));
        } else {
          // Passthrough / echo for other message types
          ws.send(JSON.stringify({ type: "echo", data: raw.toString() }));
        }
      } catch (e: any) {
        console.error("Error:", e.message);
        ws.send(JSON.stringify({ type: "error", message: e.message }));
      }
    },

    close() {
      console.log("Client disconnected");
    },
  },
});

console.log(`LLM relay running on ws://0.0.0.0:${PORT}  →  ${OLLAMA_URL}`);
console.log(`Logging chat to ${LOG_FILE}`);
