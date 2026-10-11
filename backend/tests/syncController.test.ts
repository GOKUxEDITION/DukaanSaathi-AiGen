import test from "node:test";
import assert from "node:assert/strict";
import { createSyncController, type SyncRequest, type SyncResponse, type SyncService } from "../src/sync/syncController.js";

function responseRecorder() {
  let statusCode = 200;
  let payload: Record<string, unknown> | undefined;
  const response: SyncResponse = {
    status(code) {
      statusCode = code;
      return response;
    },
    json(body) {
      payload = body;
      return body;
    },
  };
  return { response, getStatus: () => statusCode, getPayload: () => payload };
}

const validBody = {
  schemaVersion: 1,
  clientId: "android-client-01",
  idempotencyKey: "sync:request-0001",
  changes: [{ changeId: "change-1", entity: "sale", operation: "upsert" }],
};

const auth = { userId: "user-1", tenantId: "shop-1" };

test("rejects unauthenticated requests before calling persistence service", async () => {
  let called = false;
  const service: SyncService = {
    async applyBatch() {
      called = true;
      return { acceptedChangeIds: [], serverCursor: "cursor-1" };
    },
  };
  const recorder = responseRecorder();
  await createSyncController(service)({ body: validBody }, recorder.response);
  assert.equal(recorder.getStatus(), 401);
  assert.equal(called, false);
});

test("rejects unsupported schema versions and malformed batches", async () => {
  const service: SyncService = {
    async applyBatch() {
      throw new Error("must not be called");
    },
  };
  const recorder = responseRecorder();
  await createSyncController(service)(
    { auth, body: { ...validBody, schemaVersion: 2 } },
    recorder.response,
  );
  assert.equal(recorder.getStatus(), 400);
  assert.equal(recorder.getPayload()?.error, "INVALID_SYNC_BATCH");
});

test("rejects oversized batches before service execution", async () => {
  let called = false;
  const service: SyncService = {
    async applyBatch() {
      called = true;
      return { acceptedChangeIds: [], serverCursor: "cursor-1" };
    },
  };
  const recorder = responseRecorder();
  await createSyncController(service)(
    { auth, body: { ...validBody, padding: "x".repeat(260_000) } },
    recorder.response,
  );
  assert.equal(recorder.getStatus(), 413);
  assert.equal(called, false);
});

test("passes authenticated tenant context and a valid batch to the service", async () => {
  let receivedContext: unknown;
  let receivedBatch: unknown;
  const service: SyncService = {
    async applyBatch(context, batch) {
      receivedContext = context;
      receivedBatch = batch;
      return { acceptedChangeIds: ["change-1"], serverCursor: "cursor-2" };
    },
  };
  const recorder = responseRecorder();
  await createSyncController(service)({ auth, body: validBody }, recorder.response);
  assert.equal(recorder.getStatus(), 200);
  assert.deepEqual(receivedContext, auth);
  assert.deepEqual(receivedBatch, validBody);
  assert.deepEqual(recorder.getPayload(), {
    ok: true,
    acceptedChangeIds: ["change-1"],
    serverCursor: "cursor-2",
  });
});

test("returns a sanitized error when the sync service fails", async () => {
  const service: SyncService = {
    async applyBatch() {
      throw new Error("database password must never leak");
    },
  };
  const recorder = responseRecorder();
  await createSyncController(service)({ auth, body: validBody }, recorder.response);
  assert.equal(recorder.getStatus(), 500);
  assert.deepEqual(recorder.getPayload(), {
    error: "SYNC_FAILED",
    message: "Sync could not be completed. Retry with the same idempotency key.",
  });
  assert.equal(JSON.stringify(recorder.getPayload()).includes("password"), false);
});
