import { serve, type ServerWebSocket } from "bun";
import { appendFileSync } from "fs";
import { join } from "path";
import { sendElevenLabsTts } from "./elevenlabs";
import { evaluateInterview } from "./evaluator.ts";

const PORT = Number(process.env.PORT ?? 3001);
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434/api/generate";
const LOG_FILE = process.env.CHAT_LOG_FILE ?? join(import.meta.dir, "chat_log.jsonl");

const ENABLE_ELEVENLABS = (process.env.ENABLE_ELEVENLABS ?? "true").toLowerCase() === "true";

// --- THE INVISIBLE SCORECARD ---
function getInitialState() {
    return {
        categoryIndex: 0,
        categories: [
            "Introduction", 
            "Judgment & prioritization", 
            "Collaboration", 
            "Accountability", 
            "Growth",
            "Wrap-up & Outro"
        ],
        // NEW: An array of scores that matches the categories above!
        scores: [0, 0, 0, 0, 0, 0], 
        questionCount: 0
    };
}

let interviewState = getInitialState();

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

 // if (msg.vad !== 1) return null;
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
    // 1. Scrub the LLM output! 
    // This removes markdown ticks and extra spaces that break JSON.parse
    let cleanJsonString = stateMatch[1]
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    try {
      state = JSON.parse(cleanJsonString);
    } catch (e) {
      // 2. If it STILL fails, print the exact string to the console so we can see the hallucination!
      console.error("⚠️ Failed to parse STATE block JSON.");
      console.error("Here is the exact broken string the LLM generated: ->", cleanJsonString, "<-");
    }
  }
  // Remove the [STATE] block from the text
  let textWithoutState = rawText.replace(stateRegex, "").trim();

  // --- NEW: THE SUBTITLE SANITIZER ---
  // If the AI hallucinates a closing tag (with a slash), delete it so Unity never sees it.
  textWithoutState = textWithoutState.replace(/\[\/.*?\]/g, "");

  // 2. Extract the inline animation tags (Now catches hyphens and numbers!)
  const tagRegex = /\[([a-zA-Z0-9_-]+)\]/g; 
  const tags: string[] = [];
  let match;
  while ((match = tagRegex.exec(textWithoutState)) !== null) {
    if (match[1]) { 
      tags.push(match[1]); 
    }
  }

  // 3. THE MUZZLE: Create a clean string for TTS
  let ttsCleanText = textWithoutState.replace(/\[.*?\]/g, ""); // Removes normal tags
  ttsCleanText = ttsCleanText.replace(/\[.*/g, ""); // VIOLENTLY removes broken, unclosed tags at the end like [smile_pol000...
  
  // Strips out emojis so the TTS doesn't try to read them
  ttsCleanText = ttsCleanText.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, "").trim();

  return {
    state,              
    rawText,            
    textWithTags: textWithoutState, 
    ttsCleanText,       // Nice, clean, emoji-free, bracket-free text!
    tags                
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
      interviewState = getInitialState();
      console.log("[SYSTEM] New interview session started. State wiped clean.");

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
          console.log(`[bc_features] vad=${msg.vad} pauseMs=${msg.pauseMs} speechMs=${msg.speechMs} addr=${msg.addressee}`);

              const st = (ws as any).data?.bc as BcState | undefined;
             if (!st) return;

            const trigger = shouldTriggerBc(st, msg as BcFeaturesMsg);
             if (trigger) {
              console.log(`[bc_trigger] npc=${trigger.npc} action=${trigger.action}`); //remove after testing
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
         // 1. INJECT THE INVISIBLE SCORECARD INTO THE PROMPT
          const nextCatIndex = interviewState.categoryIndex < interviewState.categories.length - 1 ? interviewState.categoryIndex + 1 : interviewState.categoryIndex;
          const nextCategory = interviewState.categories[nextCatIndex];
          
          const currentScore = Math.min(interviewState.scores[interviewState.categoryIndex] ?? 0, 100); 
          const pointsNeeded = 100 - currentScore;

          // --- BRUTE FORCE ORCHESTRATOR ---
          // The Server now explicitly commands the AI on exactly what to do.
          let forcedAction = "";
          if (msg.prompt.includes("[KICKOFF]")) {
              forcedAction = "SPEAKER MUST BE HR. Output 'addProgress': 0. Welcome the candidate and ask an icebreaker.";
          } else if (interviewState.categoryIndex === interviewState.categories.length - 1) {
              forcedAction = "SPEAKER MUST BE HR. Output 'addProgress': 0. Wrap up the interview and say goodbye.";
          } else if (interviewState.questionCount >= 2) {
              // 3-STRIKE RULE ENFORCER:
              forcedAction = `THIS IS THE FINAL QUESTION FOR THIS CATEGORY. SPEAKER MUST BE HR. Output 'addProgress': 25. You MUST say 'Let's move on' and ask the lead question for: ${nextCategory}.`;
          } else {
              // STANDARD GRADING:
              forcedAction = `Evaluate the answer. IF Grade >= ${pointsNeeded}, speaker MUST be HR and move to ${nextCategory}. IF Grade < ${pointsNeeded}, speaker MUST be TECH and ask a follow-up.`;
          }

          const systemContext = `
[SYSTEM CONTEXT - DO NOT READ ALOUD]
Current Category: ${interviewState.categories[interviewState.categoryIndex]}
Next Category: ${nextCategory}

[SYSTEM COMMAND FOR THIS TURN - CRITICAL]
${forcedAction}
[/SYSTEM CONTEXT]

User Answer: "${msg.prompt}"
`;
          // 
          const fullPrompt = systemContext;

          console.log(`[llm] model=${msg.model} category=${interviewState.categories[interviewState.categoryIndex]}`);
          log({ role: "user", prompt: fullPrompt });
          
          const rawResponse = await queryOllama({
            model: msg.model,
            prompt: fullPrompt,
            options: msg.options,
          });
          
          log({ role: "assistant", response: rawResponse });

          // Parse the JSON block and tags using your existing helper function
          const parsed = parseLlmResponse(rawResponse);

          // 2. PROCESS THE GRADE AND GAME LOOP
          let currentSpeaker = "HR"; 
          
          if (parsed.state) {
            // Did the LLM pick a speaker?
            if (parsed.state.speaker) currentSpeaker = parsed.state.speaker;
            
            // Did the LLM grade the answer?
            if (parsed.state.addProgress) {
                // Add points to the specific category's "HP bar"
                interviewState.scores[interviewState.categoryIndex] += parsed.state.addProgress;
                interviewState.questionCount += 1;
                console.log(`[SCORE] +${parsed.state.addProgress}. Category Total: ${interviewState.scores[interviewState.categoryIndex]}%`);
            }

            // --- THE FIX: CHECK THE ARRAY SCORE ---
            // We now check if THIS specific category has 100 points!
            if ((interviewState.scores[interviewState.categoryIndex] ?? 0) >= 100 || interviewState.questionCount >= 3) {
              
                // Only move to the next category if we AREN'T on the final Outro step
                if (interviewState.categoryIndex < interviewState.categories.length - 1) {
                    interviewState.categoryIndex++;
                    interviewState.questionCount = 0; // Reset questions for the new level!
                    console.log(`[LEVEL UP] Moving to category: ${interviewState.categories[interviewState.categoryIndex]}`);
                } else {
                    console.log(`[INTERVIEW COMPLETE] We are in the Outro phase.`);
                }
            }
          }
          

          // 3. SEND TO UNITY 
          ws.send(JSON.stringify({ 
            type: "llm_parsed", 
            npc: currentSpeaker, 
            state: parsed.state,
            tags: parsed.tags,
            textForSubtitles: parsed.textWithTags, 
            response: rawResponse,
            // --- NEW: THE CLEAN DATA BRIDGE ---
            gameData: {
                allCategories: interviewState.categories,
                allScores: interviewState.scores,
                isOutro: interviewState.categoryIndex === (interviewState.categories.length - 1)
            }
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
