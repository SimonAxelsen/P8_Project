# P8 Project: Immersive Experiences

![Unity](https://img.shields.io/badge/Unity-6000.3.6f1-000000?style=for-the-badge&logo=unity&logoColor=white) ![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Mac-grey?style=for-the-badge)

## 🛠️ Technical Requirements

### ⚠️ Action Required: Model Setup
To keep the repo light, the Speech Recognition model is not included. You must install it manually.

[![Download Model](https://img.shields.io/badge/⬇️_Download_Model-ggml--base.en.bin-2563eb?style=for-the-badge&logo=huggingface&logoColor=white)](https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin?download=true)

**Steps to Install:**
1. Click the button above to auto-download `ggml-base.en.bin`.
2. Drag the file into your Unity project at this exact path:
   
   <kbd>Assets</kbd> ▸ <kbd>StreamingAssets</kbd> ▸ <kbd>Whisper</kbd>

> **Note:** If the `<kbd>Whisper</kbd>` folder doesn't exist, please create it.
>
# How to Create a Custom LLM with Ollama Modelfile

---

## Step 1: Navigate to the Modelfiles Folder

Open your terminal and go to the correct directory:

```bash
cd P8_Project\P8-IMMEXP26\server\modelfiles
```
Make sure your Modelfile exists in this folder  
(example: `Modelfile.interviewer`).

---

## Step 2: Create the Custom Model

Run the following command:

```bash
ollama create interviewee_1 -f Modelfile.interviewer
```

## Step 3: Run Your Custom Model

After the model is successfully created:

```bash
ollama run interviewee_1
```

---

## Optional: List Installed Models

```bash
ollama list
```

---

## Optional: Remove the Model

```bash
ollama rm interviewee_1
```
