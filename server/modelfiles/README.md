# Ollama Modelfiles — Baked NPC Personalities
#
# Each file creates a custom Ollama model with the system prompt + META
# instructions permanently embedded. Unity just references the model name.
#
# Usage (run on the PC that hosts Ollama):
#   ollama create npc-bartender -f Modelfile.bartender
#   ollama create npc-guard     -f Modelfile.guard
#
# Then in Unity, set NPCProfile.modelName = "npc-bartender" etc.
#
# To iterate on a personality, edit the Modelfile and re-run `ollama create`.
# The base model (FROM) is shared — only the system prompt layer is added.
