import  { useEffect, useMemo, useRef, useState } from "react";

/**
 * REAINO MVP Demo (single-file React component)
 * ------------------------------------------------
 * 3-pane UI:
 *  - Left: Projects & Twins
 *  - Center: Tasks & Workflow (agentic build)
 *  - Right: Review & KPIs / Deploy
 * AR/VR Viewer Mode: pop-out overlay with KPI labels
 *
 * Behavior:
 *  - 3-minute scripted demo (180s)
 *  - Prompt is “typed” into the prompt box
 *  - Agents progress through stages, emitting artifacts
 *  - Data bus activity (Modbus/MQTT/Timeseries) scrolls
 *  - KPIs slowly populate and stabilize
 *
 * Styling: Tailwind classes (no imports required if Tailwind is configured)
 */

type AgentStatus = "Queued" | "Planning" | "Running" | "Needs review" | "Done" | "Failed";
type Severity = "info" | "warn" | "ok";

type Agent = {
  id: string;
  name: string;
  status: AgentStatus;
  progress: number; // 0..100
  outputArtifacts: string[];
  logs: string[];
};

type Artifact = {
  key: string;
  label: string;
  kind: "manifest" | "bindings" | "kpis" | "views" | "validation";
  version: number;
  lastUpdatedSec: number;
  summary: string;
  diffLines: { sev: Severity; text: string }[];
};

type BusEvent = {
  t: number; // seconds since start
  bus: "Modbus TCP" | "OPC-UA" | "MQTT" | "TimescaleDB";
  sev: Severity;
  msg: string;
};

type KPI = {
  key: string;
  label: string;
  unit?: string;
  value: number | null;
  target?: number;
  trend: "up" | "down" | "flat";
  confidence: number; // 0..100
};

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function formatNumber(v: number, digits = 0) {
  const p = Math.pow(10, digits);
  return (Math.round(v * p) / p).toLocaleString();
}

