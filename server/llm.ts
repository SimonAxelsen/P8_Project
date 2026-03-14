const ENV = ((globalThis as any).process?.env ?? (globalThis as any).Bun?.env ?? {}) as Record<string, string | undefined>;
const OLLAMA_URL = ENV.OLLAMA_URL ?? "http://localhost:11434/api/generate";

export async function streamOllama(body: { model: string; prompt: string; system?: string; options?: Record<string, number> }, onChunk: (text: string, isFinal: boolean) => void) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, stream: true, keep_alive: "1h" }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  if (!res.body) return;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    const chunk = decoder.decode(value, { stream: true });
    // Ollama streams JSON objects separated by newlines
    buffer += chunk;
    const lines = buffer.split('\n');

    // We only process complete lines, leave the last incomplete line in buffer 
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        onChunk(parsed.response || "", !!parsed.done);
      } catch (e) { }
    }
  }
}

export function parseLlmResponse(rawText: string) {
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
