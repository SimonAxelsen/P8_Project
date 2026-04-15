using UnityEngine;
using uLipSync;

[RequireComponent(typeof(EyeContactIK))]
public class ConversationalGazeBrain : MonoBehaviour
{
    private EyeContactIK ikController;
    
    [Header("Audio Sources")]
    public uLipSync.uLipSync myLipSync;
    public uLipSync.uLipSync coAgentLipSync;

    [Header("Settings")]
    public float speakingThreshold = 0.01f;
    public float gazeSpeed = 3f;
    
    [Tooltip("How long to wait during audio pauses before assuming they stopped talking")]
    public float silenceHoldTime = 0.5f; 

    private float coAgentSilenceTimer = 0f;
    private float mySilenceTimer = 0f;
    private float nextStateChangeTime;
    
    // The master variable the brain decides on
    private float targetGaze = 0f; 
    private bool isCurrentlyAverting = false;

    void Start()
    {
        ikController = GetComponent<EyeContactIK>();
        nextStateChangeTime = Time.time + Random.Range(3f, 6f);
    }

    void Update()
    {
        // 1. SMOOTH THE AUDIO (Fixes Culprit 2)
        bool amIMakingNoise = myLipSync.result.rawVolume > speakingThreshold;
        bool isCoAgentMakingNoise = coAgentLipSync.result.rawVolume > speakingThreshold;

        if (amIMakingNoise) mySilenceTimer = 0f;
        else mySilenceTimer += Time.deltaTime;

        if (isCoAgentMakingNoise) coAgentSilenceTimer = 0f;
        else coAgentSilenceTimer += Time.deltaTime;

        // They are officially "speaking" if they are making noise OR in a micro-pause
        bool amISpeaking = mySilenceTimer < silenceHoldTime;
        bool isCoAgentSpeaking = coAgentSilenceTimer < silenceHoldTime;


        // 2. DECIDE THE TARGET GAZE
        if (isCoAgentSpeaking && !amISpeaking)
        {
            // Active Listening: Look at Co-Agent (1), occasionally avert to User (0)
            HandleGazeLogic(baseTarget: 1f, aversionTarget: 0f, minWait: 4f, maxWait: 8f, aversionDuration: 1.5f);
        }
        else
        {
            // I am speaking, OR nobody is talking. Lock onto the User (0).
            targetGaze = 0f;
            isCurrentlyAverting = false; // Reset the state so it doesn't break future logic
        }

        // 3. APPLY THE SMOOTH MOVEMENT
        ikController.gazeBlend = Mathf.Lerp(ikController.gazeBlend, targetGaze, Time.deltaTime * gazeSpeed);
    }

    // A helper function to handle the timer logic cleanly
    private void HandleGazeLogic(float baseTarget, float aversionTarget, float minWait, float maxWait, float aversionDuration)
    {
        if (!isCurrentlyAverting)
        {
            targetGaze = baseTarget; // Look at our main target

            // Is it time to look away?
            if (Time.time > nextStateChangeTime)
            {
                isCurrentlyAverting = true;
                nextStateChangeTime = Time.time + aversionDuration; // How long to look away
            }
        }
        else
        {
            targetGaze = aversionTarget; // Look away

            // Is it time to look back?
            if (Time.time > nextStateChangeTime)
            {
                isCurrentlyAverting = false;
                nextStateChangeTime = Time.time + Random.Range(minWait, maxWait); // How long until next aversion
            }
        }
    }
}