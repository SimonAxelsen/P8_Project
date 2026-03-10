using UnityEngine;
using System.Collections;

[RequireComponent(typeof(Animator))]
public class EyeContactIK : MonoBehaviour
{
    [Header("Targets")]
    [Tooltip("The User (Main Camera)")]
    public Transform target;
    [Tooltip("Drag the OTHER agent's Head bone or eye target here!")]
    public Transform coAgentTarget;

    [Header("Tracking Weights")]
    [Range(0f, 1f)] public float overallWeight = 1.0f;
    [Range(0f, 1f)] public float bodyWeight = 0.05f;
    [Range(0f, 1f)] public float headWeight = 0.6f;
    [Range(0f, 1f)] public float eyesWeight = 1.0f;
    [Range(0f, 1f)] public float clampWeight = 0.5f;

    private Animator animator;
    private float currentWeight = 1.0f;
    private Coroutine weightCoroutine;
    private Vector3 targetOffset = Vector3.zero;

    // 0 means look at User, 1 means look at Co-Agent
    public float gazeBlend = 0f;

    void Start()
    {
        animator = GetComponent<Animator>();
        currentWeight = overallWeight;
    }

    void OnAnimatorIK(int layerIndex)
    {
        if (animator != null && target != null)
        {
            animator.SetLookAtWeight(currentWeight, bodyWeight, headWeight, eyesWeight, clampWeight);

            // If we have a co-agent, lerp between the user and the co-agent
            if (coAgentTarget != null)
            {
                Vector3 finalPos = Vector3.Lerp(target.position + targetOffset, coAgentTarget.position, gazeBlend);
                animator.SetLookAtPosition(finalPos);
            }
            else
            {
                // Fallback to normal offset if no co-agent is assigned
                animator.SetLookAtPosition(target.position + targetOffset);
            }
        }
        else if (animator != null)
        {
            animator.SetLookAtWeight(0);
        }
    }

    public void SmoothTransitionWeight(float targetW, float duration)
    {
        if (weightCoroutine != null) StopCoroutine(weightCoroutine);
        weightCoroutine = StartCoroutine(LerpWeight(targetW, duration));
    }

    private IEnumerator LerpWeight(float targetW, float duration)
    {
        float startW = currentWeight;
        float time = 0;
        while (time < duration)
        {
            currentWeight = Mathf.Lerp(startW, targetW, time / duration);
            time += Time.deltaTime;
            yield return null;
        }
        currentWeight = targetW;
    }

    // ---PROCEDURAL NOD LOGIC ---
    public void TriggerProceduralNod(float duration = 1.0f)
    {
        StartCoroutine(NodRoutine(duration));
    }

    private IEnumerator NodRoutine(float duration)
    {
        float time = 0;
        // sine wave to simulate the nod makes the animation procedural and not dependent on 
        while (time < duration)
        {
            // Nod intensity
            float yOffset = Mathf.Sin((time / duration) * Mathf.PI * 2) * -0.15f;
            targetOffset = new Vector3(0, yOffset, 0);

            time += Time.deltaTime;
            yield return null;
        }
        targetOffset = Vector3.zero; // Resets
    }

    public void TriggerProceduralGazeAversion(float duration = 2.5f)
    {
        StartCoroutine(GazeAversionRoutine(duration));
    }

    private IEnumerator GazeAversionRoutine(float duration)
    {
        // Turn Speed
        float transitionTime = 0.7f;

        float t = 0;
        while (t < transitionTime)
        {
            // Acceleration
            float easedTime = Mathf.SmoothStep(0f, 1f, t / transitionTime);
            gazeBlend = Mathf.Lerp(0f, 1f, easedTime);
            t += Time.deltaTime;
            yield return null;
        }
        gazeBlend = 1f;

        yield return new WaitForSeconds(duration - (transitionTime * 2));

        t = 0;
        while (t < transitionTime)
        {
            float easedTime = Mathf.SmoothStep(0f, 1f, t / transitionTime);
            gazeBlend = Mathf.Lerp(1f, 0f, easedTime);
            t += Time.deltaTime;
            yield return null;
        }
        gazeBlend = 0f;
    }
}