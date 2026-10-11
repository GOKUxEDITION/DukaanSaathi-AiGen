export interface AuthenticatedSyncContext {
  userId: string;
  tenantId: string;
}

export interface SyncRequest {
  auth?: AuthenticatedSyncContext;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
}

export interface SyncResponse {
  status(code: number): SyncResponse;
  json(body: Record<string, unknown>): unknown;
}

export interface SyncBatch {
  schemaVersion: 1;
  clientId: string;
  idempotencyKey: string;
  changes: Array<Record<string, unknown>>;
}

export interface SyncService {
  applyBatch(context: AuthenticatedSyncContext, batch: SyncBatch): Promise<{
    acceptedChangeIds: string[];
    serverCursor: string;
  }>;
}

const MAX_BATCH_BYTES = 256 * 1024;
const MAX_CHANGES = 100;
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseBatch(value: unknown): SyncBatch | null {
  if (!isRecord(value)) return null;
  const { schemaVersion, clientId, idempotencyKey, changes } = value;
  if (schemaVersion !== 1) return null;
  if (typeof clientId !== "string" || !ID_PATTERN.test(clientId)) return null;
  if (typeof idempotencyKey !== "string" || !ID_PATTERN.test(idempotencyKey)) return null;
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES) return null;
  if (!changes.every(isRecord)) return null;
  return {
    schemaVersion: 1,
    clientId,
    idempotencyKey,
    changes: changes as Array<Record<string, unknown>>,
  };
}

/**
 * Creates a fail-closed sync handler. Authentication and tenant membership must be
 * established by trusted server middleware before this handler is called.
 * The injected service must enforce tenant-scoped authorization, idempotency,
 * conflict handling, and transactional persistence.
 */
export function createSyncController(service: SyncService) {
  return async function syncController(req: SyncRequest, res: SyncResponse): Promise<unknown> {
    const auth = req.auth;
    if (
      !auth ||
      typeof auth.userId !== "string" ||
      auth.userId.length === 0 ||
      typeof auth.tenantId !== "string" ||
      auth.tenantId.length === 0
    ) {
      return res.status(401).json({ error: "UNAUTHENTICATED", message: "Authentication is required." });
    }

    let serializedBody: string;
    try {
      serializedBody = JSON.stringify(req.body);
    } catch {
      return res.status(400).json({ error: "INVALID_BODY", message: "Request body must be valid JSON data." });
    }

    if (serializedBody === undefined || serializedBody.length > MAX_BATCH_BYTES) {
      return res.status(413).json({ error: "BATCH_TOO_LARGE", message: "Sync batch exceeds the allowed size." });
    }

    const batch = parseBatch(req.body);
    if (!batch) {
      return res.status(400).json({
        error: "INVALID_SYNC_BATCH",
        message: "Expected schemaVersion 1, valid clientId and idempotencyKey, and at most 100 change objects.",
      });
    }

    try {
      const result = await service.applyBatch(
        { userId: auth.userId, tenantId: auth.tenantId },
        batch,
      );
      return res.status(200).json({
        ok: true,
        acceptedChangeIds: result.acceptedChangeIds,
        serverCursor: result.serverCursor,
      });
    } catch {
      // Do not leak database errors, tokens, or tenant data to the caller.
      return res.status(500).json({
        error: "SYNC_FAILED",
        message: "Sync could not be completed. Retry with the same idempotency key.",
      });
    }
  };
}
