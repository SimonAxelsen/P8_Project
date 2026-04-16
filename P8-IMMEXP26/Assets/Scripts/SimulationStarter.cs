using UnityEngine;
using System.Collections;

public class SimulationStarter : MonoBehaviour
{
    [Header("References")]
    [Tooltip("Drag your LlmService GameObject here")]
    public LlmService llmService;

    [Tooltip("Drag your HR Character GameObject from the scene here")]
    public NpcAgent hrAgent;

    [Header("Connection Settings")]
    [Tooltip("Maximum time to wait for connection (seconds)")]
    public float connectionTimeout = 10f;
    
    // NEW: The bool you suggested!
    [Tooltip("If true, the interview will automatically kickoff as soon as the scene loads")]
    public bool autoStartOnAwake = true; 

    void Start()
    {
        // Subscribe to connection events
        if (llmService != null)
        {
            llmService.OnConnected += OnServerConnected;
            llmService.OnDisconnected += OnServerDisconnected;
        }

        // NEW: Trigger the delayed start instead of an instant start
        if (autoStartOnAwake)
        {
            StartCoroutine(DelayedKickoff());
        }
    }

    // This gives your other scripts time to fully initialize!
    IEnumerator DelayedKickoff()
    {
        yield return new WaitForSeconds(1f); // Wait for 1 second
        BeginInterview();
    }

    void OnDestroy()
    {
        if (llmService != null)
        {
            llmService.OnConnected -= OnServerConnected;
            llmService.OnDisconnected -= OnServerDisconnected;
        }
    }

    void OnServerConnected()
    {
        Debug.Log("<color=green>[SimulationStarter] Server connected! Ready to begin interview.</color>");
    }

    void OnServerDisconnected()
    {
        Debug.LogWarning("<color=orange>[SimulationStarter] Server disconnected!</color>");
    }

    public void BeginInterview()
    {
        Debug.Log("<color=cyan>[SYSTEM] Begin Interview triggered...</color>");

        // Check if connected
        if (llmService != null && llmService.IsConnected)
        {
            StartInterviewImmediately();
        }
        else
        {
            Debug.LogWarning("<color=yellow>[SimulationStarter] Server not connected yet. Waiting...</color>");
            StartCoroutine(WaitForConnectionThenStart());
        }
    }

    void StartInterviewImmediately()
    {
        Debug.Log("<color=cyan>[SYSTEM] Sending Kickoff to the server...</color>");
        llmService.Ask("[KICKOFF]", hrAgent.Profile, response => { });
        
        // I commented this out! Since you aren't using a UI button anymore,
        // turning off the gameObject might break your LLM Service or other scripts attached to it.
        // gameObject.SetActive(false); 
    }

    IEnumerator WaitForConnectionThenStart()
    {
        float elapsed = 0f;
        
        while (elapsed < connectionTimeout)
        {
            if (llmService != null && llmService.IsConnected)
            {
                Debug.Log("<color=green>[SimulationStarter] Connection established! Starting interview...</color>");
                StartInterviewImmediately();
                yield break;
            }
            
            elapsed += 0.1f;
            yield return new WaitForSeconds(0.1f);
        }
        
        // Timeout reached
        Debug.LogError($"<color=red>[SimulationStarter] Connection timeout after {connectionTimeout}s. Please check your server URL and ensure the server is running.</color>");
    }
}