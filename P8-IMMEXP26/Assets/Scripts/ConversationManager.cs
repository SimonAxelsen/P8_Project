using UnityEngine;
using System.Collections;

/// <summary>
/// Orchestrates a 1v2 interview conversation.
/// Player speaks → server picks NPC + responds (one round trip) → TTS plays → Idle.
/// </summary>
public class ConversationManager : MonoBehaviour
{
    [Header("Interviewers")]
    public NpcAgent npcA;
    public NpcAgent npcB;

    [Header("Eye Contact")]
    public Transform playerTransform;

    public enum State { Idle, WaitingForLLM, Speaking }
    [HideInInspector] public State CurrentState = State.Idle;
    public bool IsBusy => CurrentState != State.Idle;

    private string sessionId;
    private LlmService llm;

    void Start()
    {
        llm = FindObjectOfType<LlmService>();
        sessionId = System.Guid.NewGuid().ToString();
    }

    public void HandlePlayerInput(string playerText)
    {
        if (IsBusy) return;
        if (npcA == null || npcB == null || npcA.Profile == null || npcB.Profile == null)
        { Debug.LogError("[Conversation] Assign both NPC agents!"); return; }

        CurrentState = State.WaitingForLLM;
        SetGaze(npcA, playerTransform);
        SetGaze(npcB, playerTransform);

        llm.AskConversation(sessionId, playerText, npcA.Profile, npcB.Profile, (npcName, raw) =>
        {
            NpcAgent speaker = PickAgent(npcName) ?? npcA;
            NpcAgent listener = speaker == npcA ? npcB : npcA;

            var (action, dialogue) = NpcAction.Parse(raw);
            Debug.Log($"<color=cyan>[{speaker.Profile.npcName}]</color> {dialogue}");

            speaker.ApplyAction(action);
            speaker.OnActionReceived?.Invoke(action);
            speaker.OnResponseReceived?.Invoke(dialogue);

            SetGaze(listener, speaker.transform);
            SetGaze(speaker, playerTransform);

            CurrentState = State.Speaking;
            speaker.SpeakWithCallback(dialogue, () =>
            {
                SetGaze(npcA, playerTransform);
                SetGaze(npcB, playerTransform);
                CurrentState = State.Idle;
            });
        });
    }

    NpcAgent PickAgent(string name)
    {
        if (name == null) return null;
        string lower = name.ToLowerInvariant();
        if (npcA.Profile != null && lower.Contains(npcA.Profile.npcName.ToLowerInvariant())) return npcA;
        if (npcB.Profile != null && lower.Contains(npcB.Profile.npcName.ToLowerInvariant())) return npcB;
        return null;
    }

    void SetGaze(NpcAgent agent, Transform target)
    {
        if (agent == null || target == null) return;
        var ik = agent.GetComponent<EyeContactIK>();
        if (ik != null) ik.target = target;
    }

    public void ResetSession()
    {
        sessionId = System.Guid.NewGuid().ToString();
        CurrentState = State.Idle;
    }
}
