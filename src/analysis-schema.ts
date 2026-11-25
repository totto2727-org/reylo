// oxlint-disable-next-line rules/no-node-imports -- Read the local project's HCL bytes before analysis can use its catalog.
import { readFileSync } from "node:fs";
import { NotMysql, reason, Unreachable } from "./connection.ts";
import type { AnalysisConnection } from "./analysis-connection.ts";
import { digestPrefix, sha256 } from "./analysis-identity.ts";
import { cacheTime, errorMessage, liveSchema, offlineSchema } from "./analysis-results.ts";
import type { SchemaSnapshot } from "./analysis-results.ts";
import { matchesNull, matchesUndefined, nonemptyText } from "./native-predicates.ts";
import { hclPath } from "./project.ts";
import type { ResolvedProject } from "./project.ts";
import { FINGERPRINT } from "./schema-fingerprint.ts";

const SCHEMA_DIGEST_LENGTH = 16;
const SCHEMA_TTL = 5000;
const OFFLINE_TTL = 60_000;

interface CatalogContext {
  connect: () => Promise<AnalysisConnection>;
  drop: (pending: Promise<AnalysisConnection>) => void;
  project: () => ResolvedProject;
  refused: (error: NotMysql) => string;
  release: () => Promise<void>;
  root: () => string;
}

interface CatalogRequest {
  at: number;
  source: string | undefined;
}

const catalogHash = (source: string): { hash: string } | { error: unknown } => {
  try {
    // oxlint-disable-next-line node/no-sync -- Capture the local catalog bytes before yielding so each cache check starts with the current file revision.
    return { hash: sha256(readFileSync(source, "utf8")) };
  } catch (error) {
    return { error };
  }
};

export class SchemaTracker {
  public snapshot: SchemaSnapshot | undefined = undefined;
  #hclHash: string | undefined;
  #context: CatalogContext;

  public constructor(context: CatalogContext) {
    this.#context = context;
  }

  public async read(): Promise<SchemaSnapshot> {
    const at = cacheTime();
    const source = hclPath(this.#context.project().url ?? "", this.#context.root());
    const local = matchesUndefined(source) ? undefined : catalogHash(source);
    if (local && "error" in local) {
      return this.#failedLocalRead(at, source, local.error);
    }
    if (local && (local.hash !== this.#hclHash || matchesNull(this.snapshot?.value))) {
      await this.#context.release();
      this.snapshot = undefined;
      this.#hclHash = local.hash;
    }
    return this.#freshSnapshot(at) ?? this.#query({ at, source });
  }

  #freshSnapshot(at: number): SchemaSnapshot | undefined {
    const { snapshot } = this;
    if (!snapshot) {return undefined;}
    const ttl = matchesNull(snapshot.value) ? OFFLINE_TTL : SCHEMA_TTL;
    return at - snapshot.at < ttl ? snapshot : undefined;
  }

  async #failedLocalRead(at: number, source: string | undefined, error: unknown): Promise<SchemaSnapshot> {
    await this.#context.release();
    this.snapshot = offlineSchema(at, `Cannot read HCL schema ${source}: ${errorMessage(error)}`, true);
    return this.snapshot;
  }

  async #query(request: CatalogRequest): Promise<SchemaSnapshot> {
    const pending = this.#context.connect();
    try {
      const connection = await pending;
      // oxlint-disable-next-line typescript/return-await -- This catch handles connection opening. The fingerprint handles its own query failures.
      return this.#fingerprint(request, pending, connection);
    } catch (error) {
      this.#context.drop(pending);
      this.snapshot = this.#failedConnection(request.at, error);
      return this.snapshot;
    }
  }

  #failedConnection(at: number, error: unknown): SchemaSnapshot {
    if (error instanceof Unreachable) {
      return offlineSchema(at, reason(error));
    }
    const message = error instanceof NotMysql ? this.#context.refused(error) : errorMessage(error);
    return offlineSchema(at, message, true);
  }

  async #fingerprint(
    { at, source }: CatalogRequest,
    pending: Promise<AnalysisConnection>,
    connection: AnalysisConnection,
  ): Promise<SchemaSnapshot> {
    try {
      // The HCL file is the complete catalog. Its content hash replaces a live SQL fingerprint.
      const rows = matchesUndefined(source) ? await connection.query(FINGERPRINT[this.#context.project().dialect], []) : [];
      const fingerprint = digestPrefix(JSON.stringify(matchesUndefined(source) ? rows : [this.#hclHash, rows]), SCHEMA_DIGEST_LENGTH);
      const previousFingerprint = nonemptyText(this.snapshot?.value);
      if (!matchesUndefined(previousFingerprint) && previousFingerprint !== fingerprint) {
        await connection.forget().catch(() => {
          // Connection-specific answers are stale once the catalog changes.
        });
      }
      this.snapshot = liveSchema(fingerprint, at);
    } catch (error) {
      this.snapshot = this.#failedFingerprint({ at, source }, pending, error);
    }
    return this.snapshot;
  }

  #failedFingerprint({ at, source }: CatalogRequest, pending: Promise<AnalysisConnection>, error: unknown): SchemaSnapshot {
    if (!matchesUndefined(source)) {
      this.#context.drop(pending);
      return offlineSchema(at, errorMessage(error), true);
    }
    if (error instanceof Unreachable) {
      this.#context.drop(pending);
      return offlineSchema(at, reason(error));
    }
    return liveSchema(`unverified ${process.pid} ${at}`, at);
  }
}
