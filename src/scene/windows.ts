import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { decodeUtf8Lenient } from "../util/text.js";
import { findCsc, runCsc } from "./bridge.js";

/**
 * A tiny Win32 helper (compiled on first use with the .NET Framework csc.exe that ships with Windows)
 * that lists and answers the game's message boxes and captures its window. The Modding Kit build shows
 * "RGL WARNING" dialogs for every problem it meets — e.g. Workshop mods whose SubModule.xml uses
 * launcher-extension tags — and each one blocks the game until someone presses OK. Window capture is
 * needed because the engine's own screenshot only sees the game's render target, which stays black
 * while the Qt-based scene editor is in front. The editor's own modal Qt dialogs ("Do you want to save the
 * scene?", Save Scene As…) have no Win32 controls; they are read and answered through MSAA, which Qt 5.11
 * implements (UI Automation reaches the same objects but stalls for seconds on these windows).
 */
export const WIN_HELPER_CS = String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Accessibility;

public static class WinHelper
{
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, StringBuilder lParam, int flags, int timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam, int flags, int timeout, out IntPtr result);
    [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int InternalGetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, out int value, int size);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hWnd);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hWnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object acc);
    [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible container, int start, int count, [Out] object[] children, out int obtained);
    static Guid IID_IAccessible = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

    class Button { public IntPtr Hwnd; public int Id; public string Text; public IAccessible Acc; public object Child; }
    class Dialog { public IntPtr Hwnd; public uint Pid; public bool System; public bool FileDialog; public bool Qt; public bool Partial; public string Title; public List<string> Texts = new List<string>(); public List<Button> Buttons = new List<Button>(); }
    class Win { public IntPtr Hwnd; public uint Pid; public string Cls; public string Title; public RECT Rect; public bool Hung; public bool Iconic; }

    // Message boxes that Windows (csrss) shows on the game's behalf, matched by their text.
    static Regex SystemPattern;

    static string Text(IntPtr h)
    {
        IntPtr len;
        if (SendMessageTimeout(h, 0x000E, IntPtr.Zero, IntPtr.Zero, 2, 1000, out len) != IntPtr.Zero && (long)len > 0)
        {
            var sb = new StringBuilder((int)len + 1);
            IntPtr ignored;
            SendMessageTimeout(h, 0x000D, (IntPtr)sb.Capacity, sb, 2, 1000, out ignored);
            if (sb.Length > 0) return sb.ToString();
        }
        // Frozen windows and windows of more privileged processes (csrss) do not answer messages.
        var raw = new StringBuilder(4096);
        InternalGetWindowText(h, raw, raw.Capacity);
        return raw.ToString();
    }

    static string ClassOf(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetClassName(h, sb, 256);
        return sb.ToString();
    }

    static HashSet<uint> CsrssPids()
    {
        var set = new HashSet<uint>();
        try { foreach (var p in Process.GetProcessesByName("csrss")) set.Add((uint)p.Id); } catch { }
        return set;
    }

    /** A visible Qt window that blocks the window it belongs to: Qt disables the windows a modal dialog blocks. */
    static bool IsQtModal(IntPtr h, string cls)
    {
        if (!cls.StartsWith("Qt", StringComparison.Ordinal) || !IsWindowEnabled(h)) return false;
        if ((GetWindowLongPtr(h, -20).ToInt64() & 0x80) != 0) return false; // WS_EX_TOOLWINDOW: floating panels, menus
        IntPtr owner = GetWindow(h, 4); // GW_OWNER
        return owner != IntPtr.Zero && !IsWindowEnabled(owner);
    }

    /** Title, texts, input fields and buttons of a Qt dialog (at most 5 s; a frozen editor leaves them unread). */
    static Dialog QtDialog(IntPtr h, uint pid)
    {
        var d = new Dialog { Hwnd = h, Pid = pid, Qt = true, Title = Text(h) };
        if (IsHungAppWindow(h)) { d.Partial = true; return d; }
        var read = new Dialog();
        var t = new Thread(() =>
        {
            try
            {
                object o;
                if (AccessibleObjectFromWindow(h, 0xFFFFFFFC, ref IID_IAccessible, out o) == 0 && o is IAccessible) QtContent((IAccessible)o, read, 0); // OBJID_CLIENT
            }
            catch { }
        });
        t.IsBackground = true;
        t.Start();
        if (t.Join(5000)) { d.Texts = read.Texts; d.Buttons = read.Buttons; }
        else d.Partial = true;
        return d;
    }

    static void QtContent(IAccessible acc, Dialog d, int depth)
    {
        if (depth > 8) return;
        int count = 0;
        try { count = acc.accChildCount; } catch { }
        if (count <= 0) return;
        var kids = new object[Math.Min(count, 200)];
        int got = 0;
        try { AccessibleChildren(acc, 0, kids.Length, kids, out got); } catch { return; }
        for (int i = 0; i < got && d.Texts.Count + d.Buttons.Count < 60; i++)
        {
            IAccessible ka = kids[i] as IAccessible;
            object self = ka != null ? (object)0 : kids[i]; // a full object, or a child id of acc
            IAccessible host = ka ?? acc;
            int role = 0, state = 0;
            string name = "", value = "";
            try { role = Convert.ToInt32(host.get_accRole(self)); } catch { }
            try { state = Convert.ToInt32(host.get_accState(self)); } catch { }
            if ((state & 0x8000) != 0) continue; // STATE_SYSTEM_INVISIBLE
            try { name = (host.get_accName(self) ?? "").Trim(); } catch { }
            switch (role)
            {
                case 0x2B: // push button (pressable unless STATE_SYSTEM_UNAVAILABLE)
                    if (name.Length > 0 && (state & 0x1) == 0) d.Buttons.Add(new Button { Id = -1, Text = name.Replace("&", ""), Acc = host, Child = self });
                    break;
                case 0x29: // static text
                    if (name.Length > 0) d.Texts.Add(name);
                    break;
                case 0x2A: // editable text
                case 0x2E: // combo box
                    try { value = host.get_accValue(self) ?? ""; } catch { }
                    d.Texts.Add("[" + (name.Length > 0 ? name : "field") + ": " + value + "]");
                    break;
                case 0x2C: // check box
                    d.Texts.Add("[" + name + ": " + ((state & 0x10) != 0 ? "checked" : "not checked") + "]");
                    break;
                case 0x21: case 0x23: case 0x18: case 0x01: case 0x02: case 0x03: case 0x0B: // lists, trees, tables, title/menu/scroll bars, menus
                    break;
                default:
                    if (ka != null) QtContent(ka, d, depth + 1);
                    break;
            }
        }
    }

    static List<Dialog> Dialogs(HashSet<uint> pids) { return Dialogs(pids, false); }

    /** Message boxes of the processes (and csrss boxes matching SystemPattern); with qt, also modal Qt dialogs. */
    static List<Dialog> Dialogs(HashSet<uint> pids, bool qt)
    {
        var list = new List<Dialog>();
        var system = SystemPattern != null ? CsrssPids() : new HashSet<uint>();
        var qtWindows = new List<KeyValuePair<IntPtr, uint>>();
        EnumWindows((h, l) =>
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            bool own = pids.Contains(pid);
            if ((!own && !system.Contains(pid)) || !IsWindowVisible(h)) return true;
            string wc = ClassOf(h);
            if (wc != "#32770")
            {
                if (qt && own && IsQtModal(h, wc)) qtWindows.Add(new KeyValuePair<IntPtr, uint>(h, pid));
                return true;
            }
            var d = new Dialog { Hwnd = h, Pid = pid, System = !own, Title = Text(h) };
            EnumChildWindows(h, (c, l2) =>
            {
                string cls = ClassOf(c);
                if (cls == "DirectUIHWND" || cls == "SHELLDLL_DefView") { d.FileDialog = true; return true; } // Explorer-style open/save dialog
                string t = Text(c);
                if (cls == "Button") d.Buttons.Add(new Button { Hwnd = c, Id = GetDlgCtrlID(c), Text = t.Replace("&", "") });
                else if (t.Length > 0 && !d.FileDialog) d.Texts.Add(t);
                return true;
            }, IntPtr.Zero);
            if (d.FileDialog) d.Texts.Clear();
            if (d.System && !SystemPattern.IsMatch(d.Title + "\n" + string.Join("\n", d.Texts.ToArray()))) return true;
            list.Add(d);
            return true;
        }, IntPtr.Zero);
        foreach (var w in qtWindows) list.Add(QtDialog(w.Key, w.Value));
        return list;
    }

    /** Visible top-level windows of the processes (any class), with their responsiveness. */
    static List<Win> Windows(HashSet<uint> pids)
    {
        var list = new List<Win>();
        EnumWindows((h, l) =>
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r) || r.Right - r.Left < 40 || r.Bottom - r.Top < 20) return true; // tooltips, IME
            list.Add(new Win { Hwnd = h, Pid = pid, Cls = ClassOf(h), Title = Text(h), Rect = r, Hung = IsHungAppWindow(h), Iconic = IsIconic(h) });
            return true;
        }, IntPtr.Zero);
        return list;
    }

    /** The largest visible top-level window of the processes that is not a message box. */
    static IntPtr MainWindow(HashSet<uint> pids)
    {
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows((h, l) =>
        {
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (!pids.Contains(p) || !IsWindowVisible(h) || ClassOf(h) == "#32770") return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
            if (area > bestArea) { bestArea = area; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    static bool MostlyDark(Bitmap bmp)
    {
        int dark = 0, total = 0;
        for (int y = 0; y < 32; y++)
            for (int x = 0; x < 32; x++)
            {
                Color c = bmp.GetPixel(x * (bmp.Width - 1) / 31, y * (bmp.Height - 1) / 31);
                total++;
                if (c.R + c.G + c.B < 30) dark++;
            }
        return dark * 100 >= total * 97;
    }

    /** PrintWindow on a worker thread: a frozen window would block the caller forever. */
    static Bitmap Print(IntPtr h, int w, int ht, int timeoutMs)
    {
        Bitmap result = null;
        var t = new Thread(() =>
        {
            var bmp = new Bitmap(w, ht, PixelFormat.Format24bppRgb);
            bool ok = false;
            try
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    try { ok = PrintWindow(h, hdc, 2); } // PW_RENDERFULLCONTENT also captures DirectX content
                    finally { g.ReleaseHdc(hdc); }
                }
            }
            catch { ok = false; }
            if (ok) result = bmp; else bmp.Dispose();
        });
        t.IsBackground = true;
        t.Start();
        return t.Join(timeoutMs) ? result : null;
    }

    /** True when the window (or Windows' "not responding" ghost of it) is what the screen shows around its center. */
    static bool OnTop(IntPtr h, RECT r)
    {
        int cx = (r.Left + r.Right) / 2, cy = (r.Top + r.Bottom) / 2;
        int dx = (r.Right - r.Left) / 4, dy = (r.Bottom - r.Top) / 4;
        int[][] pts = { new[] { cx, cy }, new[] { cx - dx, cy - dy }, new[] { cx + dx, cy - dy }, new[] { cx - dx, cy + dy }, new[] { cx + dx, cy + dy } };
        foreach (var p in pts)
        {
            IntPtr hit = WindowFromPoint(new POINT { X = p[0], Y = p[1] });
            IntPtr root = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, 2); // GA_ROOT
            if (root != h && ClassOf(root) != "Ghost") return false;
        }
        return true;
    }

    /**
     * Blacks out, in a screen copy of window h (at rect r), every visible window of another program that lies above h
     * and overlaps it — notifications, chat windows, other apps — so the image shows only what belongs to the game.
     */
    static int MaskOtherWindows(Bitmap bmp, IntPtr h, RECT r, HashSet<uint> pids)
    {
        int masked = 0;
        using (var g = Graphics.FromImage(bmp))
        {
            for (IntPtr x = GetWindow(h, 3); x != IntPtr.Zero; x = GetWindow(x, 3)) // GW_HWNDPREV: the windows above, nearest first
            {
                if (!IsWindowVisible(x) || IsIconic(x)) continue;
                int cloaked;
                if (DwmGetWindowAttribute(x, 14, out cloaked, 4) == 0 && cloaked != 0) continue; // DWMWA_CLOAKED: not on screen
                uint pid;
                GetWindowThreadProcessId(x, out pid);
                if (pids.Contains(pid) || ClassOf(x) == "Ghost") continue; // the game's own windows, and Windows' image of the frozen one
                RECT o;
                if (!GetWindowRect(x, out o)) continue;
                int left = Math.Max(o.Left, r.Left), top = Math.Max(o.Top, r.Top), right = Math.Min(o.Right, r.Right), bottom = Math.Min(o.Bottom, r.Bottom);
                if (right <= left || bottom <= top) continue;
                g.FillRectangle(Brushes.Black, left - r.Left, top - r.Top, right - left, bottom - top);
                masked++;
            }
        }
        return masked;
    }

    static string Capture(HashSet<uint> pids, string full, string small, int maxWidth)
    {
        try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } // per-monitor v2: real pixel sizes
        catch { try { SetProcessDPIAware(); } catch { } }
        IntPtr main = MainWindow(pids);
        IntPtr h = main;
        string source = "window";
        bool mainHung = main != IntPtr.Zero && IsHungAppWindow(main);
        if (main == IntPtr.Zero || IsIconic(main) || mainHung)
        {
            // A message box is usually why the game is frozen or has no window yet.
            var ds = Dialogs(pids);
            if (ds.Count > 0) { h = ds[0].Hwnd; source = ds[0].System ? "system dialog" : "dialog"; }
            else if (main == IntPtr.Zero) throw new Exception("The game has no visible window (still starting, or closed).");
            else if (IsIconic(main)) throw new Exception("The game window is minimized; restore it first.");
        }
        RECT r;
        GetWindowRect(h, out r);
        int w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (w <= 0 || ht <= 0) throw new Exception("The window has no size.");
        Bitmap printed = IsHungAppWindow(h) ? null : Print(h, w, ht, 5000);
        int masked = 0;
        if (printed == null)
        {
            // A frozen window cannot paint itself: copy the screen, but only where it is what the screen shows.
            if (!OnTop(h, r)) throw new Exception("The game window does not respond and other windows cover it; bring it to the front, or try again later.");
            printed = new Bitmap(w, ht, PixelFormat.Format24bppRgb);
            using (var g = Graphics.FromImage(printed)) g.CopyFromScreen(r.Left, r.Top, 0, 0, new Size(w, ht));
            masked = MaskOtherWindows(printed, h, r, pids);
            source += " (screen copy)";
        }
        using (var bmp = printed)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(full)));
            bmp.Save(full, ImageFormat.Png);
            double s = Math.Min(1.0, (double)maxWidth / w);
            int sw = Math.Max(1, (int)Math.Round(w * s)), sh = Math.Max(1, (int)Math.Round(ht * s));
            using (var thumb = new Bitmap(sw, sh, PixelFormat.Format24bppRgb))
            {
                using (var g2 = Graphics.FromImage(thumb))
                {
                    g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
                    g2.DrawImage(bmp, 0, 0, sw, sh);
                }
                thumb.Save(small, ImageFormat.Png);
            }
            return "{\"width\":" + w + ",\"height\":" + ht + ",\"smallWidth\":" + sw + ",\"smallHeight\":" + sh +
                ",\"dark\":" + (MostlyDark(bmp) ? "true" : "false") + ",\"title\":" + J(Text(h)) + ",\"source\":" + J(source) +
                ",\"mainHung\":" + (mainHung ? "true" : "false") + ",\"masked\":" + masked + "}";
        }
    }

    // Standard dialog button ids, so 'No', 'Yes', 'OK', 'Cancel' … work whatever the Windows language is.
    static readonly Dictionary<string, int> StdIds = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase)
    {
        { "ok", 1 }, { "cancel", 2 }, { "abort", 3 }, { "retry", 4 }, { "ignore", 5 }, { "yes", 6 }, { "no", 7 },
        { "close", 8 }, { "help", 9 }, { "try again", 10 }, { "tryagain", 10 }, { "continue", 11 }
    };

    /** "否(&N)", "&No", "否(N)" → "否" / "no": accelerators and their markers do not count. */
    static string NormButton(string t)
    {
        t = (t ?? "").Replace("&", "").Trim();
        t = Regex.Replace(t, @"\s*\([A-Za-z0-9]\)\s*$", "");
        return t.Trim().ToLowerInvariant();
    }

    static Button Pick(Dialog d, string want)
    {
        if (!string.IsNullOrEmpty(want))
        {
            int id;
            if (int.TryParse(want.Trim(), out id))
            {
                foreach (var b in d.Buttons) if (b.Id == id) return b;
                return null;
            }
            string w = NormButton(want);
            foreach (var b in d.Buttons) if (NormButton(b.Text) == w) return b;
            int std;
            if (StdIds.TryGetValue(w, out std))
            {
                foreach (var b in d.Buttons) if (b.Id == std) return b;
                if (std == 1 && d.Buttons.Count == 1) return d.Buttons[0]; // OK-only boxes may give their button id 2
            }
            return null;
        }
        if (d.FileDialog || d.Qt) return null; // a file dialog's default button opens/saves whatever is selected; editor dialogs decide about the scene
        if (d.Buttons.Count == 1) return d.Buttons[0];
        foreach (var b in d.Buttons) if (b.Id == 1) return b; // IDOK
        return null;
    }

    static bool Press(Dialog d, Button b)
    {
        if (d.Qt) return PressQt(d, b);
        // WM_COMMAND(BN_CLICKED) to the dialog works even when it is not the active window.
        PostMessage(d.Hwnd, 0x0111, (IntPtr)(b.Id & 0xFFFF), b.Hwnd);
        for (int i = 0; i < 20; i++)
        {
            Thread.Sleep(100);
            if (!IsWindow(d.Hwnd) || !IsWindowVisible(d.Hwnd)) return true;
        }
        return false;
    }

    /** Presses a Qt button with its MSAA default action (works while the editor is in the background). */
    static bool PressQt(Dialog d, Button b)
    {
        if (b.Acc == null) return false;
        // The call returns when the button's handler does; one that opens the next dialog keeps it waiting.
        var t = new Thread(() =>
        {
            try { b.Acc.accDoDefaultAction(b.Child ?? 0); } catch { }
        });
        t.IsBackground = true;
        t.Start();
        t.Join(5000);
        for (int i = 0; i < 30; i++)
        {
            if (!IsWindow(d.Hwnd) || !IsWindowVisible(d.Hwnd)) return true;
            Thread.Sleep(100);
        }
        return false;
    }


    // ---- filling scene editor dialogs (MSAA) ------------------------------------------------------

    class Control { public IAccessible Acc; public object Child; public int Role, State; public string Name = "", Label = "", Value = ""; }

    static void CollectControls(IAccessible acc, List<Control> list, ref string lastText, int depth, bool includeHidden)
    {
        if (depth > 12 || list.Count > 3000) return;
        int count = 0;
        try { count = acc.accChildCount; } catch { }
        if (count <= 0) return;
        var kids = new object[Math.Min(count, 1000)];
        int got = 0;
        try { AccessibleChildren(acc, 0, kids.Length, kids, out got); } catch { return; }
        for (int i = 0; i < got; i++)
        {
            IAccessible ka = kids[i] as IAccessible;
            object self = ka != null ? (object)0 : kids[i];
            IAccessible host = ka ?? acc;
            var c = new Control { Acc = host, Child = self };
            try { c.Role = Convert.ToInt32(host.get_accRole(self)); } catch { }
            try { c.State = Convert.ToInt32(host.get_accState(self)); } catch { }
            if (!includeHidden && (c.State & 0x8000) != 0) continue; // STATE_SYSTEM_INVISIBLE
            try { c.Name = (host.get_accName(self) ?? "").Trim(); } catch { }
            try { c.Value = host.get_accValue(self) ?? ""; } catch { }
            if (c.Role == 0x29 && c.Name.Length > 0) lastText = c.Name; // a label names the field after it
            c.Label = c.Name.Length > 0 ? c.Name : (lastText ?? "");
            list.Add(c);
            if (c.Role == 0x01 || c.Role == 0x02 || c.Role == 0x03 || c.Role == 0x0B) continue; // title, menu and scroll bars, menus
            if (ka != null) CollectControls(ka, list, ref lastText, depth + 1, includeHidden);
        }
    }

    static string NormLabel(string s)
    {
        return Regex.Replace((s ?? "").Replace("&", ""), @"[\s:：*]+$", "").Trim().ToLowerInvariant();
    }

    static Control FindByLabel(string key, List<Control> candidates)
    {
        if (key.StartsWith("#"))
        {
            int n;
            if (int.TryParse(key.Substring(1), out n) && n >= 1 && n <= candidates.Count) return candidates[n - 1];
            return null;
        }
        string k = NormLabel(key);
        foreach (var c in candidates) if (NormLabel(c.Name) == k) return c;
        foreach (var c in candidates) if (NormLabel(c.Label) == k) return c;
        foreach (var c in candidates) if (NormLabel(c.Label).Contains(k) || NormLabel(c.Name).Contains(k)) return c;
        return null;
    }

    static bool IsItem(int role) { return role == 0x22 || role == 0x24 || role == 0x1D; } // list item, tree item, table cell

    static string ApplySpec(char kind, string key, string val, List<Control> all)
    {
        if (kind == 'F')
        {
            var fields = all.Where(x => x.Role == 0x2A || x.Role == 0x2E).ToList(); // editable text, combo box
            Control c = FindByLabel(key, fields);
            if (c == null) return "no input field '" + key + "' (fields: " + string.Join(", ", fields.Select((f, i) => "#" + (i + 1) + " " + (f.Label.Length > 0 ? f.Label : "(unlabeled)")).ToArray()) + ")";
            if ((c.State & 0x1) != 0) return "field '" + c.Label + "' is disabled";
            try { c.Acc.set_accValue(c.Child, val); } catch (Exception e) { return "setting the value failed: " + e.Message; }
            string now = "";
            try { now = c.Acc.get_accValue(c.Child) ?? ""; } catch { }
            if (now == val) return "set";
            if (c.Role == 0x2E)
            {
                // A non-editable combo box: pick the entry from its (hidden) list.
                var inner = new List<Control>();
                string none = null;
                if (c.Child is int && (int)c.Child == 0) CollectControls(c.Acc, inner, ref none, 0, true);
                Control entry = inner.FirstOrDefault(x => IsItem(x.Role) && string.Equals(x.Name, val, StringComparison.OrdinalIgnoreCase));
                if (entry == null) return "the combo box has no entry '" + val + "' (it reads '" + now + "')";
                try { entry.Acc.accDoDefaultAction(entry.Child); } catch (Exception e) { return "choosing the entry failed: " + e.Message; }
                try { now = c.Acc.get_accValue(c.Child) ?? ""; } catch { }
                return now == val ? "chosen" : "chose the entry, but the box reads '" + now + "'";
            }
            return "set, but the field reads '" + now + "' (input validation?)";
        }
        if (kind == 'C')
        {
            var boxes = all.Where(x => x.Role == 0x2C || x.Role == 0x2D).ToList(); // check box, radio button
            Control c = FindByLabel(key, boxes);
            if (c == null) return "no check box '" + key + "' (boxes: " + string.Join(", ", boxes.Select(b => b.Label).ToArray()) + ")";
            bool want = val == "1" || val.Equals("true", StringComparison.OrdinalIgnoreCase) || val.Equals("yes", StringComparison.OrdinalIgnoreCase);
            bool isOn = (c.State & 0x10) != 0; // STATE_SYSTEM_CHECKED
            if (isOn == want) return "already " + (want ? "checked" : "unchecked");
            if (c.Role == 0x2D && !want) return "a radio button is cleared by choosing another one";
            try { c.Acc.accDoDefaultAction(c.Child); } catch (Exception e) { return "toggling failed: " + e.Message; }
            int st = 0;
            try { st = Convert.ToInt32(c.Acc.get_accState(c.Child)); } catch { }
            return ((st & 0x10) != 0) == want ? (want ? "checked" : "unchecked") : "toggled, but the state did not change";
        }
        if (kind == 'S')
        {
            var items = all.Where(x => IsItem(x.Role)).ToList();
            Control c = items.FirstOrDefault(x => string.Equals(x.Name, val, StringComparison.OrdinalIgnoreCase))
                ?? items.FirstOrDefault(x => x.Name.IndexOf(val, StringComparison.OrdinalIgnoreCase) >= 0);
            if (c == null) return "no list or tree item '" + val + "'";
            if ((c.State & 0x2) != 0) return "'" + c.Name + "' was already selected";
            try { c.Acc.accSelect(0x3, c.Child); } catch { } // SELFLAG_TAKEFOCUS | SELFLAG_TAKESELECTION
            int st = 0;
            try { st = Convert.ToInt32(c.Acc.get_accState(c.Child)); } catch { }
            if ((st & 0x2) == 0)
            {
                try { c.Acc.accDoDefaultAction(c.Child); } catch { }
                try { st = Convert.ToInt32(c.Acc.get_accState(c.Child)); } catch { }
            }
            return (st & 0x2) != 0 ? "selected '" + c.Name + "'" : "could not select '" + c.Name + "'";
        }
        return "unknown spec";
    }

    static string FillDialog(Dialog d, List<string> specs)
    {
        object o;
        if (AccessibleObjectFromWindow(d.Hwnd, 0xFFFFFFFC, ref IID_IAccessible, out o) != 0 || !(o is IAccessible)) throw new Exception("The dialog exposes no accessibility objects.");
        var root = (IAccessible)o;
        var sb = new StringBuilder("{\"hwnd\":").Append(J(d.Hwnd.ToInt64().ToString())).Append(",\"title\":").Append(J(d.Title)).Append(",\"applied\":[");
        int n = 0;
        foreach (string spec in specs)
        {
            var all = new List<Control>();
            string last = null;
            CollectControls(root, all, ref last, 0, false);
            char kind = spec.Length > 1 ? spec[0] : '?';
            string body = spec.Length > 2 ? spec.Substring(2) : "";
            int tab = body.IndexOf('\t');
            string key = tab >= 0 ? body.Substring(0, tab) : body;
            string val = tab >= 0 ? body.Substring(tab + 1) : "";
            string outcome;
            try { outcome = ApplySpec(kind, key, val, all); } catch (Exception e) { outcome = "error: " + e.Message; }
            sb.Append(n++ > 0 ? "," : "").Append("{\"kind\":").Append(J(kind.ToString())).Append(",\"key\":").Append(J(key)).Append(",\"value\":").Append(J(val)).Append(",\"outcome\":").Append(J(outcome)).Append("}");
        }
        var after = new List<Control>();
        string l2 = null;
        CollectControls(root, after, ref l2, 0, false);
        sb.Append("],\"fields\":[");
        int m = 0;
        foreach (var c in after)
        {
            string kindName = c.Role == 0x2A ? "text" : c.Role == 0x2E ? "combo" : c.Role == 0x2C ? "check" : c.Role == 0x2D ? "radio" : null;
            if (kindName == null) continue;
            string value = c.Role == 0x2C || c.Role == 0x2D ? ((c.State & 0x10) != 0 ? "on" : "off") : c.Value;
            sb.Append(m++ > 0 ? "," : "").Append("{\"kind\":").Append(J(kindName)).Append(",\"label\":").Append(J(c.Label)).Append(",\"value\":").Append(J(value)).Append(",\"disabled\":").Append((c.State & 0x1) != 0 ? "true" : "false").Append("}");
        }
        sb.Append("],\"items\":[");
        int k = 0;
        foreach (var c in after)
        {
            if (!IsItem(c.Role) || c.Name.Length == 0) continue;
            if (k >= 300) break;
            sb.Append(k++ > 0 ? "," : "").Append("{\"text\":").Append(J(c.Name)).Append(",\"selected\":").Append((c.State & 0x2) != 0 ? "true" : "false").Append("}");
        }
        sb.Append("]}");
        return sb.ToString();
    }

    static string Fill(HashSet<uint> pids, string title, string only, List<string> specs)
    {
        Dialog target = null;
        foreach (var d in Dialogs(pids, true))
        {
            if (!d.Qt) continue;
            if (title.Length > 0 && d.Title.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) continue;
            if (only.Length > 0 && d.Hwnd.ToInt64().ToString() != only) continue;
            target = d;
            break;
        }
        if (target == null) throw new Exception("No scene editor dialog" + (title.Length > 0 ? " titled like '" + title + "'" : "") + " is open.");
        string result = null;
        Exception error = null;
        var t = new Thread(() => { try { result = FillDialog(target, specs); } catch (Exception e) { error = e; } });
        t.IsBackground = true;
        t.Start();
        if (!t.Join(20000)) throw new Exception("The dialog did not answer within 20 s.");
        if (error != null) throw error;
        return result;
    }

    /** First stack frame outside the warning plumbing, e.g. "TaleWorlds.ModuleManager.dll". */
    static string Origin(Dialog d)
    {
        foreach (string block in d.Texts)
            foreach (string raw in block.Split('\n'))
            {
                string line = raw.Trim();
                int at = line.IndexOf(".dll@", StringComparison.OrdinalIgnoreCase);
                if (at < 0) continue;
                string name = line.Substring(0, at + 4);
                int slash = name.LastIndexOfAny(new[] { '\\', '/' });
                if (slash >= 0) name = name.Substring(slash + 1);
                if (name.StartsWith("TaleWorlds.DotNet", StringComparison.OrdinalIgnoreCase)) continue;
                if (name.Equals("TaleWorlds.Engine.dll", StringComparison.OrdinalIgnoreCase)) continue;
                if (name.Equals("TaleWorlds.Library.dll", StringComparison.OrdinalIgnoreCase)) continue;
                return name;
            }
        return "";
    }

    static string J(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            if (c == '"' || c == '\\') sb.Append('\\').Append(c);
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.Append('"').ToString();
    }

    static string Json(Dialog d, string extra)
    {
        var sb = new StringBuilder();
        sb.Append("{\"hwnd\":").Append(J(d.Hwnd.ToInt64().ToString())).Append(",\"pid\":").Append(d.Pid).Append(",\"system\":").Append(d.System ? "true" : "false").Append(",\"fileDialog\":").Append(d.FileDialog ? "true" : "false");
        if (d.Qt) sb.Append(",\"qt\":true").Append(d.Partial ? ",\"partial\":true" : "");
        sb.Append(",\"title\":").Append(J(d.Title)).Append(",\"origin\":").Append(J(Origin(d))).Append(",\"texts\":[");
        for (int i = 0; i < d.Texts.Count; i++) sb.Append(i > 0 ? "," : "").Append(J(d.Texts[i]));
        sb.Append("],\"buttons\":[");
        for (int i = 0; i < d.Buttons.Count; i++)
            sb.Append(i > 0 ? "," : "").Append("{\"id\":").Append(d.Buttons[i].Id).Append(",\"text\":").Append(J(d.Buttons[i].Text)).Append("}");
        sb.Append("]").Append(extra ?? "").Append("}");
        return sb.ToString();
    }

    static HashSet<uint> Pids(string arg)
    {
        var set = new HashSet<uint>();
        foreach (string p in arg.Split(','))
        {
            uint v;
            if (uint.TryParse(p.Trim(), out v)) set.Add(v);
        }
        return set;
    }

    static bool Alive(uint pid)
    {
        try { return !Process.GetProcessById((int)pid).HasExited; }
        catch { return false; }
    }

    public static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }
        try
        {
            string cmd = args.Length > 0 ? args[0] : "";
            if (cmd == "dialogs" && args.Length >= 2)
            {
                // dialogs <pids> [systemPattern]
                if (args.Length > 2 && args[2].Length > 0) SystemPattern = new Regex(args[2], RegexOptions.IgnoreCase);
                var list = Dialogs(Pids(args[1]), true);
                var sb = new StringBuilder("[");
                for (int i = 0; i < list.Count; i++) sb.Append(i > 0 ? "," : "").Append(Json(list[i], null));
                Console.WriteLine(sb.Append("]").ToString());
                return 0;
            }
            if (cmd == "dismiss" && args.Length >= 2)
            {
                // dismiss <pids> [button] [titleFilter] [hwnd] [systemPattern]
                string want = args.Length > 2 ? args[2] : "";
                string title = args.Length > 3 ? args[3] : "";
                string only = args.Length > 4 ? args[4] : "";
                if (args.Length > 5 && args[5].Length > 0) SystemPattern = new Regex(args[5], RegexOptions.IgnoreCase);
                var sb = new StringBuilder("[");
                int n = 0;
                // Only answer boxes that have been open for a moment (see "watch").
                var before = new HashSet<IntPtr>();
                foreach (var d in Dialogs(Pids(args[1]), true)) before.Add(d.Hwnd);
                if (before.Count > 0) Thread.Sleep(2500);
                foreach (var d in Dialogs(Pids(args[1]), true))
                {
                    if (!before.Contains(d.Hwnd)) continue;
                    if (title.Length > 0 && d.Title.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    if (only.Length > 0 && d.Hwnd.ToInt64().ToString() != only) continue;
                    var b = Pick(d, want);
                    string extra = b == null ? ",\"pressed\":null,\"closed\":false" : ",\"pressed\":" + J(b.Text) + ",\"closed\":" + (Press(d, b) ? "true" : "false");
                    sb.Append(n++ > 0 ? "," : "").Append(Json(d, extra));
                }
                Console.WriteLine(sb.Append("]").ToString());
                return 0;
            }
            if (cmd == "fill" && args.Length >= 4)
            {
                // fill <pids> <titleFilter> <hwnd> [F:key<TAB>value | C:key<TAB>0/1 | S:item]...
                var specs = new List<string>();
                for (int i = 4; i < args.Length; i++) specs.Add(args[i]);
                Console.WriteLine(Fill(Pids(args[1]), args[2], args[3], specs));
                return 0;
            }
            if (cmd == "capture" && args.Length >= 4)
            {
                // capture <pids> <full.png> <small.png> [maxWidth] [systemPattern]
                if (args.Length > 5 && args[5].Length > 0) SystemPattern = new Regex(args[5], RegexOptions.IgnoreCase);
                Console.WriteLine(Capture(Pids(args[1]), args[2], args[3], args.Length > 4 ? int.Parse(args[4]) : 1280));
                return 0;
            }
            if (cmd == "windows" && args.Length >= 2)
            {
                // windows <pids>
                var sb = new StringBuilder("[");
                int n = 0;
                foreach (var w in Windows(Pids(args[1])))
                {
                    sb.Append(n++ > 0 ? "," : "").Append("{\"hwnd\":").Append(J(w.Hwnd.ToInt64().ToString())).Append(",\"pid\":").Append(w.Pid)
                      .Append(",\"cls\":").Append(J(w.Cls)).Append(",\"title\":").Append(J(w.Title))
                      .Append(",\"width\":").Append(w.Rect.Right - w.Rect.Left).Append(",\"height\":").Append(w.Rect.Bottom - w.Rect.Top)
                      .Append(",\"hung\":").Append(w.Hung ? "true" : "false").Append(",\"iconic\":").Append(w.Iconic ? "true" : "false").Append("}");
                }
                Console.WriteLine(sb.Append("]").ToString());
                return 0;
            }
            if (cmd == "watch" && args.Length >= 5)
            {
                // watch <pid> <seconds> <logFile> <origins,comma,separated> [Title=button;~Title=button] [systemPattern]
                // "~Title" rules only apply within 5 minutes after this watcher answered a module warning: the
                // prompts the crash watchdog shows for that warning ("collect files?", "Always Ignore?").
                uint pid = uint.Parse(args[1]);
                DateTime end = DateTime.UtcNow.AddSeconds(int.Parse(args[2]));
                string log = args[3];
                var origins = new HashSet<string>(args[4].ToLowerInvariant().Split(','));
                var titleRules = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var followUps = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                if (args.Length > 5)
                    foreach (string rule in args[5].Split(';'))
                    {
                        int eq = rule.LastIndexOf('=');
                        if (eq <= 0) continue;
                        string t = rule.Substring(0, eq).Trim(), b = rule.Substring(eq + 1).Trim();
                        if (t.StartsWith("~")) followUps[t.Substring(1).Trim()] = b;
                        else titleRules[t] = b;
                    }
                if (args.Length > 6 && args[6].Length > 0) SystemPattern = new Regex(args[6], RegexOptions.IgnoreCase);
                DateTime lastWarning = DateTime.MinValue;
                var pressedAt = new Dictionary<IntPtr, DateTime>();
                var seenAt = new Dictionary<IntPtr, DateTime>();
                var one = new HashSet<uint>();
                one.Add(pid);
                while (DateTime.UtcNow < end && Alive(pid))
                {
                    foreach (var d in Dialogs(one))
                    {
                        string ruleButton;
                        string title = d.Title.Trim();
                        bool byTitle = titleRules.TryGetValue(title, out ruleButton);
                        if (!byTitle && (DateTime.UtcNow - lastWarning).TotalSeconds < 300) byTitle = followUps.TryGetValue(title, out ruleButton);
                        bool warning = false;
                        if (!byTitle)
                        {
                            if (d.Title.IndexOf("RGL WARNING", StringComparison.OrdinalIgnoreCase) < 0) continue;
                            if (!origins.Contains(Origin(d).ToLowerInvariant())) continue;
                            warning = true;
                        }
                        // Answer at human speed: the engine is still logging and reporting the warning
                        // (it may sit idle for a minute afterwards either way).
                        DateTime first;
                        if (!seenAt.TryGetValue(d.Hwnd, out first)) { seenAt[d.Hwnd] = DateTime.UtcNow; continue; }
                        if ((DateTime.UtcNow - first).TotalSeconds < 2.5) continue;
                        DateTime last;
                        if (pressedAt.TryGetValue(d.Hwnd, out last) && (DateTime.UtcNow - last).TotalSeconds < 3) continue;
                        var b = Pick(d, byTitle ? ruleButton : "");
                        if (b == null) continue;
                        pressedAt[d.Hwnd] = DateTime.UtcNow;
                        seenAt.Remove(d.Hwnd); // window handles get reused by the next box
                        bool closed = Press(d, b);
                        if (warning) lastWarning = DateTime.UtcNow;
                        File.AppendAllText(log, Json(d, ",\"time\":" + J(DateTime.Now.ToString("s")) + ",\"pressed\":" + J(b.Text) + ",\"closed\":" + (closed ? "true" : "false")) + "\n", new UTF8Encoding(false));
                    }
                    Thread.Sleep(500);
                }
                return 0;
            }
            Console.Error.WriteLine("usage: dialogs <pids> [pattern] | dismiss <pids> [button] [title] [hwnd] [pattern] | fill <pids> <title> <hwnd> [specs] | windows <pids> | capture <pids> <full.png> <small.png> [maxWidth] [pattern] | watch <pid> <seconds> <log> <origins> [rules] [pattern]");
            return 2;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }
}
`;

export interface GameDialog {
  hwnd: string;
  pid: number;
  /** Shown by Windows (csrss) on the game's behalf; matched by its text. */
  system?: boolean;
  /** An open/save file dialog of the editor (never answered with a default button). */
  fileDialog?: boolean;
  /** A modal Qt dialog of the scene editor, read through MSAA (never answered with a default button). */
  qt?: boolean;
  /** Its contents could not be read (the editor does not respond). */
  partial?: boolean;
  title: string;
  origin: string;
  texts: string[];
  buttons: { id: number; text: string }[];
  pressed?: string | null;
  closed?: boolean;
  time?: string;
}

/** Origins whose warnings are about module metadata only; editor_launch answers them automatically. */
export const MODULE_WARNING_ORIGINS = ["TaleWorlds.ModuleManager.dll"];

/**
 * Texts of Bannerlord prompts that Windows' csrss may show on the game's behalf (their window belongs to
 * csrss.exe, not to the game): the shader-cache notice after a mod change, the crash-report upload question…
 */
export const GAME_SYSTEM_PROMPTS = "Bannerlord|TaleWorlds|RGL |Mod change detected|change in your active mods|The application faced a problem|upload these files|Safe Mode|Always Ignore";

export interface GameWindow {
  hwnd: string;
  pid: number;
  cls: string;
  title: string;
  width: number;
  height: number;
  /** Windows considers the window "not responding" (no message processed for 5 s). */
  hung: boolean;
  iconic: boolean;
}

let helperCache: string | null = null;

/** Path of the compiled helper (compiled into <dataDir>/bin on first use). */
export async function winHelper(dataDir: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("Game dialogs and window screenshots are only available on Windows.");
  if (helperCache && fs.existsSync(helperCache)) return helperCache;
  const hash = crypto.createHash("sha1").update(WIN_HELPER_CS).digest("hex").slice(0, 10);
  const dir = path.join(dataDir, "bin");
  const exe = path.join(dir, `mb2mcp-win-${hash}.exe`);
  if (!fs.existsSync(exe)) {
    const csc = findCsc();
    if (!csc) throw new Error("The .NET Framework C# compiler (csc.exe) was not found; it ships with Windows (.NET Framework 4.x).");
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}`;
    const src = path.join(dir, `mb2mcp-win-${stamp}.cs`);
    const tmp = path.join(dir, `mb2mcp-win-${stamp}.exe`);
    const rsp = path.join(dir, `mb2mcp-win-${stamp}.rsp`);
    try {
      fs.writeFileSync(src, WIN_HELPER_CS, "utf8");
      fs.writeFileSync(rsp, ["/nologo", "/target:exe", "/optimize+", "/reference:Accessibility.dll", `/out:"${tmp}"`, `"${src}"`].join("\r\n"), "utf8");
      const res = await runCsc(csc, rsp);
      if (res.code !== 0 || !fs.existsSync(tmp)) throw new Error(`Compiling the window helper failed:\n${res.output.split(/\r?\n/).slice(0, 20).join("\n")}`);
      try {
        fs.renameSync(tmp, exe);
      } catch (e) {
        if (!fs.existsSync(exe)) throw e; // another call won the race
      }
    } finally {
      for (const f of [src, rsp, tmp]) fs.rmSync(f, { force: true });
    }
  }
  helperCache = exe;
  return exe;
}

