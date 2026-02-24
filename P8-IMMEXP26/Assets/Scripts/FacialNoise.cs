using UnityEngine;
using System.Collections;

public class FacialNoise : MonoBehaviour
{
    [Header("Assign your character's Face Mesh here:")]
    public SkinnedMeshRenderer faceMesh;

    [Header("Micro-Expression Blendshapes")]
    public string[] noiseShapes = new string[] {
        "Brow_Compress_L",
        "Brow_Compress_R",
        "Brow_Drop_L",
        "Brow_Drop_R",
        "Eye_Squint_L",
        "Eye_Squint_R",
        "Nose_Sneer_L",
        "Nose_Sneer_R"
    };

    [Header("Noise Settings")]
    [Tooltip("Maximum intensity of the twitch (0-100). Keep it low (15-25)!")]
    public float maxWeight = 20f;
    [Tooltip("How fast the muscle flexes")]
    public float twitchSpeed = 0.15f;
    public float minTimeBetweenTwitches = 1.5f;
    public float maxTimeBetweenTwitches = 4.0f;

    private int[] shapeIndices;

    void Start()
    {
        if (faceMesh == null)
        {
            Debug.LogWarning("AutoFacialNoise: Please assign the Face Mesh!");
            return;
        }

        // Cache the blendshape indices on startup so Unity doesn't have to search every frame
        shapeIndices = new int[noiseShapes.Length];
        for (int i = 0; i < noiseShapes.Length; i++)
        {
            shapeIndices[i] = faceMesh.sharedMesh.GetBlendShapeIndex(noiseShapes[i]);
        }

        // Start the automatic noise loop immediately
        StartCoroutine(AutoNoiseRoutine());
    }

    IEnumerator AutoNoiseRoutine()
    {
        while (true)
        {
            // Wait for a random amount of time
            yield return new WaitForSeconds(Random.Range(minTimeBetweenTwitches, maxTimeBetweenTwitches));

            // Pick a random muscle from the list
            int randomShapeIndex = shapeIndices[Random.Range(0, shapeIndices.Length)];

            // Flex it! (But only if the blendshape was actually found)
            if (randomShapeIndex != -1)
            {
                yield return StartCoroutine(FlexMuscle(randomShapeIndex));
            }
        }
    }

    IEnumerator FlexMuscle(int blendShapeIndex)
    {
        // Randomize the intensity slightly so it feels organic
        float targetWeight = Random.Range(5f, maxWeight);
        float t = 0;

        // 1. Flex the muscle
        while (t < twitchSpeed)
        {
            t += Time.deltaTime;
            faceMesh.SetBlendShapeWeight(blendShapeIndex, Mathf.Lerp(0, targetWeight, t / twitchSpeed));
            yield return null;
        }

        // 2. Hold the twitch for a split second
        yield return new WaitForSeconds(Random.Range(0.05f, 0.2f));

        // 3. Relax the muscle
        t = 0;
        while (t < twitchSpeed)
        {
            t += Time.deltaTime;
            faceMesh.SetBlendShapeWeight(blendShapeIndex, Mathf.Lerp(targetWeight, 0, t / twitchSpeed));
            yield return null;
        }

        // 4. Ensure it fully resets to 0
        faceMesh.SetBlendShapeWeight(blendShapeIndex, 0);
    }
}