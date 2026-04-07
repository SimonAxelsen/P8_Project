using UnityEngine;

/// <summary>
/// Simple conversation memory system that tracks the latest question and answer exchange.
/// Can be queried to provide context about the last interaction.
/// </summary>
public class ConversationMemory : MonoBehaviour
{
    private string lastUserQuestion = "";
    private string lastNpcResponse = "";

    /// <summary>
    /// Store the user's question (called when asking the NPC).
    /// </summary>
    public void StoreQuestion(string userQuestion)
    {
        lastUserQuestion = userQuestion;
    }

    /// <summary>
    /// Store the NPC's response.
    /// </summary>
    public void StoreResponse(string npcResponse)
    {
        lastNpcResponse = npcResponse;
        Debug.Log($"<color=green>[ConversationMemory]</color> Stored exchange - Q: {lastUserQuestion} | A: {npcResponse}");
    }

    /// <summary>
    /// Store a question-answer exchange in memory.
    /// </summary>
    public void StoreExchange(string userQuestion, string npcResponse)
    {
        lastUserQuestion = userQuestion;
        lastNpcResponse = npcResponse;
        
        Debug.Log($"<color=green>[ConversationMemory]</color> Stored exchange - Q: {userQuestion} | A: {npcResponse}");
    }

    /// <summary>
    /// Get the last conversation exchange formatted as a string for LLM context.
    /// Returns empty string if no history exists.
    /// </summary>
    public string GetContextForPrompt()
    {
        if (string.IsNullOrEmpty(lastUserQuestion))
            return "";

        // Format for the LLM to understand context naturally
        return $"[CONVERSATION CONTEXT]\nPrevious exchange:\nUser: {lastUserQuestion}\nAssistant: {lastNpcResponse}\n[/CONVERSATION CONTEXT]\n";
    }

    /// <summary>
    /// Get the last conversation exchange formatted as a string for debugging/display.
    /// </summary>
    public string GetLastExchange()
    {
        if (string.IsNullOrEmpty(lastUserQuestion))
            return "";

        return $"Previous Question: {lastUserQuestion}\nPrevious Answer: {lastNpcResponse}";
    }

    /// <summary>
    /// Get just the last question.
    /// </summary>
    public string GetLastQuestion()
    {
        return lastUserQuestion;
    }

    /// <summary>
    /// Get just the last response.
    /// </summary>
    public string GetLastResponse()
    {
        return lastNpcResponse;
    }

    /// <summary>
    /// Check if there is a conversation history stored.
    /// </summary>
    public bool HasHistory()
    {
        return !string.IsNullOrEmpty(lastUserQuestion);
    }

    /// <summary>
    /// Clear the conversation history.
    /// </summary>
    public void Clear()
    {
        lastUserQuestion = "";
        lastNpcResponse = "";
    }
}
