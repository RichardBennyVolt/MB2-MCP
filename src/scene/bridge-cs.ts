/**
 * C# source of the MB2MCP.EditorBridge module. It is compiled on the user's machine with the
 * .NET Framework C# compiler (C# 5 — keep the syntax old-fashioned: no string interpolation,
 * no ?. operator, no expression-bodied members) against the installed game's editor assemblies.
 *
 * Inside the Modding Kit editor process it opens a localhost TCP socket (port + random token in
 * Documents/Mount and Blade II Bannerlord/MB2MCP/bridge.json). Requests are JSON lines; they are
 * queued and executed on the game's main thread from OnApplicationTick, where engine calls are safe.
 */
export const BRIDGE_VERSION = "0.3.0";

export const BRIDGE_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using IOPath = System.IO.Path;
using TaleWorlds.Core;
using TaleWorlds.Engine;
using TaleWorlds.Library;
using TaleWorlds.MountAndBlade;

namespace MB2MCP.EditorBridge
{
    public class SubModule : MBSubModuleBase
    {
        private static Bridge _bridge;

        protected override void OnSubModuleLoad()
        {
            base.OnSubModuleLoad();
            try
            {
                if (!Bridge.IsEditorBuild())
                {
                    Bridge.Log("Not running the Modding Kit (Win64_Shipping_wEditor) build; bridge stays off.");
                    return;
                }
                _bridge = new Bridge();
                _bridge.Start();
            }
            catch (Exception e)
            {
                Bridge.Log("Start failed: " + e);
            }
        }

        protected override void OnSubModuleUnloaded()
        {
            if (_bridge != null) _bridge.Stop();
            base.OnSubModuleUnloaded();
        }

        protected override void OnApplicationTick(float dt)
        {
            base.OnApplicationTick(dt);
            if (_bridge != null) _bridge.Tick(dt);
        }
    }

    internal sealed class Request
    {
        public object Id;
        public string Cmd;
        public Dictionary<string, object> Args;
        public string Response;
        public readonly ManualResetEvent Done = new ManualResetEvent(false);
        /** 0 queued, 1 running, 2 abandoned by the client (never started). */
        public int State;
    }

    public sealed class Bridge
    {
        public const string Version = "__BRIDGE_VERSION__";

        private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 64 };
        private static readonly object LogLock = new object();

        private TcpListener _listener;
        private volatile bool _running;
        private string _token;
        private int _port;
        private readonly Queue<Request> _queue = new Queue<Request>();
        private readonly object _queueLock = new object();
        private readonly Dictionary<int, GameEntity> _handles = new Dictionary<int, GameEntity>();
        private readonly Dictionary<UIntPtr, int> _handleOf = new Dictionary<UIntPtr, int>();
        // Entities built here from a bare mesh (CreateEmpty + AddMultiMesh) and their copies. The engine keeps
        // no prefab bookkeeping for them, so prefab queries are skipped. GetOldPrefabName is never called at
        // all: on such entities it dereferences a null engine pointer, an access violation that managed
        // try/catch cannot stop (the editor hangs under its crash watchdog).
        private readonly HashSet<UIntPtr> _meshEntities = new HashSet<UIntPtr>();
        // Handles belong to one opened scene: after the scene is (re)opened the old entity objects may be freed.
        private Scene _handleScene;
        private UIntPtr _handleScenePtr;
        private int _firstHandleOfScene = 1;
        // What the main thread is doing, for "hello" (answered off the main thread).
        private volatile string _current;
        private long _currentSince;
        private volatile string _lastLong;
        private int _nextHandle = 1;
        private long _lastTickTicks;
        private int _autostartFrames;
        private DateTime _nextAutostartCheck = DateTime.MinValue;
        private DateTime _quitAt = DateTime.MinValue;

