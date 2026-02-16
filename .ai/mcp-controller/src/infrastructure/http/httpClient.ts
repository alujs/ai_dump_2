export interface HttpKernelOptions {
  maxRetries: number;
  baseBackoffMs: number;
  cacheTtlMs: number;
  minIntervalMs: number;
}

export interface HttpTrace {
  traceRef: string;
  attempt: number;
  url: string;
}

export class NormalizedHttpError extends Error {
  constructor(
    message: string,
    public readonly code: "HTTP_STATUS_ERROR" | "HTTP_NETWORK_ERROR" | "HTTP_TIMEOUT_ERROR",
    public readonly status?: number
  ) {
    super(message);
  }
}

export class HttpKernel {
  private readonly options: HttpKernelOptions;
  private readonly cache = new Map<string, { expiresAt: number; payload: unknown }>();
  private lastRequestAt = 0;

  constructor(options?: Partial<HttpKernelOptions>) {
    this.options = {
      maxRetries: options?.maxRetries ?? 2,
      baseBackoffMs: options?.baseBackoffMs ?? 200,
      cacheTtlMs: options?.cacheTtlMs ?? 30_000,
      minIntervalMs: options?.minIntervalMs ?? 30
    };
  }

  async fetchJson(
    url: string,
    init: RequestInit,
    traceRef: string
  ): Promise<{ payload: unknown; trace: HttpTrace[]; cacheHit: boolean }> {
    const cacheKey = `${init.method ?? "GET"}:${url}:${JSON.stringify(init.body ?? "")}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        payload: cached.payload,
        trace: [
          {
            traceRef,
            attempt: 0,
            url
          }
        ],
        cacheHit: true
      };
    }

    const trace: HttpTrace[] = [];
    let attempt = 0;
    while (attempt <= this.options.maxRetries) {
      attempt += 1;
      trace.push({ traceRef, attempt, url });
      try {
        await this.throttle();
        const response = await fetch(url, init);
        if (!response.ok) {
          throw new NormalizedHttpError(
            `HTTP status ${response.status} for ${url}`,
            "HTTP_STATUS_ERROR",
            response.status
          );
        }
        const payload = (await response.json()) as unknown;
        this.cache.set(cacheKey, {
          payload,
          expiresAt: Date.now() + this.options.cacheTtlMs
        });
        return {
          payload,
          trace,
          cacheHit: false
        };
      } catch (error) {
        if (attempt > this.options.maxRetries) {
          if (error instanceof NormalizedHttpError) {
            throw error;
          }
          throw new NormalizedHttpError(
            error instanceof Error ? error.message : "Network error",
            "HTTP_NETWORK_ERROR"
          );
        }
        await sleep(this.options.baseBackoffMs * attempt);
      }
    }
    throw new NormalizedHttpError("Unreachable retry loop exit", "HTTP_NETWORK_ERROR");
  }

  private async throttle(): Promise<void> {
    const elapsed = Date.now() - this.lastRequestAt;
    if (elapsed < this.options.minIntervalMs) {
      await sleep(this.options.minIntervalMs - elapsed);
    }
    this.lastRequestAt = Date.now();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
