using UnityEngine;
using System.Collections;

public class SimulationStarter : MonoBehaviour
{
    [Header("References")]
    [Tooltip("Drag your LlmService GameObject here")]
    public LlmService llmService;

    // FIX: We changed this from NPCProfile to NpcAgent!
    [Tooltip("Drag your HR Character GameObject from the scene here")]
    public NpcAgent hrAgent;

    [Header("Connection Settings")]
    [Tooltip("Maximum time to wait for connection (seconds)")]
    public float connectionTimeout = 10f;

    void Start()
    {
        // Subscribe to connection events
        if (llmService != null)
        {
            llmService.OnConnected += OnServerConnected;
            llmService.OnDisconnected += OnServerDisconnected;
        }
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
        Debug.Log("<color=cyan>[SYSTEM] Begin Interview button pressed...</color>");

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
        llmService.Ask("[KICKOFF]", hrAgent.Profile, null);
        
        // Turn off the start button so the user can't click it twice
        gameObject.SetActive(false);
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
        
        // Re-enable button so user can try again
        // gameObject.SetActive(true); // Optional: uncomment if you want to allow retry
    }
}