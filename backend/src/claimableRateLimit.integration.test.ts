/**
 * Isolated integration test for the GET /api/streams/:id/claimable rate
 * limiter.
 *
 * src/test-setup.ts sets CLAIMABLE_RATE_LIMIT=999999 globally so the rest of
 * the suite never trips this limiter. index.ts reads that value into a
 * module-level const at import time, so verifying the real 429-at-30
 * behavior requires overriding the env var before "./index" is first
 * evaluated. Static `import` declarations are hoisted above plain
 * statements by the ES module spec (vite-node included), so a static
 * `import { app } from "./index"` would still observe the 999999 value set
 * by test-setup.ts regardless of where it's written in this file. A dynamic
 * `import()` inside beforeAll is NOT hoisted, so it's used here instead —
 * this mirrors the pattern already used inside src/integration.test.ts for
 * per-test env overrides (see its "Rate Limiting" describe block).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import path from "path";
import fs from "fs";

const TEST_DB_PATH = path.join(
  __dirname,
  "..",
  "data",
  "test-claimable-rate-limit.db",
);
process.env.DB_PATH = TEST_DB_PATH;

const mockSimulateTransaction = vi.fn();
const mockGetLatestLedger = vi.fn();

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    // The mocked simulation result below uses a plain number for retval
    // rather than real ScVal XDR, so pass it through as-is.
    scValToNative: vi.fn((value: any) => value),
    rpc: {
      ...actual.rpc,
      Server: vi.fn().mockImplementation(() => ({
        getLatestLedger: mockGetLatestLedger,
        simulateTransaction: mockSimulateTransaction,
        prepareTransaction: vi.fn().mockImplementation((tx) => tx),
        getAccount: vi.fn().mockImplementation(
          (pubKey: string) => Promise.resolve(new actual.Account(pubKey, "1")),
        ),
      })),
      Api: {
        ...actual.rpc.Api,
        isSimulationSuccess: (response: any) => response.kind === "success",
      },
    },
  };
});

import { StrKey } from "@stellar/stellar-sdk";

const FIXTURE_STREAM_ID = "600001";

describe("GET /api/streams/:id/claimable rate limiting", () => {
  let app: import("express").Express;
  let getDb: typeof import("./services/db").getDb;

  beforeAll(async () => {
    process.env.CLAIMABLE_RATE_LIMIT = "30";

    const dbMod = await import("./services/db");
    dbMod.initDb();
    getDb = dbMod.getDb;

    const cacheMod = await import("./services/cache");
    cacheMod.initCache();

    process.env.CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
    const streamStoreMod = await import("./services/streamStore");
    await streamStoreMod.initSoroban();

    const indexMod = await import("./index");
    app = indexMod.app;
  });

  afterAll(() => {
    delete process.env.CONTRACT_ID;
    delete process.env.CLAIMABLE_RATE_LIMIT;
    getDb().close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const db = getDb();
    db.exec("DELETE FROM stream_events");
    db.exec("DELETE FROM streams");

    const now = Math.floor(Date.now() / 1000);
    db.prepare(`
      INSERT INTO streams (id, sender, recipient, asset_code, total_amount, duration_seconds, start_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      FIXTURE_STREAM_ID,
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "USDC",
      1000,
      3600,
      now - 1800,
      now - 1800,
    );

    mockGetLatestLedger.mockResolvedValue({
      sequence: 12345,
      closeTime: "1716812160",
    });
    mockSimulateTransaction.mockResolvedValue({
      kind: "success",
      result: { retval: 10 },
    });
  });

  it("allows 30 requests per minute and rejects the 31st with 429", async () => {
    for (let i = 0; i < 31; i++) {
      const response = await request(app).get(`/api/streams/${FIXTURE_STREAM_ID}/claimable`);
      if (i < 30) {
        expect(response.status).toBe(200);
      } else {
        expect(response.status).toBe(429);
        expect(response.body.code).toBe("RATE_LIMIT_EXCEEDED");
      }
    }
  });
});
