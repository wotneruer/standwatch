using System.Diagnostics;
using System.IO.Pipes;
using System.Net;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace StandWatch.Desktop;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        var baseDir = Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory);
        var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(baseDir.ToUpperInvariant())))[..16];
        using var mutex = new Mutex(true, $"Local\\StandWatch-{id}", out var primary);
        if (!primary)
        {
            try
            {
                using var client = new NamedPipeClientStream(".", $"StandWatch-{id}", PipeDirection.Out);
                client.Connect(2500);
                client.WriteByte(1);
            }
            catch { }
            return;
        }

        using var form = new MainForm(baseDir, $"StandWatch-{id}");
        Application.Run(form);
    }
}

internal sealed class MainForm : Form
{
    private readonly string _baseDir;
    private readonly string _pipeName;
    private readonly string _dataDir;
    private readonly string _logPath;
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly Panel _statusPanel = new() { Dock = DockStyle.Fill, BackColor = Color.FromArgb(246, 248, 251) };
    private readonly Label _status = new() { AutoSize = false, Dock = DockStyle.Fill, TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Segoe UI", 12) };
    private readonly Button _retry = new() { Text = "Повторити", AutoSize = true, Visible = false };
    private readonly WebView2 _web = new() { Dock = DockStyle.Fill, Visible = false };
    private readonly CancellationTokenSource _lifetime = new();
    private Process? _backend;
    private JobObject? _job;
    private Uri? _backendUri;
    private bool _closing;

    public MainForm(string baseDir, string pipeName)
    {
        _baseDir = baseDir;
        _pipeName = pipeName;
        _dataDir = Path.Combine(baseDir, "data");
        _logPath = Path.Combine(_dataDir, "logs", "standwatch.log");
        Text = "StandWatch · менеджмент портал";
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(900, 600);
        ClientSize = new Size(1320, 880);

        var retryHost = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 60, FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(0, 8, 0, 0) };
        retryHost.Controls.Add(_retry);
        retryHost.Resize += (_, _) => _retry.Margin = new Padding(Math.Max(0, (retryHost.ClientSize.Width - _retry.Width) / 2), 3, 0, 0);
        _statusPanel.Controls.Add(_status);
        _statusPanel.Controls.Add(retryHost);
        Controls.Add(_web);
        Controls.Add(_statusPanel);

        _retry.Click += async (_, _) => await StartAsync();
        Shown += async (_, _) => await StartAsync();
        FormClosing += OnFormClosing;
        _ = ListenForActivationAsync();
        Log($"desktop start version=1.0.0 base={_baseDir}");
    }

    private async Task ListenForActivationAsync()
    {
        while (!_lifetime.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(_pipeName, PipeDirection.In, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                await server.WaitForConnectionAsync(_lifetime.Token);
                _ = server.ReadByte();
                if (!IsDisposed) BeginInvoke(ActivateWindow);
                Log("single-instance activate");
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex) { Log("activation pipe error: " + ex.Message); }
        }
    }

