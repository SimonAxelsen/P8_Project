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

    private struct TimedTag
    {
        public string triggerName;
        public float relativePosition;
    }

    private struct AudioClipInfo
    {
        public AudioClip clip;
        public List<TimedTag> tags;
        public string originalText;
    }

    private Queue<string> chunkQueue = new Queue<string>();
    private Queue<AudioClipInfo> audioQueue = new Queue<AudioClipInfo>();
    private bool isGeneratingTts = false;
    private bool isPlayingAudio = false;

    void Start()
    {
        llm = FindFirstObjectByType<LlmService>();
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
        if (llm == null) { Debug.LogWarning($"{name}: No LlmService found in scene!"); return; }
        llm.Ask(userText, Profile, OnLlmChunk);
    }

    void OnLlmChunk(string chunk, bool isFinal)
    {
        if (string.IsNullOrWhiteSpace(chunk)) return;

        Debug.Log($"<color=yellow>[{Profile.npcName} CHUNK]</color> {chunk}");
        chunkQueue.Enqueue(chunk);

        if (!isGeneratingTts)
        {
            GenerateTtsLoop();
        }
    }

    async void GenerateTtsLoop()
    {
        isGeneratingTts = true;

        while (true)
        {
            if (chunkQueue.Count == 0)
            {
                isGeneratingTts = false;
                if (chunkQueue.Count == 0) break;
                isGeneratingTts = true;
            }

            string rawChunk = chunkQueue.Dequeue();
            
            // Extract tags
            List<TimedTag> timedTags = new List<TimedTag>();
            string cleanDialogue = rawChunk;

            Regex tagRegex = new Regex(@"\[([a-z_]+)\]");
            MatchCollection matches = tagRegex.Matches(rawChunk);

            int removedCharacters = 0;
            foreach (Match match in matches)
            {
                string tagName = match.Groups[1].Value;
                int cleanIndex = match.Index - removedCharacters;
                timedTags.Add(new TimedTag { triggerName = tagName, relativePosition = cleanIndex });
                removedCharacters += match.Length;
            }

            cleanDialogue = tagRegex.Replace(rawChunk, "").Trim();

            for (int i = 0; i < timedTags.Count; i++)
            {
                var tag = timedTags[i];
                tag.relativePosition = Mathf.Clamp01(tag.relativePosition / (float)Mathf.Max(1, cleanDialogue.Length));
                timedTags[i] = tag;
            }

            AudioClip clip = null;
            if (llm != null && !llm.useElevenLabsAudio && piperManager != null && !string.IsNullOrEmpty(cleanDialogue))
            {
                clip = await piperManager.TextToSpeech(cleanDialogue);
            }
            
            if (clip != null)
            {
                audioQueue.Enqueue(new AudioClipInfo { clip = clip, tags = timedTags, originalText = cleanDialogue });
                
                if (!isPlayingAudio)
                {
                    StartCoroutine(PlayAudioLoop());
                }
            }
        }

        isGeneratingTts = false;
    }

    IEnumerator PlayAudioLoop()
    {
        isPlayingAudio = true;

        while (true)
        {
            if (audioQueue.Count == 0)
            {
                isPlayingAudio = false;
                if (audioQueue.Count == 0) yield break;
                isPlayingAudio = true;
            }

            var info = audioQueue.Dequeue();
            
            Debug.Log($"<color=cyan>[{Profile.npcName} TTS]</color> {info.originalText}");
            OnResponseReceived?.Invoke(info.originalText);

            audioSource.clip = info.clip;
            audioSource.Play();

            // Run timeline for this specific chunk
            StartCoroutine(PlayAnimationTimeline(info.tags, info.clip.length));

            // Wait for clip to finish before playing next
            yield return new WaitForSeconds(info.clip.length);
        }
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

    private void FireAnimatorTrigger(string triggerName)
    {
        if (animator != null)
        {
            try { animator.SetTrigger(triggerName); }
            catch { Debug.LogWarning($"{name}: Animator missing trigger '{triggerName}'"); }
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