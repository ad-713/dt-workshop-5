// ./src/nodes/node.ts
import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

export type NodeState = {
  killed: boolean; // indicates if the node was stopped by the /stop route
  x: 0 | 1 | "?" | null; // the current consensus value
  decided: boolean | null; // indicates if the node has reached consensus
  k: number | null; // the current round of the node
};

type Message = {
  senderId: number;
  round: number;
  value: 0 | 1 | "?" | null;
};

export async function node(
  nodeId: number, // the ID of the node
  N: number, // total number of nodes in the network
  F: number, // number of faulty nodes in the network
  initialValue: Value, // initial value of the node (0, 1, or "?")
  isFaulty: boolean, // true if the node is faulty, false otherwise
  nodesAreReady: () => boolean, // used to check if all nodes are ready to receive requests
  setNodeIsReady: (index: number) => void // called when the node is ready
) {
  const app = express();
  app.use(express.json());
  app.use(bodyParser.json());

  // Internal node state
  const state: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  // In-memory storage for messages per round
  const receivedMessages: Record<number, Message[]> = {};

  // Helper: wait until we have at least (N - F) messages for a given round
  const waitForMessages = (round: number): Promise<Message[]> => {
    return new Promise((resolve) => {
      const check = () => {
        const msgs = receivedMessages[round] || [];
        if (msgs.length >= N - F) {
          resolve(msgs);
        } else if (state.killed) {
          // If the node was stopped, resolve with what we have
          resolve(msgs);
        } else {
          setTimeout(check, 50); // check again after 50ms
        }
      };
      check();
    });
  };

  // Helper: broadcast a message to all nodes (including self)
  const broadcastMessage = async (round: number, value: 0 | 1 | "?" | null) => {
    const message: Message = {
      senderId: nodeId,
      round,
      value,
    };

    for (let targetId = 0; targetId < N; targetId++) {
      // All nodes are assumed to run on localhost
      const url = `http://localhost:${BASE_NODE_PORT + targetId}/message`;
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
        });
      } catch (err) {
        console.error(`Error sending message from node ${nodeId} to ${targetId}:`, err);
      }
    }
  };

  // Route: Get node status
  app.get("/status", (req, res) => {
    if (isFaulty) {
      res.status(500).send("faulty");
    } else {
      res.status(200).send("live");
    }
  });

  // Route: Get current state of the node
  app.get("/getState", (req, res) => {
    res.json(state);
  });

  // Route: Receive messages from other nodes
  app.post("/message", (req, res) => {
    const msg: Message = req.body;
    if (typeof msg.round !== "number") {
      res.sendStatus(400);
      return;
    }
    if (!receivedMessages[msg.round]) {
      receivedMessages[msg.round] = [];
    }
    receivedMessages[msg.round].push(msg);
    res.sendStatus(200);
  });

  // Route: Stop the consensus algorithm
  app.get("/stop", async (req, res) => {
    state.killed = true;
    res.sendStatus(200);
  });

  // Route: Start the consensus algorithm
  app.get("/start", async (req, res) => {
    if (!isFaulty) {
      runConsensus();
    }
    res.sendStatus(200);
  });

  // The core consensus loop implementing Ben‑Or algorithm
  async function runConsensus() {
    let round = 0;
    while (!state.killed && !state.decided) {
      state.k = round;
      // Phase 1: Broadcast current estimate
      await broadcastMessage(round, state.x);
      // Wait for at least (N - F) messages for the current round
      const msgs = await waitForMessages(round);

      let count0 = 0;
      let count1 = 0;
      for (const m of msgs) {
        if (m.value === 0) count0++;
        else if (m.value === 1) count1++;
      }

      const threshold = Math.floor((N - F) / 2) + 1;
      // Only decide on a value if we're within round 10. After round 10, even if a majority appears, we do not decide.
      if (round <= 10 && (count0 >= threshold || count1 >= threshold)) {
        state.x = count0 >= threshold ? 0 : 1;
        state.decided = true;
        await broadcastMessage(round, state.x);
      } else {
        // No decision: randomly choose next value
        state.x = Math.random() < 0.5 ? 0 : 1;
      }
      round++;
    }
  }

  // Start the server
  const server = app.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}