function runHelper(exe: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { windowsHide: true, timeout: timeoutMs, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = decodeUtf8Lenient(Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0)).trim();
      if (err) {
        const msg = decodeUtf8Lenient(Buffer.isBuffer(stderr) ? stderr : Buffer.alloc(0)).trim();
        return reject(new Error(`Window helper failed: ${msg || err.message}`));
      }
      resolve(out);
    });
  });
}

/** Visible message boxes of the given processes, plus Bannerlord prompts Windows shows on their behalf. */
export async function listDialogs(dataDir: string, pids: number[]): Promise<GameDialog[]> {
  if (!pids.length) return [];
  const out = await runHelper(await winHelper(dataDir), ["dialogs", pids.join(","), GAME_SYSTEM_PROMPTS], 15000);
  return out ? (JSON.parse(out) as GameDialog[]) : [];
}

/** Presses a button (default: OK / the only button) on the processes' message boxes. */
export async function dismissDialogs(dataDir: string, pids: number[], opts: { button?: string; title?: string; hwnd?: string } = {}): Promise<GameDialog[]> {
  if (!pids.length) return [];
  const out = await runHelper(await winHelper(dataDir), ["dismiss", pids.join(","), opts.button ?? "", opts.title ?? "", opts.hwnd ?? "", GAME_SYSTEM_PROMPTS], 60000);
  return out ? (JSON.parse(out) as GameDialog[]) : [];
}

