import { serve, type ServerWebSocket } from "bun";
import { appendFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { streamOllama, parseLlmResponse } from "./llm";
import { shouldTriggerBc, type BcState, type BcFeaturesMsg } from "./backchannel";
import { sendElevenLabsTts } from "./elevenlabs";

const PORT = 3001;
const BASE_DIR = fileURLToPath(new URL(".", import.meta.url));
const LOG_FILE = join(BASE_DIR, "chat_log.jsonl");
const ENV = ((globalThis as any).process?.env ?? (globalThis as any).Bun?.env ?? {}) as Record<string, string | undefined>;

// Separate architecture for research comparison. NOT used in main pipeline (Piper is default).
const ENABLE_ELEVENLABS = (ENV.ENABLE_ELEVENLABS ?? "false").toLowerCase() === "true";

// Append one JSON line to the log file (sync is fine for small writes)
function log(entry: Record<string, unknown>) {
  appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + "\n");
}

// ── WebSocket server ────────────────────────────────────────────
serve({
  port: PORT,

  fetch(req: Request, server: any) {
    if (server.upgrade(req)) return;
    return new Response("LLM relay running — connect via WebSocket", { status: 200 });
  },

  websocket: {
    open(ws: ServerWebSocket<unknown>) {
      console.log("Client connected");
      // Initialize backchannel.
      (ws as any).data = (ws as any).data ?? {};
      (ws as any).data.bc = {
        lastGlobalTs: 0,
        lastPerNpcTs: { HR: 0, TECH: 0 },
      } satisfies BcState;

      ws.send(JSON.stringify({ type: "connected" }));
    },

    async message(ws: ServerWebSocket<unknown>, raw: unknown) {
      try {
        const rawString = typeof raw === "string"
          ? raw
          : raw instanceof Uint8Array
            ? new TextDecoder().decode(raw)
            : String(raw);
        const msg = JSON.parse(rawString);

        // Checks for BC features / piggyback of features and triggers.
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
          const npcContext = msg.system_prompt ? `[NPC Profile: ${msg.system_prompt}]\n\n` : "";
          const fullPrompt = npcContext + msg.prompt;
          console.log(`[llm_stream] npc=${msg.npc ?? "?"}  model=${msg.model}  prompt=${fullPrompt.substring(0, 120)}…`);
          log({ role: "user", npc: msg.npc, prompt: fullPrompt });

          let fullResponse = "";
          let sentenceBuffer = "";
          let stateParsed = false;

          await streamOllama({
            model: msg.model,
            prompt: fullPrompt,
            options: msg.options,
          }, (textChunk, isFinal) => {
            fullResponse += textChunk;
            sentenceBuffer += textChunk;

            // Phase 1: Wait for [STATE] block
            if (!stateParsed) {
              if (fullResponse.includes("[/STATE]")) {
                stateParsed = true;
                const stateMatch = fullResponse.match(/\[STATE\](.*?)\[\/STATE\]/s);
                let stateObj = null;
                if (stateMatch && stateMatch[1]) {
                  try { stateObj = JSON.parse(stateMatch[1]); } catch(e){}
                }

                // Clear the state from the spoken buffer
                sentenceBuffer = fullResponse.replace(/\[STATE\](.*?)\[\/STATE\]/s, "").trimStart();
                
                ws.send(JSON.stringify({
                  type: "llm_state",
                  npc: msg.npc ?? "",
                  state: stateObj
                }));
              } else if (fullResponse.length > 24 && !fullResponse.startsWith("[STATE]")) {
                stateParsed = true;
                ws.send(JSON.stringify({
                  type: "llm_state",
                  npc: msg.npc ?? "",
                  state: null
                }));
              }
              return; // End early if state not finished
            }

            // Phase 2: Slice into natural phrase chunks and stream to Unity
            const splitRegex = /([.!?])(\s|$)/;

            while (true) {
              const match = sentenceBuffer.match(splitRegex);
              if (!match) break;

              const punctuation = match[1] ?? "";
              const splitIndex = (match.index ?? 0) + punctuation.length;
              const chunkText = sentenceBuffer.substring(0, splitIndex).trim();
              sentenceBuffer = sentenceBuffer.substring(splitIndex).trimStart();

              if (chunkText.length > 0) {
                ws.send(JSON.stringify({
                  type: "llm_chunk",
                  npc: msg.npc ?? "",
                  chunk: chunkText,
                  isFinal: false
                }));
              }
            }

            if (isFinal) {
              const finalChunk = sentenceBuffer.trim();
              ws.send(JSON.stringify({
                type: "llm_chunk",
                npc: msg.npc ?? "",
                chunk: finalChunk,
                isFinal: true
              }));
              sentenceBuffer = "";
            }
          });

          log({ role: "assistant", npc: msg.npc, response: fullResponse });

          // Send to elevenlabs at the very end just for your research tests
          // Entirely isolated and separate from main streaming pipeline.
          if (ENABLE_ELEVENLABS) {
            const parsed = parseLlmResponse(fullResponse);
            await sendElevenLabsTts(ws, msg, parsed.ttsCleanText);
          }
        } else {
          // Passthrough / echo for other message types
          ws.send(JSON.stringify({ type: "echo", data: rawString }));
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

console.log(`LLM relay running on ws://0.0.0.0:${PORT} - Using Ollama`);
