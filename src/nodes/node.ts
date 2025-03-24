// ./src/nodes/node.ts
import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

/** NodeState structure required by your tests */
export type NodeState = {
  killed: boolean;           // set to true if /stop is called
  x: 0 | 1 | "?" | null;     // current consensus value
  decided: boolean | null;   // true if the node reached finality
  k: number | null;          // current round
};

/** Message phases in two-phase Ben-Or */
type Phase = "R" | "P";

/** Message shape */
type Message = {
  senderId: number;
  phase: Phase;              // "R" or "P"
  round: number;
  value: 0 | 1 | "?" | null; // proposed or partial value
};

export async function node(
  nodeId: number,    // the ID of this node
  N: number,         // total number of nodes
  F: number,         // max number of faulty nodes
  initialValue: Value,   // initial value (0, 1, or "?")
  isFaulty: boolean,     // true if this node is faulty
  nodesAreReady: () => boolean, // checks if all nodes are ready
  setNodeIsReady: (index: number) => void // callback when node is ready
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  // Internal state
  const state: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  /**
   * We store messages by (phase, round).
   * Example: receivedMessages["R"][k] = array of messages for the R-phase of round k.
   */
  const receivedMessages: Record<Phase, Record<number, Message[]>> = {
    R: {},
    P: {},
  };

  // --- Helpers ---

  /** 
   * Wait until we receive at least (N - F) messages for a given phase & round,
   * or until the node is killed. 
   */
  function waitForMessages(phase: Phase, round: number): Promise<Message[]> {
    return new Promise((resolve) => {
      const check = () => {
        const msgs = receivedMessages[phase][round] || [];
        if (msgs.length >= N - F || state.killed) {
          resolve(msgs);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  /** Broadcast a message of the given phase & round with a certain value */
  async function broadcastMessage(phase: Phase, round: number, value: 0 | 1 | "?" | null) {
    const msg: Message = {
      senderId: nodeId,
      phase,
      round,
      value,
    };

    for (let targetId = 0; targetId < N; targetId++) {
      const url = `http://localhost:${BASE_NODE_PORT + targetId}/message`;
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg),
        });
      } catch (err) {
        // It's OK if some nodes are down or unreachable
        console.error(`Node ${nodeId} -> Node ${targetId} broadcast error:`, err);
      }
    }
  }

  // --- Routes ---

  app.get("/status", (req, res) => {
    if (isFaulty) {
      return res.status(500).send("faulty");
    }
    return res.status(200).send("live");
  });

  app.get("/getState", (req, res) => {
    res.json(state);
  });

  /** 
   * The /message endpoint receives either R-phase or P-phase messages.
   * We store them so the node can process them in its consensus loop.
   */
  app.post("/message", (req, res) => {
    const msg = req.body as Message;
    const { phase, round } = msg;
    if (!["R", "P"].includes(phase) || typeof round !== "number") {
      return res.sendStatus(400); // return here
    }
  
    if (!receivedMessages[phase][round]) {
      receivedMessages[phase][round] = [];
    }
    receivedMessages[phase][round].push(msg);
    
    return res.sendStatus(200); // and return here
  });

  app.get("/stop", (req, res) => {
    state.killed = true;
    return res.sendStatus(200);
  });

  /** 
   * /start triggers the Ben-Or consensus loop if the node is not faulty.
   */
  app.get("/start", async (req, res) => {
    if (!isFaulty) {
      runConsensus();
    }
    res.sendStatus(200);
  });

  // --- Ben-Or Two-Phase Consensus ---

  async function runConsensus() {
    // If we are faulty or killed, do nothing
    if (isFaulty || state.killed) return;

    while (!state.decided && !state.killed) {
      const round = state.k ?? 0;

      // --------------------- R-phase ---------------------
      // 1) Broadcast (R, k, x)
      await broadcastMessage("R", round, state.x);

      // 2) Wait for (N - F) messages from R-phase
      const rMsgs = await waitForMessages("R", round);
      if (state.killed) break; // stop if killed

      // Count 0s and 1s among R-phase messages
      let count0 = 0;
      let count1 = 0;
      for (const m of rMsgs) {
        if (m.value === 0) count0++;
        if (m.value === 1) count1++;
      }

      // If a single value is in strict majority (> N/2), broadcast (P, k, v). Else broadcast (P, k, ?)
      const majorityThreshold = Math.floor(N / 2) + 1;
      let R_phase_value: 0 | 1 | "?" = "?";
      if (count0 >= majorityThreshold) {
        R_phase_value = 0;
      } else if (count1 >= majorityThreshold) {
        R_phase_value = 1;
      }

      await broadcastMessage("P", round, R_phase_value);

      // --------------------- P-phase ---------------------
      // 3) Wait for (N - F) messages from P-phase
      const pMsgs = await waitForMessages("P", round);
      if (state.killed) break; // stop if killed

      // Check how many non-"?" values appear, and how many times each
      let pCount0 = 0;
      let pCount1 = 0;
      for (const m of pMsgs) {
        if (m.value === 0) pCount0++;
        if (m.value === 1) pCount1++;
      }

      // 4) If we see at least (F+1) messages with the same non-"?" value, decide
      //    else if we see at least one message with a non-"?" value, set x to that
      //    else pick x randomly
      const fPlusOne = F + 1;

      if (pCount0 >= fPlusOne) {
        // Decide 0
        state.x = 0;
        state.decided = true;
      } else if (pCount1 >= fPlusOne) {
        // Decide 1
        state.x = 1;
        state.decided = true;
      } else {
        // No final decision, but if there's at least one non-"?" in P-phase, adopt that
        if (pCount0 > 0) {
          state.x = 0;
        } else if (pCount1 > 0) {
          state.x = 1;
        } else {
          // Everyone broadcasted "?" => choose randomly
          state.x = Math.random() < 0.5 ? 0 : 1;
        }
      }

      // Next round
      state.k = round + 1;
    }
  }

  // --- Start the HTTP server ---

  const server = app.listen(BASE_NODE_PORT + nodeId, () => {
    console.log(`Node ${nodeId} listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}
