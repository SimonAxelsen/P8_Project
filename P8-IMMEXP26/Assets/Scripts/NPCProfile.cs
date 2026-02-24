using UnityEngine;
using System;

/// <summary>
/// NPC identity including personality, system prompt, and runtime tweaks
/// editable in the Inspector. The system prompt is built per-NPC and sent
/// to the relay server at runtime.
/// </summary>
[Serializable]
public class NPCProfile
{
    public string npcName = "New NPC";

    [Header("Ollama Model")]
    [Tooltip("Name of the Ollama model created via Modelfile (contains general instructions like META format)")]
    public string modelName = "npc-base";

    [Header("NPC Personality")]
    [TextArea(3, 10)] public string systemPrompt = "You are a helpful AI assistant.";
    [TextArea(3, 10)] public string contextPrompt;
    [TextArea(3, 10)] public string personalityTraits;

    [Header("Voice")]
    public string voiceModelName = "en_US-lessac-medium";

    [Header("LLM Overrides")]
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
