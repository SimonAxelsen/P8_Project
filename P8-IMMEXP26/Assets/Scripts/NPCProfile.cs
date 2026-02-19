using UnityEngine;
using System;

[Serializable]
public class NPCProfile
{
    public string npcName = "New NPC";

    [TextArea(3, 10)] public string systemPrompt = "You are a helpful AI assistant.";
    [TextArea(3, 10)] public string contextPrompt;
    [TextArea(3, 10)] public string personalityTraits;

    [Header("Voice")]
    public string voiceModelName = "en_US-lessac-medium";

    [Header("LLM")]
    [Range(0f, 2f)] public float temperature = 0.7f;
    [Range(1f, 2f)] public float repeatPenalty = 1.1f;

    public string GetSystemPrompt()
    {
        string p = $"You are {npcName}. {systemPrompt}";
        if (!string.IsNullOrEmpty(personalityTraits)) p += $"\n\nPersonality: {personalityTraits}";
        if (!string.IsNullOrEmpty(contextPrompt))     p += $"\n\nContext: {contextPrompt}";
        return p;
    }
}

[CreateAssetMenu(fileName = "New NPC Profile", menuName = "AI/NPC Profile")]
public class NPCProfileAsset : ScriptableObject { public NPCProfile profile; }