export interface DialogFill {
  hwnd: string;
  title: string;
  applied: { kind: string; key: string; value: string; outcome: string }[];
  fields: { kind: string; label: string; value: string; disabled: boolean }[];
  items: { text: string; selected: boolean }[];
}

/**
 * Sets input fields (by label, name or "#n"), check boxes and a list/tree selection of an open scene editor
 * (Qt) dialog, then reads everything back. Never presses a button: dismissDialogs does that.
 */
export async function fillDialog(
  dataDir: string,
  pids: number[],
  opts: { title?: string; hwnd?: string; fields?: Array<[string, string]>; checks?: Array<[string, boolean]>; select?: string },
): Promise<DialogFill> {
  const specs = [
    ...(opts.fields ?? []).map(([k, v]) => `F:${k}\t${v}`),
    ...(opts.checks ?? []).map(([k, v]) => `C:${k}\t${v ? 1 : 0}`),
    ...(opts.select ? [`S:${opts.select}`] : []),
  ];
  const out = await runHelper(await winHelper(dataDir), ["fill", pids.join(","), opts.title ?? "", opts.hwnd ?? "", ...specs], 40000);
  return JSON.parse(out) as DialogFill;
}

/** Visible top-level windows of the processes (any kind: the editor's Qt windows, crash uploader…). */
export async function listWindows(dataDir: string, pids: number[]): Promise<GameWindow[]> {
  if (!pids.length) return [];
  const out = await runHelper(await winHelper(dataDir), ["windows", pids.join(",")], 15000);
  return out ? (JSON.parse(out) as GameWindow[]) : [];
}

