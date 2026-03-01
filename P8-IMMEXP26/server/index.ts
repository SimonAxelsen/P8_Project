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



// ── Backchannel  trigger logic 
type NpcKey = "HR" | "TECH";

type BcFeaturesMsg = {
  type: "bc_features";
  t?: number;
  vad: 0 | 1;
  pauseMs: number;
  speechMs: number;
  addressee?: "HR" | "TECH" | "UNKNOWN";
  agentsSpeaking?: { HR?: boolean; TECH?: boolean };
};

type BcTriggerMsg = {
  type: "bc_trigger";
  npc: NpcKey;
  action: string; // animator trigger name
};

type BcState = {
  lastGlobalTs: number;
  lastPerNpcTs: Record<NpcKey, number>;
};

// --- Changable things for the mic(amount of times a BC can be triggered etc. ALL IN MS) ---
const BC_MICROPAUSE_MIN = 250;
const BC_MICROPAUSE_MAX = 700;
const BC_EOT_THRESHOLD = 1000;      // treat > this as end-of-turn 
const BC_GLOBAL_COOLDOWN = 2500;    
const BC_NPC_COOLDOWN = 5000;       

function nowMs() {
  return Date.now();
}

function chooseNpc(
  st: BcState,
  addressee: "HR" | "TECH" | "UNKNOWN",
  speaking?: { HR?: boolean; TECH?: boolean }
): NpcKey | null {
  const canUse = (npc: NpcKey) => !(speaking?.[npc] ?? false);

  // NPC addressee gets priority or least recently triggered NPC 
  if (addressee === "HR" && canUse("HR")) return "HR";
  if (addressee === "TECH" && canUse("TECH")) return "TECH";

  const a: NpcKey = "HR";
  const b: NpcKey = "TECH";
  if (!canUse(a) && !canUse(b)) return null;
  if (!canUse(a)) return b;
  if (!canUse(b)) return a;

  return st.lastPerNpcTs[a] <= st.lastPerNpcTs[b] ? a : b;
}

function shouldTriggerBc(st: BcState, msg: BcFeaturesMsg): BcTriggerMsg | null {
  const t = nowMs();

  if (msg.vad !== 1) return null;
  if (msg.pauseMs < BC_MICROPAUSE_MIN || msg.pauseMs > BC_MICROPAUSE_MAX) return null;
  if (msg.pauseMs >= BC_EOT_THRESHOLD) return null;

  if (t - st.lastGlobalTs < BC_GLOBAL_COOLDOWN) return null;

  const addressee = msg.addressee ?? "UNKNOWN";
  const npc = chooseNpc(st, addressee, msg.agentsSpeaking);
  if (!npc) return null;

  if (t - st.lastPerNpcTs[npc] < BC_NPC_COOLDOWN) return null;

  // Testing for 1 action atm
  const action = "NodSmall";

  st.lastGlobalTs = t;
  st.lastPerNpcTs[npc] = t;

  return { type: "bc_trigger", npc, action };
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
      //Initialize backchannel. 
    (ws as any).data = (ws as any).data ?? {};
    (ws as any).data.bc = {
    lastGlobalTs: 0,
    lastPerNpcTs: { HR: 0, TECH: 0 },
    } satisfies BcState;

      ws.send(JSON.stringify({ type: "connected" }));
    },

    async message(ws, raw) {
      try {
        const msg = JSON.parse(raw.toString());
        console.log("[ws] type:", msg.type, "npc:", msg.npc);

                   //Checks for BC  features / piggyback of features and triggers.
        if (msg.type === "bc_features") {
              const st = (ws as any).data?.bc as BcState | undefined;
             if (!st) return;

            const trigger = shouldTriggerBc(st, msg as BcFeaturesMsg);
             if (trigger) {
            ws.send(JSON.stringify(trigger));
            }
             return;
            }

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
