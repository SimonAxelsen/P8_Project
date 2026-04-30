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
            "Collaboration", 
            "Accountability", 
            "Growth",
            "Wrap-up & Outro"
        ],
        // NEW: An array of scores that matches the categories above!
        scores: [0, 0, 0, 0, 0], 
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

type SessionScratchpad = {
  candidateName?: string;
  currentTopic: string;
  lastMeaningfulExample?: string;
  openFollowUp?: string;
};

function getInitialMemory(): ConversationMemory {
  return {
    exchanges: [],
    maxExchanges: 5
  };
}

function getInitialScratchpad(): SessionScratchpad {
  return {
    currentTopic: "Introduction",
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

function normalizeMemoryText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trim()}...`;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeForSimilarity(text: string): string[] {
  const stopwords = new Set([
    "a", "an", "and", "are", "can", "could", "do", "for", "from", "have", "how", "i",
    "if", "im", "is", "it", "let", "like", "me", "my", "of", "on", "or", "please",
    "so", "that", "the", "this", "to", "we", "what", "when", "with", "would", "you",
    "your",
  ]);

  return normalizeForComparison(text)
    .split(" ")
    .filter((token) => token.length > 2 && !stopwords.has(token));
}

function extractCandidateName(text: string): string | undefined {
  const patterns = [
    /\bmy name is\s+([a-z][a-z' -]{1,30})/i,
    /\bcall me\s+([a-z][a-z' -]{1,30})/i,
    /\bthis is\s+([a-z][a-z' -]{1,30})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const rawName = match?.[1]?.trim();
    if (!rawName) continue;

    const words = rawName
      .replace(/[.,!?;:]+$/g, "")
      .split(/\s+/)
      .filter(Boolean);

    if (words.length === 0 || words.length > 3) continue;
    if (!words.every((word) => /^[a-z][a-z'’-]*$/i.test(word))) continue;

    return words
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");
  }

  return undefined;
}

function isShortGreeting(text: string): boolean {
  const normalized = normalizeForComparison(text);
  const words = wordCount(normalized);
  if (words > 8) return false;

  return /^(hi|hello|hey|good morning|good afternoon|good evening|how are you|nice to meet you)\b/.test(normalized);
}

function isClarificationRequest(text: string): boolean {
  const normalized = normalizeForComparison(text);

  return /(can you repeat|could you repeat|repeat the question|say that again|clarify|please clarify|what do you mean|can you explain|didn t catch|pardon|sorry can you repeat|sorry can you clarify)/.test(normalized);
}

function isEchoOfPreviousQuestion(userText: string, previousAssistantText?: string): boolean {
  if (!previousAssistantText) return false;

  const userTokens = tokenizeForSimilarity(userText);
  const assistantTokens = tokenizeForSimilarity(previousAssistantText);

  if (userTokens.length < 4 || assistantTokens.length < 4) return false;

  const assistantTokenSet = new Set(assistantTokens);
  const overlap = userTokens.filter((token) => assistantTokenSet.has(token)).length;
  const overlapRatio = overlap / userTokens.length;

  return overlapRatio >= 0.7;
}

function shouldStoreMeaningfulTurn(userText: string, previousAssistantText?: string): boolean {
  const normalized = normalizeMemoryText(userText, 400);
  if (!normalized) return false;
  if (wordCount(normalized) < 4) return false;
  if (isShortGreeting(normalized)) return false;
  if (isClarificationRequest(normalized)) return false;
  if (isEchoOfPreviousQuestion(normalized, previousAssistantText)) return false;
  return true;
}

function extractOpenFollowUp(text: string): string | undefined {
  const normalized = normalizeMemoryText(text, 220);
  const questionMatches = normalized.match(/[^?]*\?/g);
  if (!questionMatches || questionMatches.length === 0) return undefined;
  return questionMatches[questionMatches.length - 1]?.trim();
}

function getScratchpadContext(scratchpad: SessionScratchpad): string {
  const lines = ["[SESSION SUMMARY]"];

  lines.push(`Current topic: ${scratchpad.currentTopic}`);

  if (scratchpad.candidateName) {
    lines.push(`Candidate name: ${scratchpad.candidateName}`);
  }
  if (scratchpad.lastMeaningfulExample) {
    lines.push(`Last meaningful example: ${scratchpad.lastMeaningfulExample}`);
  }
  if (scratchpad.openFollowUp) {
    lines.push(`Open follow-up: ${scratchpad.openFollowUp}`);
  }

  lines.push("[/SESSION SUMMARY]", "");
  return `${lines.join("\n")}\n`;
}

function updateScratchpadFromUserInput(
  scratchpad: SessionScratchpad,
  currentTopic: string,
  userText: string,
  shouldStore: boolean,
): void {
  scratchpad.currentTopic = currentTopic;

  const candidateName = extractCandidateName(userText);
  if (candidateName) {
    scratchpad.candidateName = candidateName;
  }

  if (shouldStore) {
    scratchpad.lastMeaningfulExample = normalizeMemoryText(userText);
  }
}

function updateScratchpadFromAssistantOutput(
  scratchpad: SessionScratchpad,
  currentTopic: string,
  assistantText: string,
): void {
  scratchpad.currentTopic = currentTopic;
  scratchpad.openFollowUp = extractOpenFollowUp(assistantText);
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
    body: JSON.stringify({ ...body, think: false, stream: false, keep_alive: "1h" }),
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
  rmsDb: number;
  f0Slope: number;
  voicedRatio: number;
  specFlux: number;
  speechConfidence: number;
  boundaryConfidence: number;
  turnEndScore: number;
  questionLike: number;
  engagementScore: number;
  addressee?: "HR" | "TECH" | "UNKNOWN";
  agentsSpeaking?: { HR?: boolean; TECH?: boolean };
};

type BcAction = "NodSmall" | "nrub" | "shrugandshake" | "seatAdjustment" | "shoulderwarmup";

type BcTriggerMsg = {
  type: "bc_trigger";
  npc: NpcKey;
  action: string; // animator trigger name
};

type BcState = {
  lastGlobalTs: number;
  lastPerNpcTs: Record<NpcKey, number>;
  lastPerActionTs: Record<BcAction, number>;
};

// --- Changable things for the mic(amount of times a BC can be triggered etc. ALL IN MS) ---
const BC_MICROPAUSE_MIN = 250;
const BC_MICROPAUSE_MAX = 700;
const BC_EOT_THRESHOLD = 1000;      // treat > this as end-of-turn 
const BC_GLOBAL_COOLDOWN = 2500;    
const BC_NPC_COOLDOWN = 5000;       
const BC_ACTION_COOLDOWN: Record<BcAction, number> = {
  NodSmall: 4000,
  nrub: 7000,
  shrugandshake: 7000,
  seatAdjustment: 8000,
  shoulderwarmup: 8000,
};

function nowMs() {
  return Date.now();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normRange(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || max <= min) return 0;
  return clamp01((value - min) / (max - min));
}

function absNorm(value: number, maxAbs: number): number {
  if (!Number.isFinite(value) || maxAbs <= 0) return 0;
  return clamp01(Math.abs(value) / maxAbs);
}

function chooseBackchannelAction(msg: BcFeaturesMsg): BcAction | null {
  const normPause = normRange(msg.pauseMs, 120, 700);
  const normSpeech = normRange(msg.speechMs, 400, 4000);
  const normRms = normRange(msg.rmsDb, -45, -12);
  const normF0Slope = absNorm(msg.f0Slope, 80);
  const normFlux = normRange(msg.specFlux, 1, 6);
  const speechConfidence = clamp01(msg.speechConfidence);
  const boundaryConfidence = clamp01(msg.boundaryConfidence);
  const turnEndScore = clamp01(msg.turnEndScore);
  const questionLike = clamp01(msg.questionLike);
  const engagementScore = clamp01(msg.engagementScore);
  const voicedRatio = clamp01(msg.voicedRatio);

  const turnYield = clamp01(
    0.45 * turnEndScore +
    0.35 * boundaryConfidence +
    0.20 * normPause,
  );

  const uncertainty = clamp01(
    0.35 * questionLike +
    0.30 * (1 - speechConfidence) +
    0.20 * normF0Slope +
    0.15 * (1 - voicedRatio),
  );

  const arousal = clamp01(
    0.35 * normRms +
    0.25 * normFlux +
    0.25 * engagementScore +
    0.15 * voicedRatio,
  );

  const fatigueOrDisengagement = clamp01(
    0.45 * (1 - engagementScore) +
    0.30 * (1 - normRms) +
    0.25 * normPause,
  );

  const strain = clamp01(
    0.45 * normSpeech +
    0.35 * arousal +
    0.20 * (1 - speechConfidence),
  );

  if (turnYield > 0.62 && speechConfidence > 0.45 && uncertainty < 0.65) {
    return "NodSmall";
  }

  if (questionLike > 0.65 && uncertainty > 0.55 && turnYield < 0.55) {
    return "shrugandshake";
  }

  if (uncertainty > 0.68 && speechConfidence < 0.55) {
    return "nrub";
  }

  if (fatigueOrDisengagement > 0.65 && engagementScore < 0.45) {
    return "seatAdjustment";
  }

  if (strain > 0.66 && msg.speechMs > 1200 && engagementScore > 0.45) {
    return "shoulderwarmup";
  }

  return null;
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

  const action = chooseBackchannelAction(msg);
  if (!action) return null;

  if (t - st.lastPerActionTs[action] < BC_ACTION_COOLDOWN[action]) return null;

  st.lastGlobalTs = t;
  st.lastPerNpcTs[npc] = t;
  st.lastPerActionTs[action] = t;

  return { type: "bc_trigger", npc, action };
}

// ── LLM Response Parser ─────────────────────────────────────────
function parseLlmResponse(rawText: string) {
  let state = null;
  let textWithoutState = rawText.trim();

  // 1. NUKE SCRIPT LABELS
  // Removes "HR:" or "TECH:" from the beginning of the text so ElevenLabs never reads it
  textWithoutState = textWithoutState.replace(/^(?:HR|TECH|Interviewer|Assistant|System|Candidate)\s*:\s*/i, "");

  // 2. ROBUST JSON EXTRACTION & COMPLETE BLOCK REMOVAL
  // Look for the exact boundaries of the [STATE] block
  const stateBlockRegex = /\[\s*STATE\s*\](.*?)\[\s*\/\s*STATE\s*\]/is;
  const stateMatch = textWithoutState.match(stateBlockRegex);

  if (stateMatch) {
    let cleanJsonString = stateMatch[1] || ''
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    try {
      state = JSON.parse(cleanJsonString);
    } catch (e) {
      console.error("⚠️ Failed to parse STATE block JSON. Broken literal:", cleanJsonString);
    }
    
    // THE FIX: Violently delete the ENTIRE block (brackets, JSON, and all) from the string
    textWithoutState = textWithoutState.replace(stateBlockRegex, "").trim();
  } else {
    // Fallback: If it forgot the [STATE] tags but output JSON anyway
    const configRegex = /\{[^{}]*?(?:"speaker"|"addProgress")[^{}]*?\}/is;
    const configMatch = textWithoutState.match(configRegex);
    if (configMatch) {
      let cleanJsonString = configMatch[0].replace(/```json/gi, "").replace(/```/g, "").trim();
      try { state = JSON.parse(cleanJsonString); } catch (e) {}
      textWithoutState = textWithoutState.replace(configMatch[0], "").trim();
    }
  }

  // Run the script label nuke one more time, just in case the AI put "HR:" AFTER the JSON block
  textWithoutState = textWithoutState.replace(/^(?:HR|TECH|Interviewer|Assistant|System|Candidate)\s*:\s*/i, "");

  // Sanitize any remaining markdown or hallucinated closures
  textWithoutState = textWithoutState
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/\[\s*\/.*?\]/g, "") 
    .trim();

  // 3. EXTRACT INLINE ANIMATION TAGS
  const tagRegex = /\[\s*([a-zA-Z0-9_-]+)\s*\]/g; 
  const tags: string[] = [];
  let match;
  while ((match = tagRegex.exec(textWithoutState)) !== null) {
    if (match[1] && !match[1].toUpperCase().includes("STATE")) { 
      tags.push(match[1]); 
    }
  }

  // 4. THE MUZZLE: Create a clean string for TTS
  let ttsCleanText = textWithoutState.replace(/\[.*?\]/g, ""); 
  ttsCleanText = ttsCleanText.replace(/\[\s*[a-zA-Z0-9_-]*\s*$/g, ""); 
  ttsCleanText = ttsCleanText.replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu, "").trim();

  // --- 5. PROCEDURAL ANIMATION INJECTION (THE "AMP UP") ---
  let wordCounter = 0;
  const fillerTags = ["gesture_beat", "gesture_explain"]; 
  
  // Regex looks for words (ignoring the bracketed tags the LLM already placed)
  let ampedTextWithTags = textWithoutState.replace(/(\b[a-zA-Z0-9_'-]+\b[.,!?]*)/g, (wordMatch) => {
      wordCounter++;
      if (wordCounter % 3 === 0) {
          const randomTag = fillerTags[Math.floor(Math.random() * fillerTags.length)]!;
          tags.push(randomTag); 
          return `${wordMatch} [${randomTag}]`;
      }
      return wordMatch;
  });

  // --- NEW FIX: Prevent the finish-line traffic jam ---
  // This regex deletes any existing tags at the very tail end of the string
  ampedTextWithTags = ampedTextWithTags.replace(/(?:\[[a-zA-Z0-9_]+\]\s*)+$/, "");

  // Force the neutral ending cleanly
  ampedTextWithTags = `${ampedTextWithTags.trim()} [neutral]`;
  
  if (!tags.includes("neutral")) {
      tags.push("neutral");
  }

  return {
    state,              
    rawText,            
    textWithTags: ampedTextWithTags, 
    ttsCleanText,       
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
        lastPerActionTs: {
          NodSmall: 0,
          nrub: 0,
          shrugandshake: 0,
          seatAdjustment: 0,
          shoulderwarmup: 0,
        },
      } satisfies BcState;
      
      // Initialize conversation memory for this session
      (ws as any).data.conversationMemory = getInitialMemory();
      (ws as any).data.sessionScratchpad = getInitialScratchpad();

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
          const currentCategory = interviewState.categories[interviewState.categoryIndex] ?? "Introduction";
          const nextCatIndex = interviewState.categoryIndex < interviewState.categories.length - 1 ? interviewState.categoryIndex + 1 : interviewState.categoryIndex;
          const nextCategory = interviewState.categories[nextCatIndex] ?? currentCategory;
          
          const currentScore = Math.min(interviewState.scores[interviewState.categoryIndex] ?? 0, 100); 
          const pointsNeeded = 100 - currentScore;

          // --- ADAPTIVE ORCHESTRATOR ---
          // The server guides the AI but allows natural flow
          let forcedAction = "";
          
          // NEW: 40% chance for the Tech lead to jump in with an add-on question
          const techJumpInChance = Math.random() < 0.50;

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
          } else if (techJumpInChance) {
              // NEW: Artificially force Tech to ask a follow-up/add-on
              forcedAction = `Evaluate the candidate's answer thoughtfully. SPEAKER MUST BE TECH. You are jumping in to ask a specific, practical follow-up question based on what the candidate just said. Focus on basic troubleshooting or reasoning. Grade their answer normally using 'addProgress'.`;
          } else {
              // Standard grading: HR takes the lead
              forcedAction = `Evaluate the candidate's answer thoughtfully. IF Grade >= ${pointsNeeded}, SPEAKER MUST BE HR and naturally transition to ${nextCategory} with a brief acknowledgment. IF Grade < ${pointsNeeded}, SPEAKER MUST BE HR and ask a relevant follow-up question to probe deeper.`;
          }

          // Get conversation context to make responses more natural
          const conversationMemory = (ws as any).data?.conversationMemory as ConversationMemory | undefined;
          const sessionScratchpad = (ws as any).data?.sessionScratchpad as SessionScratchpad | undefined;
          const conversationContext = conversationMemory ? getContextForPrompt(conversationMemory) : "";
          
          // --- FIX: Only store actual user speech, not meta commands ---
          const isMetaCommand = msg.prompt.includes("[KICKOFF]") || msg.prompt.includes("[SYSTEM");
          const cleanUserInput = isMetaCommand ? "" : msg.prompt;
          const previousAssistantText = conversationMemory && conversationMemory.exchanges.length > 0
            ? conversationMemory.exchanges[conversationMemory.exchanges.length - 1]?.npc
            : undefined;
          const shouldStoreTurn = !isMetaCommand && shouldStoreMeaningfulTurn(cleanUserInput, previousAssistantText);

          if (sessionScratchpad && cleanUserInput) {
            updateScratchpadFromUserInput(
              sessionScratchpad,
              currentCategory,
              cleanUserInput,
              shouldStoreTurn,
            );
          }

          const scratchpadContext = sessionScratchpad ? getScratchpadContext(sessionScratchpad) : "";

          // Build the full prompt with clear separation
          const systemContext = `
[SYSTEM CONTEXT - DO NOT READ ALOUD]
Current Category: ${currentCategory}
Next Category: ${nextCategory}

[SYSTEM COMMAND FOR THIS TURN - CRITICAL]
${forcedAction}
[/SYSTEM CONTEXT]

${scratchpadContext}${conversationContext}${isMetaCommand ? msg.prompt : `User Answer: "${msg.prompt}"`}
`;
          // 
          const fullPrompt = systemContext;

          console.log(`[llm] model=${msg.model} category=${currentCategory}`);
          log({ role: "user", prompt: fullPrompt });
          
          const rawResponse = await queryOllama({
            model: msg.model,
            prompt: fullPrompt,
            options: msg.options,
          });
          
          log({ role: "assistant", response: rawResponse });

          // Parse the JSON block and tags using your existing helper function
          const parsed = parseLlmResponse(rawResponse);

          // Keep only substantive turns in raw history to reduce prompt noise.
          if (conversationMemory && shouldStoreTurn && parsed.ttsCleanText) {
            addExchangeToMemory(
              conversationMemory,
              normalizeMemoryText(cleanUserInput),
              normalizeMemoryText(parsed.ttsCleanText),
            );
            console.log(`[Memory] Stored exchange. History size: ${conversationMemory.exchanges.length}/${conversationMemory.maxExchanges}`);
          } else if (!isMetaCommand && cleanUserInput) {
            console.log("[Memory] Skipped noisy turn.");
          }

          if (sessionScratchpad && parsed.ttsCleanText) {
            updateScratchpadFromAssistantOutput(
              sessionScratchpad,
              currentCategory,
              parsed.ttsCleanText,
            );
          }

          // 2. PROCESS THE GRADE AND GAME LOOP
          let currentSpeaker = "HR"; 
          
          let isSimulationComplete = false; // <-- MOVE IT HERE! So the whole function can see it.

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
          
            // (Remove the "let isSimulationComplete = false;" that was here)

            if (categoryComplete || questionLimitReached) {
              // Only move to the next category if we AREN'T on the final Outro step
              if (interviewState.categoryIndex < interviewState.categories.length - 1) {
                  const previousCategory = interviewState.categories[interviewState.categoryIndex];
                  interviewState.categoryIndex++;
                  interviewState.questionCount = 0; // Reset questions for the new category
                  
                  const reason = categoryComplete ? "100% score reached" : "question limit reached";
                  console.log(`[PHASE TRANSITION] ${previousCategory} → ${interviewState.categories[interviewState.categoryIndex]} (${reason})`);
              } else {
                  console.log(`[INTERVIEW COMPLETE] Outro phase finished.`);
                  isSimulationComplete = true; // NEW: The final phase is over!
              }
            }
          }

          if (sessionScratchpad) {
            sessionScratchpad.currentTopic = interviewState.categories[interviewState.categoryIndex] ?? currentCategory;
          }
          

         // 3. SEND TO UNITY 
          ws.send(JSON.stringify({ 
            type: "llm_parsed", 
            npc: currentSpeaker, 
            state: parsed.state,
            tags: parsed.tags,
            textForSubtitles: parsed.textWithTags, 
            response: rawResponse,
            // --- THE CLEAN DATA BRIDGE ---
            gameData: {
                allCategories: interviewState.categories,
                allScores: interviewState.scores,
                isOutro: interviewState.categoryIndex === (interviewState.categories.length - 1),
                isSimulationComplete: isSimulationComplete
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
