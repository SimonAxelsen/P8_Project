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
}