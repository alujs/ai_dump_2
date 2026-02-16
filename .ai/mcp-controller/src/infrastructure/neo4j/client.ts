import neo4j, { Driver, Record as Neo4jRecord } from "neo4j-driver";
import { replaceWithGuard } from "../../shared/replaceGuard";

export interface Neo4jConnectionConfig {
  uri: string;
  username: string;
  password: string;
  database: string;
}

export class Neo4jClient {
  private driver: Driver | null = null;
  private activeUri: string | null = null;

  constructor(private readonly config: Neo4jConnectionConfig) {}

  async verifyConnectivity(): Promise<void> {
    await this.ensureDriver();
  }

  async runWrite<T = unknown>(
    query: string,
    params: Record<string, unknown> = {},
    mapper?: (record: Neo4jRecord) => T
  ): Promise<T[]> {
    const driver = await this.ensureDriver();
    const session = driver.session({ database: this.config.database, defaultAccessMode: neo4j.session.WRITE });
    try {
      const result = await session.run(query, params);
      if (!mapper) {
        return result.records.map((record) => record.toObject() as T);
      }
      return result.records.map((record) => mapper(record));
    } finally {
      await session.close();
    }
  }

  async runRead<T = unknown>(
    query: string,
    params: Record<string, unknown> = {},
    mapper?: (record: Neo4jRecord) => T
  ): Promise<T[]> {
    const driver = await this.ensureDriver();
    const session = driver.session({ database: this.config.database, defaultAccessMode: neo4j.session.READ });
    try {
      const result = await session.run(query, params);
      if (!mapper) {
        return result.records.map((record) => record.toObject() as T);
      }
      return result.records.map((record) => mapper(record));
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.activeUri = null;
    }
  }

  private async ensureDriver(): Promise<Driver> {
    if (this.driver) {
      return this.driver;
    }

    let lastError: unknown = new Error("No Neo4j URI candidates available.");
    for (const uri of uriCandidates(this.config.uri)) {
      const candidate = neo4j.driver(uri, neo4j.auth.basic(this.config.username, this.config.password));
      try {
        await candidate.verifyConnectivity();
        this.driver = candidate;
        this.activeUri = uri;
        return candidate;
      } catch (error) {
        lastError = error;
        await candidate.close();
      }
    }
    throw lastError;
  }
}

function uriCandidates(inputUri: string): string[] {
  if (inputUri.startsWith("neo4j+s://")) {
    return [
      inputUri,
      replaceWithGuard(inputUri, "neo4j+s://", "bolt+s://", "Neo4jClient:uriCandidates:neo4j+s")
    ];
  }
  if (inputUri.startsWith("neo4j+ssc://")) {
    return [
      inputUri,
      replaceWithGuard(inputUri, "neo4j+ssc://", "bolt+ssc://", "Neo4jClient:uriCandidates:neo4j+ssc")
    ];
  }
  if (inputUri.startsWith("neo4j://")) {
    return [inputUri, replaceWithGuard(inputUri, "neo4j://", "bolt://", "Neo4jClient:uriCandidates:neo4j")];
  }
  return [inputUri];
}
