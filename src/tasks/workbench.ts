import { referenceMetadata } from "../catalog/reference.js";
import { randomUUID } from "node:crypto";
import { ConnectionManager } from "../connections/manager.js";
import { SafeError } from "../connections/envelopes.js";
import {
  fetchModels,
  ProviderFailure,
  type Fetcher,
} from "../providers/http.js";
import { probeModel, PROBE_INPUT, outcome } from "../providers/probe.js";
import {
  modelIdSchema,
  type Job,
  type ProbePlan,
  type WorkbenchSnapshot,
} from "../shared/workbench.js";
import { type Reference, type Snapshot } from "../shared/security.js";

export class Workbench {
  #state: WorkbenchSnapshot = this.empty();
  #list: AbortController | null = null;
  #active: AbortController | null = null;
  #plans = new Map<string, ProbePlan>();
  #requests = new Map<string, { jobId: string; planId: string }>();
  #generation = 0;
  readonly #unsubscribe: () => void;
  constructor(
    readonly connections: ConnectionManager,
    readonly fetcher: Fetcher = fetch,
  ) {
    this.#unsubscribe = connections.onChange(() => this.reset());
  }
  private empty(): WorkbenchSnapshot {
    return {
      catalog: {
        status: "idle",
        fetchedAt: null,
        reasonCode: null,
        warnings: [],
        models: [],
      },
      jobs: [],
      activeJobId: null,
    };
  }
  snapshot(): Snapshot {
    return {
      ...this.connections.snapshot(),
      stage: "readonly",
      networkRequestsEnabled: true,
      workbench: structuredClone(this.#state),
    };
  }
  private reset(): void {
    this.#generation += 1;
    this.#list?.abort();
    this.#active?.abort();
    this.#list = null;
    this.#active = null;
    this.#plans.clear();
    this.#requests.clear();
    this.#state = this.empty();
  }
  close(): void {
    this.reset();
    this.#unsubscribe();
  }
  private touch(): void {
    this.connections.touch();
  }
  refreshModels(reference: Reference): Snapshot {
    this.connections.assertReady(reference);
    if (this.#list) return this.snapshot();
    const controller = new AbortController(),
      generation = this.#generation;
    this.#list = controller;
    this.#state.catalog.status = "loading";
    this.#state.catalog.reasonCode = null;
    this.touch();
    void (async () => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 15000);
      try {
        const result = await this.connections.useConnection(
          reference,
          async (material) => {
            const result = await fetchModels(
              material,
              controller.signal,
              this.fetcher,
            );
            return {
              ...result,
              models: result.models.map((model) => ({
                ...model,
                referenceMetadata: referenceMetadata(
                  material.baseUrl,
                  model.id,
                ),
              })),
            };
          },
        );
        if (generation !== this.#generation) return;
        if (controller.signal.aborted) throw new ProviderFailure("cancelled");
        const previous = new Map(
          this.#state.catalog.models.map((model) => [model.id, model]),
        );
        const models = result.models.map((model) => ({
          ...model,
          result: previous.get(model.id)?.result ?? null,
        }));
        const known = new Set(models.map((model) => model.id));
        const manual = this.#state.catalog.models
          .filter(
            (model) =>
              !known.has(model.id) &&
              (model.source === "manual" || model.result),
          )
          .map((model) => ({
            ...model,
            source: "manual" as const,
            owner: null,
            created: null,
            claims: [],
          }));
        if (
          models.length + manual.length > 1000 &&
          !result.warnings.includes("truncated")
        )
          result.warnings.push("truncated");
        this.#state.catalog = {
          status: "ready",
          fetchedAt: Date.now(),
          reasonCode: null,
          warnings: result.warnings,
          models: [...models, ...manual].slice(0, 1000),
        };
      } catch (error) {
        if (generation !== this.#generation) return;
        this.#state.catalog.status = "error";
        this.#state.catalog.reasonCode = timedOut
          ? "timeout"
          : controller.signal.aborted
            ? "cancelled"
            : error instanceof ProviderFailure
              ? error.reason
              : "network";
      } finally {
        clearTimeout(timer);
        if (generation === this.#generation && this.#list === controller) {
          this.#list = null;
          this.touch();
        }
      }
    })();
    return this.snapshot();
  }
  cancelModels(reference: Reference): Snapshot {
    this.connections.security.assertReference(reference);
    this.#list?.abort();
    return this.snapshot();
  }
  addManual(reference: Reference, raw: string): Snapshot {
    this.connections.assertReady(reference);
    const parsed = modelIdSchema.safeParse(raw);
    if (!parsed.success || this.connections.containsSecret(parsed.data))
      throw new SafeError("invalid_models");
    if (this.#state.catalog.models.some((model) => model.id === parsed.data))
      return this.snapshot();
    if (this.#state.catalog.models.length >= 1000)
      throw new SafeError("task_limit");
    this.#state.catalog.models.push({
      id: parsed.data,
      source: "manual",
      owner: null,
      created: null,
      claims: [],
      result: null,
    });
    this.touch();
    return this.snapshot();
  }
  preview(reference: Reference, rows: unknown): string {
    const allowed = new Set([
      ...this.#state.catalog.models.map((v) => v.id),
      ...(this.connections.snapshot().localCatalog?.models.map((v) => v.key) ??
        []),
    ]);
    return this.connections.previewCatalog(reference, rows, allowed);
  }
  async prepareCatalog(reference: Reference, rows: unknown) {
    const json = this.preview(reference, rows);
    const plan = await this.connections.prepareCatalog(reference, json);
    return { catalogJson: json, catalogPlan: plan };
  }
  plan(reference: Reference, modelIds: string[]): ProbePlan {
    this.connections.assertReady(reference);
    if (this.#active) throw new SafeError("task_running");
    if (this.#state.jobs.length >= 32) throw new SafeError("task_limit");
    const known = new Set(this.#state.catalog.models.map((model) => model.id));
    if (
      modelIds.length < 1 ||
      modelIds.length > 1000 ||
      new Set(modelIds).size !== modelIds.length ||
      modelIds.some(
        (id) => !known.has(id) || this.connections.containsSecret(id),
      )
    )
      throw new SafeError("invalid_models");
    for (const [key, plan] of this.#plans)
      if (plan.expiresAt <= Date.now()) this.#plans.delete(key);
    if (this.#plans.size >= 8)
      this.#plans.delete(this.#plans.keys().next().value!);
    const plan: ProbePlan = {
      planId: randomUUID(),
      expiresAt: Date.now() + 60000,
      modelIds: [...modelIds],
      protocol: "responses",
      address: this.connections.snapshot().connection?.address ?? "已配置地址",
      input: PROBE_INPUT,
      maxOutputTokens: 64,
      timeoutMs: 30000,
      firstEventTimeoutMs: 15000,
    };
    this.#plans.set(plan.planId, plan);
    return structuredClone(plan);
  }
  start(reference: Reference, planId: string, requestId: string): Snapshot {
    this.connections.assertReady(reference);
    const previous = this.#requests.get(requestId);
    if (previous) {
      if (previous.planId !== planId)
        throw new SafeError("idempotency_conflict");
      return this.snapshot();
    }
    if (this.#active) throw new SafeError("task_running");
    if (this.#state.jobs.length >= 32) throw new SafeError("task_limit");
    const plan = this.#plans.get(planId);
    if (!plan || plan.expiresAt <= Date.now()) {
      this.#plans.delete(planId);
      throw new SafeError("expired_plan");
    }
    this.#plans.delete(planId);
    const controller = new AbortController(),
      generation = this.#generation;
    const job: Job = {
      jobId: randomUUID(),
      requestId,
      status: "queued",
      protocol: "responses",
      modelIds: plan.modelIds,
      currentModel: null,
      results: [],
      startedAt: null,
      endedAt: null,
    };
    this.#state.jobs.push(job);
    this.#state.activeJobId = job.jobId;
    this.#active = controller;
    this.#requests.set(requestId, { jobId: job.jobId, planId });
    this.touch();
    // The start tool returns promptly; polling never issues a new inference request.
    queueMicrotask(() => {
      void this.run(reference, job, controller, generation);
    });
    return this.snapshot();
  }
  private async run(
    reference: Reference,
    job: Job,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    try {
      if (generation !== this.#generation || controller.signal.aborted) return;
      job.status = "running";
      job.startedAt = Date.now();
      this.touch();
      for (const modelId of job.modelIds) {
        if (controller.signal.aborted || generation !== this.#generation) break;
        job.currentModel = modelId;
        this.touch();
        const result = await this.connections.useConnection(
          reference,
          (material) =>
            probeModel(material, modelId, controller.signal, this.fetcher),
        );
        if (generation !== this.#generation) return;
        job.results.push({ modelId, result });
        const model = this.#state.catalog.models.find(
          (item) => item.id === modelId,
        );
        if (model) model.result = result;
        this.touch();
      }
    } catch {
      // Unexpected current-generation failures still leave a conservative result.
      if (generation === this.#generation && job.currentModel) {
        const result = outcome(
          controller.signal.aborted ? "cancelled" : "service",
        );
        job.results.push({ modelId: job.currentModel, result });
        const model = this.#state.catalog.models.find(
          (item) => item.id === job.currentModel,
        );
        if (model) model.result = result;
      }
    } finally {
      if (generation === this.#generation) {
        job.status = controller.signal.aborted ? "cancelled" : "completed";
        job.currentModel = null;
        job.endedAt = Date.now();
        this.#active = null;
        this.#state.activeJobId = null;
        this.touch();
      }
    }
  }
  cancel(reference: Reference, jobId: string): Snapshot {
    this.connections.security.assertReference(reference);
    const job = this.#state.jobs.find((item) => item.jobId === jobId);
    if (!job) throw new SafeError("invalid_task");
    if (this.#state.activeJobId === jobId) {
      this.#active?.abort();
      this.touch();
    }
    return this.snapshot();
  }
}
