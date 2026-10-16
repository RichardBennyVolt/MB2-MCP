import fs from "node:fs";
import path from "node:path";
import { bridgeCall, bridgeDir } from "../scene/bridge.js";
import { logMark, logSince, messageHints } from "../scene/gamelog.js";
import { resolveScene } from "../scene/xscene.js";
import type { Args } from "../util/args.js";
import { bool, int, schema, str, strEnum, type ToolDef } from "./common.js";
import {
  editorSceneFile,
  fmtV,
  liveCall,
  livePing,
  missionLine,
  sceneFileLine,
  unsavedLine,
  unsavedLiveEdits,
  vecArg,
  vecSchema,
  type LiveAgent,
  type LiveMission,
  type LiveStatus,
} from "./scene.js";

/**
 * Play mode and the running mission: start/stop the editor's test mission, walk the player along a route with the
 * game's own AI movement, use objects, query the navigation mesh, read and move the editor camera.
 */

const numSchema = (description: string): Record<string, unknown> => ({ type: "number", description });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function num(a: Args, name: string): number | undefined {
  const v = a.value(name);
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`'${name}' must be a number.`);
  return n;
}

/** [[x,y,z], …] — also as a JSON string or "x,y,z; x,y,z". */
function pointsArg(a: Args, name: string): number[][] {
  let v = a.value(name);
  if (v === undefined || v === null || v === "") return [];
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) v = JSON.parse(s);
    else v = s.split(";").map((p) => p.trim()).filter(Boolean).map((p) => p.split(/[,\s]+/).filter(Boolean).map(Number));
  }
  if (!Array.isArray(v)) throw new Error(`'${name}' must be a list of [x, y, z] points.`);
  return (v as unknown[]).map((p, i) => {
    const arr = Array.isArray(p) ? p.map(Number) : typeof p === "object" && p ? [Number((p as Record<string, unknown>).x), Number((p as Record<string, unknown>).y), Number((p as Record<string, unknown>).z)] : [];
    if (arr.length < 3 || arr.slice(0, 3).some((x) => !Number.isFinite(x))) throw new Error(`'${name}' point ${i + 1} must be [x, y, z].`);
    return arr.slice(0, 3);
  });
}

interface PlayStatus {
  playing: boolean;
  editorPlay: boolean;
  editMode: boolean;
  editorScene?: string;
  mission?: LiveMission & { walk?: WalkReport };
}

interface WalkLeg {
  leg: number;
  from: number[];
  target: number[];
  result: string;
  seconds: number;
  distanceLeft: number;
  closest: number;
  end: number[];
}

interface WalkReport {
  id: number;
  status: string;
  detail?: string;
  legsTotal: number;
  leg: number;
  seconds: number;
  legs: WalkLeg[];
  position?: number[];
  traceSamples: number;
  trace?: Array<[number, number, number, number, number]>;
}

interface UsableRow {
  type: string;
  entity: string;
  parent?: string;
  tags: string[];
  position: number[];
  distance: number;
  disabled: boolean;
  deactivated: boolean;
  inUse: boolean;
  usableByPlayer?: boolean;
  description?: string;
}

interface FaceInfo {
  index: number;
  id: number;
  island: number;
  center: number[];
  unsharedEdges?: boolean;
}

const r1 = (n: number): string => (Math.round(n * 10) / 10).toString();

function agentLine(m: LiveAgent): string {
  return `Player agent #${m.index}${m.name ? ` (${m.name})` : ""} at ${fmtV(m.position)}, facing ${fmtV(m.direction)}, controller ${m.controller}${m.mounted ? ", mounted" : ""}${m.using ? `, using ${m.using}` : ""}, health ${r1(m.health)}${m.active ? "" : ", NOT ACTIVE"}`;
}

function walkHeadline(w: WalkReport): string {
  const done = w.legs.filter((l) => l.result === "reached").length;
  switch (w.status) {
    case "running":
      return `Walk #${w.id}: running — leg ${w.leg}/${w.legsTotal}, ${r1(w.seconds)} s so far${w.position ? `, player at ${fmtV(w.position)}` : ""}.`;
    case "passed":
      return `Walk #${w.id}: PASSED — ${done}/${w.legsTotal} legs reached in ${r1(w.seconds)} s.`;
    case "blocked":
      return `Walk #${w.id}: BLOCKED — ${w.detail}; ${done}/${w.legsTotal} legs reached.`;
    default:
      return `Walk #${w.id}: ${w.status.toUpperCase()}${w.detail ? ` — ${w.detail}` : ""}; ${done}/${w.legsTotal} legs reached.`;
  }
}

