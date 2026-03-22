export type QueryFunction = (body: {
  model: string;
  prompt: string;
  system?: string;
  options?: Record<string, number>;
}) => Promise<string>;

type ChatLogEntry = {
  participantId?: string;
  role?: "user" | "assistant";
  prompt?: string;
  response?: string;
};

export type InterviewEvaluation = {
  score: number;
  strengthsParagraph: string;
  weaknessesParagraph: string;
};

export type InterviewEvaluationOutput = {
  participantId: string;
  evaluation: InterviewEvaluation;
  raw: string;
  model: string;
  transcriptTurns: number;
};

function findMostRecentParticipantId(lines: string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (!line) continue;

    let entry: ChatLogEntry;
    try {
      entry = JSON.parse(line) as ChatLogEntry;
    } catch {
      continue;
    }

    const participantId = entry.participantId?.trim();
    if (!participantId || participantId === "unknown") continue;

    if (entry.role) {
      return participantId;
    }
  }

  return null;
}

function extractLikelyJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) return raw.slice(first, last + 1).trim();

  return null;
}

function normalizeEvaluation(parsed: unknown): InterviewEvaluation {
  const obj = (parsed && typeof parsed === "object") ? (parsed as Record<string, unknown>) : {};

  const rawScore = typeof obj.score === "number" ? obj.score : Number(obj.score ?? 0);
  const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(100, Math.round(rawScore))) : 0;

  const pickText = (value: unknown, fallback: string) =>
    typeof value === "string" && value.trim().length > 0 ? value : fallback;

  return {
    score,
    strengthsParagraph: pickText(obj.strengthsParagraph, "No strengths summary returned."),
    weaknessesParagraph: pickText(obj.weaknessesParagraph, "No weaknesses summary returned."),
  };
}

function parseEvaluationResponse(raw: string): InterviewEvaluation {
  const candidate = extractLikelyJson(raw);
  if (!candidate) throw new Error("Evaluator did not return JSON.");

  const parsed = JSON.parse(candidate) as unknown;
  return normalizeEvaluation(parsed);
}

export async function evaluateInterview(
  participantId: string | undefined,
  logFile: string,
  queryFn: QueryFunction,
  evaluatorModel: string = "qwen2.5:14b"
): Promise<InterviewEvaluationOutput> {
  const logsText = await Bun.file(logFile).text();
  const lines = logsText.split("\n").filter((line) => line.trim().length > 0);

  const selectedParticipantId =
    typeof participantId === "string" && participantId.trim().length > 0
      ? participantId.trim()
      : findMostRecentParticipantId(lines);

  if (!selectedParticipantId) {
    throw new Error("No participant found in chat_log for evaluation.");
  }

  const transcript: string[] = [];

  for (const line of lines) {
    let entry: ChatLogEntry;
    try {
      entry = JSON.parse(line) as ChatLogEntry;
    } catch {
      continue;
    }

    if (entry.participantId !== selectedParticipantId) continue;

    if (entry.role === "user" && typeof entry.prompt === "string" && entry.prompt.trim().length > 0) {
      transcript.push(`CANDIDATE: ${entry.prompt}`);
    } else if (entry.role === "assistant" && typeof entry.response === "string" && entry.response.trim().length > 0) {
      transcript.push(`INTERVIEWER: ${entry.response}`);
    }
  }

  if (transcript.length === 0) {
    throw new Error(`No transcript found in chat_log for participantId: ${selectedParticipantId}`);
  }

  const transcriptText = transcript.join("\n");

  const systemPrompt = `You are an interview evaluation agent.
Your only goal is to grade the participant and provide:
1) score (0-100)
2) one short strengths paragraph
3) one short weaknesses paragraph

Return strictly as JSON with this exact schema:
{
  "score": 0,
  "strengthsParagraph": "...",
  "weaknessesParagraph": "..."
}`;

  const evalPrompt = `Evaluate this participant transcript:\n\n${transcriptText}\n\nReturn only JSON.`;

  const response = await queryFn({
    model: evaluatorModel,
    system: systemPrompt,
    prompt: evalPrompt,
    options: {
      temperature: 0.1,
    },
  });

  return {
    participantId: selectedParticipantId,
    evaluation: parseEvaluationResponse(response),
    raw: response,
    model: evaluatorModel,
    transcriptTurns: transcript.length,
  };
}