function formatSec(s: number) {
  const mm = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function sevColor(sev: Severity) {
  if (sev === "ok") return "text-emerald-300";
  if (sev === "warn") return "text-amber-300";
  return "text-slate-300";
}

function statusBadge(status: AgentStatus) {
  const base = "inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium border";
  switch (status) {
    case "Queued":
      return `${base} border-slate-600 text-slate-200 bg-slate-800/50`;
    case "Planning":
      return `${base} border-indigo-500/40 text-indigo-100 bg-indigo-950/40`;
    case "Running":
      return `${base} border-sky-500/40 text-sky-100 bg-sky-950/40`;
    case "Needs review":
      return `${base} border-amber-500/40 text-amber-100 bg-amber-950/30`;
    case "Done":
      return `${base} border-emerald-500/40 text-emerald-100 bg-emerald-950/30`;
    case "Failed":
      return `${base} border-rose-500/40 text-rose-100 bg-rose-950/30`;
    default:
      return `${base} border-slate-600 text-slate-200 bg-slate-800/50`;
  }
}

const SCRIPT_PROMPT =
  "Create a digital twin for an ebm-papst cabinet cooling setup: two EC fans, variable speed control, Modbus TCP telemetry, monthly KPI reporting. Include energy usage, efficiency vs curve, utilization, and maintenance risk. Add AR overlay labels for RPM, kW, and status.";

export default function ReainoEbmPapstDemo() {
  // Demo clock
  const [t, setT] = useState(0); // seconds, 0..180
  const [running, setRunning] = useState(true);
  const duration = 180;

  // Prompt typing
  const [promptText, setPromptText] = useState("");
  const [promptDone, setPromptDone] = useState(false);

  // UI state
  const [selectedProject, setSelectedProject] = useState("ebm-papst • Cabinet Cooling MVP");
  const [selectedTwin, setSelectedTwin] = useState("Twin: EC Fan Pair (Cabinet A)");
  const [selectedAgentId, setSelectedAgentId] = useState("spec");
  const [selectedArtifactKey, setSelectedArtifactKey] = useState("manifest");
  const [viewerOpen, setViewerOpen] = useState(false);

  const intervalRef = useRef<number | null>(null);

  // Base agents (7-agent MVP set)
  const [agents, setAgents] = useState<Agent[]>([
    { id: "spec", name: "Spec Agent", status: "Queued", progress: 0, outputArtifacts: ["manifest"], logs: [] },
    { id: "topo", name: "Topology Agent", status: "Queued", progress: 0, outputArtifacts: ["manifest"], logs: [] },
    { id: "conn", name: "Connector Agent", status: "Queued", progress: 0, outputArtifacts: ["bindings"], logs: [] },
    { id: "der", name: "Derived Signal Agent", status: "Queued", progress: 0, outputArtifacts: ["bindings", "kpis"], logs: [] },
    { id: "kpi", name: "KPI Agent", status: "Queued", progress: 0, outputArtifacts: ["kpis"], logs: [] },
    { id: "view", name: "View Agent", status: "Queued", progress: 0, outputArtifacts: ["views"], logs: [] },
    { id: "val", name: "Validation Agent", status: "Queued", progress: 0, outputArtifacts: ["validation"], logs: [] },
  ]);

  // Artifacts store
  const [artifacts, setArtifacts] = useState<Record<string, Artifact>>({
    manifest: {
      key: "manifest",
      label: "Twin Manifest",
      kind: "manifest",
      version: 0,
      lastUpdatedSec: 0,
      summary: "No manifest yet.",
      diffLines: [{ sev: "info", text: "— awaiting spec compilation —" }],
    },
    bindings: {
      key: "bindings",
      label: "Data Bindings",
      kind: "bindings",
      version: 0,
      lastUpdatedSec: 0,
      summary: "No bindings yet.",
      diffLines: [{ sev: "info", text: "— awaiting connector mapping —" }],
    },
    kpis: {
      key: "kpis",
      label: "KPIs Pack",
      kind: "kpis",
      version: 0,
      lastUpdatedSec: 0,
      summary: "No KPIs yet.",
      diffLines: [{ sev: "info", text: "— awaiting KPI definitions —" }],
    },
    views: {
      key: "views",
      label: "Views / AR Labels",
      kind: "views",
      version: 0,
      lastUpdatedSec: 0,
      summary: "No views yet.",
      diffLines: [{ sev: "info", text: "— awaiting view generation —" }],
    },
    validation: {
      key: "validation",
      label: "Validation Report",
      kind: "validation",
      version: 0,
      lastUpdatedSec: 0,
      summary: "Not validated.",
      diffLines: [{ sev: "info", text: "— run validation to deploy —" }],
    },
  });

  // Data bus events
  const [busEvents, setBusEvents] = useState<BusEvent[]>([]);

  // KPIs
  const [kpis, setKpis] = useState<KPI[]>([
    { key: "prod", label: "System Uptime", unit: "%", value: null, trend: "flat", confidence: 0, target: 99.0 },
    { key: "energy", label: "Energy Usage", unit: "kW", value: null, trend: "flat", confidence: 0, target: 75 },
    { key: "eff", label: "Efficiency vs Curve", unit: "%", value: null, trend: "flat", confidence: 0, target: 85 },
    { key: "util", label: "Load Utilization", unit: "%", value: null, trend: "flat", confidence: 0, target: 70 },
    { key: "risk", label: "Maintenance Risk", unit: "%", value: null, trend: "flat", confidence: 0, target: 10 },
  ]);

  // Deployment state
  const [deployStage, setDeployStage] = useState<"Draft" | "Staging" | "Prod">("Draft");
  const [deployEnabled, setDeployEnabled] = useState(false);

  // Script timeline helpers (in seconds)
  const timeline = useMemo(
    () => ({
      // prompt typing over first ~14 seconds
      promptStart: 0,
      promptEnd: 14,

      // agent waves
      specStart: 6,
      specEnd: 32,

      topoStart: 16,
      topoEnd: 40,

      connStart: 30,
      connEnd: 74,

      derStart: 55,
      derEnd: 95,

      kpiStart: 70,
      kpiEnd: 120,

      viewStart: 95,
      viewEnd: 140,

      valStart: 130,
      valEnd: 160,

      // deployment ready after validation
      deployReady: 160,
    }),
    []
  );

  // Drive the demo clock
  useEffect(() => {
    if (!running) return;
    intervalRef.current = window.setInterval(() => {
      setT((prev) => {
        if (prev >= duration) return duration;
        return prev + 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
  }, [running]);

  // Pause at end
  useEffect(() => {
    if (t >= duration) setRunning(false);
  }, [t]);

  // Prompt typing effect
  useEffect(() => {
    if (t < timeline.promptStart || t > timeline.promptEnd) return;
    const total = timeline.promptEnd - timeline.promptStart;
    const frac = clamp((t - timeline.promptStart) / total, 0, 1);
    const chars = Math.floor(SCRIPT_PROMPT.length * frac);
    setPromptText(SCRIPT_PROMPT.slice(0, chars));
    if (chars >= SCRIPT_PROMPT.length) setPromptDone(true);
  }, [t, timeline]);

  // Utility to push bus events with cap
  const pushBus = (evt: BusEvent) => {
    setBusEvents((prev) => {
      const next = [...prev, evt];
      // cap to last 70 events
      return next.slice(Math.max(0, next.length - 70));
    });
  };

  // Script bus activity
  useEffect(() => {
    // Early: “project init”
    if (t === 2) pushBus({ t, bus: "TimescaleDB", sev: "info", msg: "Workspace created: ebm-papst/cabinetA" });
    if (t === 8) pushBus({ t, bus: "TimescaleDB", sev: "ok", msg: "Twin PR branch: draft/v1 created" });

    // Connector phase: Modbus discovery
    if (t === 33) pushBus({ t, bus: "Modbus TCP", sev: "info", msg: "Connecting to PLC gateway 10.0.2.31:502" });
    if (t === 38) pushBus({ t, bus: "Modbus TCP", sev: "ok", msg: "Handshake OK. Reading holding registers…" });
    if (t === 44) pushBus({ t, bus: "Modbus TCP", sev: "info", msg: "Discovered tags: RPM_A, RPM_B, kW_A, kW_B, Temp_Cab" });
    if (t === 52) pushBus({ t, bus: "MQTT", sev: "info", msg: "Subscribing: ebmpapst/cabinetA/faults/#" });
    if (t === 60) pushBus({ t, bus: "MQTT", sev: "ok", msg: "Live faults stream online (no active faults)" });
    if (t === 68) pushBus({ t, bus: "TimescaleDB", sev: "ok", msg: "Ingest pipeline started (1s sample → 1m rollup)" });

    // Data quality + derived signals
    if (t === 76) pushBus({ t, bus: "TimescaleDB", sev: "warn", msg: "Unit check: kW_A appears in W → normalizing" });
    if (t === 82) pushBus({ t, bus: "TimescaleDB", sev: "ok", msg: "Derived signal: airflow_est computed from RPM + curve proxy" });

    // Validation + deploy
    if (t === 131) pushBus({ t, bus: "TimescaleDB", sev: "info", msg: "Running validation suite: bindings + KPI deps + view labels" });
    if (t === 148) pushBus({ t, bus: "TimescaleDB", sev: "ok", msg: "Validation passed (0 errors, 2 warnings)" });
    if (t === 162) pushBus({ t, bus: "TimescaleDB", sev: "ok", msg: "Ready to deploy: staging candidate v1.0" });
  }, [t]);

  // Agent status/progress + artifact emission
  useEffect(() => {
    function stageProgress(start: number, end: number) {
      if (t < start) return 0;
      if (t > end) return 100;
      return Math.round(clamp((t - start) / (end - start), 0, 1) * 100);
    }

    const specP = stageProgress(timeline.specStart, timeline.specEnd);
    const topoP = stageProgress(timeline.topoStart, timeline.topoEnd);
    const connP = stageProgress(timeline.connStart, timeline.connEnd);
    const derP = stageProgress(timeline.derStart, timeline.derEnd);
    const kpiP = stageProgress(timeline.kpiStart, timeline.kpiEnd);
    const viewP = stageProgress(timeline.viewStart, timeline.viewEnd);
    const valP = stageProgress(timeline.valStart, timeline.valEnd);

    const computeStatus = (p: number, start: number, end: number): AgentStatus => {
      if (t < start) return "Queued";
      if (p > 0 && p < 20) return "Planning";
      if (p >= 20 && p < 95) return "Running";
      if (p >= 95 && t < end) return "Needs review";
      if (t >= end) return "Done";
      return "Queued";
    };

    setAgents((prev) =>
      prev.map((a) => {
        let p = 0;
        let status: AgentStatus = "Queued";
        if (a.id === "spec") {
          p = specP;
          status = computeStatus(p, timeline.specStart, timeline.specEnd);
        }
        if (a.id === "topo") {
          p = topoP;
          status = computeStatus(p, timeline.topoStart, timeline.topoEnd);
        }
        if (a.id === "conn") {
          p = connP;
          status = computeStatus(p, timeline.connStart, timeline.connEnd);
        }
        if (a.id === "der") {
          p = derP;
          status = computeStatus(p, timeline.derStart, timeline.derEnd);
        }
        if (a.id === "kpi") {
          p = kpiP;
          status = computeStatus(p, timeline.kpiStart, timeline.kpiEnd);
        }
        if (a.id === "view") {
          p = viewP;
          status = computeStatus(p, timeline.viewStart, timeline.viewEnd);
        }
        if (a.id === "val") {
          p = valP;
          status = computeStatus(p, timeline.valStart, timeline.valEnd);
        }

        // Lightweight log “beats”
        const shouldLog =
          (a.id === "spec" && [10, 18, 26, 32].includes(t)) ||
          (a.id === "conn" && [40, 52, 68, 74].includes(t)) ||
          (a.id === "kpi" && [76, 90, 108, 120].includes(t)) ||
          (a.id === "view" && [104, 118, 132, 140].includes(t)) ||
          (a.id === "val" && [136, 148, 160].includes(t));

        let logs = a.logs;
        if (shouldLog) {
          const line =
            a.id === "spec"
              ? t === 10
                ? "Parsing prompt → selecting template: CabinetCooling.EC2"
                : t === 18
                ? "Creating assets: Fan_A, Fan_B, Cabinet, PLC_Gateway"
                : t === 26
                ? "Setting parameters: variable_speed, monthly_kpis=true"
                : "Manifest compiled (draft v1)"
              : a.id === "conn"
              ? t === 40
                ? "Browsing Modbus registers…"
                : t === 52
                ? "Binding MQTT faults topic → twin.faults"
                : t === 68
                ? "Creating rollups: 1s→1m→1h"
                : "Bindings compiled (draft v1)"
              : a.id === "kpi"
              ? t === 76
                ? "Selecting KPI pack: Energy + Efficiency + Utilization + Risk"
                : t === 90
                ? "Defining monthly windows + baselines"
                : t === 108
                ? "Adding confidence scoring and thresholds"
                : "KPI pack compiled (draft v1)"
              : a.id === "view"
              ? t === 104
                ? "Generating 3D layout + AR anchors"
                : t === 118
                ? "Placing labels: RPM, kW, Status"
                : t === 132
                ? "Exporting Web viewer + AR overlay spec"
                : "Views compiled (draft v1)"
              : a.id === "val"
              ? t === 136
                ? "Validating dependencies: bindings→kpis→views"
                : t === 148
                ? "PASS: 0 errors, 2 warnings (units normalized)"
                : "Ready for staging deploy"
              : `Log @ ${formatSec(t)}`;

          logs = [...logs, `${formatSec(t)} • ${line}`].slice(-20);
        }

        return { ...a, progress: p, status, logs };
      })
    );

    // Artifact emission points (version bumps + diffs)
    setArtifacts((prev) => {
      const next = { ...prev };

      // Manifest
      if (t === timeline.specEnd) {
        const v = next.manifest.version + 1;
        next.manifest = {
          ...next.manifest,
          version: v,
          lastUpdatedSec: t,
          summary: "CabinetCooling.EC2 with Fan_A/Fan_B, PLC gateway, sensors.",
          diffLines: [
            { sev: "ok", text: "+ Assets: Fan_A, Fan_B, Cabinet_A, PLC_Gateway" },
            { sev: "ok", text: "+ Relationships: Motor→Fan, Fan→Airflow→CabinetTemp" },
            { sev: "info", text: "+ Defaults: variable_speed=true, reporting=monthly" },
          ],
        };
      }

      // Bindings
      if (t === timeline.connEnd) {
        const v = next.bindings.version + 1;
        next.bindings = {
          ...next.bindings,
          version: v,
          lastUpdatedSec: t,
          summary: "Mapped Modbus registers + MQTT faults; created rollups.",
          diffLines: [
            { sev: "ok", text: "+ Bind: Fan_A.rpm ← Modbus HR:40021" },
            { sev: "ok", text: "+ Bind: Fan_A.kW  ← Modbus HR:40031 (normalized)" },
            { sev: "ok", text: "+ Bind: Cabinet.temp_C ← HR:40110" },
            { sev: "info", text: "+ Subscribe: MQTT ebmpapst/cabinetA/faults/#" },
          ],
        };
      }

      // Derived signals
      if (t === timeline.derEnd) {
        // bump bindings and/or kpis (keep MVP simple)
        const vB = next.bindings.version + 1;
        next.bindings = {
          ...next.bindings,
          version: vB,
          lastUpdatedSec: t,
          summary: "Added derived airflow_est + unit normalization rules.",
          diffLines: [
            { sev: "ok", text: "+ Derived: airflow_est ← f(RPM, curve_proxy)" },
            { sev: "warn", text: "~ Unit rule: kW tags sometimes in W (auto-normalize)" },
            { sev: "info", text: "+ Quality: flatline/spike detection enabled" },
          ],
        };
      }

      // KPIs
      if (t === timeline.kpiEnd) {
        const v = next.kpis.version + 1;
        next.kpis = {
          ...next.kpis,
          version: v,
          lastUpdatedSec: t,
          summary: "Energy, efficiency vs curve, utilization, maintenance risk (monthly).",
          diffLines: [
            { sev: "ok", text: "+ KPI: energy_kWh_month ← Σ(kW)*Δt" },
            { sev: "ok", text: "+ KPI: efficiency_pct ← airflow_est / power (normalized)" },
            { sev: "ok", text: "+ KPI: utilization_pct ← time_in_band / total" },
            { sev: "info", text: "+ KPI: risk_pct ← variance(power)+fault_rate proxy" },
          ],
        };
      }

      // Views
      if (t === timeline.viewEnd) {
        const v = next.views.version + 1;
        next.views = {
          ...next.views,
          version: v,
          lastUpdatedSec: t,
          summary: "Web 3D view + AR label overlays (RPM/kW/Status).",
          diffLines: [
            { sev: "ok", text: "+ View: Cabinet_A overview scene" },
            { sev: "ok", text: "+ AR Label: Fan_A (RPM, kW, Status)" },
            { sev: "ok", text: "+ AR Label: Fan_B (RPM, kW, Status)" },
            { sev: "info", text: "+ Anchors: cabinet_faceplate, fan_housing" },
          ],
        };
      }

      // Validation
      if (t === timeline.valEnd) {
        const v = next.validation.version + 1;
        next.validation = {
          ...next.validation,
          version: v,
          lastUpdatedSec: t,
          summary: "PASS: 0 errors, 2 warnings (unit normalization).",
          diffLines: [
            { sev: "ok", text: "✓ Schema: manifest/bindings/kpis/views" },
            { sev: "ok", text: "✓ Dependencies: tags → derived → kpis → overlays" },
            { sev: "warn", text: "⚠ Warning: kW tag unit inconsistent; normalized to kW" },
            { sev: "warn", text: "⚠ Warning: vibration missing; risk uses proxy" },
          ],
        };
      }

      return next;
    });

    // Deploy readiness
    if (t >= timeline.deployReady) setDeployEnabled(true);
  }, [t, timeline]);

  // KPI population (slowly becomes confident)
  useEffect(() => {
    // KPI fill starts once bindings/kpi pack exists (we simulate phases)
    const phase1 = clamp((t - 55) / 40, 0, 1); // data arriving
    const phase2 = clamp((t - 95) / 45, 0, 1); // KPIs defined + stabilizing
    const phase3 = clamp((t - 130) / 30, 0, 1); // validation + confident

    // base truth values (demo targets)
    const uptimeTarget = 99.2;
    const energyKW = 78.0;
    const effPct = 86.0;
    const utilPct = 72.0;
    const riskPct = 8.0;

    // Add gentle drift / noise (deterministic, no RNG)
    const wobble = (k: number) => Math.sin((t / 8) * (k + 1)) * 0.6 + Math.sin((t / 17) * (k + 2)) * 0.25;

    const conf = (base: number) => Math.round(lerp(base, 100, phase3));

    setKpis((prevKpis) =>
      prevKpis.map((k) => {
        let value: number | null = null;
        let confidence = 0;

        if (phase1 > 0) {
          const warm = phase1; // getting data
          const stable = phase2; // KPI computation stabilizes

          if (k.key === "prod") {
            value = lerp(0, uptimeTarget + wobble(0), stable);
            confidence = Math.round(lerp(0, 70, warm));
          } else if (k.key === "energy") {
            value = lerp(0, energyKW + wobble(1), stable);
            confidence = Math.round(lerp(0, 75, warm));
          } else if (k.key === "eff") {
            value = lerp(0, effPct + wobble(2), stable);
            confidence = Math.round(lerp(0, 70, warm));
          } else if (k.key === "util") {
            value = lerp(0, utilPct + wobble(3), stable);
            confidence = Math.round(lerp(0, 72, warm));
          } else if (k.key === "risk") {
            value = lerp(0, riskPct + Math.abs(wobble(4)) * 0.7, stable);
            confidence = Math.round(lerp(0, 65, warm));
          }

          // after phase3, confidence rises
          confidence = Math.max(confidence, conf(confidence));
        }

        // trend direction (very light heuristic)
        const last = k.value ?? value ?? 0;
        const now = value ?? last;
        const delta = now - last;
        const trend: KPI["trend"] = Math.abs(delta) < 0.15 ? "flat" : delta > 0 ? "up" : "down";

        return { ...k, value, confidence, trend };
      })
    );
  }, [t]);

  // Selected agent details
  const selectedAgent = useMemo(() => agents.find((a) => a.id === selectedAgentId) ?? agents[0], [agents, selectedAgentId]);
  const selectedArtifact = useMemo(() => artifacts[selectedArtifactKey], [artifacts, selectedArtifactKey]);

  // Quick AR overlay KPI values
  const arKpi = useMemo(() => {
    const energy = kpis.find((k) => k.key === "energy")?.value ?? 0;
    const eff = kpis.find((k) => k.key === "eff")?.value ?? 0;
    const status = deployStage === "Prod" ? "All Green" : deployStage === "Staging" ? "Staging" : "Draft";
    return { energy, eff, status };
  }, [kpis, deployStage]);

  // Actions
  const resetDemo = () => {
    setT(0);
    setRunning(true);
    setPromptText("");
    setPromptDone(false);
    setDeployStage("Draft");
    setDeployEnabled(false);
    setBusEvents([]);
    setSelectedAgentId("spec");
    setSelectedArtifactKey("manifest");
    setViewerOpen(false);

    setAgents([
      { id: "spec", name: "Spec Agent", status: "Queued", progress: 0, outputArtifacts: ["manifest"], logs: [] },
      { id: "topo", name: "Topology Agent", status: "Queued", progress: 0, outputArtifacts: ["manifest"], logs: [] },
      { id: "conn", name: "Connector Agent", status: "Queued", progress: 0, outputArtifacts: ["bindings"], logs: [] },
      { id: "der", name: "Derived Signal Agent", status: "Queued", progress: 0, outputArtifacts: ["bindings", "kpis"], logs: [] },
      { id: "kpi", name: "KPI Agent", status: "Queued", progress: 0, outputArtifacts: ["kpis"], logs: [] },
      { id: "view", name: "View Agent", status: "Queued", progress: 0, outputArtifacts: ["views"], logs: [] },
      { id: "val", name: "Validation Agent", status: "Queued", progress: 0, outputArtifacts: ["validation"], logs: [] },
    ]);

    setArtifacts({
      manifest: { key: "manifest", label: "Twin Manifest", kind: "manifest", version: 0, lastUpdatedSec: 0, summary: "No manifest yet.", diffLines: [{ sev: "info", text: "— awaiting spec compilation —" }] },
      bindings: { key: "bindings", label: "Data Bindings", kind: "bindings", version: 0, lastUpdatedSec: 0, summary: "No bindings yet.", diffLines: [{ sev: "info", text: "— awaiting connector mapping —" }] },
      kpis: { key: "kpis", label: "KPIs Pack", kind: "kpis", version: 0, lastUpdatedSec: 0, summary: "No KPIs yet.", diffLines: [{ sev: "info", text: "— awaiting KPI definitions —" }] },
      views: { key: "views", label: "Views / AR Labels", kind: "views", version: 0, lastUpdatedSec: 0, summary: "No views yet.", diffLines: [{ sev: "info", text: "— awaiting view generation —" }] },
      validation: { key: "validation", label: "Validation Report", kind: "validation", version: 0, lastUpdatedSec: 0, summary: "Not validated.", diffLines: [{ sev: "info", text: "— run validation to deploy —" }] },
    });

    setKpis([
      { key: "prod", label: "System Uptime", unit: "%", value: null, trend: "flat", confidence: 0, target: 99.0 },
      { key: "energy", label: "Energy Usage", unit: "kW", value: null, trend: "flat", confidence: 0, target: 75 },
      { key: "eff", label: "Efficiency vs Curve", unit: "%", value: null, trend: "flat", confidence: 0, target: 85 },
      { key: "util", label: "Load Utilization", unit: "%", value: null, trend: "flat", confidence: 0, target: 70 },
      { key: "risk", label: "Maintenance Risk", unit: "%", value: null, trend: "flat", confidence: 0, target: 10 },
    ]);
  };

  const promote = () => {
    if (!deployEnabled) return;
    if (deployStage === "Draft") setDeployStage("Staging");
    else if (deployStage === "Staging") setDeployStage("Prod");
  };

  const stageLabel = deployStage === "Draft" ? "Draft" : deployStage === "Staging" ? "Staging" : "Production";

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <div className="sticky top-0 z-20 border-b border-slate-800 bg-slate-950/85 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-sky-400/80 to-indigo-500/80 shadow-[0_0_0_1px_rgba(255,255,255,.08)]" />
            <div>
              <div className="text-sm font-semibold tracking-wide">REAINO • ebm-papst MVP Demo</div>
              <div className="text-xs text-slate-400">Natural language → digital twin → data bindings → KPIs → AR viewer</div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden sm:flex items-center gap-3 text-xs text-slate-300">
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1">
                Demo time: <span className="font-semibold text-slate-100">{formatSec(t)}</span> / {formatSec(duration)}
              </span>
              <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1">
                Stage: <span className="font-semibold text-slate-100">{stageLabel}</span>
              </span>
            </div>
            <button
              className="rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-semibold hover:bg-slate-900"
              onClick={() => setRunning((r) => !r)}
            >
              {running ? "Pause" : "Play"}
            </button>
            <button
              className="rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-semibold hover:bg-slate-900"
              onClick={resetDemo}
            >
              Reset
            </button>
            <button
              className="rounded-xl bg-sky-500/90 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-sky-400"
              onClick={() => setViewerOpen(true)}
            >
              Open AR/VR Viewer
            </button>
          </div>
        </div>
      </div>

      {/* Main 3-pane layout */}
      <div className="mx-auto grid max-w-[1400px] grid-cols-1 gap-4 px-5 py-5 lg:grid-cols-12">
        {/* LEFT: Projects & Twins */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">Projects & Twins</div>
              <span className="text-xs text-slate-400">Context</span>
            </div>

            <div className="space-y-2">
              {[
                "ebm-papst • Cabinet Cooling MVP",
                "Pilot • Data Center Row (future)",
                "Template Library • EC Fan Packs",
              ].map((p) => (
                <button
                  key={p}
                  onClick={() => setSelectedProject(p)}
                  className={[
                    "w-full rounded-xl border px-3 py-2 text-left text-sm",
                    p === selectedProject
                      ? "border-sky-500/40 bg-sky-950/30"
                      : "border-slate-800 bg-slate-950/20 hover:bg-slate-950/35",
                  ].join(" ")}
                >
                  <div className="font-medium">{p}</div>
                  <div className="text-xs text-slate-400">Workspace • Artifacts • History</div>
                </button>
              ))}
            </div>

            <div className="my-4 border-t border-slate-800" />

            <div className="mb-2 text-xs font-semibold text-slate-300">Selected Twin</div>
            <div className="space-y-2">
              {["Twin: EC Fan Pair (Cabinet A)", "Twin: Single Fan (Cabinet B)", "Twin: Fan Array (Lab)"].map((tw) => (
                <button
                  key={tw}
                  onClick={() => setSelectedTwin(tw)}
                  className={[
                    "w-full rounded-xl border px-3 py-2 text-left text-sm",
                    tw === selectedTwin
                      ? "border-indigo-500/40 bg-indigo-950/30"
                      : "border-slate-800 bg-slate-950/20 hover:bg-slate-950/35",
                  ].join(" ")}
                >
                  <div className="font-medium">{tw}</div>
                  <div className="text-xs text-slate-400">Draft → Staging → Prod</div>
                </button>
              ))}
            </div>

            <div className="my-4 border-t border-slate-800" />

            <div className="text-xs font-semibold text-slate-300">Natural language prompt</div>
            <div className="mt-2 rounded-xl border border-slate-800 bg-slate-950/30 p-3">
              <textarea
                value={promptText}
                onChange={(e) => setPromptText(e.target.value)}
                className="h-28 w-full resize-none bg-transparent text-xs leading-relaxed text-slate-100 outline-none placeholder:text-slate-600"
                placeholder="Describe your system…"
              />
              <div className="mt-2 flex items-center justify-between text-[11px] text-slate-400">
                <span>{promptDone ? "✓ Prompt captured" : "Typing…"}</span>
                <span className="tabular-nums">{promptText.length} chars</span>
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/20 p-3">
              <div className="text-xs font-semibold text-slate-300">Data buses</div>
              <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
                <span className="rounded-full border border-slate-700 bg-slate-900/50 px-2 py-1">Modbus TCP</span>
                <span className="rounded-full border border-slate-700 bg-slate-900/50 px-2 py-1">MQTT</span>
                <span className="rounded-full border border-slate-700 bg-slate-900/50 px-2 py-1">TimescaleDB</span>
                <span className="rounded-full border border-slate-700 bg-slate-900/50 px-2 py-1">OPC-UA (later)</span>
              </div>
            </div>
          </div>

          {/* Bus feed */}
          <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">Data Activity</div>
              <span className="text-xs text-slate-400">Events</span>
            </div>
            <div className="h-56 overflow-auto rounded-xl border border-slate-800 bg-slate-950/30 p-2 text-xs">
              {busEvents.length === 0 ? (
                <div className="p-3 text-slate-500">Waiting for bus activity…</div>
              ) : (
                busEvents.map((e, idx) => (
                  <div key={idx} className="flex gap-2 px-2 py-1">
                    <span className="w-12 shrink-0 tabular-nums text-slate-500">{formatSec(e.t)}</span>
                    <span className="w-20 shrink-0 text-slate-400">{e.bus}</span>
                    <span className={["shrink text-slate-200", sevColor(e.sev)].join(" ")}>{e.msg}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* CENTER: Tasks & Workflow */}
        <div className="lg:col-span-5">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">Tasks & Workflow</div>
              <span className="text-xs text-slate-400">Agent runs</span>
            </div>

            <div className="grid grid-cols-1 gap-2">
              {agents.map((a) => (
                <button
                  key={a.id}
                  onClick={() => setSelectedAgentId(a.id)}
                  className={[
                    "rounded-xl border p-3 text-left transition",
                    a.id === selectedAgentId
                      ? "border-sky-500/40 bg-sky-950/20"
                      : "border-slate-800 bg-slate-950/20 hover:bg-slate-950/35",
                  ].join(" ")}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{a.name}</div>
                      <div className="text-xs text-slate-400">Outputs: {a.outputArtifacts.join(" · ")}</div>
                    </div>
                    <span className={statusBadge(a.status)}>{a.status}</span>
                  </div>

                  <div className="mt-3">
                    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-500"
                        style={{ width: `${a.progress}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                      <span className="truncate">{a.status === "Done" ? "Completed" : a.status === "Queued" ? "Waiting…" : "Working…"}</span>
                      <span className="tabular-nums">{a.progress}%</span>
                    </div>
                  </div>
                </button>
              ))}
            </div>

            <div className="my-4 border-t border-slate-800" />

            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold">Agent Log</div>
              <div className="text-xs text-slate-400">Selected: {selectedAgent?.name}</div>
            </div>
            <div className="mt-2 h-52 overflow-auto rounded-xl border border-slate-800 bg-slate-950/30 p-2 text-xs">
              {selectedAgent.logs.length === 0 ? (
                <div className="p-3 text-slate-500">No logs yet.</div>
              ) : (
                selectedAgent.logs.map((line, idx) => (
                  <div key={idx} className="px-2 py-1 text-slate-200">
                    {line}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="mt-4 rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-sm font-semibold">Quick Controls</div>
              <span className="text-xs text-slate-400">Demo</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="rounded-xl border border-slate-700 bg-slate-950/30 px-3 py-2 text-xs font-semibold hover:bg-slate-950/45"
                onClick={() => setViewerOpen(true)}
              >
                Open AR/VR Viewer
              </button>
              <button
                className="rounded-xl border border-slate-700 bg-slate-950/30 px-3 py-2 text-xs font-semibold hover:bg-slate-950/45"
                onClick={() => {
                  // jump to “deploy ready”
                  setT(Math.max(t, 160));
                }}
              >
                Jump to Deploy
              </button>
              <button
                className="rounded-xl border border-slate-700 bg-slate-950/30 px-3 py-2 text-xs font-semibold hover:bg-slate-950/45"
                onClick={() => {
                  // nudge KPI fill
                  setT(Math.max(t, 120));
                }}
              >
                Jump to KPIs
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT: Review & KPIs / Deploy */}
        <div className="lg:col-span-4">
          <div className="rounded-2xl border border-slate-800 bg-slate-900/30 p-4">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">Review & KPIs</div>
              <span className="text-xs text-slate-400">Artifacts + deploy</span>
            </div>

            {/* Artifact tabs */}
            <div className="flex flex-wrap gap-2">
              {Object.values(artifacts).map((a) => (
                <button
                  key={a.key}
                  onClick={() => setSelectedArtifactKey(a.key)}
                  className={[
                    "rounded-full border px-3 py-1 text-xs font-semibold",
                    a.key === selectedArtifactKey
                      ? "border-sky-500/40 bg-sky-950/30 text-sky-100"
                      : "border-slate-700 bg-slate-950/25 text-slate-200 hover:bg-slate-950/40",
                  ].join(" ")}
                >
                  {a.label}
                  <span className="ml-2 rounded-full border border-slate-700 bg-slate-950/40 px-2 py-0.5 text-[10px] text-slate-300">
                    v{a.version}
                  </span>
                </button>
              ))}
            </div>

            {/* Artifact viewer */}
            <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/30 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{selectedArtifact.label}</div>
                  <div className="text-xs text-slate-400">
                    Updated:{" "}
                    {selectedArtifact.version === 0 ? "—" : `${formatSec(selectedArtifact.lastUpdatedSec)} (demo)`}
                  </div>
                  <div className="mt-1 text-xs text-slate-200">{selectedArtifact.summary}</div>
                </div>
                <button
                  className="shrink-0 rounded-xl border border-slate-700 bg-slate-950/30 px-3 py-2 text-xs font-semibold hover:bg-slate-950/45"
                  onClick={() => setViewerOpen(true)}
                >
                  View AR
                </button>
              </div>

              <div className="mt-3 space-y-2 text-xs">
                {selectedArtifact.diffLines.map((d, idx) => (
                  <div
                    key={idx}
                    className={[
                      "rounded-lg border px-3 py-2",
                      d.sev === "ok"
                        ? "border-emerald-500/20 bg-emerald-950/10 text-emerald-100"
                        : d.sev === "warn"
                        ? "border-amber-500/20 bg-amber-950/10 text-amber-100"
                        : "border-slate-700 bg-slate-950/20 text-slate-200",
                    ].join(" ")}
                  >
                    {d.text}
                  </div>
                ))}
              </div>
            </div>

            {/* KPI grid */}
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold">KPIs (slow populate)</div>
                <span className="text-xs text-slate-400">Confidence</span>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {kpis.map((k) => {
                  const has = k.value !== null;
                  const val = has ? k.value! : 0;
                  const conf = k.confidence;

                  const bar = clamp(conf / 100, 0, 1);

                  const isGood =
                    k.key === "risk"
                      ? has && val <= (k.target ?? 10)
                      : has && val >= (k.target ?? 0);

                  return (
                    <div key={k.key} className="rounded-xl border border-slate-800 bg-slate-950/25 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-xs font-semibold text-slate-200">{k.label}</div>
                          <div className="mt-1 text-lg font-bold tabular-nums">
                            {has ? (
                              <>
                                {formatNumber(val, k.key === "energy" ? 1 : 0)}
                                <span className="ml-1 text-xs font-semibold text-slate-400">{k.unit}</span>
                              </>
                            ) : (
                              <span className="text-slate-600">—</span>
                            )}
                          </div>
                        </div>

                        <span
                          className={[
                            "rounded-full border px-2 py-1 text-[10px] font-semibold",
                            !has
                              ? "border-slate-700 bg-slate-950/30 text-slate-400"
                              : isGood
                              ? "border-emerald-500/30 bg-emerald-950/20 text-emerald-200"
                              : "border-amber-500/30 bg-amber-950/20 text-amber-200",
                          ].join(" ")}
                        >
                          {has ? (isGood ? "OK" : "ATTN") : "WAIT"}
                        </span>
                      </div>

                      <div className="mt-2">
                        <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-500"
                            style={{ width: `${Math.round(bar * 100)}%` }}
                          />
                        </div>
                        <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
                          <span>conf</span>
                          <span className="tabular-nums">{conf}%</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Deploy */}
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/25 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-semibold">Review & Deploy</div>
                  <div className="text-xs text-slate-400">
                    {deployEnabled ? "Validation passed — deploy enabled." : "Waiting for validation…"}
                  </div>
                </div>
                <span className="rounded-full border border-slate-700 bg-slate-900/60 px-3 py-1 text-xs font-semibold">
                  {stageLabel}
                </span>
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  disabled={!deployEnabled}
                  onClick={promote}
                  className={[
                    "rounded-xl px-3 py-2 text-xs font-semibold",
                    deployEnabled
                      ? "bg-emerald-400 text-slate-950 hover:bg-emerald-300"
                      : "cursor-not-allowed bg-slate-800 text-slate-500",
                  ].join(" ")}
                >
                  {deployStage === "Draft" ? "Promote → Staging" : deployStage === "Staging" ? "Promote → Prod" : "In Production"}
                </button>

                <button
                  onClick={() => setDeployStage("Draft")}
                  className="rounded-xl border border-slate-700 bg-slate-950/30 px-3 py-2 text-xs font-semibold hover:bg-slate-950/45"
                >
                  Back to Draft
                </button>

                <button
                  onClick={() => setViewerOpen(true)}
                  className="rounded-xl border border-slate-700 bg-slate-950/30 px-3 py-2 text-xs font-semibold hover:bg-slate-950/45"
                >
                  AR/VR Viewer
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* AR/VR Viewer Mode (pop-out) */}
      {viewerOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm">
          <div className="mx-auto mt-8 w-[95%] max-w-[1200px] overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/70 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">AR / VR Viewer Mode</div>
                <div className="truncate text-xs text-slate-400">
                  {selectedProject} • {selectedTwin} • {stageLabel}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs font-semibold hover:bg-slate-900"
                  onClick={() => setViewerOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>

            {/* “Scene” */}
            <div className="relative h-[540px] w-full bg-gradient-to-b from-slate-900 to-slate-950">
              {/* Fake factory background */}
              <div className="absolute inset-0 opacity-30">
                <div className="absolute left-0 top-0 h-full w-full bg-[radial-gradient(circle_at_20%_30%,rgba(56,189,248,.35),transparent_40%),radial-gradient(circle_at_70%_40%,rgba(99,102,241,.30),transparent_45%),radial-gradient(circle_at_40%_80%,rgba(16,185,129,.22),transparent_40%)]" />
              </div>

              {/* “Twin model” placeholder */}
              <div className="absolute left-10 top-14 right-10 bottom-16 rounded-2xl border border-slate-800 bg-slate-900/20">
                <div className="absolute left-6 top-6 text-xs text-slate-400">
                  WebXR / Unity / native VR viewer goes here (demo placeholder)
                </div>

                {/* KPI overlays */}
                <div className="absolute left-10 top-16 w-72 space-y-3">
                  <OverlayCard
                    title="Efficiency vs Curve"
                    value={`${formatNumber(arKpi.eff, 0)}%`}
                    subtitle="Cabinet A • EC Fan Pair"
                    accent="sky"
                  />
                  <OverlayCard
                    title="Energy Usage"
                    value={`${formatNumber(arKpi.energy, 1)} kW`}
                    subtitle="Normalized from telemetry"
                    accent="indigo"
                  />
                  <OverlayCard title="System Status" value={arKpi.status} subtitle="Live KPI overlays" accent="emerald" />
                </div>

                {/* “Device silhouette” */}
                <div className="absolute right-8 bottom-6 w-80">
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/25 p-4">
                    <div className="text-xs font-semibold text-slate-200">AR Overlay Anchors</div>
                    <div className="mt-2 space-y-2 text-xs text-slate-300">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Fan_A</span>
                        <span className="font-semibold">RPM/kW/Status</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Fan_B</span>
                        <span className="font-semibold">RPM/kW/Status</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">Cabinet</span>
                        <span className="font-semibold">Temp/Alerts</span>
                      </div>
                    </div>

                    <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs text-slate-300">
                      Tip: in MVP, AR/VR is a viewer mode fed by <span className="font-semibold">views.json</span> +
                      live KPIs.
                    </div>
                  </div>
                </div>
              </div>

              {/* Footer */}
              <div className="absolute left-0 right-0 bottom-0 border-t border-slate-800 bg-slate-950/70 px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs text-slate-400">
                    Rendering: <span className="text-slate-200">CabinetCooling.EC2</span> • Artifacts:{" "}
                    <span className="text-slate-200">
                      v{artifacts.manifest.version}.{artifacts.bindings.version}.{artifacts.kpis.version}
                    </span>
                  </div>
                  <div className="text-xs text-slate-400">
                    Demo time: <span className="text-slate-200 tabular-nums">{formatSec(t)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mx-auto max-w-[1400px] px-5 pb-8 pt-2 text-xs text-slate-500">
        MVP note: Agents write artifacts (manifest/bindings/kpis/views) → validator gates deploy → AR/VR is a viewer mode.
      </div>
    </div>
  );
}

function OverlayCard({
  title,
  value,
  subtitle,
  accent,
}: {
  title: string;
  value: string;
  subtitle: string;
  accent: "sky" | "indigo" | "emerald";
}) {
  const ring =
    accent === "sky"
      ? "border-sky-500/30 bg-sky-950/20"
      : accent === "indigo"
      ? "border-indigo-500/30 bg-indigo-950/20"
      : "border-emerald-500/30 bg-emerald-950/20";

  const valColor =
    accent === "sky" ? "text-sky-200" : accent === "indigo" ? "text-indigo-200" : "text-emerald-200";

  return (
    <div className={["rounded-2xl border p-4 backdrop-blur", ring].join(" ")}>
      <div className="text-xs font-semibold text-slate-200">{title}</div>
      <div className={["mt-1 text-3xl font-bold tabular-nums", valColor].join(" ")}>{value}</div>
      <div className="mt-1 text-xs text-slate-400">{subtitle}</div>
    </div>
  );
}