function walkLines(w: WalkReport): string[] {
  const L = [walkHeadline(w)];
  for (const l of w.legs) {
    const what = l.result === "reached" ? `reached in ${r1(l.seconds)} s` : `${l.result === "stuck" ? "stuck" : "timed out"} after ${r1(l.seconds)} s, ${r1(l.distanceLeft)} m left (closest ${r1(l.closest)} m), stopped at ${fmtV(l.end)}`;
    L.push(`  leg ${l.leg}: ${fmtV(l.from)} → ${fmtV(l.target)}: ${what}`);
  }
  if (w.status !== "running") L.push(`  Player control restored${w.position ? `; the player stands at ${fmtV(w.position)}` : ""}.`);
  return L;
}

function usableLine(u: UsableRow): string {
  const flags = [u.disabled ? "disabled" : "", u.deactivated ? "deactivated" : "", u.inUse ? "in use" : "", u.usableByPlayer === false ? "not usable by the player" : ""].filter(Boolean);
  return `- ${u.type} '${u.entity}'${u.parent ? ` (in '${u.parent}')` : ""} at ${fmtV(u.position)}, ${r1(u.distance)} m${u.tags.length ? `, tags ${u.tags.join(",")}` : ""}${u.description ? `, "${u.description}"` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
}

function faceLine(f: FaceInfo | null | undefined, at?: number[]): string {
  if (!f) return `no navigation mesh face${at ? ` at ${fmtV(at)}` : ""}`;
  return `face #${f.index} (id ${f.id}, island ${f.island}, center ${fmtV(f.center)}${f.unsharedEdges ? ", has open edges" : ""})`;
}

