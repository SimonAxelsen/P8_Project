export type NpcKey = "HR" | "TECH";

export type BcFeaturesMsg = {
  type: "bc_features";
  t?: number;
  vad: 0 | 1;
  pauseMs: number;
  speechMs: number;
  addressee?: "HR" | "TECH" | "UNKNOWN";
  agentsSpeaking?: { HR?: boolean; TECH?: boolean };
};

export type BcTriggerMsg = {
  type: "bc_trigger";
  npc: NpcKey;
  action: string; // animator trigger name
};

export type BcState = {
  lastGlobalTs: number;
  lastPerNpcTs: Record<NpcKey, number>;
};

// --- Changable things for the mic(amount of times a BC can be triggered etc. ALL IN MS) ---
const BC_MICROPAUSE_MIN = 250;
const BC_MICROPAUSE_MAX = 700;
const BC_EOT_THRESHOLD = 1000;      // treat > this as end-of-turn
const BC_GLOBAL_COOLDOWN = 2500;
const BC_NPC_COOLDOWN = 5000;

function nowMs() {
  return Date.now();
}

export function chooseNpc(
  st: BcState,
  addressee: "HR" | "TECH" | "UNKNOWN",
  speaking?: { HR?: boolean; TECH?: boolean }
): NpcKey | null {
  const canUse = (npc: NpcKey) => !(speaking?.[npc] ?? false);

  // NPC addressee gets priority or least recently triggered NPC
  if (addressee === "HR" && canUse("HR")) return "HR";
  if (addressee === "TECH" && canUse("TECH")) return "TECH";

  const a: NpcKey = "HR";
  const b: NpcKey = "TECH";
  if (!canUse(a) && !canUse(b)) return null;
  if (!canUse(a)) return b;
  if (!canUse(b)) return a;

  return st.lastPerNpcTs[a] <= st.lastPerNpcTs[b] ? a : b;
}

export function shouldTriggerBc(st: BcState, msg: BcFeaturesMsg): BcTriggerMsg | null {
  const t = nowMs();                                                            
  if (msg.vad !== 1) return null;
  if (msg.pauseMs < BC_MICROPAUSE_MIN || msg.pauseMs > BC_MICROPAUSE_MAX) return null;
  if (msg.pauseMs >= BC_EOT_THRESHOLD) return null;

  if (t - st.lastGlobalTs < BC_GLOBAL_COOLDOWN) return null;

  const addressee = msg.addressee ?? "UNKNOWN";
  const npc = chooseNpc(st, addressee, msg.agentsSpeaking);
  if (!npc) return null;

  if (t - st.lastPerNpcTs[npc] < BC_NPC_COOLDOWN) return null;

  // Testing for 1 action atm
  const action = "NodSmall";

  st.lastGlobalTs = t;
  st.lastPerNpcTs[npc] = t;

  return { type: "bc_trigger", npc, action };
}
