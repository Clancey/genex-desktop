import type { Activate, PluginContext, PluginNativeResult, PluginScalar } from "../../plugin-sdk/index.d.ts";

/**
 * The host services this plugin calls, by their public SDK names. Kept here rather than imported
 * from Studio, so the plugin stays SDK-only for authors who copy it.
 */
const HostService = {
  AssetsDeliver: "assets.deliver",
  JobsRead: "jobs.read",
  JobsWrite: "jobs.write",
  NativeRun: "native.run",
  NativeJobs: "native.jobs",
  NativeResult: "native.result",
  RuntimeDetect: "runtime.detect",
  RuntimeInstall: "runtime.install",
  RuntimeInstallation: "runtime.installation",
  RuntimeCancelInstall: "runtime.cancelInstall",
} as const;
/** The native job state a finished run reports. */
const JOB_COMPLETED = "completed";
/** The prefix of the one result line `wrapper.gd` prints. */
export const STUDIO_GODOT_RESULT = "STUDIO_GODOT_RESULT ";

/** The Godot editor every job runs. */
const GODOT = { runtime: "godot" } as const;
/** The web export templates the export job reads. */
const TEMPLATES = { download: "web-templates" } as const;
/** The exported page the agent previews. */
const WEB_ENTRY = "web/index.html";

/** The setup actions plugin.json declares. */
const GodotAction = {
  Status: "status",
  Install: "install",
  CancelInstall: "cancel-install",
  InstallTemplates: "install-templates",
  CancelTemplates: "cancel-templates",
} as const;
/** The agent tools plugin.json declares. */
const GodotTool = { Status: "status", Check: "check", Export: "export", Retrieve: "retrieve" } as const;
/** The native jobs plugin.json declares. */
const GodotJob = { Check: "check", Export: "export" } as const;

const MESSAGE = {
  UnknownAction: "Unknown Godot action",
  UnknownOperation: "Unknown Godot operation",
  NoRecordedJob: "No recorded job in this project",
  NoResult: "no result from Godot",
  JobFailed: (id: string, reason: string) => `Godot job ${id}: ${reason}`,
  CheckGuidance: "Fix every listed issue (file and line follow each message), then run godot__check again.",
  ExportGuidance:
    "Files are relative to the game workspace. Open the returned entry in the preview to play the exported build; run godot__export again after changes.",
} as const;

type ToolArgs = Record<string, PluginScalar>;

/** One step the wrapper ran and the error lines it found in that step's output. */
type GodotStep = { step: string; exitCode: number; issues: string[] };
/** The wrapper's result line. */
type GodotResult = { ok: boolean; mode: string; error?: string; steps?: GodotStep[]; [key: string]: unknown };

// Agents get durable IDs and delivered relative paths. Host output roots/logs belong to setup.
const publicJob = (job: PluginNativeResult) => ({
  id: job.id,
  state: job.state,
  runtime: job.runtime,
  version: job.version,
  createdAt: job.createdAt,
  finishedAt: job.finishedAt,
  files: job.files,
  exitCode: job.exitCode,
});

/** The wrapper's JSON result from a job's stdout, when it printed one. */
export function godotResult(stdout: string | undefined): GodotResult | null {
  const line = stdout?.split("\n").findLast((l) => l.startsWith(STUDIO_GODOT_RESULT));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(STUDIO_GODOT_RESULT.length));
  } catch {
    return null;
  }
}

/** Why a job produced no usable result. */
const failure = (job: PluginNativeResult, result: GodotResult | null) =>
  MESSAGE.JobFailed(job.id, result?.error || job.reason || job.stderr || MESSAGE.NoResult);

/** Check the project: the issues are the answer, so a failed check is a result, not an error. */
async function check(ctx: PluginContext) {
  const job = await ctx.host(HostService.NativeRun, { job: GodotJob.Check, inputs: {}, values: {} });
  const result = godotResult(job.stdout);
  if (!result?.steps) throw new Error(failure(job, result));
  return {
    jobId: job.id,
    runtimeVersion: job.version,
    ok: result.ok,
    mainScene: result.mainScene,
    steps: result.steps,
    ...(result.ok ? {} : { guidance: MESSAGE.CheckGuidance }),
  };
}

/** Export to the web, deliver the build into the game and record the delivery. */
async function exportWeb(args: ToolArgs, ctx: PluginContext) {
  const job = await ctx.host(HostService.NativeRun, {
    job: GodotJob.Export,
    inputs: {},
    values: { preset: String(args.preset ?? "") },
  });
  const result = godotResult(job.stdout);
  if (job.state !== JOB_COMPLETED || !result?.ok)
    return { jobId: job.id, ok: false, error: failure(job, result), steps: result?.steps ?? [] };
  const files: string[] = await ctx.host(HostService.AssetsDeliver, { output: job.output, jobId: job.id });
  await ctx.host(HostService.JobsWrite, {
    id: job.id,
    value: { id: job.id, files, deliveredAt: new Date().toISOString() },
  });
  return {
    jobId: job.id,
    ok: true,
    provider: "Local Godot",
    runtimeVersion: job.version,
    preset: result.preset,
    entry: files.find((f) => f.endsWith(WEB_ENTRY)),
    files,
    steps: result.steps,
    guidance: MESSAGE.ExportGuidance,
  };
}

/** Runtime, templates and recent jobs, for the setup panel. */
async function setupStatus(ctx: PluginContext) {
  return {
    runtime: await ctx.host(HostService.RuntimeDetect, GODOT),
    installation: await ctx.host(HostService.RuntimeInstallation, GODOT),
    templates: await ctx.host(HostService.RuntimeDetect, TEMPLATES),
    templatesInstallation: await ctx.host(HostService.RuntimeInstallation, TEMPLATES),
    jobs: await ctx.host(HostService.NativeJobs),
  };
}

/** Local Godot uses only public SDK services; no import from Studio core. */
export const activate: Activate = () => ({
  async action(name, _args, ctx) {
    if (name === GodotAction.Status) return setupStatus(ctx);
    if (name === GodotAction.Install) return ctx.host(HostService.RuntimeInstall, GODOT);
    if (name === GodotAction.CancelInstall) return ctx.host(HostService.RuntimeCancelInstall, GODOT);
    if (name === GodotAction.InstallTemplates) return ctx.host(HostService.RuntimeInstall, TEMPLATES);
    if (name === GodotAction.CancelTemplates) return ctx.host(HostService.RuntimeCancelInstall, TEMPLATES);
    throw new Error(MESSAGE.UnknownAction);
  },
  async tool(name, args, ctx) {
    if (name === GodotTool.Status)
      return {
        runtime: await ctx.host(HostService.RuntimeDetect, GODOT),
        templates: await ctx.host(HostService.RuntimeDetect, TEMPLATES),
        jobs: (await ctx.host(HostService.NativeJobs)).map(publicJob),
      };
    if (name === GodotTool.Check) return check(ctx);
    if (name === GodotTool.Export) return exportWeb(args, ctx);
    if (name !== GodotTool.Retrieve) throw new Error(MESSAGE.UnknownOperation);
    const job = await ctx.host(HostService.NativeResult, { id: String(args.id) });
    if (!job) throw new Error(MESSAGE.NoRecordedJob);
    return { ...publicJob(job), delivery: await ctx.host(HostService.JobsRead, { id: job.id }) };
  },
});
