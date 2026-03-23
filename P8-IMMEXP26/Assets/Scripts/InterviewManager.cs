using UnityEngine;
using System.Collections.Generic;

/// <summary>
/// Manages the structured phases of the interview (Intro, Main, End).
/// Built to be scalable so more phases (e.g., "Technical Challenge", "Q&A") can be added easily.
/// </summary>
public class InterviewManager : MonoBehaviour
{
    public static InterviewManager Instance { get; private set; }

    public enum InterviewPhase
    {
        Intro,
        Main,
        End
    }

    [Header("Current State")]
    public InterviewPhase currentPhase = InterviewPhase.Intro;

    [Header("Interview Session")]
    [Tooltip("Stable identifier for this interview participant. Auto-generated if empty.")]
    public string participantId = "";

    [Tooltip("Evaluator model sent to Ollama for interview scoring.")]
    public string evaluatorModel = "qwen2.5:14b";

    // Instructions injected into the LLM system prompt based on the current phase
    private readonly Dictionary<InterviewPhase, string> phaseInstructions = new Dictionary<InterviewPhase, string>()
    {
        { InterviewPhase.Intro, "[CURRENT PHASE: INTRO] You are just starting the interview. Greet the candidate, introduce yourself, and briefly set the stage. Keep your response very short and welcoming." },
        { InterviewPhase.Main, "[CURRENT PHASE: MAIN] You are in the core of the interview. Ask the candidate questions about their experience, technical skills, or behavioral scenarios. Dig deep into their background." },
        { InterviewPhase.End, "[CURRENT PHASE: END] The interview is concluding. Thank the candidate for their time, ask if they have any final questions, and formally say goodbye." }
    };

    void Awake()
    {
        if (Instance == null)
        {
            Instance = this;
        }
        else
        {
            Destroy(gameObject);
        }
    }

    /// <summary>
    /// Gets the context string for the current phase to inject into the LLM prompt.
    /// </summary>
    public string GetPhaseContext()
    {
        if (phaseInstructions.TryGetValue(currentPhase, out string instruction))
        {
            return instruction;
        }
        return "";
    }

    /// <summary>
    /// Call this from UI, an event, or game logic to move the interview forward.
    /// </summary>
    public void SetPhase(InterviewPhase newPhase)
    {
        currentPhase = newPhase;
        Debug.Log($"[InterviewManager] Transitioned to phase: {newPhase}");
    }

    public string GetOrCreateParticipantId()
    {
        if (string.IsNullOrWhiteSpace(participantId))
        {
            participantId = $"participant_{System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        }

        return participantId;
    }

    public string BeginNewInterviewSession()
    {
        participantId = $"participant_{System.DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}";
        currentPhase = InterviewPhase.Intro;
        return participantId;
    }

    /// <summary>
    /// Constructs a message to stop tracking and evaluate the candidate in the backend server.
    /// You should send this payload via WebSocket when currentPhase transitions out or ends.
    /// </summary>
    public string CreateEvaluateMessage(string participantId, string model = "qwen2.5:14b")
    {
        return $"{{\"type\": \"evaluate_interview\", \"participantId\": \"{participantId}\", \"model\": \"{model}\"}}";
    }

    public string CreateEvaluateMessage()
    {
        return CreateEvaluateMessage(GetOrCreateParticipantId(), evaluatorModel);
    }
}