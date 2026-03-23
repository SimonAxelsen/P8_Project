using UnityEngine;

public class SimulationStarter : MonoBehaviour
{
    [Header("References")]
    [Tooltip("Drag your LlmService GameObject here")]
    public LlmService llmService;

    // FIX: We changed this from NPCProfile to NpcAgent!
    [Tooltip("Drag your HR Character GameObject from the scene here")]
    public NpcAgent hrAgent;

    public void BeginInterview()
    {
        Debug.Log("<color=cyan>[SYSTEM] Sending Kickoff to the server...</color>");

        // We just grab the profile straight off the HR agent in your scene!
        llmService.Ask("[KICKOFF]", hrAgent.Profile, null);

        // Turn off the start button so the user can't click it twice
        gameObject.SetActive(false);
    }
}