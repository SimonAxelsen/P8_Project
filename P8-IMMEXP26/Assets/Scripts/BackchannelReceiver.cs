using UnityEngine;

public class BackchannelReceiver : MonoBehaviour
{
    public NpcAgent hrAgent;
    public NpcAgent techAgent;

    LlmService llm;

    void Start()
    {
        llm = FindFirstObjectByType<LlmService>();
        llm.OnBackchannel += HandleBackchannel;
    }

    void OnDestroy()
    {
        if (llm != null) llm.OnBackchannel -= HandleBackchannel;
    }

    void HandleBackchannel(string npc, string action)
    {
        var agent = (npc == "HR") ? hrAgent : techAgent;
        if (agent == null || agent.animator == null) return;

        // Minimal safety: don�t do anything if the agent is currently speaking
        // (optional: add a speaking flag to NpcAgent later)
        agent.animator.SetTrigger(action);
    }
}