        public static string Dir
        {
            get { return IOPath.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Mount and Blade II Bannerlord", "MB2MCP"); }
        }

        public static bool IsEditorBuild()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory ?? "";
            return baseDir.IndexOf("wEditor", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        public static void Log(string message)
        {
            try
            {
                lock (LogLock)
                {
                    Directory.CreateDirectory(Dir);
                    string file = IOPath.Combine(Dir, "bridge.log");
                    if (File.Exists(file) && new FileInfo(file).Length > 2 * 1024 * 1024) File.Delete(file);
                    File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff", CultureInfo.InvariantCulture) + " " + message + Environment.NewLine);
                }
            }
            catch
            {
            }
        }

        public void Start()
        {
            _token = Guid.NewGuid().ToString("N");
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
            _port = ((IPEndPoint)_listener.LocalEndpoint).Port;
            _running = true;
            var t = new Thread(AcceptLoop);
            t.IsBackground = true;
            t.Name = "MB2MCP bridge";
            t.Start();
            WriteStatus();
            AppDomain.CurrentDomain.ProcessExit += delegate { DeleteStatus(); };
            Log("Bridge " + Version + " listening on 127.0.0.1:" + _port);
        }

        public void Stop()
        {
            _running = false;
            try { _listener.Stop(); } catch { }
            DeleteStatus();
        }

        private void WriteStatus()
        {
            Directory.CreateDirectory(Dir);
            var d = new Dictionary<string, object>();
            d["port"] = _port;
            d["token"] = _token;
            d["pid"] = Process.GetCurrentProcess().Id;
            d["bridge"] = Version;
            d["started"] = DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture);
            d["exe"] = AppDomain.CurrentDomain.BaseDirectory;
            File.WriteAllText(IOPath.Combine(Dir, "bridge.json"), Json.Serialize(d), new UTF8Encoding(false));
        }

        private void DeleteStatus()
        {
            try
            {
                string file = IOPath.Combine(Dir, "bridge.json");
                if (File.Exists(file) && File.ReadAllText(file).Contains(_token)) File.Delete(file);
            }
            catch
            {
            }
        }

        // ---- networking (background threads) ------------------------------------------------

        private void AcceptLoop()
        {
            while (_running)
            {
                TcpClient client;
                try { client = _listener.AcceptTcpClient(); }
                catch { if (!_running) return; continue; }
                var t = new Thread(() => HandleClient(client));
                t.IsBackground = true;
                t.Start();
            }
        }

        private void HandleClient(TcpClient client)
        {
            try
            {
                using (client)
                {
                    var stream = client.GetStream();
                    var reader = new StreamReader(stream, new UTF8Encoding(false));
                    var writer = new StreamWriter(stream, new UTF8Encoding(false));
                    writer.AutoFlush = true;
                    writer.NewLine = "\n";
                    string line;
                    while (_running && (line = reader.ReadLine()) != null)
                    {
                        if (line.Length == 0) continue;
                        writer.WriteLine(Handle(line));
                    }
                }
            }
            catch (Exception e)
            {
                Log("client error: " + e.Message);
            }
        }

        private string Handle(string line)
        {
            object id = null;
            try
            {
                var msg = Json.DeserializeObject(line) as Dictionary<string, object>;
                if (msg == null) return Err(null, "Request must be a JSON object.");
                msg.TryGetValue("id", out id);
                object token;
                if (!msg.TryGetValue("token", out token) || !string.Equals(token as string, _token, StringComparison.Ordinal)) return Err(id, "Bad token.");
                object cmdObj;
                msg.TryGetValue("cmd", out cmdObj);
                string cmd = cmdObj as string ?? "";
                object argsObj;
                msg.TryGetValue("args", out argsObj);
                var args = argsObj as Dictionary<string, object> ?? new Dictionary<string, object>();
                if (cmd == "hello")
                {
                    var hello = new Dictionary<string, object>();
                    hello["bridge"] = Version;
                    hello["pid"] = Process.GetCurrentProcess().Id;
                    long last = Interlocked.Read(ref _lastTickTicks);
                    hello["lastTickMsAgo"] = last == 0 ? -1 : (long)(DateTime.UtcNow - new DateTime(last, DateTimeKind.Utc)).TotalMilliseconds;
                    string cur = _current;
                    if (cur != null)
                    {
                        hello["busyWith"] = cur;
                        hello["busyMs"] = (long)(DateTime.UtcNow - new DateTime(Interlocked.Read(ref _currentSince), DateTimeKind.Utc)).TotalMilliseconds;
                    }
                    string lastLong = _lastLong;
                    if (lastLong != null) hello["lastLong"] = lastLong;
                    return Ok(id, hello);
                }
                var r = new Request();
                r.Id = id;
                r.Cmd = cmd;
                r.Args = args;
                lock (_queueLock) _queue.Enqueue(r);
                int timeout = GetInt(args, "timeoutMs", 60000);
                if (!r.Done.WaitOne(timeout))
                {
                    // A request the client gave up on must not run later behind its back.
                    if (Interlocked.CompareExchange(ref r.State, 2, 0) == 0)
                        return Err(id, "The editor did not process the request within " + timeout + " ms (main thread busy: loading, a long command or a modal window); it was cancelled and nothing was done.");
                    return Err(id, "The editor did not finish the request within " + timeout + " ms; it is still running on the main thread and will complete, but its result is lost. Check the outcome before repeating it.");
                }
                return r.Response;
            }
            catch (Exception e)
            {
                return Err(id, e.Message);
            }
        }

        private static string Ok(object id, object result)
        {
            var d = new Dictionary<string, object>();
            d["id"] = id;
            d["ok"] = true;
            d["result"] = result;
            return Json.Serialize(d);
        }

        private static string Err(object id, string error)
        {
            var d = new Dictionary<string, object>();
            d["id"] = id;
            d["ok"] = false;
            d["error"] = error;
            return Json.Serialize(d);
        }

        // ---- main thread ---------------------------------------------------------------------

        public void Tick(float dt)
        {
            Interlocked.Exchange(ref _lastTickTicks, DateTime.UtcNow.Ticks);
            if (_quitAt != DateTime.MinValue && DateTime.UtcNow >= _quitAt)
            {
                _quitAt = DateTime.MinValue;
                Log("Quit requested through the bridge.");
                DeleteStatus();
                TaleWorlds.Engine.Utilities.QuitGame();
                return;
            }
            HandleAutostart();
            try { TickWalk(dt); } catch (Exception e) { Log("walk tick failed: " + e.Message); }
            try { TickPerf(dt); } catch (Exception e) { Log("perf tick failed: " + e.Message); }
            var sw = Stopwatch.StartNew();
            int processed = 0;
            while (processed < 64 && sw.ElapsedMilliseconds < 50)
            {
                Request r = null;
                lock (_queueLock) { if (_queue.Count > 0) r = _queue.Dequeue(); }
                if (r == null) break;
                if (Interlocked.CompareExchange(ref r.State, 1, 0) != 0) continue; // the client gave up on it
                Interlocked.Exchange(ref _currentSince, DateTime.UtcNow.Ticks);
                _current = r.Cmd;
                var watch = Stopwatch.StartNew();
                try { r.Response = Ok(r.Id, Execute(r.Cmd, r.Args)); }
                catch (Exception e) { r.Response = Err(r.Id, e.Message); Log(r.Cmd + " failed: " + e); }
                finally
                {
                    _current = null;
                    if (watch.ElapsedMilliseconds > 2000)
                    {
                        _lastLong = r.Cmd + " took " + (watch.ElapsedMilliseconds / 1000.0).ToString("0.0", CultureInfo.InvariantCulture) + " s (finished " + DateTime.Now.ToString("HH:mm:ss", CultureInfo.InvariantCulture) + ")";
                        Log(_lastLong);
                    }
                }
                r.Done.Set();
                processed++;
            }
        }

        private void HandleAutostart()
        {
            if (DateTime.UtcNow < _nextAutostartCheck) return;
            string file = IOPath.Combine(Dir, "autostart.json");
            if (!File.Exists(file)) { _nextAutostartCheck = DateTime.UtcNow.AddSeconds(1); _autostartFrames = 0; return; }
            try
            {
                if ((DateTime.UtcNow - File.GetLastWriteTimeUtc(file)).TotalMinutes > 15) { File.Delete(file); return; }
                if (!(ActiveState() is InitialState)) { _autostartFrames = 0; return; }
                if (++_autostartFrames < 90) return;
                File.Delete(file);
                Log("Autostart: entering the scene editor.");
                MBInitialScreenBase.OnEditModeEnterPress(); // what the main menu's Editor button and Ctrl+E do
            }
            catch (Exception e)
            {
                Log("Autostart failed: " + e);
                _nextAutostartCheck = DateTime.UtcNow.AddSeconds(5);
            }
        }

        private object Execute(string cmd, Dictionary<string, object> a)
        {
            switch (cmd)
            {
                case "ping": return Status();
                case "enter_editor": return EnterEditor();
                case "entities": return Entities(a);
                case "selection": return Selection();
                case "select": return Select(a);
                case "spawn": return Spawn(a);
                case "transform": return Transform(a);
                case "delete": return Delete(a);
                case "duplicate": return Duplicate(a);
                case "modify": return Modify(a);
                case "focus": return Focus(a);
                case "raycast": return Raycast(a);
                case "screenshot": return Screenshot(a);
                case "console": return ConsoleCommand(a);
                case "commands": return Commands(a);
                case "check": return Check();
                case "reimport": return Reimport();
                case "warning": MBEditor.AddEditorWarning(GetString(a, "message", "")); return true;
                case "prefabs_exist": return PrefabsExist(a);
                case "play": return Play(a);
                case "mission": return MissionCommand(a);
                case "navmesh": return NavMesh(a);
                case "camera": return CameraCommand(a);
                case "perf": return Perf(a);
                case "quit":
                    if (!GetBool(a, "confirm", false)) throw new Exception("quit needs confirm=true (unsaved editor changes are lost).");
                    _quitAt = DateTime.UtcNow.AddSeconds(1);
                    return "The game will exit in about one second.";
                default: throw new Exception("Unknown command '" + cmd + "'.");
            }
        }

        private Dictionary<string, object> Status()
        {
            var d = new Dictionary<string, object>();
            d["bridge"] = Version;
            d["pid"] = Process.GetCurrentProcess().Id;
            d["editMode"] = MBEditor.IsEditModeOn;
            d["state"] = ActiveStateName();
            Scene scene = MBEditor._editorScene;
            if (scene != null)
            {
                string name = scene.GetName();
                d["scene"] = name;
                var all = new List<GameEntity>();
                scene.GetEntities(ref all);
                d["entities"] = all.Count;
                d["rootEntities"] = scene.RootEntityCount;
                var sel = new List<GameEntity>();
                TaleWorlds.Engine.Utilities.GetSelectedEntities(ref sel);
                d["selected"] = sel.Count;
                try { d["sceneFile"] = TaleWorlds.Engine.Utilities.GetFullFilePathOfScene(name); } catch { }
                try { d["loaded"] = scene.IsLoadingFinished(); } catch { }
                try { d["loadingState"] = scene.GetLoadingStateName(); } catch { }
            }
            try { var ms = MissionSummary(); if (ms != null) d["mission"] = ms; } catch { }
            return d;
        }

        private static GameState ActiveState()
        {
            var gsm = GameStateManager.Current;
            if (gsm == null && TaleWorlds.MountAndBlade.Module.CurrentModule != null) gsm = TaleWorlds.MountAndBlade.Module.CurrentModule.GlobalGameStateManager;
            return gsm != null ? gsm.ActiveState : null;
        }

        private static string ActiveStateName()
        {
            var s = ActiveState();
            return s != null ? s.GetType().Name : null;
        }

        private object EnterEditor()
        {
            if (MBEditor.IsEditModeOn) return "already in the editor";
            if (!(ActiveState() is InitialState)) throw new Exception("Go to the main menu first (current state: " + (ActiveStateName() ?? "none") + ").");
            MBInitialScreenBase.OnEditModeEnterPress();
            return "entering the editor";
        }

        private Scene RequireScene()
        {
            Scene scene = MBEditor._editorScene;
            if (scene == null || !MBEditor.IsEditModeOn) throw new Exception("The scene editor is not open. Enter it from the main menu (Ctrl+E) and open a scene.");
            if (EditorPlay())
                throw new Exception("The editor is in play mode (" + PlayLabel() + "): live scene commands act on the edited scene, which play mode replaces until it ends. Stop play first (editor_play action=stop), or use the mission and navmesh tools.");
            if (scene.Pointer == UIntPtr.Zero) throw new Exception("The editor scene is being opened or closed; try again in a moment.");
            if (!ReferenceEquals(scene, _handleScene) || scene.Pointer != _handleScenePtr)
            {
                // Another scene, or the same one opened again: entities seen before may be freed.
                _handles.Clear();
                _handleOf.Clear();
                _meshEntities.Clear();
                _handleScene = scene;
                _handleScenePtr = scene.Pointer;
                _firstHandleOfScene = _nextHandle;
            }
            return scene;
        }

        // ---- entity helpers --------------------------------------------------------------------

        private int HandleOf(GameEntity e)
        {
            int h;
            if (_handleOf.TryGetValue(e.Pointer, out h)) return h;
            h = _nextHandle++;
            _handles[h] = e;
            _handleOf[e.Pointer] = h;
            return h;
        }

        private static object[] V(Vec3 v)
        {
            return new object[] { R(v.x), R(v.y), R(v.z) };
        }

        private static double R(float f)
        {
            if (float.IsNaN(f) || float.IsInfinity(f)) return 0;
            return Math.Round(f, 4);
        }

        private Dictionary<string, object> Info(GameEntity e)
        {
            var d = new Dictionary<string, object>();
            d["handle"] = HandleOf(e);
            d["name"] = e.Name;
            if (!_meshEntities.Contains(e.Pointer))
            {
                try { string p = e.GetPrefabName(); if (!string.IsNullOrEmpty(p)) d["prefab"] = p; } catch { }
            }
            MatrixFrame f = e.GetGlobalFrame();
            d["position"] = V(f.origin);
            d["rotation"] = V(f.rotation.GetEulerAngles());
            d["scale"] = V(f.rotation.GetScaleVector());
            d["tags"] = (e.Tags ?? new string[0]).Where(t => !string.IsNullOrEmpty(t)).ToArray();
            d["children"] = e.ChildCount;
            var parent = e.Parent;
            if (parent != null) d["parent"] = parent.Name;
            try { d["selected"] = MBEditor.IsEntitySelected(e); } catch { }
            return d;
        }

        private GameEntity EntityForHandle(Scene scene, int h, ref HashSet<UIntPtr> live)
        {
            GameEntity e;
            if (!_handles.TryGetValue(h, out e) || e == null)
            {
                if (h > 0 && h < _firstHandleOfScene) throw new Exception("Handle #" + h + " belongs to an earlier opening of the scene; handles are only valid until the scene is opened again — list entities again.");
                throw new Exception("Unknown handle #" + h + "; list entities again.");
            }
            if (live == null)
            {
                var all = new List<GameEntity>();
                scene.GetEntities(ref all);
                live = new HashSet<UIntPtr>();
                foreach (var x in all) live.Add(x.Pointer);
            }
            if (e.Pointer == UIntPtr.Zero || !live.Contains(e.Pointer))
            {
                // Never touch an entity that left the scene: its engine object may be freed.
                _handles.Remove(h);
                _handleOf.Remove(e.Pointer);
                _meshEntities.Remove(e.Pointer);
                throw new Exception("Entity #" + h + " is no longer in the open scene (deleted or replaced in the editor); list entities again.");
            }
            return e;
        }

        /** Scene.GetFirstEntityWithName does not see child entities; fall back to all entities (exact, then case-insensitive). */
        private static GameEntity FindByName(Scene scene, string name)
        {
            GameEntity e = scene.GetFirstEntityWithName(name);
            if (e != null) return e;
            var all = new List<GameEntity>();
            scene.GetEntities(ref all);
            GameEntity loose = null;
            foreach (var x in all)
            {
                string n = x.Name;
                if (n == name) return x;
                if (loose == null && string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) loose = x;
            }
            return loose;
        }

        private List<GameEntity> ResolveEntities(Scene scene, Dictionary<string, object> a, string key, bool required)
        {
            HashSet<UIntPtr> live = null;
            var list = new List<GameEntity>();
            object raw;
            if (!a.TryGetValue(key, out raw) || raw == null)
            {
                if (required) throw new Exception("Missing '" + key + "'.");
                return list;
            }
            var items = raw as object[];
            if (items == null) items = new object[] { raw };
            foreach (var item in items)
            {
                GameEntity e = null;
                string s = item as string;
                if (s == null)
                {
                    e = EntityForHandle(scene, Convert.ToInt32(item, CultureInfo.InvariantCulture), ref live);
                }
                else if (s.StartsWith("guid:", StringComparison.OrdinalIgnoreCase))
                {
                    e = scene.GetEntityWithGuid(s.Substring(5));
                }
                else if (s == "@selected")
                {
                    var sel = new List<GameEntity>();
                    TaleWorlds.Engine.Utilities.GetSelectedEntities(ref sel);
                    list.AddRange(sel);
                    continue;
                }
                else
                {
                    int h;
                    string hs = s.StartsWith("#") ? s.Substring(1) : s;
                    if (int.TryParse(hs, NumberStyles.Integer, CultureInfo.InvariantCulture, out h)) e = EntityForHandle(scene, h, ref live);
                    else e = FindByName(scene, s);
                }
                if (e == null) throw new Exception("No entity named '" + Convert.ToString(item, CultureInfo.InvariantCulture) + "' in the open scene; list entities to get names and #handles.");
                if (!list.Contains(e)) list.Add(e);
            }
            return list;
        }

        private static readonly string[] SpawnerScripts =
        {
            "BallistaSpawner", "BatteringRamSpawner", "MangonelSpawner", "SiegeLadderSpawner", "SiegeTowerSpawner", "TrebuchetSpawner",
            "MultiplayerBallistaSpawner", "MultiplayerBatteringRamSpawner", "MultiplayerFireBallistaSpawner", "MultiplayerFireMangonelSpawner",
            "MultiplayerFireTrebuchetSpawner", "MultiplayerMangonelSpawner", "MultiplayerSiegeTowerSpawner", "MultiplayerTrebuchetSpawner",
            "ShipFireBallistaSpawner"
        };

        private string SpawnerScriptOf(GameEntity e)
        {
            if (_meshEntities.Contains(e.Pointer)) return null;
            foreach (var sc in SpawnerScripts) if (e.HasScriptComponent(sc)) return sc;
            return null;
        }

        /**
         * SpawnerEntityEditorHelper.GetPrefabName instantiates "name minus its last '_part'" as the spawner's
         * preview; a name that does not lead to an existing prefab crashes the editor when the scene loads.
         */
        private string SpawnerNameProblem(GameEntity e, string newName)
        {
            string script = SpawnerScriptOf(e);
            if (script == null) return null;
            int us = newName.LastIndexOf('_');
            string prefab = us > 0 ? newName.Substring(0, us) : "";
            if (prefab.Length > 0 && us < newName.Length - 1 && GameEntity.PrefabExists(prefab)) return null;
            return "Refusing to name '" + e.Name + "' (" + script + ") '" + newName + "': the editor builds a siege spawner's preview from its name minus the last '_part' (" +
                (prefab.Length > 0 ? "'" + prefab + "', which is not a prefab" : "nothing") + ") and crashes loading the scene. Keep '<prefab>_spawner' names and label it with tags or a parent entity.";
        }

        private static Mat3 BuildRotation(Vec3 euler, Vec3 scale)
        {
            Mat3 m = Mat3.Identity;
            m.ApplyEulerAngles(ref euler);
            m.ApplyScaleLocal(ref scale);
            return m;
        }

        private static bool SnapToGround(Scene scene, ref Vec3 pos, GameEntity ignore)
        {
            float dist;
            Vec3 point;
            var from = new Vec3(pos.x, pos.y, pos.z + 200f, -1f);
            var to = new Vec3(pos.x, pos.y, pos.z - 2000f, -1f);
            bool hit = scene.RayCastForClosestEntityOrTerrain(from, to, out dist, out point);
            if (hit) pos = new Vec3(pos.x, pos.y, point.z, -1f);
            return hit;
        }

        // ---- commands ------------------------------------------------------------------------------

        private object Entities(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            var all = new List<GameEntity>();
            scene.GetEntities(ref all);
            string name = GetString(a, "name", null);
            string tag = GetString(a, "tag", null);
            string prefab = GetString(a, "prefab", null);
            bool rootOnly = GetBool(a, "rootOnly", false);
            bool selectedOnly = GetBool(a, "selectedOnly", false);
            Vec3 near = GetVec(a, "near", Vec3.Invalid);
            float radius = GetFloat(a, "radius", 10f);
            int limit = GetInt(a, "limit", 50);
            int offset = GetInt(a, "offset", 0);
            var hits = new List<GameEntity>();
            foreach (var e in all)
            {
                if (rootOnly && e.Parent != null) continue;
                if (name != null && (e.Name ?? "").IndexOf(name, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (tag != null && !e.HasTag(tag)) continue;
                if (prefab != null)
                {
                    string p = "";
                    if (!_meshEntities.Contains(e.Pointer)) { try { p = e.GetPrefabName() ?? ""; } catch { } }
                    if (p.IndexOf(prefab, StringComparison.OrdinalIgnoreCase) < 0) continue;
                }
                if (selectedOnly && !MBEditor.IsEntitySelected(e)) continue;
                if (near.IsValid && e.GetGlobalFrame().origin.Distance(near) > radius) continue;
                hits.Add(e);
            }
            var rows = new List<object>();
            foreach (var e in hits.Skip(offset).Take(limit)) rows.Add(Info(e));
            var d = new Dictionary<string, object>();
            d["total"] = hits.Count;
            d["entities"] = rows;
            return d;
        }

        private object Selection()
        {
            RequireScene();
            var sel = new List<GameEntity>();
            TaleWorlds.Engine.Utilities.GetSelectedEntities(ref sel);
            var rows = new List<object>();
            foreach (var e in sel.Take(500)) rows.Add(Info(e));
            var d = new Dictionary<string, object>();
            d["total"] = sel.Count;
            d["entities"] = rows;
            return d;
        }

        private object Select(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            var list = ResolveEntities(scene, a, "entities", false);
            if (GetBool(a, "add", false))
            {
                var cur = new List<GameEntity>();
                TaleWorlds.Engine.Utilities.GetSelectedEntities(ref cur);
                foreach (var e in cur) if (!list.Contains(e)) list.Add(e);
            }
            TaleWorlds.Engine.Utilities.SelectEntities(list);
            if (list.Count > 0 && GetBool(a, "focus", false)) MBEditor.ZoomToPosition(list[0].GetGlobalFrame().origin);
            return list.Count;
        }

        private object Spawn(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            string prefab = GetString(a, "prefab", null);
            string mesh = GetString(a, "mesh", null);
            if (prefab == null && mesh == null) throw new Exception("Give a prefab or a mesh.");
            if (prefab != null && !GameEntity.PrefabExists(prefab)) throw new Exception("Prefab '" + prefab + "' does not exist in the loaded modules.");
            Vec3 pos = GetVec(a, "position", new Vec3(0, 0, 0, -1f));
            Vec3 rot = GetVec(a, "rotation", new Vec3(0, 0, 0, -1f));
            Vec3 scale = GetVec(a, "scale", new Vec3(1, 1, 1, -1f));
            Vec3 step = GetVec(a, "offset", new Vec3(0, 0, 0, -1f));
            int count = Math.Max(1, Math.Min(500, GetInt(a, "count", 1)));
            string name = GetString(a, "name", null);
            bool snap = GetBool(a, "snapToGround", false);
            var tags = GetStrings(a, "tags");
            var created = new List<GameEntity>();
            for (int i = 0; i < count; i++)
            {
                Vec3 p = new Vec3(pos.x + step.x * i, pos.y + step.y * i, pos.z + step.z * i, -1f);
                if (snap) SnapToGround(scene, ref p, null);
                MatrixFrame frame = MatrixFrame.Identity;
                frame.rotation = BuildRotation(rot, scale);
                frame.origin = p;
                GameEntity e;
                if (prefab != null)
                {
                    e = GameEntity.Instantiate(scene, prefab, frame, true);
                }
                else
                {
                    MetaMesh mm = MetaMesh.GetCopy(mesh, false, true);
                    if (mm == null) throw new Exception("Mesh '" + mesh + "' was not found.");
                    e = GameEntity.CreateEmpty(scene, true, true, true);
                    if (e != null) _meshEntities.Add(e.Pointer);
                    e.AddMultiMesh(mm, true);
                    e.SetGlobalFrame(ref frame, true);
                }
                if (e == null) throw new Exception("The engine returned no entity.");
                if (name != null)
                {
                    string newName = count > 1 && GetBool(a, "numberNames", true) ? name + "_" + (i + 1).ToString(CultureInfo.InvariantCulture) : name;
                    string problem = SpawnerNameProblem(e, newName);
                    if (problem != null)
                    {
                        created.Add(e);
                        try { TaleWorlds.Engine.Utilities.DeleteEntitiesInEditorScene(created); } catch { foreach (var x in created) x.Remove(0); }
                        MBEditor.UpdateSceneTree(true);
                        throw new Exception(problem + " Nothing was added.");
                    }
                    e.Name = newName;
                }
                foreach (var t in tags) e.AddTag(t);
                created.Add(e);
            }
            if (GetBool(a, "select", true)) TaleWorlds.Engine.Utilities.SelectEntities(created);
            MBEditor.UpdateSceneTree(true);
            return created.Select(x => (object)Info(x)).ToList();
        }

        private object Transform(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            var list = ResolveEntities(scene, a, "entities", true);
            bool hasPos = a.ContainsKey("position");
            bool hasMove = a.ContainsKey("moveBy");
            bool hasRot = a.ContainsKey("rotation");
            bool hasRotBy = a.ContainsKey("rotateBy");
            bool hasScale = a.ContainsKey("scale");
            bool snap = GetBool(a, "snapToGround", false);
            foreach (var e in list)
            {
                MatrixFrame f = e.GetGlobalFrame();
                Vec3 scale = f.rotation.GetScaleVector();
                Vec3 euler = f.rotation.GetEulerAngles();
                if (hasPos) f.origin = GetVec(a, "position", f.origin);
                if (hasMove) { Vec3 d = GetVec(a, "moveBy", new Vec3(0, 0, 0, -1f)); f.origin = new Vec3(f.origin.x + d.x, f.origin.y + d.y, f.origin.z + d.z, -1f); }
                if (hasRot) euler = GetVec(a, "rotation", euler);
                if (hasRotBy) { Vec3 d = GetVec(a, "rotateBy", new Vec3(0, 0, 0, -1f)); euler = new Vec3(euler.x + d.x, euler.y + d.y, euler.z + d.z, -1f); }
                if (hasScale) scale = GetVec(a, "scale", scale);
                if (hasRot || hasRotBy || hasScale) f.rotation = BuildRotation(euler, scale);
                if (snap) { Vec3 o = f.origin; SnapToGround(scene, ref o, e); f.origin = o; }
                e.SetGlobalFrame(ref f, true);
            }
            MBEditor.UpdateSceneTree(true);
            return list.Select(x => (object)Info(x)).ToList();
        }

        private object Delete(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            var list = ResolveEntities(scene, a, "entities", true);
            int n = list.Count;
            foreach (var x in list)
            {
                int h;
                if (_handleOf.TryGetValue(x.Pointer, out h)) { _handles.Remove(h); _handleOf.Remove(x.Pointer); }
                _meshEntities.Remove(x.Pointer);
            }
            try
            {
                TaleWorlds.Engine.Utilities.DeleteEntitiesInEditorScene(list);
            }
            catch (Exception e)
            {
                Log("DeleteEntitiesInEditorScene failed, removing directly: " + e.Message);
                foreach (var x in list) x.Remove(0);
            }
            MBEditor.UpdateSceneTree(true);
            return n;
        }

        private object Duplicate(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            var list = ResolveEntities(scene, a, "entities", true);
            Vec3 step = GetVec(a, "offset", new Vec3(1, 0, 0, -1f));
            int count = Math.Max(1, Math.Min(500, GetInt(a, "count", 1)));
            var created = new List<GameEntity>();
            foreach (var src in list)
            {
                MatrixFrame f0 = src.GetGlobalFrame();
                for (int i = 1; i <= count; i++)
                {
                    GameEntity c = GameEntity.CopyFrom(scene, src, true, true);
                    if (_meshEntities.Contains(src.Pointer)) _meshEntities.Add(c.Pointer);
                    MatrixFrame f = f0;
                    f.origin = new Vec3(f0.origin.x + step.x * i, f0.origin.y + step.y * i, f0.origin.z + step.z * i, -1f);
                    c.SetGlobalFrame(ref f, true);
                    if (SpawnerScriptOf(c) == null) c.Name = (src.Name ?? "entity") + "_copy" + (count > 1 ? i.ToString(CultureInfo.InvariantCulture) : "");
                    created.Add(c);
                }
            }
            if (GetBool(a, "select", true)) TaleWorlds.Engine.Utilities.SelectEntities(created);
            MBEditor.UpdateSceneTree(true);
            return created.Select(x => (object)Info(x)).ToList();
        }

        private object Modify(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            var list = ResolveEntities(scene, a, "entities", true);
            string name = GetString(a, "name", null);
            var add = GetStrings(a, "addTags");
            var remove = GetStrings(a, "removeTags");
            object vis;
            bool hasVis = a.TryGetValue("visible", out vis);
            bool numbered = GetBool(a, "numberNames", false) && list.Count > 1;
            var newNames = new List<string>();
            for (int i = 0; i < list.Count; i++)
            {
                if (name == null) { newNames.Add(null); continue; }
                string nn = numbered ? name + "_" + (i + 1).ToString(CultureInfo.InvariantCulture) : name;
                string problem = SpawnerNameProblem(list[i], nn);
                if (problem != null) throw new Exception(problem + " Nothing was changed.");
                newNames.Add(nn);
            }
            for (int i = 0; i < list.Count; i++)
            {
                var e = list[i];
                if (newNames[i] != null) e.Name = newNames[i];
                foreach (var t in add) if (!e.HasTag(t)) e.AddTag(t);
                foreach (var t in remove) if (e.HasTag(t)) e.RemoveTag(t);
                if (hasVis) e.SetVisibilityExcludeParents(Convert.ToBoolean(vis, CultureInfo.InvariantCulture));
            }
            MBEditor.UpdateSceneTree(true);
            return list.Select(x => (object)Info(x)).ToList();
        }

        private object Focus(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            Vec3 pos;
            if (a.ContainsKey("entities"))
            {
                var list = ResolveEntities(scene, a, "entities", true);
                pos = list[0].GetGlobalFrame().origin;
                if (GetBool(a, "select", false)) TaleWorlds.Engine.Utilities.SelectEntities(list);
            }
            else pos = GetVec(a, "position", new Vec3(0, 0, 0, -1f));
            MBEditor.ZoomToPosition(pos);
            return V(pos);
        }

        private object Raycast(Dictionary<string, object> a)
        {
            Scene scene = RequireScene();
            Vec3 from, to, origin;
            if (a.ContainsKey("from"))
            {
                from = GetVec(a, "from", Vec3.Zero);
                to = GetVec(a, "to", Vec3.Zero);
                origin = from;
            }
            else
            {
                // Vertical probe through the point: the topmost surface above or below it.
                origin = GetVec(a, "position", Vec3.Zero);
                from = new Vec3(origin.x, origin.y, origin.z + 1000f, -1f);
                to = new Vec3(origin.x, origin.y, origin.z - 3000f, -1f);
            }
            float dist;
            Vec3 point;
            bool hit = scene.RayCastForClosestEntityOrTerrain(from, to, out dist, out point);
            var d = new Dictionary<string, object>();
            d["hit"] = hit;
            if (hit) { d["distance"] = R(origin.Distance(point)); d["point"] = V(point); }
            return d;
        }

        private object Screenshot(Dictionary<string, object> a)
        {
            string path = GetString(a, "path", null);
            if (string.IsNullOrEmpty(path)) path = IOPath.Combine(Dir, "screenshot_" + DateTime.Now.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture) + ".png");
            Directory.CreateDirectory(IOPath.GetDirectoryName(path));
            TaleWorlds.Engine.Utilities.TakeScreenshot(path);
            return path;
        }

        private object ConsoleCommand(Dictionary<string, object> a)
        {
            string command = GetString(a, "command", "");
            if (command.Length == 0) throw new Exception("Missing command.");
            return TaleWorlds.Engine.Utilities.ExecuteCommandLineCommand(command);
        }

        private object Commands(Dictionary<string, object> a)
        {
            string prefix = GetString(a, "prefix", "");
            var list = new List<string>();
            for (int i = 0; i < 2000; i++)
            {
                string s = TaleWorlds.Engine.Utilities.GetPossibleCommandLineStartingWith(prefix, i);
                if (string.IsNullOrEmpty(s) || list.Contains(s)) break;
                list.Add(s);
            }
            return list;
        }

        private object Check()
        {
            Scene scene = RequireScene();
            string name = scene.GetName();
            TaleWorlds.Engine.Utilities.CheckSceneForProblems(name);
            return "Scene check started for '" + name + "'; problems appear in the editor's warning panel and the rgl log.";
        }

        private object Reimport()
        {
            TaleWorlds.Engine.Utilities.CheckResourceModifications();
            return "Asked the engine to check AssetSources/resources for modifications.";
        }

        private object PrefabsExist(Dictionary<string, object> a)
        {
            var d = new Dictionary<string, object>();
            foreach (var n in GetStrings(a, "names")) d[n] = GameEntity.PrefabExists(n);
            return d;
        }

        // ---- play mode, missions, navigation mesh, camera, frame times -------------------------------

        private sealed class WalkJob
        {
            public int Id;
            public Mission Mission;
            public Agent Actor;
            public readonly List<Vec3> Targets = new List<Vec3>();
            public float Tolerance, LegTimeout, StallSeconds;
            public int Leg = -1;
            public float Elapsed, LegTime, SampleTime, StallTime, BestDist;
            public Vec3 StallPos, LegFrom;
            public string Status = "running";
            public string Detail;
            public AgentControllerType OldController;
            public float OldSpeed;
            public bool SpeedChanged;
            public readonly List<object> Trace = new List<object>();
            public readonly List<object> Legs = new List<object>();
        }

        private sealed class PerfJob
        {
            public int Id;
            public float Seconds, Elapsed;
            public readonly List<float> Frames = new List<float>();
            public string Status = "running";
            public Dictionary<string, object> Result;
            public string Scene;
            public object Camera;
        }

        private WalkJob _walk;
        private PerfJob _perf;
        private int _nextJob = 1;

        private static bool EditorPlay()
        {
            try { return MBEditor.IsEditorMissionOn(); } catch { return false; }
        }

        /** Editor play mode, or a game mission outside the editor: the edited scene is not what the engine shows. */
        private static bool InPlay()
        {
            return EditorPlay() || (Mission.Current != null && !MBEditor.IsEditModeOn);
        }

        private static string PlayLabel()
        {
            Mission m = Mission.Current;
            return m == null ? "a mission is starting or ending" : "mission on '" + m.SceneName + "', " + m.CurrentState;
        }

        private Dictionary<string, object> MissionSummary()
        {
            Mission m = Mission.Current;
            bool editorPlay = EditorPlay();
            if (!editorPlay && (m == null || MBEditor.IsEditModeOn)) return null; // a mission object left over in edit mode is not play
            var d = new Dictionary<string, object>();
            d["editorPlay"] = editorPlay;
            if (m == null) return d;
            d["scene"] = m.SceneName;
            d["levels"] = m.SceneLevels;
            d["state"] = m.CurrentState.ToString();
            d["mode"] = m.Mode.ToString();
            d["loaded"] = m.IsLoadingFinished;
            d["time"] = R(m.CurrentTime);
            d["agents"] = m.Agents.Count;
            if (m.MainAgent != null) d["mainAgent"] = AgentInfo(m.MainAgent);
            if (_walk != null) d["walk"] = WalkReport(_walk, false);
            return d;
        }

        private static Dictionary<string, object> AgentInfo(Agent a)
        {
            var d = new Dictionary<string, object>();
            d["index"] = a.Index;
            d["name"] = a.Name;
            d["position"] = V(a.Position);
            d["direction"] = V(a.LookDirection);
            d["controller"] = a.Controller.ToString();
            d["active"] = a.IsActive();
            d["mounted"] = a.MountAgent != null;
            d["health"] = R(a.Health);
            if (a.CurrentlyUsedGameObject != null) d["using"] = a.CurrentlyUsedGameObject.GetType().Name;
            return d;
        }

        private static List<string> EditorMissions()
        {
            var list = new List<string>();
            var mod = TaleWorlds.MountAndBlade.Module.CurrentModule;
            if (mod == null) return list;
            var mi = typeof(TaleWorlds.MountAndBlade.Module).GetMethod("GetMissionControllerClassNames", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
            if (mi == null) return list;
            string names = mi.Invoke(mod, null) as string ?? "";
            foreach (var n in names.Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) list.Add(n);
            return list;
        }

        private object Play(Dictionary<string, object> a)
        {
            string action = GetString(a, "action", "status");
            switch (action)
            {
                case "status":
                {
                    var d = new Dictionary<string, object>();
                    d["playing"] = InPlay();
                    d["editorPlay"] = EditorPlay();
                    d["editMode"] = MBEditor.IsEditModeOn;
                    if (MBEditor._editorScene != null) { try { d["editorScene"] = MBEditor._editorScene.GetName(); } catch { } }
                    var ms = MissionSummary();
                    if (ms != null) d["mission"] = ms;
                    return d;
                }
                case "missions":
                    return EditorMissions();
                case "start":
                    return PlayStart(a);
                case "stop":
                {
                    if (!EditorPlay()) throw new Exception(Mission.Current != null ? "The running mission is not an editor play session; leave it in the game." : "The editor is not in play mode.");
                    if (_walk != null && _walk.Status == "running") FinishWalk(_walk, "aborted", "play mode was stopped");
                    MBEditor.LeaveEditMissionMode(); // what the leave key does in editor play (MissionScreen.AfterMissionTick)
                    return "Leaving play mode; the editor returns to the edited scene.";
                }
                default:
                    throw new Exception("Unknown play action '" + action + "' (status, missions, start, stop).");
            }
        }

        private object PlayStart(Dictionary<string, object> a)
        {
            if (!MBEditor.IsEditModeOn || MBEditor._editorScene == null) throw new Exception("Open a scene in the scene editor first.");
            if (InPlay()) throw new Exception("Already in play mode (" + PlayLabel() + ").");
            string scene = GetString(a, "scene", null);
            if (string.IsNullOrEmpty(scene)) scene = MBEditor._editorScene.GetName();
            string file = null;
            try { file = SceneFilePath(TaleWorlds.Engine.Utilities.GetFullFilePathOfScene(scene)); } catch { }
            if (string.IsNullOrEmpty(file)) throw new Exception("Play mode loads the scene by name from its saved file, and '" + scene + "' has none in the loaded modules. Save it in the editor first.");
            var missions = EditorMissions();
            string mission = GetString(a, "mission", null);
            if (string.IsNullOrEmpty(mission))
            {
                if (missions.Count == 0) throw new Exception("No mission is registered for editor play (the SandBox module provides it).");
                mission = missions[0];
            }
            else if (missions.Count > 0 && !missions.Contains(mission))
            {
                throw new Exception("Unknown editor mission '" + mission + "'; available: " + string.Join(", ", missions.ToArray()) + ".");
            }
            string levels = GetString(a, "levels", "");
            var start = typeof(TaleWorlds.MountAndBlade.Module).GetMethod("StartMissionForEditor", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic);
            if (start == null) throw new Exception("This game version has no Module.StartMissionForEditor.");
            Log("Play start: mission " + mission + ", scene " + scene + ", levels '" + levels + "'");
            // The same managed entry the editor's Play button reaches: SandBox's editor tester starts a game
            // (EditorSceneMissionManager) that opens the mission on the saved scene.
            start.Invoke(TaleWorlds.MountAndBlade.Module.CurrentModule, new object[] { mission, scene, levels });
            var d = new Dictionary<string, object>();
            d["mission"] = mission;
            d["scene"] = scene;
            d["levels"] = levels;
            d["file"] = file;
            return d;
        }

        /** The scene file behind a path the engine reports (relative to the game's bin folder, or $BASE/…; maybe the scene folder). */
        private static string SceneFilePath(string reported)
        {
            if (string.IsNullOrEmpty(reported)) return null;
            string p = reported.Replace('/', IOPath.DirectorySeparatorChar);
            string bin = AppDomain.CurrentDomain.BaseDirectory;
            if (p.StartsWith("$BASE", StringComparison.OrdinalIgnoreCase)) p = IOPath.Combine(IOPath.GetFullPath(IOPath.Combine(bin, "..", "..")), p.Substring(5).TrimStart(IOPath.DirectorySeparatorChar));
            else if (!IOPath.IsPathRooted(p)) p = IOPath.GetFullPath(IOPath.Combine(bin, p));
            if (File.Exists(p)) return p;
            if (File.Exists(IOPath.Combine(p, "scene.xscene"))) return IOPath.Combine(p, "scene.xscene");
            if (File.Exists(p + ".xscene")) return p + ".xscene";
            return null;
        }

        private object MissionCommand(Dictionary<string, object> a)
        {
            string action = GetString(a, "action", "status");
            if (action == "walk_status")
            {
                if (_walk == null) throw new Exception("No walk was started.");
                return WalkReport(_walk, GetBool(a, "trace", false));
            }
            Mission m = Mission.Current;
            if (m == null) throw new Exception("No mission is running. Start play mode first (editor_play action=start).");
            switch (action)
            {
                case "status":
                    return MissionSummary();
                case "objects":
                    return UsableObjects(m, a);
                case "walk":
                    return WalkStart(m, a);
                case "walk_stop":
                    if (_walk == null || _walk.Status != "running") throw new Exception("No walk is running.");
                    FinishWalk(_walk, "stopped", "stopped by request");
                    return WalkReport(_walk, false);
                case "teleport":
                {
                    Agent actor = RequireMainAgent(m);
                    Vec3 p = GetVec(a, "position", Vec3.Invalid);
                    if (!p.IsValid) throw new Exception("Give 'position'.");
                    actor.TeleportToPosition(p);
                    Vec3 dir = GetVec(a, "direction", Vec3.Invalid);
                    if (dir.IsValid && dir.Length > 1e-4f)
                    {
                        dir = dir * (1f / dir.Length);
                        actor.LookDirection = dir;
                        Vec2 f = dir.AsVec2;
                        actor.SetMovementDirection(ref f);
                    }
                    return AgentInfo(actor);
                }
                case "use":
                    return UseObject(m, a);
                case "dismount":
                {
                    Agent actor = RequireMainAgent(m);
                    if (actor.MountAgent == null) throw new Exception("The player is not mounted.");
                    actor.EventControlFlags |= Agent.EventControlFlag.Dismount; // as the dismount key does; the engine acts on the next frames
                    return AgentInfo(actor);
                }
                case "stop_using":
                {
                    Agent actor = RequireMainAgent(m);
                    if (!actor.IsUsingGameObject) throw new Exception("The main agent uses nothing.");
                    actor.StopUsingGameObject(true);
                    return AgentInfo(actor);
                }
                default:
                    throw new Exception("Unknown mission action '" + action + "' (status, objects, walk, walk_status, walk_stop, teleport, use, stop_using, dismount).");
            }
        }

        private static Agent RequireMainAgent(Mission m)
        {
            if (!m.IsLoadingFinished) throw new Exception("The mission is still loading.");
            Agent actor = m.MainAgent;
            if (actor == null || !actor.IsActive()) throw new Exception("The mission has no active main agent (player).");
            return actor;
        }

        private sealed class Usable
        {
            public UsableMissionObject Obj;
            public string Name, Parent;
            public string[] Tags;
            public Vec3 Pos;
            public float Distance;
        }

        private static List<Usable> FindUsables(Mission m, Vec3 near, float radius)
        {
            var list = new List<Usable>();
            foreach (MissionObject mo in m.MissionObjects)
            {
                var u = mo as UsableMissionObject;
                if (u == null) continue;
                WeakGameEntity ge = u.GameEntity;
                if (!ge.IsValid) continue;
                Vec3 pos = ge.GetGlobalFrame().origin;
                float dist = pos.Distance(near);
                if (dist > radius) continue;
                var x = new Usable();
                x.Obj = u;
                x.Name = ge.Name ?? "";
                WeakGameEntity parent = ge.Parent;
                x.Parent = parent.IsValid ? parent.Name : null;
                x.Tags = ge.Tags ?? new string[0];
                x.Pos = pos;
                x.Distance = dist;
                list.Add(x);
            }
            return list.OrderBy(x => x.Distance).ToList();
        }

        private static Dictionary<string, object> UsableInfo(Usable x, Agent actor)
        {
            var d = new Dictionary<string, object>();
            d["type"] = x.Obj.GetType().Name;
            d["entity"] = x.Name;
            if (x.Parent != null) d["parent"] = x.Parent;
            d["tags"] = x.Tags.Where(t => !string.IsNullOrEmpty(t)).ToArray();
            d["position"] = V(x.Pos);
            d["distance"] = R(x.Distance);
            d["disabled"] = x.Obj.IsDisabled;
            d["deactivated"] = x.Obj.IsDeactivated;
            d["inUse"] = x.Obj.HasUser;
            if (actor != null) { try { d["usableByPlayer"] = actor.CanUseObject(x.Obj) && !x.Obj.IsDisabledForAgent(actor); } catch { } }
            try { if (x.Obj.DescriptionMessage != null) d["description"] = x.Obj.DescriptionMessage.ToString(); } catch { }
            return d;
        }

        private object UsableObjects(Mission m, Dictionary<string, object> a)
        {
            Agent actor = m.MainAgent;
            Vec3 near = GetVec(a, "position", actor != null ? actor.Position : Vec3.Invalid);
            if (!near.IsValid) throw new Exception("Give 'position' (the mission has no main agent).");
            float radius = GetFloat(a, "radius", 10f);
            var rows = FindUsables(m, near, radius).Take(GetInt(a, "limit", 50)).Select(x => (object)UsableInfo(x, actor)).ToList();
            var d = new Dictionary<string, object>();
            d["near"] = V(near);
            d["radius"] = R(radius);
            d["objects"] = rows;
            return d;
        }

        private object UseObject(Mission m, Dictionary<string, object> a)
        {
            Agent actor = RequireMainAgent(m);
            string name = GetString(a, "entity", null);
            string tag = GetString(a, "tag", null);
            float reach = GetFloat(a, "maxDistance", 3f);
            var near = FindUsables(m, actor.Position, Math.Max(reach, 30f));
            Usable pick = null;
            foreach (var x in near)
            {
                bool match = name == null && tag == null;
                if (name != null && (string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase) || string.Equals(x.Parent, name, StringComparison.OrdinalIgnoreCase))) match = true;
                if (tag != null && x.Tags.Contains(tag)) match = true;
                if (match) { pick = x; break; }
            }
            if (pick == null) throw new Exception("No usable object" + (name != null ? " named '" + name + "'" : tag != null ? " tagged '" + tag + "'" : "") + " within 30 m of the player.");
            if (pick.Distance > reach) throw new Exception("'" + pick.Name + "' is " + R(pick.Distance) + " m away; move closer (walk, or teleport to its position) — within " + R(reach) + " m.");
            if (pick.Obj.IsDisabled || pick.Obj.IsDeactivated || pick.Obj.IsDisabledForAgent(actor) || !actor.CanUseObject(pick.Obj))
                throw new Exception("'" + pick.Name + "' (" + pick.Obj.GetType().Name + ") cannot be used by the player right now (disabled, deactivated or in use).");
            actor.UseGameObject(pick.Obj); // the same native callback as the interaction key
            var d = new Dictionary<string, object>();
            d["used"] = UsableInfo(pick, actor);
            d["agent"] = AgentInfo(actor);
            d["scene"] = m.SceneName;
            return d;
        }

        private static float Dist2(Vec3 p, Vec3 q)
        {
            float dx = p.x - q.x, dy = p.y - q.y;
            return (float)Math.Sqrt(dx * dx + dy * dy);
        }

        private object WalkStart(Mission m, Dictionary<string, object> a)
        {
            Agent actor = RequireMainAgent(m);
            if (actor.MountAgent != null && !GetBool(a, "allowMounted", false)) throw new Exception("The player is mounted (the editor's test mission spawns a horseman); dismount first (mission action=dismount), or test the route on horseback with allow_mounted=true.");
            if (actor.IsUsingGameObject) throw new Exception("The player is using an object; stop using it first.");
            if (_walk != null && _walk.Status == "running") throw new Exception("Walk #" + _walk.Id + " is still running; stop it first.");
            var targets = GetVecList(a, "points");
            if (targets.Count == 0) throw new Exception("Give 'points': [[x, y, z], …] to walk to, in order.");
            var job = new WalkJob();
            job.Id = _nextJob++;
            job.Mission = m;
            job.Actor = actor;
            Vec3 start = actor.Position;
            job.Targets.AddRange(targets);
            if (GetBool(a, "returnToStart", false))
            {
                for (int i = targets.Count - 2; i >= 0; i--) job.Targets.Add(targets[i]);
                job.Targets.Add(start);
            }
            job.Tolerance = Math.Max(0.1f, GetFloat(a, "tolerance", 0.5f));
            job.LegTimeout = Math.Max(2f, GetFloat(a, "legTimeout", 30f));
            job.StallSeconds = Math.Max(1f, GetFloat(a, "stallSeconds", 6f));
            job.OldController = actor.Controller;
            float speed = GetFloat(a, "speed", -1f);
            if (speed > 0)
            {
                job.OldSpeed = actor.GetMaximumSpeedLimit();
                actor.SetMaximumSpeedLimit(speed, false);
                job.SpeedChanged = true;
            }
            // Same approach as a scripted NPC: AI control and a scripted target per leg. The engine plans the route on
            // the navigation mesh and the agent physically walks it; nothing is teleported.
            actor.Controller = AgentControllerType.AI;
            actor.SetIsAIPaused(false);
            _walk = job;
            SampleWalk(job);
            NextLeg(job);
            Log("Walk #" + job.Id + " started: " + job.Targets.Count + " legs.");
            return WalkReport(job, false);
        }

        private static void NextLeg(WalkJob job)
        {
            job.Leg++;
            job.LegTime = 0;
            job.StallTime = 0;
            job.LegFrom = job.Actor.Position;
            job.StallPos = job.LegFrom;
            Vec3 t = job.Targets[job.Leg];
            job.BestDist = Dist2(job.LegFrom, t);
            WorldPosition wp = new WorldPosition(job.Mission.Scene, UIntPtr.Zero, t, false);
            job.Actor.SetScriptedPosition(ref wp, false);
        }

        private static void SampleWalk(WalkJob job)
        {
            job.SampleTime = 0;
            if (job.Actor == null) return;
            Vec3 p = job.Actor.Position;
            if (job.Trace.Count >= 4000)
            {
                // keep every second sample: the trace stays bounded however long the walk is
                for (int i = job.Trace.Count - 1; i > 0; i -= 2) job.Trace.RemoveAt(i);
            }
            job.Trace.Add(new object[] { R(job.Elapsed), R(p.x), R(p.y), R(p.z), job.Leg });
        }

        private static void LegDone(WalkJob job, string result, float distLeft)
        {
            var d = new Dictionary<string, object>();
            d["leg"] = job.Leg + 1;
            d["from"] = V(job.LegFrom);
            d["target"] = V(job.Targets[job.Leg]);
            d["result"] = result;
            d["seconds"] = R(job.LegTime);
            d["distanceLeft"] = R(distLeft);
            d["closest"] = R(job.BestDist);
            d["end"] = V(job.Actor.Position);
            job.Legs.Add(d);
        }

        private void TickWalk(float dt)
        {
            var job = _walk;
            if (job == null || job.Status != "running") return;
            try
            {
                if (Mission.Current != job.Mission || job.Mission.MissionEnded) { FinishWalk(job, "aborted", "the mission ended"); return; }
                if (job.Actor == null || !job.Actor.IsActive()) { FinishWalk(job, "aborted", "the player agent is no longer active"); return; }
                job.Elapsed += dt;
                job.LegTime += dt;
                job.SampleTime += dt;
                job.StallTime += dt;
                Vec3 p = job.Actor.Position;
                Vec3 t = job.Targets[job.Leg];
                float d = Dist2(p, t);
                if (d < job.BestDist) job.BestDist = d;
                if (job.SampleTime >= 0.25f) SampleWalk(job);
                if (d <= job.Tolerance && Math.Abs(p.z - t.z) < 2.5f)
                {
                    LegDone(job, "reached", d);
                    if (job.Leg + 1 >= job.Targets.Count) { FinishWalk(job, "passed", "all " + job.Targets.Count + " legs reached"); return; }
                    NextLeg(job);
                    return;
                }
                if ((p - job.StallPos).Length > 0.3f) { job.StallPos = p; job.StallTime = 0; }
                if (job.StallTime >= job.StallSeconds)
                {
                    LegDone(job, "stuck", d);
                    FinishWalk(job, "blocked", "no progress for " + R(job.StallSeconds) + " s on leg " + (job.Leg + 1) + ", " + R(d) + " m before its target");
                    return;
                }
                if (job.LegTime >= job.LegTimeout)
                {
                    LegDone(job, "timeout", d);
                    FinishWalk(job, "blocked", "leg " + (job.Leg + 1) + " not reached within " + R(job.LegTimeout) + " s (" + R(d) + " m left)");
                }
            }
            catch (Exception e)
            {
                FinishWalk(job, "error", e.Message);
            }
        }

        private void FinishWalk(WalkJob job, string status, string detail)
        {
            job.Status = status;
            job.Detail = detail;
            try
            {
                SampleWalk(job);
                if (job.Actor != null && job.Actor.IsActive())
                {
                    job.Actor.DisableScriptedMovement();
                    job.Actor.SetIsAIPaused(true);
                    job.Actor.Controller = job.OldController;
                    if (job.SpeedChanged) job.Actor.SetMaximumSpeedLimit(job.OldSpeed, false);
                }
            }
            catch (Exception e)
            {
                job.Detail = (detail ?? "") + " (restoring player control failed: " + e.Message + ")";
            }
            Log("Walk #" + job.Id + " " + status + ": " + job.Detail);
        }

        private static Dictionary<string, object> WalkReport(WalkJob job, bool withTrace)
        {
            var d = new Dictionary<string, object>();
            d["id"] = job.Id;
            d["status"] = job.Status;
            if (job.Detail != null) d["detail"] = job.Detail;
            d["legsTotal"] = job.Targets.Count;
            d["leg"] = job.Leg + 1;
            d["seconds"] = R(job.Elapsed);
            d["legs"] = job.Legs;
            if (job.Actor != null) { try { d["position"] = V(job.Actor.Position); } catch { } }
            d["traceSamples"] = job.Trace.Count;
            if (withTrace) d["trace"] = job.Trace;
            return d;
        }

        private static List<Vec3> GetVecList(Dictionary<string, object> a, string key)
        {
            var list = new List<Vec3>();
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return list;
            var arr = v as object[];
            if (arr == null) throw new Exception("'" + key + "' must be a list of [x, y, z] points.");
            foreach (var item in arr)
            {
                var one = new Dictionary<string, object>();
                one["p"] = item;
                list.Add(GetVec(one, "p", Vec3.Invalid));
            }
            return list;
        }

        /** The scene the engine shows: the mission's in play mode, else the edited one. */
        private static Scene ShownScene()
        {
            Mission m = Mission.Current;
            if (InPlay() && m != null)
            {
                if (m.Scene == null || m.MissionEnded || m.CurrentState != Mission.State.Continuing) throw new Exception("The mission is starting or ending; try again in a moment.");
                return m.Scene;
            }
            Scene scene = MBEditor._editorScene;
            if (scene == null || !MBEditor.IsEditModeOn) throw new Exception("Open a scene in the scene editor (or start play mode) first.");
            return scene;
        }

        private static Dictionary<string, object> FaceInfo(Scene scene, Vec3 p)
        {
            var rec = new PathFaceRecord(-1, -1, -1);
            scene.GetNavMeshFaceIndex(ref rec, p, false);
            if (!rec.IsValid()) return null;
            var d = new Dictionary<string, object>();
            d["index"] = rec.FaceIndex;
            d["id"] = rec.FaceGroupIndex;
            d["island"] = rec.FaceIslandIndex;
            Vec3 c = Vec3.Zero;
            scene.GetNavMeshCenterPosition(rec.FaceIndex, ref c);
            d["center"] = V(c);
            try { d["unsharedEdges"] = scene.HasNavmeshFaceUnsharedEdges(ref rec); } catch { }
            return d;
        }

        private object NavMesh(Dictionary<string, object> a)
        {
            Scene scene = ShownScene();
            string action = GetString(a, "action", "summary");
            int count = scene.GetNavMeshFaceCount();
            var d = new Dictionary<string, object>();
            d["scene"] = scene.GetName();
            d["inPlay"] = InPlay();
            d["faces"] = count;
            if (count <= 0) { d["note"] = "No navigation mesh is loaded in this scene."; return d; }
            float radius = GetFloat(a, "radius", 0.3f);
            switch (action)
            {
                case "summary":
                {
                    var groups = new Dictionary<int, int>();
                    for (int i = 0; i < count; i++)
                    {
                        int id = scene.GetIdOfNavMeshFace(i);
                        int n;
                        groups.TryGetValue(id, out n);
                        groups[id] = n + 1;
                    }
                    try { d["crc"] = scene.GetNavigationMeshCRC().ToString(CultureInfo.InvariantCulture); } catch { }
                    d["groupCount"] = groups.Count;
                    d["groups"] = groups.OrderBy(x => x.Key).Take(400).Select(x => (object)new object[] { x.Key, x.Value }).ToList();
                    return d;
                }
                case "at":
                {
                    Vec3 p = GetVec(a, "position", Vec3.Invalid);
                    if (!p.IsValid) throw new Exception("Give 'position'.");
                    d["position"] = V(p);
                    d["face"] = FaceInfo(scene, p);
                    return d;
                }
                case "path":
                {
                    Vec3 from = GetVec(a, "from", Vec3.Invalid), to = GetVec(a, "to", Vec3.Invalid);
                    if (!from.IsValid || !to.IsValid) throw new Exception("Give 'from' and 'to'.");
                    d["from"] = V(from);
                    d["to"] = V(to);
                    d["straight"] = R(Dist2(from, to));
                    d["fromFace"] = FaceInfo(scene, from);
                    d["toFace"] = FaceInfo(scene, to);
                    WorldPosition wf = new WorldPosition(scene, UIntPtr.Zero, from, false);
                    WorldPosition wt = new WorldPosition(scene, UIntPtr.Zero, to, false);
                    d["exists"] = scene.DoesPathExistBetweenPositions(wf, wt);
                    float dist;
                    if (scene.GetPathDistanceBetweenPositions(ref wf, ref wt, radius, out dist)) d["distance"] = R(dist);
                    UIntPtr ff = wf.GetNearestNavMesh(), tf = wt.GetNearestNavMesh();
                    if (ff != UIntPtr.Zero && tf != UIntPtr.Zero)
                    {
                        var path = new NavigationPath();
                        if (scene.GetPathBetweenAIFaces(ff, tf, wf.AsVec2, wt.AsVec2, radius, path, null))
                        {
                            var pts = new List<object>();
                            for (int i = 0; i < path.Size && i < 500; i++) { Vec2 v = path[i]; pts.Add(new object[] { R(v.x), R(v.y) }); }
                            d["corners"] = pts;
                        }
                    }
                    return d;
                }
                case "line":
                {
                    Vec3 from = GetVec(a, "from", Vec3.Invalid), to = GetVec(a, "to", Vec3.Invalid);
                    if (!from.IsValid || !to.IsValid) throw new Exception("Give 'from' and 'to'.");
                    var rec = new PathFaceRecord(-1, -1, -1);
                    scene.GetNavMeshFaceIndex(ref rec, from, false);
                    d["fromFace"] = FaceInfo(scene, from);
                    if (rec.IsValid()) d["clear"] = scene.IsLineToPointClear(rec.FaceIndex, from.AsVec2, to.AsVec2, radius);
                    return d;
                }
                case "group":
                {
                    int id = GetInt(a, "id", int.MinValue);
                    if (id == int.MinValue) throw new Exception("Give 'id'.");
                    int n = 0;
                    var min = new Vec3(float.MaxValue, float.MaxValue, float.MaxValue, -1f);
                    var max = new Vec3(float.MinValue, float.MinValue, float.MinValue, -1f);
                    var sample = new List<object>();
                    for (int i = 0; i < count; i++)
                    {
                        if (scene.GetIdOfNavMeshFace(i) != id) continue;
                        n++;
                        Vec3 c = Vec3.Zero;
                        scene.GetNavMeshCenterPosition(i, ref c);
                        min = new Vec3(Math.Min(min.x, c.x), Math.Min(min.y, c.y), Math.Min(min.z, c.z), -1f);
                        max = new Vec3(Math.Max(max.x, c.x), Math.Max(max.y, c.y), Math.Max(max.z, c.z), -1f);
                        if (sample.Count < 20) sample.Add(new object[] { i, V(c) });
                    }
                    d["id"] = id;
                    d["count"] = n;
                    if (n > 0) { d["centersMin"] = V(min); d["centersMax"] = V(max); d["sample"] = sample; }
                    return d;
                }
                default:
                    throw new Exception("Unknown navmesh action '" + action + "' (summary, at, path, line, group).");
            }
        }

        private static Dictionary<string, object> CameraInfo(MatrixFrame f)
        {
            var d = new Dictionary<string, object>();
            d["position"] = V(f.origin);
            Vec3 dir = -f.rotation.u; // Camera.Direction
            float len = dir.Length;
            if (len > 1e-6f) dir = dir * (1f / len);
            d["direction"] = V(dir);
            d["pitch"] = R((float)(Math.Asin(Math.Max(-1.0, Math.Min(1.0, (double)dir.z))) * 180.0 / Math.PI));
            d["heading"] = R((float)(Math.Atan2(dir.y, dir.x) * 180.0 / Math.PI));
            return d;
        }

        private object CameraCommand(Dictionary<string, object> a)
        {
            string action = GetString(a, "action", "get");
            Scene scene = ShownScene();
            MatrixFrame f = scene.LastFinalRenderCameraFrame;
            var d = CameraInfo(f);
            d["scene"] = scene.GetName();
            d["inPlay"] = InPlay();
            if (action == "get") return d;
            if (InPlay()) throw new Exception("Moving the camera works in the scene editor only; in play mode the console command mission.set_camera_position moves the mission camera.");
            Vec3 delta;
            if (action == "set")
            {
                Vec3 target = GetVec(a, "position", Vec3.Invalid);
                if (!target.IsValid) throw new Exception("Give 'position'.");
                delta = new Vec3(target.x - f.origin.x, target.y - f.origin.y, target.z - f.origin.z, -1f);
            }
            else if (action == "move")
            {
                delta = GetVec(a, "delta", Vec3.Invalid);
                if (!delta.IsValid) throw new Exception("Give 'delta'.");
            }
            else throw new Exception("Unknown camera action '" + action + "' (get, set, move).");
            MBEditor.ApplyDeltaToEditorCamera(delta);
            d["requestedDelta"] = V(delta);
            return d;
        }

        private object Perf(Dictionary<string, object> a)
        {
            string action = GetString(a, "action", "start");
            if (action == "status")
            {
                if (_perf == null) throw new Exception("No frame-time sample was taken.");
                return PerfReport(_perf);
            }
            if (action != "start") throw new Exception("Unknown perf action '" + action + "' (start, status).");
            if (_perf != null && _perf.Status == "running") throw new Exception("A frame-time sample is already running.");
            var job = new PerfJob();
            job.Id = _nextJob++;
            job.Seconds = Math.Max(1f, Math.Min(120f, GetFloat(a, "seconds", 5f)));
            try
            {
                Scene s = ShownScene();
                job.Scene = s.GetName();
                job.Camera = CameraInfo(s.LastFinalRenderCameraFrame);
            }
            catch { }
            _perf = job;
            return PerfReport(job);
        }

        private void TickPerf(float dt)
        {
            var job = _perf;
            if (job == null || job.Status != "running") return;
            job.Elapsed += dt;
            job.Frames.Add(dt);
            if (job.Elapsed < job.Seconds && job.Frames.Count < 200000) return;
            job.Status = "done";
            var ms = job.Frames.Select(x => (double)x * 1000.0).OrderBy(x => x).ToList();
            var r = new Dictionary<string, object>();
            int n = ms.Count;
            double sum = ms.Sum();
            r["frames"] = n;
            r["seconds"] = R(job.Elapsed);
            r["avgMs"] = Math.Round(sum / n, 3);
            r["fps"] = Math.Round(n / Math.Max(1e-6, sum / 1000.0), 2);
            r["p50Ms"] = Math.Round(ms[(int)(n * 0.50)], 3);
            r["p95Ms"] = Math.Round(ms[Math.Min(n - 1, (int)(n * 0.95))], 3);
            r["p99Ms"] = Math.Round(ms[Math.Min(n - 1, (int)(n * 0.99))], 3);
            r["maxMs"] = Math.Round(ms[n - 1], 3);
            try { r["engineFps"] = R(TaleWorlds.Engine.Utilities.GetFps()); } catch { }
            try { r["mainFps"] = R(TaleWorlds.Engine.Utilities.GetMainFps()); } catch { }
            try { r["rendererFps"] = R(TaleWorlds.Engine.Utilities.GetRendererFps()); } catch { }
            job.Result = r;
            job.Frames.Clear();
        }

        private static Dictionary<string, object> PerfReport(PerfJob job)
        {
            var d = new Dictionary<string, object>();
            d["id"] = job.Id;
            d["status"] = job.Status;
            d["seconds"] = R(job.Seconds);
            if (job.Scene != null) d["scene"] = job.Scene;
            if (job.Camera != null) d["camera"] = job.Camera;
            if (job.Result != null) d["result"] = job.Result;
            return d;
        }

        // ---- argument helpers ------------------------------------------------------------------------

        private static string GetString(Dictionary<string, object> a, string key, string def)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return def;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        private static bool GetBool(Dictionary<string, object> a, string key, bool def)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return def;
            if (v is bool) return (bool)v;
            return string.Equals(Convert.ToString(v, CultureInfo.InvariantCulture), "true", StringComparison.OrdinalIgnoreCase);
        }

        private static int GetInt(Dictionary<string, object> a, string key, int def)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return def;
            try { return Convert.ToInt32(v, CultureInfo.InvariantCulture); } catch { return def; }
        }

