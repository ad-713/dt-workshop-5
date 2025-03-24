// ./src/nodes/node.ts
import bodyParser from "body-parser";
import express from "express";
import { BASE_NODE_PORT } from "../config";
import { Value } from "../types";

export type NodeState = {
  killed: boolean; // indicates if the node was stopped by the /stop route
  x: 0 | 1 | "?" | null; // the current consensus value
  decided: boolean | null; // indicates if the node has reached consensus
  k: number | null; // the current step of the node
};

export async function node(
  nodeId: number, // the ID of the node
  N: number, // total number of nodes in the network
  F: number, // number of faulty nodes in the network
  initialValue: Value, // initial value of the node
  isFaulty: boolean, // true if the node is faulty, false otherwise
  nodesAreReady: () => boolean, // used to check if all nodes are ready to receive requests
  setNodeIsReady: (index: number) => void // called when the node is ready
) {
  const node = express();
  node.use(express.json());
  node.use(bodyParser.json());

  // Internal state of the node
  const state: NodeState = {
    killed: false,
    x: isFaulty ? null : initialValue,
    decided: isFaulty ? null : false,
    k: isFaulty ? null : 0,
  };

  // Route to check node status
  node.get("/status", (req, res) => {
    if (isFaulty) {
      res.status(500).send("faulty");
    } else {
      res.status(200).send("live");
    }
  });

  // Route to get the current state of the node
  node.get("/getState", (req, res) => {
    res.json(state);
  });

  // Placeholder for the message route
  node.post("/message", (req, res) => {
    // To be implemented: handle messages from other nodes
    res.sendStatus(200);
  });

  // Placeholder for the start route (to start the consensus algorithm)
  node.get("/start", async (req, res) => {
    // To be implemented: logic to start consensus
    res.sendStatus(200);
  });

  // Route to stop the consensus algorithm (marks the node as killed)
  node.get("/stop", async (req, res) => {
    state.killed = true;
    res.sendStatus(200);
  });

  // Start the server on a port based on BASE_NODE_PORT and nodeId
  const server = node.listen(BASE_NODE_PORT + nodeId, async () => {
    console.log(`Node ${nodeId} is listening on port ${BASE_NODE_PORT + nodeId}`);
    setNodeIsReady(nodeId);
  });

  return server;
}