using UnityEngine;

public class SimulationEnd : MonoBehaviour
{
    [Header("Animation Settings")]
    [Tooltip("Drag the Animator component here from the Inspector")]
    public Animator panelAnimator;

    void OnEnable()
    {
        // 1. Subscribe to the event when this panel becomes active
        LlmService.OnSimulationComplete += TriggerEndAnimation;
    }

    void OnDisable()
    {
        // 2. Always unsubscribe to prevent errors if the object is destroyed
        LlmService.OnSimulationComplete -= TriggerEndAnimation;
    }

    private void TriggerEndAnimation()
    {
        // 3. Fire the animation trigger!
        if (panelAnimator != null)
        {
            Debug.Log("<color=cyan>[SimulationEnd] Playing EndSimulation animation!</color>");
            panelAnimator.SetTrigger("EndSimulation");
        }
        else
        {
            Debug.LogWarning("[SimulationEnd] Animator is missing! Please assign it in the Inspector.");
        }
    }
}