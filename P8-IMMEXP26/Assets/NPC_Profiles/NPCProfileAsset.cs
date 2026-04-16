using UnityEngine;

[CreateAssetMenu(fileName = "New NPC Profile", menuName = "AI/NPC Profile")]
public class NPCProfileAsset : ScriptableObject 
{ 
    // This guarantees the profile data actually exists!
    public NPCProfile profile = new NPCProfile(); 
}
