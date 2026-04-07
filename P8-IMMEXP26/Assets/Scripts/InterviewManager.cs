using UnityEngine;

/// <summary>
/// Manages interview session state (participant tracking, etc).
/// The SERVER orchestrates the actual interview phases and scoring logic via the gameData payload.
/// The CLIENT just displays what the server sends and doesn't try to replicate complex logic.
/// </summary>
public class InterviewManager : MonoBehaviour
{
    public static InterviewManager Instance { get; private set; }

    [Header("Interview Session")]
    [Tooltip("Stable identifier for this interview participant. Auto-generated if empty.")]
    public string participantId = "";

    [Tooltip("Evaluator model sent to Ollama for interview scoring.")]
    public string evaluatorModel = "qwen2.5:14b";

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
        return participantId;
    }

    /// <summary>
    /// Constructs a message to request interview evaluation from the server.
    /// The server will analyze the conversation log and score the candidate.
    /// </summary>
    public string CreateEvaluateMessage(string participantId = null, string model = null)
    {
        string targetParticipant = string.IsNullOrWhiteSpace(participantId) ? GetOrCreateParticipantId() : participantId;
        string targetModel = string.IsNullOrWhiteSpace(model) ? evaluatorModel : model;
        return $"{{\"type\": \"evaluate_interview\", \"participantId\": \"{targetParticipant}\", \"model\": \"{targetModel}\"}}";
    }
}