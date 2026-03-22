import { serve, type ServerWebSocket } from "bun";
import { appendFileSync } from "fs";
import { join } from "path";
import { sendElevenLabsTts } from "./elevenlabs";
import { evaluateInterview } from "./evaluator.ts";

const PORT = 3001;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
const LOG_FILE = join(import.meta.dir, "chat_log.jsonl");

// Flip this one line to turn ElevenLabs on/off (plus set ELEVENLABS_API_KEY in .env).
const ENABLE_ELEVENLABS = true;

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
    // OPTIMIZATION: keep_alive keeps the model aggressively loaded in VRAM/RAM so subsequent queries don't hang
    body: JSON.stringify({ ...body, stream: false, keep_alive: "1h" }),
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

// ── LLM Response Parser ─────────────────────────────────────────
function parseLlmResponse(rawText: string) {
  // 1. Extract the [STATE] JSON block
  let state = null;
  const stateRegex = /\[STATE\](.*?)\[\/STATE\]/s;
  const stateMatch = rawText.match(stateRegex);
  
  if (stateMatch && stateMatch[1]) {
    try {
      state = JSON.parse(stateMatch[1]);
    } catch (e) {
      console.error("Failed to parse STATE block JSON:", e);
    }
  }

  // Remove the [STATE] block from the text
  let textWithoutState = rawText.replace(stateRegex, "").trim();

  // 2. Extract the inline animation tags (e.g., [nod_backchannel])
  const tagRegex = /\[([a-z_]+)\]/g;
  const tags: string[] = [];
  let match;
  while ((match = tagRegex.exec(textWithoutState)) !== null) {
    // FIX: Added safety check for TypeScript
    if (match[1]) { 
      tags.push(match[1]); // Pushes just the tag name without brackets
    }
  }

  // 3. Create a clean string for the TTS engine by removing all tags
  const ttsCleanText = textWithoutState.replace(tagRegex, "").trim();

  return {
    state,              // Parsed JSON object for Unity
    rawText,            // Original text just in case
    textWithTags: textWithoutState, // Text with inline tags (useful if Unity parses them for audio sync)
    ttsCleanText,       // Tag-free text for ElevenLabs/Piper
    tags                // Array of triggered animations
  };
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

    async message(ws: ServerWebSocket<unknown>, raw) {
      try {
        const msg = JSON.parse(raw.toString());

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

        if (msg.type === "evaluate_interview") {
          const participantId = (typeof msg.participantId === "string" && msg.participantId.trim().length > 0)
            ? msg.participantId
            : undefined;

          console.log(`[llm] Evaluating interview for ${participantId ?? "<latest participant>"}...`);
          
          try {
            const evaluationResponse = await evaluateInterview(
              participantId, 
              LOG_FILE, 
              queryOllama, 
              msg.model || "qwen2.5:14b"
            );

            ws.send(JSON.stringify({ 
              type: "evaluation_result", 
              participantId: evaluationResponse.participantId,
              model: evaluationResponse.model,
              transcriptTurns: evaluationResponse.transcriptTurns,
              evaluation: evaluationResponse.evaluation,
              result: evaluationResponse.raw
            }));
            
            log({ type: "evaluation", participantId: evaluationResponse.participantId, model: evaluationResponse.model, evaluation: evaluationResponse.evaluation });
            
          } catch (err: any) {
            console.error("Evaluation Error:", err);
            ws.send(JSON.stringify({ type: "error", message: "Evaluation failed: " + err.message }));
          }
          return;
        }

        if (msg.type === "llm") {
          const participantId = (typeof msg.participantId === "string" && msg.participantId.trim().length > 0)
            ? msg.participantId
            : "unknown";

          const npcContext = msg.system_prompt ? `[NPC Profile: ${msg.system_prompt}]\n\n` : "";
          const fullPrompt = npcContext + msg.prompt;
          console.log(`[llm] participant=${participantId ?? "?"} npc=${msg.npc ?? "?"}  model=${msg.model}  prompt=${fullPrompt.substring(0, 120)}…`);
          log({ role: "user", participantId, npc: msg.npc, prompt: fullPrompt });
          
          const rawResponse = await queryOllama({
            model: msg.model,
            prompt: fullPrompt,
            options: msg.options,
          });
          
          log({ role: "assistant", participantId, npc: msg.npc, response: rawResponse });

          // --- NEW PARSING LOGIC ---
          const parsed = parseLlmResponse(rawResponse);

          // Send structured data to Unity (State + Tags + Text)
          ws.send(JSON.stringify({ 
            type: "llm_parsed", 
            npc: msg.npc ?? "", 
            state: parsed.state,
            tags: parsed.tags,
            textForSubtitles: parsed.textWithTags, 
            response: rawResponse // Keep for backward compatibility if needed
          }));

          // Send ONLY the clean text to ElevenLabs/Piper
          if (ENABLE_ELEVENLABS) {
            await sendElevenLabsTts(ws, msg, parsed.ttsCleanText);
          }
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
