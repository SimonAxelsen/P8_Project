using UnityEngine;
using System.Collections;

public class AutoBlinker : MonoBehaviour
{
    [Header("Assign character's Face Mesh")]
    public SkinnedMeshRenderer faceMesh;

    [Header("Blendshape Names")]
    public string blinkLeftName = "Eye_Blink_L";
    public string blinkRightName = "Eye_Blink_R";

    [Header("Blink Settings")]
    public float minBlinkTime = 2.0f;
    public float maxBlinkTime = 6.0f;
    public float blinkSpeed = 0.08f;

    private int blinkLeftIndex;
    private int blinkRightIndex;

    void Start()
    {
        if (faceMesh != null)
        {
            blinkLeftIndex = faceMesh.sharedMesh.GetBlendShapeIndex(blinkLeftName);
            blinkRightIndex = faceMesh.sharedMesh.GetBlendShapeIndex(blinkRightName);

            StartCoroutine(BlinkRoutine());
        }
    }

    IEnumerator BlinkRoutine()
    {
        while (true)
        {
            yield return new WaitForSeconds(Random.Range(minBlinkTime, maxBlinkTime));
            yield return StartCoroutine(DoBlink());
        }
    }

    IEnumerator DoBlink()
    {
        float t = 0;
        while (t < blinkSpeed)
        {
            t += Time.deltaTime;
            float blendValue = Mathf.Lerp(0, 100, t / blinkSpeed);
            faceMesh.SetBlendShapeWeight(blinkLeftIndex, blendValue);
            faceMesh.SetBlendShapeWeight(blinkRightIndex, blendValue);
            yield return null;
        }

        t = 0;
        while (t < blinkSpeed)
        {
            t += Time.deltaTime;
            float blendValue = Mathf.Lerp(100, 0, t / blinkSpeed);
            faceMesh.SetBlendShapeWeight(blinkLeftIndex, blendValue);
            faceMesh.SetBlendShapeWeight(blinkRightIndex, blendValue);
            yield return null;
        }

        faceMesh.SetBlendShapeWeight(blinkLeftIndex, 0);
        faceMesh.SetBlendShapeWeight(blinkRightIndex, 0);
    }
}