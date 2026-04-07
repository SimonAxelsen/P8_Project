using UnityEngine;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Piper;

public class NpcAgent : MonoBehaviour
{
    public NPCProfileAsset profileAsset;
    public PiperManager piperManager;
    public Animator animator;
    public EyeContactIK eyeContactIK;

    [Header("Facial Blendshapes")]
    public SkinnedMeshRenderer faceMesh;
    [Tooltip("Type the exact names of the Reallusion smile blendshapes here (e.g., Mouth_Smile_L, Mouth_Smile_R)")]
    public string[] smileBlendshapes = new string[] { "Mouth_Smile_L", "Mouth_Smile_R" };
    [Tooltip("Reallusion blendshapes usually go from 0 to 100")]
    public float smileIntensity = 60f;

    [HideInInspector] public NPCProfile Profile => profileAsset != null ? profileAsset.profile : null;

    public System.Action<string> OnResponseReceived;

    private AudioSource audioSource;
    private LlmService llm;
    private ConversationMemory conversationMemory;

    // --- NEW: ANIMATION VARIATION DICTIONARY ---
    // Define how many variations each trigger has. 
    // Example: "gesture_mephoric", 3 means it rolls between 0, 1, and 2.
    private Dictionary<string, int> animationVariations = new Dictionary<string, int>()
    {
        { "gesture_explain", 5 }, 
    };

    private struct TimedTag
    {
        public string triggerName;
        public float relativePosition;
    }

    void Start()
    {
        llm = FindObjectOfType<LlmService>();
        conversationMemory = GetComponent<ConversationMemory>();
        audioSource = GetComponent<AudioSource>();
        if (audioSource == null) audioSource = gameObject.AddComponent<AudioSource>();
        if (animator == null) animator = GetComponentInChildren<Animator>();
        if (eyeContactIK == null) eyeContactIK = GetComponent<EyeContactIK>();

        // Here we subscribe to the real-time backchannel events from the server!
        if (llm != null) llm.OnBackchannel += HandleRealTimeBackchannel;
    }

    public void Say(string userText)
    {
        if (Profile == null) { Debug.LogWarning($"{name}: No NPC profile assigned!"); return; }
        
        // Store the question immediately
        if (conversationMemory != null) conversationMemory.StoreQuestion(userText);
        
        // Get conversation context to add to the prompt for more natural responses
        string context = conversationMemory != null ? conversationMemory.GetContextForPrompt() : "";
        
        // Pass context to the LLM so it understands the conversation history
        llm.Ask(userText, Profile, OnLlmResponse, context);
    }

    public void OnLlmResponse(string raw)
    {
        Debug.Log($"<color=yellow>[{Profile.npcName} RAW]</color> {raw}");

        string textWithoutState = Regex.Replace(raw, @"\[STATE\].*?\[/STATE\]", "").Trim();
        List<TimedTag> timedTags = new List<TimedTag>();
        string cleanDialogue = textWithoutState;

        Regex tagRegex = new Regex(@"\[([a-z_]+)\]");
        MatchCollection matches = tagRegex.Matches(textWithoutState);

        int removedCharacters = 0;

        foreach (Match match in matches)
        {
            string tagName = match.Groups[1].Value;
            int cleanIndex = match.Index - removedCharacters;
            timedTags.Add(new TimedTag { triggerName = tagName, relativePosition = cleanIndex });
            removedCharacters += match.Length;
        }

        cleanDialogue = tagRegex.Replace(textWithoutState, "").Trim();

        for (int i = 0; i < timedTags.Count; i++)
        {
            var tag = timedTags[i];
            tag.relativePosition = Mathf.Clamp01(tag.relativePosition / (float)Mathf.Max(1, cleanDialogue.Length));
            timedTags[i] = tag;
        }

        Debug.Log($"<color=cyan>[{Profile.npcName} TTS]</color> {cleanDialogue}");
        if (conversationMemory != null) conversationMemory.StoreResponse(cleanDialogue);
        OnResponseReceived?.Invoke(cleanDialogue);

        GenerateAndPlay(cleanDialogue, timedTags);
    }

    async void GenerateAndPlay(string cleanText, List<TimedTag> timedTags)
    {
        AudioClip clip = null;

        if (llm != null && !llm.useElevenLabsAudio && piperManager != null)
        {
            clip = await piperManager.TextToSpeech(cleanText);
            if (clip != null)
            {
                audioSource.clip = clip;
                audioSource.Play();
            }
        }
        else if (audioSource.clip != null)
        {
            clip = audioSource.clip;
        }

        float duration = clip != null ? clip.length : 3.0f;
        StartCoroutine(PlayAnimationTimeline(timedTags, duration));
    }

