$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase

$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace RealtimeDesktop {
  public sealed class DesktopNativeException : Exception {
    public string Code { get; private set; }
    public DesktopNativeException(string code, string message) : base(message) { Code = code; }
  }

  public static class DesktopApi {
    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    const uint MOUSEEVENTF_WHEEL = 0x0800;
    const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const int SW_RESTORE = 9;
    const uint GW_OWNER = 4;
    static readonly object InputLock = new object();
    static readonly HashSet<ushort> PressedKeys = new HashSet<ushort>();
    static bool LeftDown;
    static bool RightDown;

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION U; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT {
      public int dx, dy;
      public uint mouseData, dwFlags, time;
      public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT {
      public ushort wVk, wScan;
      public uint dwFlags, time;
      public UIntPtr dwExtraInfo;
    }
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", EntryPoint="SetProcessDpiAwarenessContext")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);

    static DesktopApi() {
      try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
      catch { try { SetProcessDPIAware(); } catch { } }
    }

    static Dictionary<string, object> Bounds(int x, int y, int width, int height) {
      var value = new Dictionary<string, object>();
      value["x"] = x; value["y"] = y; value["width"] = width; value["height"] = height;
      return value;
    }

    static Dictionary<string, object> RectBounds(RECT rect) {
      return Bounds(rect.Left, rect.Top, Math.Max(0, rect.Right - rect.Left), Math.Max(0, rect.Bottom - rect.Top));
    }

    static string WindowId(IntPtr hWnd) { return "hwnd:" + hWnd.ToInt64().ToString("x", CultureInfo.InvariantCulture); }

    static IntPtr ParseWindowId(string id) {
      if (String.IsNullOrEmpty(id) || !id.StartsWith("hwnd:", StringComparison.Ordinal))
        throw new DesktopNativeException("invalid_window", "The window identifier is invalid.");
      long raw;
      if (!Int64.TryParse(id.Substring(5), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out raw) || raw == 0)
        throw new DesktopNativeException("invalid_window", "The window identifier is invalid.");
      return new IntPtr(raw);
    }

    static string WindowTitle(IntPtr hWnd) {
      int length = Math.Min(2048, Math.Max(0, GetWindowTextLength(hWnd)));
      if (length == 0) return String.Empty;
      var text = new StringBuilder(length + 1);
      GetWindowText(hWnd, text, text.Capacity);
      return text.ToString();
    }

    static string ProcessName(uint pid) {
      try { return Process.GetProcessById((int)pid).ProcessName; }
      catch { return "unknown"; }
    }

    static Dictionary<string, object> ReadWindow(IntPtr hWnd) {
      RECT rect;
      if (!GetWindowRect(hWnd, out rect)) throw new DesktopNativeException("window_unavailable", "The window bounds are unavailable.");
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      var value = new Dictionary<string, object>();
      value["id"] = WindowId(hWnd);
      value["processId"] = (int)pid;
      value["processName"] = ProcessName(pid);
      value["title"] = WindowTitle(hWnd);
      value["bounds"] = RectBounds(rect);
      value["minimized"] = IsIconic(hWnd);
      return value;
    }

    static List<Dictionary<string, object>> Windows() {
      var result = new List<Dictionary<string, object>>();
      EnumWindows(delegate(IntPtr hWnd, IntPtr ignored) {
        if (!IsWindowVisible(hWnd)) return true;
        RECT rect;
        if (!GetWindowRect(hWnd, out rect) || rect.Right <= rect.Left || rect.Bottom <= rect.Top) return true;
        string title = WindowTitle(hWnd);
        if (String.IsNullOrWhiteSpace(title)) return true;
        try { result.Add(ReadWindow(hWnd)); } catch { }
        return true;
      }, IntPtr.Zero);
      if (result.Count > 256) result.RemoveRange(256, result.Count - 256);
      return result;
    }

    static bool SameBounds(RECT rect, int x, int y, int width, int height) {
      return rect.Left == x && rect.Top == y && rect.Right - rect.Left == width && rect.Bottom - rect.Top == height;
    }

    static IntPtr ValidateWindow(string id, int processId, int x, int y, int width, int height, bool requireForeground, bool allowMinimized) {
      var hWnd = ParseWindowId(id);
      if (!IsWindowVisible(hWnd)) throw new DesktopNativeException("window_unavailable", "The selected window is no longer visible.");
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if ((int)pid != processId) throw new DesktopNativeException("window_replaced", "The selected window identity changed.");
      RECT rect;
      if (!GetWindowRect(hWnd, out rect) || !SameBounds(rect, x, y, width, height))
        throw new DesktopNativeException("stale_bounds", "The selected window bounds changed.");
      if (!allowMinimized && IsIconic(hWnd)) throw new DesktopNativeException("window_minimized", "The selected window is minimized.");
      if (requireForeground && GetForegroundWindow() != hWnd)
        throw new DesktopNativeException("window_not_foreground", "The selected window is not in the foreground.");
      return hWnd;
    }

    static void ValidateFocusedIdentity(IntPtr hWnd, int processId) {
      if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) throw new DesktopNativeException("window_unavailable", "The selected window is not available after focus.");
      uint pid; GetWindowThreadProcessId(hWnd, out pid);
      if ((int)pid != processId) throw new DesktopNativeException("window_replaced", "The selected window identity changed.");
      if (GetForegroundWindow() != hWnd) throw new DesktopNativeException("focus_failed", "Windows did not confirm the selected window as foreground.");
    }

    static void EnsureNotExpired(long expiresAt) {
      if (expiresAt <= 0 || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= expiresAt)
        throw new DesktopNativeException("command_expired", "The desktop command expired before any operating-system effect was sent.");
    }

    public static void CheckExpiry(long expiresAt) { EnsureNotExpired(expiresAt); }

    static Dictionary<string, object> ReadElements(IntPtr hWnd, out string error) {
      var items = new List<Dictionary<string, object>>();
      error = null;
      try {
        var root = AutomationElement.FromHandle(hWnd);
        if (root == null) { error = "UIAutomation root is unavailable."; return WrapElements(items); }
        var all = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
        int inspected = Math.Min(all.Count, 512), failures = 0;
        for (int i = 0; i < inspected && items.Count < 128; i++) {
          try {
            var element = all[i];
            if (element.Current.IsPassword) continue;
            var rectangle = element.Current.BoundingRectangle;
            if (rectangle.IsEmpty || Double.IsNaN(rectangle.X) || Double.IsInfinity(rectangle.X)) continue;
            var item = new Dictionary<string, object>();
            int[] runtime = element.GetRuntimeId();
            item["id"] = "uia:" + String.Join(".", Array.ConvertAll(runtime, delegate(int value) { return value.ToString(CultureInfo.InvariantCulture); }));
            string name = element.Current.Name ?? String.Empty;
            item["name"] = name.Length > 240 ? name.Substring(0, 240) : name;
            string role = element.Current.ControlType == null ? "Unknown" : element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
            item["role"] = role;
            item["bounds"] = Bounds((int)Math.Round(rectangle.X), (int)Math.Round(rectangle.Y), Math.Max(0, (int)Math.Round(rectangle.Width)), Math.Max(0, (int)Math.Round(rectangle.Height)));
            item["enabled"] = element.Current.IsEnabled;
            item["offscreen"] = element.Current.IsOffscreen;
            object pattern;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) {
              try {
                string value = ((ValuePattern)pattern).Current.Value ?? String.Empty;
                item["value"] = value.Length > 1000 ? value.Substring(0, 1000) : value;
              } catch { }
            }
            items.Add(item);
          } catch { failures++; }
        }
        if (failures > 0) error = "UIAutomation partially failed for " + failures.ToString(CultureInfo.InvariantCulture) + " controls.";
        if (all.Count > inspected) error = error ?? "UIAutomation scan was bounded before all controls were inspected.";
      } catch (Exception ex) {
        error = "UIAutomation failed: " + ex.GetType().Name + ".";
      }
      return WrapElements(items);
    }

    static Dictionary<string, object> WrapElements(List<Dictionary<string, object>> items) {
      var result = new Dictionary<string, object>(); result["items"] = items; return result;
    }

    public static Dictionary<string, object> Observe(string selectedWindowId) {
      var desktopRect = SystemInformation.VirtualScreen;
      var windows = Windows();
      string foreground = null;
      var fg = GetForegroundWindow(); if (fg != IntPtr.Zero) foreground = WindowId(fg);
      var result = new Dictionary<string, object>();
      result["capturedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
      result["desktop"] = Bounds(desktopRect.X, desktopRect.Y, desktopRect.Width, desktopRect.Height);
      result["windows"] = windows;
      result["foregroundWindowId"] = foreground;
      result["selectedWindowId"] = null;
      result["elements"] = new List<Dictionary<string, object>>();
      if (!String.IsNullOrEmpty(selectedWindowId)) {
        IntPtr selected = ParseWindowId(selectedWindowId);
        bool found = false;
        for (int i = 0; i < windows.Count; i++) {
          if ((string)windows[i]["id"] == selectedWindowId) { found = true; break; }
        }
        if (!found || !IsWindowVisible(selected)) throw new DesktopNativeException("window_unavailable", "The selected window is no longer visible.");
        string accessibilityError;
        var wrapped = ReadElements(selected, out accessibilityError);
        result["selectedWindowId"] = selectedWindowId;
        result["elements"] = wrapped["items"];
        if (!String.IsNullOrEmpty(accessibilityError)) result["accessibilityError"] = accessibilityError;
      }
      return result;
    }

    public static Dictionary<string, object> Screen(string selectedWindowId) {
      Rectangle capture = SystemInformation.VirtualScreen;
      if (!String.IsNullOrEmpty(selectedWindowId)) {
        IntPtr hWnd = ParseWindowId(selectedWindowId);
        if (!IsWindowVisible(hWnd) || IsIconic(hWnd)) throw new DesktopNativeException("window_unavailable", "The selected window cannot be captured while hidden or minimized.");
        RECT rect;
        if (!GetWindowRect(hWnd, out rect)) throw new DesktopNativeException("window_unavailable", "The selected window bounds are unavailable.");
        capture = Rectangle.Intersect(new Rectangle(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top), SystemInformation.VirtualScreen);
      }
      if (capture.Width <= 0 || capture.Height <= 0 || (long)capture.Width * (long)capture.Height > 64000000L)
        throw new DesktopNativeException("capture_bounds", "The capture bounds are invalid or too large.");
      using (var bitmap = new Bitmap(capture.Width, capture.Height, PixelFormat.Format32bppArgb)) {
        using (var graphics = Graphics.FromImage(bitmap)) {
          graphics.CopyFromScreen(capture.Left, capture.Top, 0, 0, capture.Size, CopyPixelOperation.SourceCopy);
        }
        using (var stream = new MemoryStream()) {
          bitmap.Save(stream, ImageFormat.Png);
          var result = new Dictionary<string, object>();
          result["pngBase64"] = Convert.ToBase64String(stream.ToArray());
          result["bounds"] = Bounds(capture.X, capture.Y, capture.Width, capture.Height);
          result["capturedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
          return result;
        }
      }
    }

    public static void Validate(string id, int processId, int x, int y, int width, int height, bool requireForeground, bool allowMinimized) {
      ValidateWindow(id, processId, x, y, width, height, requireForeground, allowMinimized);
    }

    static void Emit(Action issued) { if (issued != null) issued(); }

    static bool FocusWindow(IntPtr hWnd) {
      if (GetForegroundWindow() == hWnd) return true;
      if (IsIconic(hWnd)) ShowWindowAsync(hWnd, SW_RESTORE);
      var foreground = GetForegroundWindow();
      uint foregroundThread = 0, ignored;
      if (foreground != IntPtr.Zero) foregroundThread = GetWindowThreadProcessId(foreground, out ignored);
      uint currentThread = GetCurrentThreadId();
      bool attached = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
      try {
        BringWindowToTop(hWnd);
        SetForegroundWindow(hWnd);
      } finally {
        if (attached) AttachThreadInput(currentThread, foregroundThread, false);
      }
      Thread.Sleep(40);
      return GetForegroundWindow() == hWnd;
    }

    public static Dictionary<string, object> Focus(string id, int processId, int x, int y, int width, int height, long expiresAt, Action issued) {
      IntPtr hWnd = ValidateWindow(id, processId, x, y, width, height, false, true);
      EnsureNotExpired(expiresAt);
      Emit(issued);
      if (!FocusWindow(hWnd)) throw new DesktopNativeException("focus_failed", "Windows did not confirm the selected window as foreground.");
      ValidateFocusedIdentity(hWnd, processId);
      return Observe(id);
    }

    static INPUT MouseInput(int dx, int dy, uint data, uint flags) {
      var input = new INPUT(); input.type = INPUT_MOUSE;
      input.U.mi.dx = dx; input.U.mi.dy = dy; input.U.mi.mouseData = data; input.U.mi.dwFlags = flags;
      return input;
    }
    static INPUT KeyInput(ushort vk, ushort scan, uint flags) {
      var input = new INPUT(); input.type = INPUT_KEYBOARD;
      input.U.ki.wVk = vk; input.U.ki.wScan = scan; input.U.ki.dwFlags = flags;
      return input;
    }
    static void SendOne(INPUT input) {
      var items = new INPUT[] { input };
      if (SendInput(1, items, Marshal.SizeOf(typeof(INPUT))) != 1)
        throw new DesktopNativeException("send_input_failed", "Windows rejected an input event.");
    }
    static uint SendBatch(INPUT[] inputs) {
      if (inputs == null || inputs.Length == 0) return 0;
      return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
    static void MouseMovePhysical(int x, int y) {
      var desktop = SystemInformation.VirtualScreen;
      if (!desktop.Contains(x, y)) throw new DesktopNativeException("coordinate_outside_desktop", "The input coordinate is outside the virtual desktop.");
      int nx = desktop.Width <= 1 ? 0 : (int)Math.Round((x - desktop.Left) * 65535.0 / (desktop.Width - 1));
      int ny = desktop.Height <= 1 ? 0 : (int)Math.Round((y - desktop.Top) * 65535.0 / (desktop.Height - 1));
      SendOne(MouseInput(nx, ny, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK));
    }
    static void EnsurePoint(RECT rect, int x, int y) {
      if (x < rect.Left || x >= rect.Right || y < rect.Top || y >= rect.Bottom)
        throw new DesktopNativeException("coordinate_outside_window", "The input coordinate is outside the selected window.");
    }

    public static Dictionary<string, object> Click(string id, int processId, int bx, int by, int width, int height, int x, int y, string button, int clicks, long expiresAt, Action issued) {
      IntPtr hWnd = ValidateWindow(id, processId, bx, by, width, height, false, false);
      if (clicks != 1 && clicks != 2) throw new DesktopNativeException("invalid_clicks", "Click count must be one or two.");
      bool right = String.Equals(button, "right", StringComparison.OrdinalIgnoreCase);
      if (!right && !String.Equals(button, "left", StringComparison.OrdinalIgnoreCase)) throw new DesktopNativeException("invalid_button", "Mouse button is invalid.");
      EnsureNotExpired(expiresAt);
      Emit(issued);
      if (!FocusWindow(hWnd)) throw new DesktopNativeException("focus_failed", "Windows did not confirm the selected window as foreground.");
      hWnd = ValidateWindow(id, processId, bx, by, width, height, true, false);
      RECT rect; GetWindowRect(hWnd, out rect); EnsurePoint(rect, x, y);
      lock (InputLock) {
        MouseMovePhysical(x, y);
        for (int i = 0; i < clicks; i++) {
          var pair = right
            ? new INPUT[] { MouseInput(0, 0, 0, MOUSEEVENTF_RIGHTDOWN), MouseInput(0, 0, 0, MOUSEEVENTF_RIGHTUP) }
            : new INPUT[] { MouseInput(0, 0, 0, MOUSEEVENTF_LEFTDOWN), MouseInput(0, 0, 0, MOUSEEVENTF_LEFTUP) };
          uint sent = SendBatch(pair);
          if (sent != pair.Length) {
            if (sent == 1) { try { SendOne(pair[1]); } catch { } }
            throw new DesktopNativeException("send_input_failed", "Windows rejected part of a mouse click.");
          }
          if (clicks > 1) Thread.Sleep(40);
        }
      }
      Thread.Sleep(60); return Observe(id);
    }

    public static Dictionary<string, object> TypeText(string id, int processId, int x, int y, int width, int height, string text, long expiresAt, Action issued) {
      IntPtr hWnd = ValidateWindow(id, processId, x, y, width, height, false, false);
      if (text == null) throw new DesktopNativeException("invalid_text", "Text is required.");
      if (text.Length > 4000) throw new DesktopNativeException("invalid_text", "Text is too long.");
      EnsureNotExpired(expiresAt);
      Emit(issued);
      if (!FocusWindow(hWnd)) throw new DesktopNativeException("focus_failed", "Windows did not confirm the selected window as foreground.");
      ValidateWindow(id, processId, x, y, width, height, true, false);
      lock (InputLock) {
        foreach (char ch in text) {
          // Long Unicode payloads remain deadline-bounded between complete key down/up pairs.
          EnsureNotExpired(expiresAt);
          var pair = new INPUT[] { KeyInput(0, ch, KEYEVENTF_UNICODE), KeyInput(0, ch, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) };
          uint sent = SendBatch(pair);
          if (sent != pair.Length) {
            if (sent == 1) { try { SendOne(pair[1]); } catch { } }
            throw new DesktopNativeException("send_input_failed", "Windows rejected part of a Unicode key pair.");
          }
        }
      }
      Thread.Sleep(60); return Observe(id);
    }

    static ushort VirtualKey(string key) {
      if (String.IsNullOrWhiteSpace(key)) throw new DesktopNativeException("invalid_key", "Key names must be non-empty.");
      string value = key.Trim().ToUpperInvariant();
      if (value.Length == 1) {
        char c = value[0];
        if (c >= 'A' && c <= 'Z') return (ushort)c;
        if (c >= '0' && c <= '9') return (ushort)c;
      }
      switch (value) {
        case "CTRL": case "CONTROL": return 0x11;
        case "SHIFT": return 0x10;
        case "ALT": return 0x12;
        case "WIN": case "META": return 0x5B;
        case "ENTER": return 0x0D;
        case "TAB": return 0x09;
        case "ESC": case "ESCAPE": return 0x1B;
        case "SPACE": return 0x20;
        case "BACKSPACE": return 0x08;
        case "DELETE": return 0x2E;
        case "HOME": return 0x24;
        case "END": return 0x23;
        case "PAGEUP": return 0x21;
        case "PAGEDOWN": return 0x22;
        case "LEFT": return 0x25;
        case "UP": return 0x26;
        case "RIGHT": return 0x27;
        case "DOWN": return 0x28;
      }
      if (value.Length >= 2 && value[0] == 'F') {
        int number; if (Int32.TryParse(value.Substring(1), out number) && number >= 1 && number <= 24) return (ushort)(0x70 + number - 1);
      }
      throw new DesktopNativeException("invalid_key", "The requested key is not in the supported key set.");
    }

    public static Dictionary<string, object> KeyChord(string id, int processId, int x, int y, int width, int height, string[] keys, long expiresAt, Action issued) {
      IntPtr hWnd = ValidateWindow(id, processId, x, y, width, height, false, false);
      if (keys == null || keys.Length == 0 || keys.Length > 8) throw new DesktopNativeException("invalid_key", "A shortcut needs between one and eight keys.");
      var vks = new List<ushort>(); foreach (var key in keys) vks.Add(VirtualKey(key));
      EnsureNotExpired(expiresAt);
      Emit(issued);
      if (!FocusWindow(hWnd)) throw new DesktopNativeException("focus_failed", "Windows did not confirm the selected window as foreground.");
      ValidateWindow(id, processId, x, y, width, height, true, false);
      lock (InputLock) {
        var batch = new List<INPUT>();
        foreach (ushort vk in vks) batch.Add(KeyInput(vk, 0, 0));
        for (int i = vks.Count - 1; i >= 0; i--) batch.Add(KeyInput(vks[i], 0, KEYEVENTF_KEYUP));
        foreach (ushort vk in vks) PressedKeys.Add(vk);
        uint sent = SendBatch(batch.ToArray());
        if (sent != batch.Count) {
          for (int i = vks.Count - 1; i >= 0; i--) { try { SendOne(KeyInput(vks[i], 0, KEYEVENTF_KEYUP)); } catch { } }
          PressedKeys.Clear();
          throw new DesktopNativeException("send_input_failed", "Windows rejected part of a keyboard shortcut.");
        }
        PressedKeys.Clear();
      }
      Thread.Sleep(60); return Observe(id);
    }

    public static Dictionary<string, object> Scroll(string id, int processId, int bx, int by, int width, int height, int x, int y, int delta, long expiresAt, Action issued) {
      IntPtr hWnd = ValidateWindow(id, processId, bx, by, width, height, false, false);
      if (delta < -12000 || delta > 12000 || delta == 0) throw new DesktopNativeException("invalid_scroll", "Scroll delta is invalid.");
      EnsureNotExpired(expiresAt);
      Emit(issued);
      if (!FocusWindow(hWnd)) throw new DesktopNativeException("focus_failed", "Windows did not confirm the selected window as foreground.");
      hWnd = ValidateWindow(id, processId, bx, by, width, height, true, false);
      RECT rect; GetWindowRect(hWnd, out rect); EnsurePoint(rect, x, y);
      lock (InputLock) { MouseMovePhysical(x, y); SendOne(MouseInput(0, 0, unchecked((uint)delta), MOUSEEVENTF_WHEEL)); }
      Thread.Sleep(60); return Observe(id);
    }

    public static void ReleaseAll() {
      lock (InputLock) {
        var keys = new List<ushort>(PressedKeys);
        for (int i = keys.Count - 1; i >= 0; i--) { try { SendOne(KeyInput(keys[i], 0, KEYEVENTF_KEYUP)); } catch { } }
        PressedKeys.Clear();
        if (LeftDown) { try { SendOne(MouseInput(0, 0, 0, MOUSEEVENTF_LEFTUP)); } catch { } LeftDown = false; }
        if (RightDown) { try { SendOne(MouseInput(0, 0, 0, MOUSEEVENTF_RIGHTUP)); } catch { } RightDown = false; }
      }
    }
  }
}
'@

$referenceNames = @('System.Drawing', 'System.Windows.Forms', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase')
$references = [AppDomain]::CurrentDomain.GetAssemblies() |
  Where-Object { $referenceNames -contains $_.GetName().Name } |
  ForEach-Object { $_.Location } |
  Sort-Object -Unique
Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies $references

function Write-JsonLine([object]$value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 10))
  [Console]::Out.Flush()
}

function Bounds-Args([object]$expected) {
  @([int]$expected.processId, [int]$expected.bounds.x, [int]$expected.bounds.y, [int]$expected.bounds.width, [int]$expected.bounds.height)
}

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([String]::IsNullOrWhiteSpace($line)) { continue }
  $request = $null
  $shutdown = $false
  try {
    $request = $line | ConvertFrom-Json
    $id = [string]$request.id
    if ([String]::IsNullOrWhiteSpace($id)) { throw [RealtimeDesktop.DesktopNativeException]::new('invalid_request', 'A request id is required.') }
    switch ([string]$request.kind) {
      'ping' { $result = @{ ready = $true } }
      'protocol-test-expiry' {
        $delayMs = [int]$request.delayMs
        if ($delayMs -lt 0 -or $delayMs -gt 5000) { throw [RealtimeDesktop.DesktopNativeException]::new('invalid_request', 'The protocol test delay is invalid.') }
        if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
        [RealtimeDesktop.DesktopApi]::CheckExpiry([long]$request.expiresAt)
        $result = @{ checked = $true }
      }
      'protocol-test-delay' {
        $delayMs = [int]$request.delayMs
        if ($delayMs -lt 0 -or $delayMs -gt 5000) { throw [RealtimeDesktop.DesktopNativeException]::new('invalid_request', 'The protocol test delay is invalid.') }
        if ($delayMs -gt 0) { Start-Sleep -Milliseconds $delayMs }
        $result = @{ delayed = $true }
      }
      'observe' { $result = [RealtimeDesktop.DesktopApi]::Observe([string]$request.windowId) }
      'screen' { $result = [RealtimeDesktop.DesktopApi]::Screen([string]$request.windowId) }
      'validate' {
        $boundsArgs = Bounds-Args $request.expected
        [RealtimeDesktop.DesktopApi]::Validate([string]$request.windowId, $boundsArgs[0], $boundsArgs[1], $boundsArgs[2], $boundsArgs[3], $boundsArgs[4], [bool]$request.requireForeground, [bool]$request.allowMinimized)
        $result = @{ valid = $true }
      }
      'execute' {
        $boundsArgs = Bounds-Args $request.expected
        $expiresAt = [long]$request.expiresAt
        $delayBeforeEffectMs = if ($null -ne $request.testDelayBeforeEffectMs) { [int]$request.testDelayBeforeEffectMs } else { 0 }
        if ($delayBeforeEffectMs -lt 0 -or $delayBeforeEffectMs -gt 10000) { throw [RealtimeDesktop.DesktopNativeException]::new('invalid_request', 'The helper delay is invalid.') }
        if ($delayBeforeEffectMs -gt 0) { Start-Sleep -Milliseconds $delayBeforeEffectMs }
        $issued = [Action]{ Write-JsonLine @{ id = $id; event = 'issued' } }
        $command = $request.command
        switch ([string]$command.kind) {
          'focus' { $result = [RealtimeDesktop.DesktopApi]::Focus([string]$request.windowId, $boundsArgs[0], $boundsArgs[1], $boundsArgs[2], $boundsArgs[3], $boundsArgs[4], $expiresAt, $issued) }
          'click' { $result = [RealtimeDesktop.DesktopApi]::Click([string]$request.windowId, $boundsArgs[0], $boundsArgs[1], $boundsArgs[2], $boundsArgs[3], $boundsArgs[4], [int]$command.x, [int]$command.y, [string]$command.button, [int]$command.clicks, $expiresAt, $issued) }
          'type' { $result = [RealtimeDesktop.DesktopApi]::TypeText([string]$request.windowId, $boundsArgs[0], $boundsArgs[1], $boundsArgs[2], $boundsArgs[3], $boundsArgs[4], [string]$command.text, $expiresAt, $issued) }
          'key' { $result = [RealtimeDesktop.DesktopApi]::KeyChord([string]$request.windowId, $boundsArgs[0], $boundsArgs[1], $boundsArgs[2], $boundsArgs[3], $boundsArgs[4], [string[]]$command.keys, $expiresAt, $issued) }
          'scroll' { $result = [RealtimeDesktop.DesktopApi]::Scroll([string]$request.windowId, $boundsArgs[0], $boundsArgs[1], $boundsArgs[2], $boundsArgs[3], $boundsArgs[4], [int]$command.x, [int]$command.y, [int]$command.delta, $expiresAt, $issued) }
          default { throw [RealtimeDesktop.DesktopNativeException]::new('invalid_command', 'The desktop command is not supported.') }
        }
      }
      'release' { [RealtimeDesktop.DesktopApi]::ReleaseAll(); $result = @{ released = $true } }
      'shutdown' { [RealtimeDesktop.DesktopApi]::ReleaseAll(); Write-JsonLine @{ id = $id; ok = $true; result = @{ closed = $true } }; $shutdown = $true }
      default { throw [RealtimeDesktop.DesktopNativeException]::new('invalid_request', 'The helper request kind is not supported.') }
    }
    if ($shutdown) { break }
    Write-JsonLine @{ id = $id; ok = $true; result = $result }
  } catch {
    $exception = $_.Exception
    while ($exception.InnerException) { $exception = $exception.InnerException }
    $code = if ($exception -is [RealtimeDesktop.DesktopNativeException]) { $exception.Code } else { 'native_failure' }
    $message = if ($exception -is [RealtimeDesktop.DesktopNativeException]) { $exception.Message } else { 'The Windows desktop helper could not complete the request.' }
    Write-JsonLine @{ id = if ($request) { [string]$request.id } else { $null }; ok = $false; error = @{ code = $code; message = $message } }
  }
}

[RealtimeDesktop.DesktopApi]::ReleaseAll()