export interface WindowCapture {
  width: number;
  height: number;
  smallWidth: number;
  smallHeight: number;
  /** Nearly all pixels black: the capture probably missed DirectX content. */
  dark: boolean;
  title: string;
  /** "window", or "dialog"/"system dialog" when the game window was frozen, hidden or missing; "(screen copy)" for frozen windows. */
  source: string;
  /** The game's main window is not responding. */
  mainHung: boolean;
  /** Screen copies: windows of other programs over the game that were blacked out. */
  masked?: number;
}

/**
 * Captures the game's main window into `full` (full size) and `small` (at most maxWidth wide), both PNG.
 * When the game window is frozen, minimized or not there yet, the message box blocking it is captured instead.
 */
export async function captureGameWindow(dataDir: string, pids: number[], full: string, small: string, maxWidth: number): Promise<WindowCapture> {
  const out = await runHelper(await winHelper(dataDir), ["capture", pids.join(","), full, small, String(maxWidth), GAME_SYSTEM_PROMPTS], 60000);
  return JSON.parse(out) as WindowCapture;
}

/**
 * Prompts that follow a module-metadata warning in the Modding Kit build: the crash watchdog asks (in a box
 * Windows shows for the game) whether to collect diagnostic files for it, then the game asks whether to always
 * ignore it. "No" collects and uploads nothing; "Cancel" changes no setting.
 */
