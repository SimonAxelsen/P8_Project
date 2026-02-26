using UnityEngine;
using System.Collections;
using Piper;

/// <summary>
/// Attach to each NPC GameObject. Holds profile, audio, and talks to LlmService.
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
    private Coroutine speakCoroutine;

    public bool IsSpeaking => audioSource != null && audioSource.isPlaying;

    void Start()
    {
        llm = FindObjectOfType<LlmService>();
        audioSource = GetComponent<AudioSource>();
        if (audioSource == null) audioSource = gameObject.AddComponent<AudioSource>();
        if (animator == null)    animator = GetComponentInChildren<Animator>();
    }

    /// <summary>Legacy single-shot: send text, get response, play TTS.</summary>
    public void Say(string userText)
    {
        if (Profile == null) return;
        llm.Ask(userText, Profile, raw =>
        {
            var (action, dialogue) = NpcAction.Parse(raw);
            ApplyAction(action);
            OnActionReceived?.Invoke(action);
            OnResponseReceived?.Invoke(dialogue);
            if (piperManager != null) SpeakFire(dialogue);
        });
    }

    public void ApplyAction(NpcAction action)
    {
        if (animator == null || string.IsNullOrEmpty(action.animatorTrigger)) return;
        try { animator.SetTrigger(action.animatorTrigger); }
        catch { Debug.LogWarning($"{name}: No trigger '{action.animatorTrigger}'"); }
    }

    /// <summary>Fire-and-forget TTS (for legacy Say flow).</summary>
    async void SpeakFire(string text)
    {
        var clip = await piperManager.TextToSpeech(text);
        if (clip != null) { audioSource.clip = clip; audioSource.Play(); }
    }

    /// <summary>TTS with completion callback. Used by ConversationManager.</summary>
    public void SpeakWithCallback(string text, System.Action onComplete)
    {
        if (piperManager == null) { onComplete?.Invoke(); return; }
        if (speakCoroutine != null) StopCoroutine(speakCoroutine);
        speakCoroutine = StartCoroutine(SpeakAndWait(text, onComplete));
    }

    IEnumerator SpeakAndWait(string text, System.Action onComplete)
    {
        var task = piperManager.TextToSpeech(text);
        while (!task.IsCompleted) yield return null;

        var clip = task.Result;
        if (clip != null)
        {
            audioSource.clip = clip;
            audioSource.Play();
            while (audioSource.isPlaying) yield return null;
        }
        onComplete?.Invoke();
    }
}
