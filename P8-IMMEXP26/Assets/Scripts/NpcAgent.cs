using UnityEngine;
using Piper;

/// <summary>
/// Attach to each NPC GameObject. Holds its own profile, audio, and talks to the shared LlmService.
/// Parses [META] non-verbal actions from LLM output and fires animator triggers.
/// </summary>
public class NpcAgent : MonoBehaviour
{
    public NPCProfileAsset profileAsset;
    public PiperManager piperManager;
    public Animator animator;

    [HideInInspector] public NPCProfile Profile => profileAsset != null ? profileAsset.profile : null;

    public System.Action<string> OnResponseReceived;
    public System.Action<NpcAction> OnActionReceived;

    private AudioSource audioSource;
    private LlmService llm;

    void Start()
    {
        llm = FindObjectOfType<LlmService>();
        audioSource = GetComponent<AudioSource>();
        if (audioSource == null) audioSource = gameObject.AddComponent<AudioSource>();
        if (animator == null)    animator = GetComponentInChildren<Animator>();
    }

    /// <summary>Send a user message to this agent's LLM personality.</summary>
    public void Say(string userText)
    {
        if (Profile == null) { Debug.LogWarning($"{name}: No NPC profile assigned!"); return; }
        llm.Ask(userText, Profile, OnLlmResponse);
    }

    void OnLlmResponse(string raw)
    {
        // RAW output (Ollama modelfile + NPC profile) — META tags visible for dev
        Debug.Log($"<color=yellow>[{Profile.npcName} RAW]</color> {raw}");

        var (action, dialogue) = NpcAction.Parse(raw);

        // Clean dialogue (META stripped) — this is what TTS will speak
        Debug.Log($"<color=cyan>[{Profile.npcName} TTS]</color> {dialogue}");

        ApplyAction(action);
        OnActionReceived?.Invoke(action);
        OnResponseReceived?.Invoke(dialogue);

        if (piperManager != null) Speak(dialogue);
    }

    void ApplyAction(NpcAction action)
    {
        if (animator == null || string.IsNullOrEmpty(action.animatorTrigger)) return;
        try { animator.SetTrigger(action.animatorTrigger); }
        catch { Debug.LogWarning($"{name}: Animator has no trigger '{action.animatorTrigger}'"); }
    }

    async void Speak(string text)
    {
        var clip = await piperManager.TextToSpeech(text);
        if (clip != null) { audioSource.clip = clip; audioSource.Play(); }
    }
}
