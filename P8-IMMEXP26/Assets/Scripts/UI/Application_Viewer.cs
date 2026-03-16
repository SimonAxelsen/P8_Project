using UnityEngine;
using UnityEngine.InputSystem;

/// <summary>
/// Attach to your document Quad.
/// Scales in on start, then tilts + drifts with the mouse using the new Input System.
/// </summary>
public class Application_Viewer : MonoBehaviour
{
    [Header("Mouse Tilt")]
    [Tooltip("Max tilt angle (degrees) when mouse is at screen edge")]
    public float maxTiltAngle = 12f;

    [Tooltip("How smoothly the document follows the mouse (lower = smoother/slower)")]
    public float tiltSmoothSpeed = 5f;

    [Header("Mouse Drift (Subtle Position Offset)")]
    [Tooltip("How much the document drifts in world units as mouse moves")]
    public float driftAmount = 0.12f;

    [Header("Intro Animation")]
    [Tooltip("The document scales in from zero on Start")]
    public bool playIntroAnimation = true;

    [Tooltip("Duration of the scale-in intro")]
    public float introDuration = 0.6f;

    // ── Private state ──────────────────────────────────────────────────────────
    private Vector3 _originPosition;
    private Quaternion _originRotation;
    private float _introTimer;
    private bool _introComplete;
    private Camera _cam;

    void Start()
    {
        _cam = Camera.main;
        _originPosition = transform.position;
        _originRotation = transform.rotation;

        if (playIntroAnimation)
        {
            transform.localScale = Vector3.zero;
            _introTimer = 0f;
            _introComplete = false;
        }
        else
        {
            _introComplete = true;
        }
    }

    void Update()
    {
        if (!_introComplete)
        {
            HandleIntro();
            return;
        }

        HandleMouseTilt();
    }

    // ── Intro scale-in ─────────────────────────────────────────────────────────
    void HandleIntro()
    {
        _introTimer += Time.deltaTime;
        float t = Mathf.Clamp01(_introTimer / introDuration);
        transform.localScale = Vector3.one * EaseOutElastic(t);

        if (t >= 1f)
            _introComplete = true;
    }

    // ── Mouse parallax tilt + subtle drift ────────────────────────────────────
    void HandleMouseTilt()
    {
        // Use new Input System to get mouse position
        Vector2 mousePos = Mouse.current.position.ReadValue();

        Vector2 viewport = _cam.ScreenToViewportPoint(mousePos);
        float normX = (viewport.x - 0.5f) * 2f; // -1 left  → +1 right
        float normY = (viewport.y - 0.5f) * 2f; // -1 bottom → +1 top

        // Tilt toward mouse
        Vector3 targetEuler = new Vector3(
            -normY * maxTiltAngle,
             normX * maxTiltAngle,
            0f
        );

        Quaternion targetRot = _originRotation * Quaternion.Euler(targetEuler);
        transform.rotation = Quaternion.Slerp(
            transform.rotation,
            targetRot,
            Time.deltaTime * tiltSmoothSpeed
        );

        // Subtle XY drift
        Vector3 driftOffset = new Vector3(normX * driftAmount, normY * driftAmount * 0.5f, 0f);
        transform.position = Vector3.Lerp(
            transform.position,
            _originPosition + driftOffset,
            Time.deltaTime * tiltSmoothSpeed
        );
    }

    // ── Easing ─────────────────────────────────────────────────────────────────
    float EaseOutElastic(float t)
    {
        if (t <= 0f) return 0f;
        if (t >= 1f) return 1f;
        float c4 = (2f * Mathf.PI) / 3f;
        return Mathf.Pow(2f, -10f * t) * Mathf.Sin((t * 10f - 0.75f) * c4) + 1f;
    }
}