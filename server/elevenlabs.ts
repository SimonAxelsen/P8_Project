import type { ServerWebSocket } from "bun";
import { Buffer } from "buffer";

// All ElevenLabs-specific logic lives here so it can be toggled easily.

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"; 

// Strip [META]...[/META] from the raw LLM response (same contract as Unity NpcAction.Parse).
function textForTts(raw: string): string {
  const OPEN = "[META]";
  const CLOSE = "[/META]";
  const a = raw.indexOf(OPEN);
  const b = raw.indexOf(CLOSE);
  if (a < 0 || b <= a) return raw.trim();
  return (raw.slice(0, a) + raw.slice(b + CLOSE.length)).trim();
}

// ElevenLabs PCM often defaults to 16 kHz; using 16000 here keeps
// playback speed/naturalness correct in Unity.
const ELEVENLABS_SAMPLE_RATE = 16000;

// Call ElevenLabs TTS. Returns { format, sampleRate, base64 } for Unity to play (PCM = no decoder needed).
async function elevenLabsTts(text: string): Promise<{ format: string; sampleRate: number; data: string } | null> {
  if (!ELEVENLABS_API_KEY || !text.trim()) return null;

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=pcm_${ELEVENLABS_SAMPLE_RATE}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "xi-api-key": ELEVENLABS_API_KEY,
      Accept: "application/octet-stream",
    },
    body: JSON.stringify({
      text: text.trim(),
      model_id: "eleven_multilingual_v2",
    }),
  });

  if (!res.ok) {
    console.warn("[ElevenLabs]", res.status, await res.text());
    return null;
  }

  const buf = new Uint8Array(await res.arrayBuffer());
  const b64 = Buffer.from(buf).toString("base64");
  return { format: "pcm", sampleRate: ELEVENLABS_SAMPLE_RATE, data: b64 };
}

// Simple entry point used by the main server.
// Sends a `{ type: "audio", npc, format, sampleRate, data }` message if everything succeeds.
export async function sendElevenLabsTts(
  ws: ServerWebSocket<unknown>,
  msg: any,
  rawResponse: string
): Promise<void> {
  const ttsText = textForTts(rawResponse);
  if (!ttsText) {
    console.log("[ElevenLabs] skip: no dialogue text after META strip");
    return;
  }
  if (!ELEVENLABS_API_KEY) {
    console.log("[ElevenLabs] skip: ELEVENLABS_API_KEY not set");
    return;
  }

  const result = await elevenLabsTts(ttsText);
  if (!result) return;

  const npc = msg.npc ?? "";
  ws.send(
    JSON.stringify({
      type: "audio",
      npc,
      format: result.format,
      sampleRate: result.sampleRate,
      data: result.data,
    })
  );
  console.log(`[ElevenLabs] sent audio for npc=${npc} (${(result.data.length / 1024).toFixed(1)} kB base64)`);
}