async function writeTrace(a: Args, w: WalkReport, extra: Record<string, unknown>): Promise<string | null> {
  if (!w.trace) return null;
  const custom = a.str("trace_file");
  if (custom && !/\.json$/i.test(custom)) throw new Error("trace_file must name a .json file.");
  const file = custom ? path.resolve(custom) : path.join(bridgeDir(), `walk_${w.id}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...extra, ...w, traceColumns: ["seconds", "x", "y", "z", "legIndex"] }, null, 1), "utf8");
  return file;
}

export const playTools: ToolDef[] = [
  {
    name: "editor_play",
    group: "editor",
    title: "Play the scene from the editor",
    description:
      "Play mode of the Modding Kit editor (needs the bridge). start plays the open scene with the editor's test mission — the same managed entry the editor's Play button reaches; the player spawns at spawnpoint_player_test or spawnpoint_player — and waits until the player is there. It loads the scene's SAVED file: save first (start refuses when changes made through this server are newer than the file). stop returns to the editor exactly like the leave key does in play mode, and waits for it. status / missions report. While playing, live scene_* commands are refused (they act on the edited scene); use mission, navmesh_query and editor_command screenshot.",
    inputSchema: schema({
      action: strEnum(["status", "start", "stop", "missions"], "Action (default status)."),
      scene: str("start: play another saved scene of the loaded modules by name instead of the open one (the editor keeps its scene)."),
      mission: str("start: the editor mission (default the first one listed by action=missions)."),
      levels: str("start: scene levels for the mission, e.g. 'siege' or 'civilian' (default none)."),
      allow_unsaved: bool("start: play although changes made through this server since the last save are not in the file (default false)."),
      wait_seconds: int("start/stop: wait until the player is spawned / the editor is back (default 120 / 30; 0 = return at once)."),
    }),
    handler: async (a, ctx) => {
      const action = a.str("action", "status") ?? "status";
      if (action === "missions") {
        const list = await liveCall<string[]>(ctx, "play", { action: "missions" }, 10000);
        return list.length ? `Editor missions: ${list.join(", ")} (start uses the first by default).` : "No mission is registered for editor play (the SandBox module provides the test mission).";
      }
      if (action === "status") {
        const st = await liveCall<PlayStatus>(ctx, "play", { action: "status" }, 10000);
        if (!st.playing) return `Not playing. ${st.editMode ? `Editing '${st.editorScene ?? "?"}'.` : "The scene editor is not open."}`;
        const L = [st.mission ? missionLine(st.mission) : "A mission is starting or ending."];
        if (st.mission?.mainAgent) L.push(agentLine(st.mission.mainAgent));
        if (st.mission?.walk) L.push(...walkLines(st.mission.walk));
        return L.join("\n");
      }
      if (action === "start") {
        const ping = await livePing(5000);
        if (!ping) throw new Error("The editor does not answer; editor_status says why.");
        if (ping.mission) throw new Error(`Already playing. ${missionLine(ping.mission)}`);
        if (!ping.editMode || !ping.scene) throw new Error("Open the scene editor first (editor_status).");
        const other = a.str("scene");
        let file: string | null;
        if (!other || other === ping.scene) {
          file = editorSceneFile(ctx, ping.scene, ping.sceneFile);
          if (!file) throw new Error(`Play mode loads '${ping.scene}' from its saved file, and it has none — save the scene in the editor first, or play a saved scene with scene=<name>.`);
          const unsaved = unsavedLiveEdits(ping.scene, file);
          if (unsaved && !a.bool("allow_unsaved", false)) throw new Error(`${unsavedLine(unsaved)} Play mode loads the saved file, so they would be missing. Save first, or pass allow_unsaved=true.`);
        } else {
          try {
            file = resolveScene(ctx.registry, other).file;
          } catch {
            file = null; // the bridge checks what the game can load
          }
        }
        const mark = logMark(ping.pid);
        const res = await liveCall<Record<string, string>>(ctx, "play", { action: "start", scene: other, mission: a.str("mission"), levels: a.str("levels") ?? "" }, 60000);
        const L = [`Starting play mode: mission ${res.mission} on '${res.scene}'${res.levels ? ` with levels '${res.levels}'` : ""} — ${file ? sceneFileLine(file, other ? undefined : ping.sceneFile) : "its saved file"}.`];
        const wait = a.int("wait_seconds", 120, 0, 900);
        if (wait > 0) {
          const end = Date.now() + wait * 1000;
          let st: PlayStatus | null = null;
          while (Date.now() < end) {
            await sleep(1500);
            try {
              st = await bridgeCall<PlayStatus>("play", { action: "status" }, 4000);
            } catch {
              continue; // the main thread is loading
            }
            if (st.mission?.loaded && st.mission.mainAgent) break;
          }
          if (st?.mission?.loaded && st.mission.mainAgent) L.push(missionLine(st.mission), agentLine(st.mission.mainAgent));
          else if (st?.mission) L.push(`No player yet after ${wait} s: ${missionLine(st.mission)} Check editor_play action=status.`);
          else L.push(`No mission is running after ${wait} s${st ? " — the start did not take; see the engine log below" : " — the editor is still busy"}. Check editor_play action=status and editor_status.`);
        }
        const log = logSince(ping.pid, mark, 15);
        if (log.length) L.push("Engine log since the start:", ...log.map((l) => `  ${l}`), ...messageHints(log).map((h) => `Note: ${h}`));
        return L.join("\n");
      }
      if (action === "stop") {
        const msg = await liveCall<string>(ctx, "play", { action: "stop" }, 15000);
        const L = [msg];
        const wait = a.int("wait_seconds", 30, 0, 300);
        if (wait > 0) {
          const end = Date.now() + wait * 1000;
          let back: LiveStatus | null = null;
          while (Date.now() < end) {
            await sleep(1000);
            back = await livePing(4000);
            if (back && !back.mission && back.editMode) break;
          }
          L.push(
            back && !back.mission && back.editMode
              ? `Back in the editor: scene '${back.scene}' with ${back.entities} entities. #handles listed before play stay valid only if the editor kept the scene (the tools say so when not).`
              : `The editor has not returned yet (${back?.mission ? missionLine(back.mission) : "no answer"}); check editor_play action=status.`,
          );
        }
        return L.join("\n");
      }
      throw new Error(`Unknown action '${action}' (status, start, stop, missions).`);
    },
  },
  {
    name: "mission",
    group: "editor",
    title: "Act in the running mission",
    description:
      "In play mode (editor_play) or another running mission (needs the bridge): status (player position, direction, mission state); objects (usable objects near the player — doors, chairs, passages, ladders… — and whether the player can use them); dismount (the editor's test mission spawns a horseman); walk (the player walks a route with the game's own AI movement on the navigation mesh, never teleported, and each leg reports reached / stuck / timed out with the closest approach; the position trace is saved as JSON — evidence that a route can be walked, or where it is blocked); walk_status / walk_stop; teleport (positioning before a test, reported as such — not evidence of a walkable route); use (use an object within reach, the same callback as the interaction key); stop_using.",
    inputSchema: schema({
      action: strEnum(["status", "objects", "walk", "walk_status", "walk_stop", "teleport", "use", "stop_using", "dismount"], "Action (default status)."),
      points: { type: "array", items: { type: "array", items: { type: "number" } }, description: "walk: targets in order, [[x, y, z], …]." },
      return_to_start: bool("walk: afterwards walk the route back to where the player started (default false)."),
      allow_mounted: bool("walk: test the route on horseback when the player is mounted (default false: dismount first)."),
      tolerance: numSchema("walk: a target counts as reached within this horizontal distance in meters (default 0.5)."),
      leg_timeout: numSchema("walk: seconds allowed per leg (default 30)."),
      stall_seconds: numSchema("walk: a leg fails as 'stuck' after this many seconds without 0.3 m of progress (default 6)."),
      speed: numSchema("walk: maximum speed limit for the player while walking (default: unchanged)."),
      wait_seconds: int("walk: wait for the result up to this long (default 120; 0 = return at once and poll with walk_status)."),
      trace_file: str("walk/walk_status: where to save the JSON trace (default: Documents/Mount and Blade II Bannerlord/MB2MCP/walk_<id>_<time>.json)."),
      position: vecSchema("teleport: target; objects: search center (default the player)."),
      direction: vecSchema("teleport: direction to face."),
      radius: numSchema("objects: search radius in meters (default 10)."),
      entity: str("use: name of the usable object's entity (or of its parent)."),
      tag: str("use: tag of the usable object's entity."),
      max_distance: numSchema("use: how far the player may be from the object, in meters (default 3)."),
    }),
    handler: async (a, ctx) => {
      const action = a.str("action", "status") ?? "status";
      switch (action) {
        case "status": {
          const m = await liveCall<(LiveMission & { walk?: WalkReport }) | null>(ctx, "mission", { action: "status" }, 10000);
          if (!m) return "No mission is running.";
          const L = [missionLine(m)];
          if (m.mainAgent) L.push(agentLine(m.mainAgent));
          if (m.walk) L.push(...walkLines(m.walk));
          return L.join("\n");
        }
        case "objects": {
          const r = await liveCall<{ near: number[]; radius: number; objects: UsableRow[] }>(ctx, "mission", { action: "objects", position: vecArg(a, "position"), radius: num(a, "radius") ?? 10, limit: 80 }, 10000);
          return r.objects.length
            ? [`${r.objects.length} usable object(s) within ${r.radius} m of ${fmtV(r.near)}:`, ...r.objects.map(usableLine)].join("\n")
            : `No usable objects within ${r.radius} m of ${fmtV(r.near)}.`;
        }
        case "walk": {
          const points = pointsArg(a, "points");
          if (!points.length) throw new Error("Give 'points': [[x, y, z], …] in order.");
          let w = await liveCall<WalkReport>(
            ctx,
            "mission",
            { action: "walk", points, returnToStart: a.bool("return_to_start", false), allowMounted: a.bool("allow_mounted", false), tolerance: num(a, "tolerance"), legTimeout: num(a, "leg_timeout"), stallSeconds: num(a, "stall_seconds"), speed: num(a, "speed") },
            10000,
          );
          const end = Date.now() + a.int("wait_seconds", 120, 0, 1800) * 1000;
          while (w.status === "running" && Date.now() < end) {
            await sleep(1000);
            try {
              w = await bridgeCall<WalkReport>("mission", { action: "walk_status" }, 5000);
            } catch {
              /* busy frame */
            }
          }
          if (w.status === "running") return [...walkLines(w), "Still walking; poll mission action=walk_status (or walk_stop)."].join("\n");
          const full = await liveCall<WalkReport>(ctx, "mission", { action: "walk_status", trace: true }, 10000);
          const file = await writeTrace(a, full, { points, returnToStart: a.bool("return_to_start", false) });
          return [...walkLines(full), file ? `Trace (${full.traceSamples} samples, 4 per second): ${file}` : ""].filter(Boolean).join("\n");
        }
        case "walk_status": {
          const w = await liveCall<WalkReport>(ctx, "mission", { action: "walk_status", trace: true }, 10000);
          const file = w.status === "running" ? null : await writeTrace(a, w, {});
          return [...walkLines(w), file ? `Trace (${w.traceSamples} samples): ${file}` : ""].filter(Boolean).join("\n");
        }
        case "walk_stop":
          return walkLines(await liveCall<WalkReport>(ctx, "mission", { action: "walk_stop" }, 10000)).join("\n");
        case "teleport": {
          const pos = vecArg(a, "position");
          if (!pos) throw new Error("Give 'position'.");
          const agent = await liveCall<LiveAgent>(ctx, "mission", { action: "teleport", position: pos, direction: vecArg(a, "direction") }, 10000);
          return `Teleported the player (positioning only — this says nothing about whether the place can be reached on foot). ${agentLine(agent)}`;
        }
        case "use": {
          if (!a.str("entity") && !a.str("tag")) throw new Error("Give the usable object's 'entity' name or 'tag' (mission action=objects lists them).");
          const r = await liveCall<{ used: UsableRow; agent: LiveAgent; scene: string }>(ctx, "mission", { action: "use", entity: a.str("entity"), tag: a.str("tag"), maxDistance: num(a, "max_distance") ?? 3 }, 10000);
          return [`Used ${r.used.type} '${r.used.entity}' (as with the interaction key).`, agentLine(r.agent), `Mission scene: '${r.scene}'. Objects that move the player or change the scene act over the next frames; check mission action=status.`].join("\n");
        }
        case "dismount": {
          await liveCall<LiveAgent>(ctx, "mission", { action: "dismount" }, 10000);
          let agent: LiveAgent | undefined;
          for (let i = 0; i < 10; i++) {
            await sleep(500);
            agent = (await liveCall<LiveMission | null>(ctx, "mission", { action: "status" }, 10000))?.mainAgent;
            if (agent && !agent.mounted) break;
          }
          return agent && !agent.mounted ? `Dismounted. ${agentLine(agent)}` : `Still mounted after 5 s (the engine did not dismount; a moving horse cannot be left). ${agent ? agentLine(agent) : ""}`;
        }
        case "stop_using":
          return `Stopped using the object. ${agentLine(await liveCall<LiveAgent>(ctx, "mission", { action: "stop_using" }, 10000))}`;
        default:
          throw new Error(`Unknown action '${action}'.`);
      }
    },
  },
  {
    name: "navmesh_query",
    group: "editor",
    title: "Query the navigation mesh",
    description:
      "Read-only queries with the engine's own path finding (the one AI agents use) on the navigation mesh of the scene open in the editor, or of the running mission (needs the bridge): summary (face count, face ids with their face counts, CRC), at (the face under a position: index, id, island, center, open edges), path (whether two positions are connected, path length against the straight distance, corner points), line (whether a straight move from a position stays on the mesh), group (faces with one id: count and extent). Use mission action=walk to prove a route with a real agent.",
    inputSchema: schema({
      action: strEnum(["summary", "at", "path", "line", "group"], "Query (default summary)."),
      position: vecSchema("at: position to look up."),
      from: vecSchema("path/line: start position."),
      to: vecSchema("path/line: end position."),
      radius: numSchema("path/line: agent radius in meters (default 0.3)."),
      id: int("group: face id (face group index)."),
    }),
    readOnly: true,
    handler: async (a, ctx) => {
      const action = a.str("action", "summary") ?? "summary";
      const r = await liveCall<Record<string, unknown>>(
        ctx,
        "navmesh",
        { action, position: vecArg(a, "position"), from: vecArg(a, "from"), to: vecArg(a, "to"), radius: num(a, "radius"), id: a.has("id") ? a.int("id", 0) : undefined },
        60000,
      );
      const where = `'${r.scene}'${r.inPlay ? " (running mission)" : ""}`;
      if (!r.faces) return `${where}: ${String(r.note ?? "no navigation mesh")}.`;
      switch (action) {
        case "summary": {
          const groups = (r.groups as Array<[number, number]>) ?? [];
          return [
            `Navigation mesh of ${where}: ${r.faces} faces in ${r.groupCount} face id(s)${r.crc ? `, CRC ${r.crc}` : ""}.`,
            `Faces per id: ${groups.map(([id, n]) => `${id}×${n}`).join(", ")}${(r.groupCount as number) > groups.length ? ", …" : ""}`,
          ].join("\n");
        }
        case "at":
          return `${where}: ${faceLine(r.face as FaceInfo | null, r.position as number[])}.`;
        case "path": {
          const L = [`Path ${fmtV(r.from as number[])} → ${fmtV(r.to as number[])} on ${where}: ${r.exists ? "CONNECTED" : "NOT CONNECTED"}.`];
          if (typeof r.distance === "number") L.push(`Path length ${r1(r.distance)} m (straight ${r1(r.straight as number)} m, ×${r1((r.distance as number) / Math.max(0.01, r.straight as number))}).`);
          L.push(`Start: ${faceLine(r.fromFace as FaceInfo | null)}; end: ${faceLine(r.toFace as FaceInfo | null)}.`);
          const corners = (r.corners as number[][] | undefined) ?? [];
          if (corners.length) L.push(`Corners (x, y): ${corners.map((c) => `(${c.map((x) => r1(x)).join(", ")})`).join(" ")}`);
          if (!r.fromFace || !r.toFace) L.push("A position off the mesh is snapped to the nearest face, or has no path at all.");
          return L.join("\n");
        }
        case "line":
          return r.clear === undefined
            ? `${where}: the start ${fmtV(r.from as number[] ?? [0, 0, 0])} is not on the mesh.`
            : `${where}: a straight move from the start stays on the mesh: ${r.clear ? "yes" : "no"} (start ${faceLine(r.fromFace as FaceInfo | null)}).`;
        case "group": {
          if (!r.count) return `${where}: no faces with id ${r.id}.`;
          const sample = (r.sample as Array<[number, number[]]>) ?? [];
          return [
            `${where}: face id ${r.id}: ${r.count} faces, centers within ${fmtV(r.centersMin as number[])} – ${fmtV(r.centersMax as number[])}.`,
            sample.length ? `Faces: ${sample.map(([i, c]) => `#${i} ${fmtV(c)}`).join(", ")}${(r.count as number) > sample.length ? ", …" : ""}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        }
        default:
          return JSON.stringify(r, null, 1);
      }
    },
  },
  {
    name: "editor_camera",
    group: "editor",
    title: "Read or move the editor camera",
    description:
      "The live viewport camera (needs the bridge): get (position, view direction, pitch and heading of the last rendered frame — also in play mode), set (move the editor camera to a position, keeping its direction), move (by a delta). The engine offers no call to turn the live editor camera: scene_edit action=focus zooms toward an entity keeping the direction, and scene_settings editor_camera sets the saved camera used when the scene is opened.",
    inputSchema: schema({
      action: strEnum(["get", "set", "move"], "Action (default get)."),
      position: vecSchema("set: camera position."),
      delta: vecSchema("move: offset to add to the camera position."),
    }),
    handler: async (a, ctx) => {
      const action = a.str("action", "get") ?? "get";
      type Cam = { position: number[]; direction: number[]; pitch: number; heading: number; scene: string; inPlay: boolean; requestedDelta?: number[] };
      const line = (c: Cam): string => `camera at ${fmtV(c.position)}, looking along ${fmtV(c.direction)} (pitch ${r1(c.pitch)}°, heading ${r1(c.heading)}° from +X toward +Y) in '${c.scene}'${c.inPlay ? " (play mode)" : ""}`;
      const before = await liveCall<Cam>(ctx, "camera", { action, position: vecArg(a, "position"), delta: vecArg(a, "delta") }, 10000);
      if (action === "get") return `Editor ${line(before)}. (Read from the last rendered frame.)`;
      const want = action === "set" ? vecArg(a, "position")! : before.position.map((x, i) => x + (before.requestedDelta?.[i] ?? 0));
      await sleep(400);
      const after = await liveCall<Cam>(ctx, "camera", { action: "get" }, 10000);
      const off = Math.hypot(...after.position.map((x, i) => x - want[i]));
      return [`Moved: ${line(after)}.`, off > 0.05 ? `It is ${r1(off)} m from the requested ${fmtV(want)} (the editor may clamp or smooth camera moves; check again).` : `Requested position ${fmtV(want)} reached; direction unchanged.`].join("\n");
    },
  },
];
