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
    private static readonly Regex FinalTtsTagOrBraceBlock = new Regex(@"\[[^\]]*\]|\{[^}]*\}", RegexOptions.Compiled);
    private static readonly Regex FinalTtsForbiddenChars = new Regex(@"[\[\]\{\}/]", RegexOptions.Compiled);
    private static readonly Regex MultiWhitespace = new Regex(@"\s{2,}", RegexOptions.Compiled);

    public bool isNVB = true;

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

        // --- NEW: Disable ConversationalGazeBrain on the parent if isNVB is false ---
        if (!isNVB)
        {
            ConversationalGazeBrain gazeBrain = GetComponentInParent<ConversationalGazeBrain>();
            if (gazeBrain != null)
            {
                gazeBrain.enabled = false;
            }
        }

        // Here we subscribe to the real-time backchannel events from the server!
        if (llm != null) llm.OnBackchannel += HandleRealTimeBackchannel;
    }

    public void Say(string userText)
{
    if (Profile == null) { Debug.LogWarning($"{name}: No NPC profile assigned!"); return; }
    
    // Let the Node.js server handle all the conversation history!
    // Just pass an empty string for the context.
    llm.Ask(userText, Profile, OnLlmResponse, "");
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

        Debug.Log($"<color=cyan>[{Profile.npcName} TTS INPUT]</color> {cleanDialogue}");
        if (conversationMemory != null) conversationMemory.StoreResponse(cleanDialogue);
        OnResponseReceived?.Invoke(cleanDialogue);

        GenerateAndPlay(cleanDialogue, timedTags);
    }

    async void GenerateAndPlay(string cleanText, List<TimedTag> timedTags)
    {
        AudioClip clip = null;

        if (llm != null && !llm.useElevenLabsAudio && piperManager != null)
        {
            string finalTtsText = BuildFinalTtsText(cleanText);

            if (string.IsNullOrEmpty(finalTtsText))
            {
                Debug.LogWarning($"{name}: TTS text is empty after final symbol filtering.");
            }
            else
            {
                Debug.Log($"<color=cyan>[{Profile.npcName} TTS FINAL]</color> {finalTtsText}");
                clip = await piperManager.TextToSpeech(finalTtsText);
                if (clip != null)
                {
                    audioSource.clip = clip;
                    audioSource.Play();
                }
            }
        }
        else if (audioSource.clip != null)
        {
            clip = audioSource.clip;
        }

        float duration = clip != null ? clip.length : 3.0f;
        StartCoroutine(PlayAnimationTimeline(timedTags, duration));
    }

    private string BuildFinalTtsText(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return string.Empty;

        string filtered = FinalTtsTagOrBraceBlock.Replace(text, " ");
        filtered = FinalTtsForbiddenChars.Replace(filtered, " ");
        filtered = MultiWhitespace.Replace(filtered, " ").Trim();
        return filtered;
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
        if (isNVB == true) {
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
                
                // --- NEW: explicitly catch the procedural neutral tag ---
                case "neutral":
                    // If you have a specific "return to idle" trigger, fire it here.
                    // Otherwise, the default block will try to find a parameter named "neutral".
                    FireAnimatorTrigger("neutral"); 
                    break;

                default:
                    FireAnimatorTrigger(tag);
                    break;
            }
        }
    }

    // ---REAL-TIME LISTENER LOGIC---
    private void HandleRealTimeBackchannel(string targetNpc, string action)
    {
        if (!isNVB) return;
        // Checks for name (HR, TECH e.g)
        if (Profile == null || !Profile.npcName.Contains(targetNpc)) return;

        Debug.Log($"<color=magenta>[Real-Time Backchannel]</color> {Profile.npcName} doing {action}");

        if (action == "NodSmall" || action == "nod_backchannel")
        {
            if (eyeContactIK != null) eyeContactIK.TriggerProceduralNod(1.2f);
            return;
        }

        FireAnimatorTrigger(action);
    }

    // --- UPDATED ANIMATOR TRIGGER LOGIC ---
    private void FireAnimatorTrigger(string triggerName)
    {
        if (animator == null) return;
        if (!HasTriggerParameter(triggerName))
        {
            Debug.LogWarning($"{name}: Animator missing trigger '{triggerName}'");
            return;
        }

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

    private bool HasTriggerParameter(string triggerName)
    {
        if (animator == null) return false;
        foreach (var parameter in animator.parameters)
        {
            if (parameter.type == AnimatorControllerParameterType.Trigger && parameter.name == triggerName)
            {
                return true;
            }
        }
        return false;
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
