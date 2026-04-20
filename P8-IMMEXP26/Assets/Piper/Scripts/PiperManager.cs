using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using UnityEngine;
using Unity.InferenceEngine; // <--- The specific namespace you need

namespace Piper
{
    public class PiperManager : MonoBehaviour
    {
        // 1. Settings
        // Note: BackendType might be strict. If GPUCompute fails, try GPUCompute (or just GPU).
        public BackendType backend = BackendType.GPUCompute;
        public ModelAsset modelAsset;

        public string voice = "en-us";
        public int sampleRate = 22050;
        [Range(0.9f, 1.3f)] public float lengthScale = 1.08f;

        private Model _runtimeModel;
        private Worker _worker; // 'IWorker' is gone, 'Worker' is the class now.

        private void Awake()
        {
            var espeakPath = Path.Combine(Application.streamingAssetsPath, "espeak-ng-data");
            PiperWrapper.InitPiper(espeakPath);

            if (modelAsset == null)
            {
                Debug.LogError("Piper Model is missing! Drag the .onnx file here.");
                return;
            }

            // 2. Load the Brain
            _runtimeModel = ModelLoader.Load(modelAsset);

            // 3. Create Worker (NEW API: No Factory, just a Constructor)
            _worker = new Worker(_runtimeModel, backend);
        }

        public async Task<AudioClip> TextToSpeech(string text)
        {
            var phonemes = PiperWrapper.ProcessText(text, voice);
            var audioBuffer = new List<float>();

            foreach (var sentence in phonemes.Sentences)
            {
                var inputIds = sentence.PhonemesIds;

                // 4. Tensors (NEW API: Generics instead of specific classes)
                // We create them directly with shape and data
                using var tInput = new Tensor<int>(new TensorShape(1, inputIds.Length), inputIds);
                using var tLength = new Tensor<int>(new TensorShape(1), new int[] { inputIds.Length });
                using var tScales = new Tensor<float>(new TensorShape(3), new float[] { 0.667f, lengthScale, 0.8f });

                // 5. Set Inputs
                _worker.SetInput("input", tInput);
                _worker.SetInput("input_lengths", tLength);
                _worker.SetInput("scales", tScales);

                // 6. Run! (Schedule is the new Execute)
                _worker.Schedule();

                // 7. Get Output
                // PeekOutput now returns a generic Tensor, so we cast to Tensor<float>
                using var outputTensor = _worker.PeekOutput() as Tensor<float>;

                // 8. Read Output
                // DownloadToArray() or ToReadOnlyArray() is the new standard
                // We use DownloadToArray() which is often safer in the newer API versions
                var outputData = outputTensor.DownloadToArray();

                audioBuffer.AddRange(outputData);

                await Task.Yield();
            }

            if (audioBuffer.Count == 0) return null;

            var clip = AudioClip.Create("piper_tts", audioBuffer.Count, 1, sampleRate, false);
            clip.SetData(audioBuffer.ToArray(), 0);

            return clip;
        }

        private void OnDestroy()
        {
            PiperWrapper.FreePiper();

            // New API often requires explicit Dispose on the worker
            _worker?.Dispose();
        }
    }
}