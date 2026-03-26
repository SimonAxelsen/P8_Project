using System.Collections;
using UnityEngine;

public class FixClothPop : MonoBehaviour
{
    private Cloth myCloth;
    
    // You can now adjust this delay in the Unity Inspector!
    public float waitTime = 0.5f; 

    void Start()
    {
        myCloth = GetComponent<Cloth>();
        
        if (myCloth != null)
        {
            // 1. Turn off the cloth immediately so it CANNOT simulate the jump
            myCloth.enabled = false; 
            
            // 2. Start our real-time countdown
            StartCoroutine(WaitAndEnableCloth());
        }
    }

    IEnumerator WaitAndEnableCloth()
    {
        // 3. Wait for real seconds, ignoring how laggy the frames are during load
        yield return new WaitForSeconds(waitTime);
        
        // 4. Clear the history just in case
        myCloth.ClearTransformMotion();
        
        // 5. Turn it back on now that the character is seated
        myCloth.enabled = true;
        
        // 6. Hit it one more time the exact frame it wakes up, just to be sure
        myCloth.ClearTransformMotion(); 
    }
}