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

// --- CONVERSATION MEMORY ---
// Track recent exchanges in a rolling window for natural multi-turn context
type ConversationExchange = {
  user: string;
  npc: string;
};

type ConversationMemory = {
  exchanges: ConversationExchange[];
  maxExchanges: number;
};

function getInitialMemory(): ConversationMemory {
  return {
    exchanges: [],
    maxExchanges: 4  // Keep last 4 exchanges for context
  };
}

function addExchangeToMemory(memory: ConversationMemory, userText: string, npcText: string) {
  memory.exchanges.push({ user: userText, npc: npcText });
  
  // Trim to max window size (FIFO - oldest exchanges are removed)
  if (memory.exchanges.length > memory.maxExchanges) {
    memory.exchanges.shift();
  }
}

function getContextForPrompt(memory: ConversationMemory): string {
  if (memory.exchanges.length === 0) return "";
  
  let context = "[CONVERSATION HISTORY]\n";
  context += "Recent exchanges:\n";
  memory.exchanges.forEach((ex, idx) => {
    context += `${idx + 1}. User: ${ex.user}\n   Assistant: ${ex.npc}\n`;
  });
  context += "[/CONVERSATION HISTORY]\n\n";
  return context;
}

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
      
      // Initialize conversation memory for this session
      (ws as any).data.conversationMemory = getInitialMemory();

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

          // --- ADAPTIVE ORCHESTRATOR ---
          // The server guides the AI but allows natural flow
          let forcedAction = "";
          if (msg.prompt.includes("[KICKOFF]")) {
              forcedAction = "SPEAKER MUST BE HR. Output 'addProgress': 0. Welcome the candidate warmly and ask an engaging icebreaker question.";
          } else if (interviewState.categoryIndex === interviewState.categories.length - 1) {
              forcedAction = "SPEAKER MUST BE HR. Output 'addProgress': 0. Wrap up the interview professionally, thank the candidate, and say goodbye.";
          } else if (interviewState.questionCount === 2) {
              // Soft warning: suggest moving on if answer is strong
              forcedAction = `You've asked 2 questions in this category. Evaluate the answer carefully. IF Grade >= ${pointsNeeded}, SPEAKER MUST BE HR and smoothly transition by saying something like "Great insights! Let's move on to..." and introduce: ${nextCategory}. IF Grade < ${pointsNeeded}, SPEAKER MUST BE TECH with ONE final clarifying question before we move on.`;
          } else if (interviewState.questionCount >= 3) {
              // Hard limit: force transition
              forcedAction = `MAXIMUM QUESTIONS REACHED. SPEAKER MUST BE HR. Output 'addProgress': ${pointsNeeded}. Say something natural like "Excellent, I think we have a good sense of this area. Let's discuss..." and transition to: ${nextCategory}.`;
          } else {
              // Standard grading: adaptive speaker assignment
              forcedAction = `Evaluate the candidate's answer thoughtfully. IF Grade >= ${pointsNeeded}, SPEAKER MUST BE HR and naturally transition to ${nextCategory} with a brief acknowledgment. IF Grade < ${pointsNeeded}, SPEAKER can be TECH or HR (whoever fits naturally) and ask a relevant follow-up question to probe deeper.`;
          }

          // Get conversation context to make responses more natural
          const conversationMemory = (ws as any).data?.conversationMemory as ConversationMemory | undefined;
          const conversationContext = conversationMemory ? getContextForPrompt(conversationMemory) : "";
          
          // --- FIX: Only store actual user speech, not meta commands ---
          const isMetaCommand = msg.prompt.includes("[KICKOFF]") || msg.prompt.includes("[SYSTEM");
          const cleanUserInput = isMetaCommand ? "" : msg.prompt;

          // Build the full prompt with clear separation
          const systemContext = `
[SYSTEM CONTEXT - DO NOT READ ALOUD]
Current Category: ${interviewState.categories[interviewState.categoryIndex]}
Next Category: ${nextCategory}

[SYSTEM COMMAND FOR THIS TURN - CRITICAL]
${forcedAction}
[/SYSTEM CONTEXT]

${conversationContext}${isMetaCommand ? msg.prompt : `User Answer: "${msg.prompt}"`}
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

          // --- FIX: Store complete exchange in rolling window memory ---
          if (conversationMemory && !isMetaCommand && parsed.ttsCleanText) {
            addExchangeToMemory(conversationMemory, msg.prompt, parsed.ttsCleanText);
            console.log(`[Memory] Stored exchange. History size: ${conversationMemory.exchanges.length}/${conversationMemory.maxExchanges}`);
          }

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

            // --- ADAPTIVE CATEGORY PROGRESSION ---
            // Check if THIS category has reached completion threshold
            const categoryComplete = (interviewState.scores[interviewState.categoryIndex] ?? 0) >= 100;
            const questionLimitReached = interviewState.questionCount >= 3;
            
            if (categoryComplete || questionLimitReached) {
                // Only move to the next category if we AREN'T on the final Outro step
                if (interviewState.categoryIndex < interviewState.categories.length - 1) {
                    const previousCategory = interviewState.categories[interviewState.categoryIndex];
                    interviewState.categoryIndex++;
                    interviewState.questionCount = 0; // Reset questions for the new category
                    
                    const reason = categoryComplete ? "100% score reached" : "question limit reached";
                    console.log(`[PHASE TRANSITION] ${previousCategory} → ${interviewState.categories[interviewState.categoryIndex]} (${reason})`);
                } else {
                    console.log(`[INTERVIEW COMPLETE] Outro phase active.`);
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
