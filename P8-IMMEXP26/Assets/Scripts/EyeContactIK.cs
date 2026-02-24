using UnityEngine;

[RequireComponent(typeof(Animator))]
public class EyeContactIK : MonoBehaviour
{
    [Header("What should the agent look at?")]
    public Transform target;

    [Header("Tracking Weights")]
    [Tooltip("Global weight. 0 turns it off, 1 turns it fully on.")]
    [Range(0f, 1f)] public float overallWeight = 1.0f;

    [Tooltip("How much the spine twists")]
    [Range(0f, 1f)] public float bodyWeight = 0.05f;

    [Tooltip("How much the head turns")]
    [Range(0f, 1f)] public float headWeight = 0.6f;

    [Tooltip("How much the eye bones track the target")]
    [Range(0f, 1f)] public float eyesWeight = 1.0f;

    [Tooltip("How far they can turn before giving up")]
    [Range(0f, 1f)] public float clampWeight = 0.5f;

    private Animator animator;

    void Start()
    {
        animator = GetComponent<Animator>();
    }

    // This is Unity's built-in callback for IK manipulation
    void OnAnimatorIK(int layerIndex)
    {
        if (animator != null && target != null)
        {
            // Tell the animator HOW MUCH to look at the target
            animator.SetLookAtWeight(overallWeight, bodyWeight, headWeight, eyesWeight, clampWeight);

            // Tell the animator WHERE to look
            animator.SetLookAtPosition(target.position);
        }
        else if (animator != null)
        {
            // Reset to 0 if there is no target
            animator.SetLookAtWeight(0);
        }
    }
}