    IEnumerator PlayAnimationTimeline(List<TimedTag> tags, float audioDuration)
    {
        float timer = 0f;
        int currentTagIndex = 0;

        while (timer < audioDuration && currentTagIndex < tags.Count)
        {
            timer += Time.deltaTime;
            float currentProgress = timer / audioDuration;

            if (currentProgress >= tags[currentTagIndex].relativePosition)
            {
                string triggerToFire = tags[currentTagIndex].triggerName;
                HandleActionTag(triggerToFire);
                currentTagIndex++;
            }
            yield return null;
        }
    }

    private void HandleActionTag(string tag)
    {
        switch (tag)
        {
            case "nod_backchannel":
                if (eyeContactIK != null) eyeContactIK.TriggerProceduralNod(1.2f);
                break;

            case "gaze_aversion":
                if (eyeContactIK != null) eyeContactIK.TriggerProceduralGazeAversion(2.5f);
                break;

            case "smile_polite":
                if (faceMesh != null) StartCoroutine(SmileRoutine(2.0f));
                break;

            default:
                FireAnimatorTrigger(tag);
                break;
        }
    }

    // ---REAL-TIME LISTENER LOGIC---
    private void HandleRealTimeBackchannel(string targetNpc, string action)
    {
        // Checks for name (HR, TECH e.g)
        if (Profile == null || !Profile.npcName.Contains(targetNpc)) return;

        Debug.Log($"<color=magenta>[Real-Time Backchannel]</color> {Profile.npcName} doing {action}");

        if (action == "NodSmall" || action == "nod_backchannel")
        {
            if (eyeContactIK != null) eyeContactIK.TriggerProceduralNod(1.2f);
        }
    }

    // --- UPDATED ANIMATOR TRIGGER LOGIC ---
    private void FireAnimatorTrigger(string triggerName)
    {
        if (animator != null)
        {
            try 
            { 
                // 1. Check if the tag has random variations defined in our Dictionary
                if (animationVariations.TryGetValue(triggerName, out int variationCount))
                {
                    // 2. Roll a random number
                    int randomIndex = Random.Range(0, variationCount);
                    
                    // 3. Set the universal VariationIndex parameter
                    animator.SetInteger("VariationIndex", randomIndex);
                    
                    Debug.Log($"[Animator] Randomizing '{triggerName}' - Rolled Index: {randomIndex}");
                }

                // 4. Fire the trigger (whether it was randomized or not)
                animator.SetTrigger(triggerName); 
            }
            catch 
            { 
                Debug.LogWarning($"{name}: Animator missing trigger '{triggerName}'"); 
            }
        }
    }

    private IEnumerator TemporarilyDisableIK(float duration)
    {
        eyeContactIK.SmoothTransitionWeight(0f, 0.2f);
        yield return new WaitForSeconds(duration);
        eyeContactIK.SmoothTransitionWeight(1f, 0.5f);
    }

    // --- SMILE LOGIC ---
    private IEnumerator SmileRoutine(float holdTime)
    {
        float t = 0;
        float transitionSpeed = 0.35f; // How fast the smile forms

        // 1. Find the exact indices for the blendshapes on the mesh
        List<int> validIndices = new List<int>();
        foreach (string shapeName in smileBlendshapes)
        {
            int idx = faceMesh.sharedMesh.GetBlendShapeIndex(shapeName);
            if (idx != -1) validIndices.Add(idx);
            else Debug.LogWarning($"Blendshape '{shapeName}' not found on {faceMesh.name}");
        }

        if (validIndices.Count == 0) yield break;

        // 2. Lerp Up (Ease In)
        while (t < transitionSpeed)
        {
            t += Time.deltaTime;
            float currentWeight = Mathf.Lerp(0, smileIntensity, t / transitionSpeed);
            foreach (int idx in validIndices) faceMesh.SetBlendShapeWeight(idx, currentWeight);
            yield return null;
        }

        // 3. Hold the smile
        yield return new WaitForSeconds(holdTime);

        // 4. Lerp Down (Ease Out)
        t = 0;
        while (t < transitionSpeed)
        {
            t += Time.deltaTime;
            float currentWeight = Mathf.Lerp(smileIntensity, 0, t / transitionSpeed);
            foreach (int idx in validIndices) faceMesh.SetBlendShapeWeight(idx, currentWeight);
            yield return null;
        }

        // 5. Ensure it is perfectly zeroed out to zero 0.
        foreach (int idx in validIndices) faceMesh.SetBlendShapeWeight(idx, 0);
    }

    void OnDestroy()
    {
        if (llm != null) llm.OnBackchannel -= HandleRealTimeBackchannel;
    }
}