        private static float GetFloat(Dictionary<string, object> a, string key, float def)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return def;
            try { return Convert.ToSingle(v, CultureInfo.InvariantCulture); } catch { return def; }
        }

        private static Vec3 GetVec(Dictionary<string, object> a, string key, Vec3 def)
        {
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return def;
            var arr = v as object[];
            if (arr == null)
            {
                var s = v as string;
                if (s == null) return def;
                arr = s.Split(',').Select(x => (object)x.Trim()).ToArray();
            }
            if (arr.Length < 3) throw new Exception("'" + key + "' needs 3 numbers.");
            return new Vec3(Convert.ToSingle(arr[0], CultureInfo.InvariantCulture), Convert.ToSingle(arr[1], CultureInfo.InvariantCulture), Convert.ToSingle(arr[2], CultureInfo.InvariantCulture), -1f);
        }

        private static List<string> GetStrings(Dictionary<string, object> a, string key)
        {
            var list = new List<string>();
            object v;
            if (!a.TryGetValue(key, out v) || v == null) return list;
            var arr = v as object[];
            if (arr == null) { list.Add(Convert.ToString(v, CultureInfo.InvariantCulture)); return list; }
            foreach (var x in arr) if (x != null) list.Add(Convert.ToString(x, CultureInfo.InvariantCulture));
            return list;
        }
    }
}
`.replace("__BRIDGE_VERSION__", BRIDGE_VERSION);
