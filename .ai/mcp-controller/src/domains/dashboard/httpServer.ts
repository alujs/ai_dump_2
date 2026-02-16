import express from "express";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { DEFAULT_DASHBOARD_PORT } from "../../shared/constants";
import { observabilityRoot, resolveRepoRoot, workRoot } from "../../shared/fsPaths";
import { TurnController } from "../controller/turnController";
import { EventStore } from "../observability/eventStore";
import type { TurnRequest } from "../../contracts/controller";

export async function startHttpServer(input: {
  controller: TurnController;
  events: EventStore;
  port?: number;
}): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/turn", async (req, res) => {
    try {
      const body = req.body as TurnRequest;
      const result = await input.controller.handleTurn(body);
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: "TURN_HANDLER_FAILED",
        message: error instanceof Error ? error.message : "Unknown error"
      });
    }
  });

  app.get("/worktrees", async (_req, res) => {
    const workBase = path.join(resolveRepoRoot(), ".ai", "tmp", "work");
    try {
      const entries = await readdir(workBase, { withFileTypes: true });
      res.json({
        worktrees: entries.filter((entry) => entry.isDirectory()).map((entry) => ({
          workId: entry.name,
          path: workRoot(entry.name)
        }))
      });
    } catch {
      res.json({ worktrees: [] });
    }
  });

  app.get("/runs", (_req, res) => {
    res.json({
      runs: input.controller.runSummaries()
    });
  });

  app.get("/errors", (_req, res) => {
    res.json({
      errors: input.events.listErrors(500),
      rejectionHeatmap: input.events.rejectionHeatmap(),
      topRejectionSignatures: input.events.topRejectionSignatures(20),
      rejectionTrend: input.events.rejectionTrend(),
      retrievalHotspots: input.events.retrievalHotspots(20),
      observabilityPath: path.join(observabilityRoot(), "events.jsonl"),
      note: "Errors are derived from denyReasons in recent events."
    });
  });

  app.get("/policies/pending", async (_req, res) => {
    const promotions = await input.controller.listMemoryPromotions();
    res.json({
      pendingCorrections: input.events.listPendingCorrections(500),
      memoryPromotions: promotions
    });
  });

  app.get("/metrics", (_req, res) => {
    res.json({
      recentEvents: input.events.listRecent(500).length,
      rejectionHeatmap: input.events.rejectionHeatmap(),
      rejectionTrend: input.events.rejectionTrend(),
      topRejectionSignatures: input.events.topRejectionSignatures(20),
      retrievalHotspots: input.events.retrievalHotspots(20)
    });
  });

  app.get("/stream/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const listener = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = input.events.onEvent(listener);

    req.on("close", () => {
      unsubscribe();
      res.end();
    });
  });

  const port = input.port ?? DEFAULT_DASHBOARD_PORT;
  await new Promise<void>((resolve) => {
    app.listen(port, () => resolve());
  });
}