export const MODULE_WARNING_FOLLOW_UPS: Record<string, string> = { "*_*": "No", "Always Ignore?": "Cancel" };

/** Informational notices with only an OK button that stop the game while it loads. */
export const STARTUP_NOTICES: Record<string, string> = { "Mod change detected": "OK", "Shader cache version is old": "OK" };

/**
 * Starts a detached watcher that answers module-metadata warnings of `pid` for `seconds`, whole dialogs by
 * exact title (`titleRules`, e.g. { "Safe Mode": "No" }) and `followUps` (by title, only within 5 minutes after
 * it answered a module warning). Prompts Windows shows for the game are included.
 */
export async function watchModuleWarnings(dataDir: string, pid: number, seconds: number, logFile: string, titleRules: Record<string, string> = {}, followUps: Record<string, string> = {}): Promise<void> {
  const exe = await winHelper(dataDir);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const rules = [...Object.entries(titleRules).map(([t, b]) => `${t}=${b}`), ...Object.entries(followUps).map(([t, b]) => `~${t}=${b}`)].join(";");
  const args = ["watch", String(pid), String(seconds), logFile, MODULE_WARNING_ORIGINS.join(","), rules, GAME_SYSTEM_PROMPTS];
  const child = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export function readDialogLog(logFile: string): GameDialog[] {
  try {
    return fs
      .readFileSync(logFile, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as GameDialog);
  } catch {
    return [];
  }
}

/**
 * "Startup prompts answered automatically: 8 (TaleWorlds.ModuleManager.dll ×4, '*_*' → 否(N) ×4)" for the
 * watcher log entries of the running game (prompts Windows showed for it carry csrss's pid), or null.
 */
export function answeredSummary(entries: GameDialog[], game: number[]): string | null {
  const mine = entries.filter((d) => game.includes(d.pid) || d.system);
  if (!mine.length) return null;
  const kinds = new Map<string, number>();
  for (const d of mine) {
    const k = d.origin ? d.origin : `'${d.title}' → ${d.pressed ?? "?"}`;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  return `Startup prompts answered automatically: ${mine.length} (${[...kinds].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ")})`;
}

export function describeOrigin(origin: string): string {
  if (!origin) return "origin unknown";
  if (MODULE_WARNING_ORIGINS.some((o) => o.toLowerCase() === origin.toLowerCase())) {
    return `${origin}: a module's SubModule.xml has entries this game version does not know (often Workshop mods written for BLSE/launcher extensions) — harmless, press OK`;
  }
  return origin;
}

/** What the game's recurring prompts mean (they are easy to misread). */
function promptNote(d: GameDialog, body: string): string {
  const text = `${d.title}\n${body}`;
  if (/collect necessary files|upload these files/i.test(text)) {
    return " (the crash watchdog asks to collect diagnostic files — after a warning or after a crash; No collects and uploads nothing, the dump of a crash stays in ProgramData\\…\\crashes)";
  }
  if (/always ignore this failure/i.test(text)) return " (OK = always ignore this warning from now on; Cancel = keep reporting it, changes nothing)";
  if (/^Safe Mode$/i.test(d.title.trim())) return " (No = start normally with the selected modules; Yes = start without them)";
  return "";
}

/** One-line summary of a dialog for tool output. */
export function dialogLine(d: GameDialog): string {
  if (d.qt) {
    const said = d.texts.join(" ").replace(/\s+/g, " ").trim();
    return `'${d.title}' (scene editor dialog, pid ${d.pid}, window ${d.hwnd})${said ? ` — "${said.slice(0, 240)}"` : d.partial ? " — contents unreadable (the editor does not respond)" : ""}; buttons: ${d.buttons.map((b) => b.text).join(" / ") || "none found"} — modal: the editor and live bridge commands wait until it is answered; dismiss_dialogs presses a button only when you name it (button=…)`;
  }
  if (d.fileDialog) {
    return `'${d.title}' (pid ${d.pid}, window ${d.hwnd}) — a file dialog of the editor; finish or cancel it in the editor (the bridge cannot run commands while it is open; dismiss_dialogs only touches it with an explicit button, e.g. Cancel); buttons: ${d.buttons.map((b) => b.text || `#${b.id}`).join(" / ") || "none"}`;
  }
  const body = d.texts.find((t) => !/\.dll@\d+@/.test(t))?.replace(/\s+/g, " ").trim();
  const buttons = d.buttons.map((b) => b.text || `#${b.id}`).join(" / ") || "none";
  return `'${d.title}' (${d.system ? `shown by Windows for the game, csrss pid ${d.pid}` : `pid ${d.pid}`}, window ${d.hwnd})${d.origin ? ` — ${describeOrigin(d.origin)}` : ""}${body ? ` — "${body.slice(0, 200)}"` : ""}; buttons: ${buttons}${promptNote(d, body ?? "")}`;
}