    private void ActivateWindow()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Activate();
        BringToFront();
    }

    private async Task StartAsync()
    {
        _retry.Visible = false;
        _status.Text = "Запуск менеджмент-порталу…";
        _statusPanel.Visible = true;
        _web.Visible = false;
        try
        {
            if (_backend is null || _backend.HasExited)
                await StartBackendAsync();
            await InitializeWebViewAsync();
            _web.Source = _backendUri!;
            _web.Visible = true;
            _statusPanel.Visible = false;
            Log($"ready url={_backendUri}");
        }
        catch (Exception ex)
        {
            Log("startup failure: " + ex);
            _status.Text = "Не вдалося запустити StandWatch.\r\n\r\n" + ex.Message + "\r\n\r\nЛог: " + _logPath;
            _retry.Visible = true;
        }
    }

    private async Task StartBackendAsync()
    {
        var exe = Path.Combine(_baseDir, "standwatch-server.exe");
        if (!File.Exists(exe)) throw new FileNotFoundException("Не знайдено backend standwatch-server.exe", exe);
        Directory.CreateDirectory(_dataDir);
        var port = FindFreePort();
        var psi = new ProcessStartInfo(exe, $"--no-open --port {port}")
        {
            WorkingDirectory = _baseDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        _backend = new Process { StartInfo = psi, EnableRaisingEvents = true };
        _backend.OutputDataReceived += (_, e) => { if (e.Data is not null) Log("backend: " + Redact(e.Data)); };
        _backend.ErrorDataReceived += (_, e) => { if (e.Data is not null) Log("backend error: " + Redact(e.Data)); };
        _backend.Exited += (_, _) => BeginInvoke(() => BackendExited());
        if (!_backend.Start()) throw new InvalidOperationException("Backend не запустився.");
        _backend.BeginOutputReadLine();
        _backend.BeginErrorReadLine();
        _job = new JobObject();
        _job.AddProcess(_backend);
        Log($"backend pid={_backend.Id} port={port}");

        var uri = new Uri($"http://127.0.0.1:{port}/");
        Exception? last = null;
        for (var i = 0; i < 60; i++)
        {
            if (_backend.HasExited) throw new InvalidOperationException($"Backend завершився з кодом {_backend.ExitCode}.");
            try
            {
                using var response = await _http.GetAsync(new Uri(uri, "api/ping"));
                if (response.IsSuccessStatusCode)
                {
                    var ping = await response.Content.ReadFromJsonAsync<Ping>();
                    if (ping?.app == "standwatch" && Path.GetFullPath(ping.dataDir ?? "") == Path.GetFullPath(_dataDir))
                    {
                        _backendUri = uri;
                        return;
                    }
                }
            }
            catch (Exception ex) { last = ex; }
            await Task.Delay(100);
        }
        throw new TimeoutException("Backend не відповів на перевірку готовності.", last);
    }

    private async Task InitializeWebViewAsync()
    {
        if (_web.CoreWebView2 is not null) return;
        var userData = Path.Combine(_dataDir, "webview2");
        Directory.CreateDirectory(userData);
        // This workstation has repeated GPU-process WATCHDOG failures. Keep the
        // workaround local to StandWatch's embedded WebView instead of changing Edge globally.
        var options = new CoreWebView2EnvironmentOptions("--disable-gpu");
        Log("webview initialize with software rendering (GPU process instability detected on target host)");
        var environment = await CoreWebView2Environment.CreateAsync(null, userData, options);
        await _web.EnsureCoreWebView2Async(environment);
        var core = _web.CoreWebView2!;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.WebMessageReceived += (_, e) =>
        {
            var message = e.TryGetWebMessageAsString();
            if (!message.StartsWith("pick-ssh-key:", StringComparison.Ordinal)) return;
            var target = message["pick-ssh-key:".Length..];
            if (target is not ("c_ssh" or "c_bootstrap" or "f_bootstrap")) return;
            using var picker = new OpenFileDialog
            {
                Title = target == "c_ssh" ? "Оберіть SSH-ключ StandWatch" : "Оберіть діючий SSH-ключ першого входу",
                Filter = "SSH private key (*.*)|*.*",
                CheckFileExists = true,
                Multiselect = false
            };
            if (picker.ShowDialog(this) == DialogResult.OK)
            {
                var payload = JsonSerializer.Serialize(new { type = "ssh-key-picked", target, path = picker.FileName.Replace('\\', '/') });
                core.PostWebMessageAsJson(payload);
            }
        };
        core.NewWindowRequested += (_, e) =>
        {
            e.Handled = true;
            if (Uri.TryCreate(e.Uri, UriKind.Absolute, out var uri) && (uri.Scheme == "http" || uri.Scheme == "https"))
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            else Log("blocked external uri: " + e.Uri);
        };
        core.ProcessFailed += (_, e) => BeginInvoke(() => ShowFailure("Компонент WebView2 завершився: " + e.ProcessFailedKind));
        core.NavigationCompleted += (_, e) => { if (!e.IsSuccess) ShowFailure("Сторінка не завантажилась: " + e.WebErrorStatus); };
    }

    private void BackendExited()
    {
        if (_closing || IsDisposed) return;
        Log($"backend exited code={_backend?.ExitCode}");
        Close();
    }

    private void ShowFailure(string message)
    {
        Log(message);
        _web.Visible = false;
        _statusPanel.Visible = true;
        _status.Text = message + "\r\n\r\nПерезапустіть портал кнопкою нижче.";
        _retry.Visible = true;
    }

    private async void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_closing) return;
        e.Cancel = true;
        _closing = true;
        Hide();
        _lifetime.Cancel();
        Log("shutdown requested");
        try
        {
            if (_backend is { HasExited: false })
            {
                if (_backendUri is not null)
                {
                    try { await _http.PostAsync(new Uri(_backendUri, "api/quit"), null); } catch { }
                }
                if (!await WaitForExitAsync(_backend, 1800))
                {
                    Log("backend grace timeout; killing owned tree");
                    _backend.Kill(true);
                    await WaitForExitAsync(_backend, 1000);
                }
            }
        }
        finally
        {
            _job?.Dispose();
            _http.Dispose();
            Log("desktop stopped");
            FormClosing -= OnFormClosing;
            Close();
        }
    }

    private static int FindFreePort()
    {
        for (var port = 8799; port <= 8819; port++)
        {
            try
            {
                var listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, port);
                listener.Start(); listener.Stop(); return port;
            }
            catch { }
        }
        throw new InvalidOperationException("Порти 8799–8819 зайняті.");
    }

    private static async Task<bool> WaitForExitAsync(Process process, int timeoutMs)
    {
        using var timeout = new CancellationTokenSource(timeoutMs);
        try { await process.WaitForExitAsync(timeout.Token); return true; }
        catch (OperationCanceledException) { return process.HasExited; }
    }

    private void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_logPath)!);
            File.AppendAllText(_logPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}");
        }
        catch { }
    }

    private static string Redact(string value) => System.Text.RegularExpressions.Regex.Replace(value,
        "(?i)(token|password|secret)(\\s*[=:]\\s*)[^\\s]+", "$1$2***");

    private sealed record Ping(string? app, int pid, string? dataDir);
}

internal sealed class JobObject : IDisposable
{
    private IntPtr _handle;
    public JobObject()
    {
        _handle = CreateJobObject(IntPtr.Zero, null);
        if (_handle == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = 0x00002000;
        var length = Marshal.SizeOf(info);
        var ptr = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, ptr, false);
            if (!SetInformationJobObject(_handle, 9, ptr, (uint)length)) throw new System.ComponentModel.Win32Exception();
        }
        finally { Marshal.FreeHGlobal(ptr); }
    }
    public void AddProcess(Process process)
    {
        if (!AssignProcessToJobObject(_handle, process.Handle)) throw new System.ComponentModel.Win32Exception();
    }
    public void Dispose()
    {
        if (_handle != IntPtr.Zero) { CloseHandle(_handle); _handle = IntPtr.Zero; }
    }

    [StructLayout(LayoutKind.Sequential)] private struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
    [StructLayout(LayoutKind.Sequential)] private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll")] private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll")] private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
