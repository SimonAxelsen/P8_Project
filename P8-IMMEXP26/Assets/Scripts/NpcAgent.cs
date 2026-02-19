using UnityEngine;
using Piper;

/// <summary>
/// Attach to each NPC GameObject. Holds its own profile, audio, and talks to the shared LlmService.
/// </summary>
public class NpcAgent : MonoBehaviour
{
    public NPCProfileAsset profileAsset;
    public PiperManager piperManager;

    [HideInInspector] public NPCProfile Profile => profileAsset != null ? profileAsset.profile : null;

    public System.Action<string> OnResponseReceived;

    private AudioSource audioSource;
    private LlmService llm;

    void Start()
    {
        llm = FindObjectOfType<LlmService>();
        audioSource = GetComponent<AudioSource>();
        if (audioSource == null) audioSource = gameObject.AddComponent<AudioSource>();
    }

    /// <summary>Send a user message to this agent's LLM personality.</summary>
    public void Say(string userText)
    {
        if (Profile == null) { Debug.LogWarning($"{name}: No NPC profile assigned!"); return; }
        llm.Ask(userText, Profile, OnLlmResponse);
    }

    void OnLlmResponse(string response)
    {
        Debug.Log($"<color=cyan>[{Profile.npcName}]</color> {response}");
        OnResponseReceived?.Invoke(response);

        if (piperManager != null) Speak(response);
    }

    async void Speak(string text)
    {
        var clip = await piperManager.TextToSpeech(text);
        if (clip != null) { audioSource.clip = clip; audioSource.Play(); }
    }
}
