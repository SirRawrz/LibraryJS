using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Microsoft.Win32;
using System.Windows.Forms;

namespace LibraryJSServerTrayHost;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new LibraryJSServerContext());
    }
}


internal static class PortUtil
{
    internal static int ClampPort(int port)
    {
        if (port < 1)
        {
            return 1;
        }

        if (port > 65535)
        {
            return 65535;
        }

        return port;
    }
}

internal sealed class LibraryJSServerContext : ApplicationContext
{
    private const string StartupRunValueName = "LibraryJS Server";

    private readonly NotifyIcon _trayIcon;
    private readonly MainWindow _window;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Icon _appIcon;
    private readonly AppSettingsStore _settings = AppSettingsStore.Load();

    private readonly List<ManagedServerInstance> _servers = new();
    private string? _runtimeRoot;
    private string? _serverUrl;
    private bool _exitRequested;
    private bool _startupInProgress;
    private bool _serverRunning;
    private bool _autoStartAttempted;
    private bool _suppressServerExitNotifications;

    public LibraryJSServerContext()
    {
        _appIcon = LoadAppIcon();

        _window = new MainWindow(_settings.Port, _appIcon);
        _window.Icon = _appIcon;
        _window.RequestStart += async (_, port) => await StartAsync(port);
        _window.RequestStop += (_, _) => StopRunningServers();
        _window.RequestExit += (_, _) => ExitApplication();
        _window.PortChanged += (_, port) =>
        {
            _settings.Port = port;
            _settings.Save();
        };
        _window.StartWithWindowsChanged += (_, enabled) =>
        {
            try
            {
                SetStartupRegistration(enabled);
                _settings.StartWithWindows = enabled;
                _settings.Save();
            }
            catch (Exception ex)
            {
                _window.SetStartupOptionSilently(_settings.StartWithWindows);
                MessageBox.Show(_window, ex.Message, "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };
        _window.AutoStartServerChanged += (_, enabled) =>
        {
            _settings.AutoStartServerOnLaunch = enabled;
            _settings.Save();
        };
        _window.MinimizeWhenStartedChanged += (_, enabled) =>
        {
            _settings.MinimizeWhenStarted = enabled;
            _settings.Save();
        };
        _window.CorsEnabledChanged += (_, enabled) =>
        {
            _settings.CorsEnabled = enabled;
            _settings.Save();
        };
        _window.LocationsChanged += (_, _) =>
        {
            _settings.Settings.Locations = _window.CurrentLocations.ToList();
            _settings.Save();
        };
        _window.Resize += Window_Resize;
        _window.FormClosing += Window_FormClosing;
        _window.Shown += Window_Shown;

        _window.SetStartupOptions(_settings.StartWithWindows, _settings.AutoStartServerOnLaunch, _settings.MinimizeWhenStarted, _settings.CorsEnabled);
        _window.SetLocations(_settings.Settings.Locations);
        _window.SetStatus("Choose one or more folder roots and assign ports.");

        _trayIcon = new NotifyIcon
        {
            Icon = _appIcon,
            Text = "LibraryJS Server",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu()
        };
        _trayIcon.DoubleClick += (_, _) => RestoreWindow();

        _window.Show();
    }

    private async void Window_Shown(object? sender, EventArgs e)
    {
        if (_autoStartAttempted || !_settings.AutoStartServerOnLaunch)
        {
            return;
        }

        _autoStartAttempted = true;

        if (_window.IsDisposed)
        {
            return;
        }

        await Task.Delay(750).ConfigureAwait(true);

        if (_window.IsDisposed)
        {
            return;
        }

        _settings.Save();
        _window.SetStatus("Auto-start is enabled. Starting the saved locations...");
        _window.SetStatusDetail("The launcher is using your saved folder roots and ports.");
        await StartAsync(_settings.Port);
    }

    private static Icon LoadAppIcon()
    {
        try
        {
            var assembly = Assembly.GetExecutingAssembly();
            using var stream = assembly.GetManifestResourceStream("LibraryJSServer.ico");
            if (stream is not null)
            {
                return new Icon(stream);
            }
        }
        catch
        {
            // Fall through to the default system icon.
        }

        return System.Drawing.SystemIcons.Application;
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open LibraryJS Server", null, (_, _) => RestoreWindow());
        menu.Items.Add("Stop server", null, (_, _) => StopRunningServers());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ExitApplication());
        return menu;
    }

    private async Task StartAsync(int port)
    {
        if (_startupInProgress || _serverRunning)
        {
            return;
        }

        var locations = BuildReadyLocations(_window.CurrentLocations);
        if (locations.Count == 0)
        {
            _window.SetStatus("Add at least one enabled location with both a folder root and a port.");
            _window.SetStatusDetail("The server needs a valid folder root before it can start.");
            return;
        }

        var duplicatePort = locations
            .GroupBy(location => location.Port)
            .FirstOrDefault(group => group.Count() > 1);
        if (duplicatePort is not null)
        {
            _window.SetStatus($"Port {duplicatePort.Key} is assigned to more than one enabled location.");
            _window.SetStatusDetail("Each folder root needs its own unique port.");
            return;
        }

        _startupInProgress = true;
        _suppressServerExitNotifications = true;
        _settings.Port = PortUtil.ClampPort(port);
        _settings.Settings.Locations = _window.CurrentLocations.ToList();
        _settings.Save();

        _window.SetUiEnabled(false);
        _window.SetStatus("Preparing the bundled runtime...");

        HttpsCertificateStatus? httpsCertificate = null;

        try
        {
            _runtimeRoot = Path.Combine(Path.GetTempPath(), "libraryjs-server-tray-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(_runtimeRoot);

            ExtractBundledFiles(_runtimeRoot);

            if (locations.Any(location => location.UseHttps))
            {
                try
                {
                    httpsCertificate = HttpsCertificateStore.EnsureCertificateFiles();
                    HttpsCertificateStore.TrustCertificate(httpsCertificate);
                    _window.RefreshHttpsCertificateIndicators();
                }
                catch (Exception certEx)
                {
                    throw new InvalidOperationException($"Unable to create or load the HTTPS certificate in '{HttpsCertificateStore.CertificateDirectory}'.", certEx);
                }
            }

            StopAllServers();
            _serverUrl = null;

            var startupTasks = new List<Task>();
            foreach (var location in locations)
            {
                var scheme = location.UseHttps ? "https" : "http";
                var healthUrl = $"{scheme}://127.0.0.1:{location.Port}/api/health";
                var browseUrl = $"{scheme}://127.0.0.1:{location.Port}/";

                _window.SetStatus($"Starting {FormatLocationLabel(location)} on {scheme.ToUpperInvariant()} port {location.Port}...");
                var process = StartServer(_runtimeRoot, location.Port, location.FolderRoot, location.UseHttps, httpsCertificate?.CertPath, httpsCertificate?.KeyPath);
                var instance = new ManagedServerInstance
                {
                    FolderRoot = location.FolderRoot,
                    Port = location.Port,
                    UseHttps = location.UseHttps,
                    Url = browseUrl,
                    HealthUrl = healthUrl,
                    Process = process
                };
                _servers.Add(instance);
                _serverUrl ??= instance.Url;
                process.Exited += (_, _) => HandleServerExited();
                startupTasks.Add(WaitForServerAsync(instance.HealthUrl, instance.UseHttps, _shutdown.Token));
            }

            await Task.WhenAll(startupTasks).ConfigureAwait(true);

            _serverRunning = true;
            _suppressServerExitNotifications = false;
            _window.SetStartButtonState(true);
            _window.SetStatus($"{locations.Count} location server(s) are running.");
            _window.SetStatusDetail(httpsCertificate is not null
                ? $"HTTPS certificate saved at {HttpsCertificateStore.CertificateDirectory}. Expires {httpsCertificate.ExpiresOn:yyyy-MM-dd}."
                : "Each enabled folder root is now served on its own port.");

            if (httpsCertificate is not null && httpsCertificate.WasGenerated && File.Exists(httpsCertificate.CerPath))
            {
                var installPrompt = MessageBox.Show(
                    _window,
                    "A new local HTTPS certificate was created and trusted for the current user. Open it now to view the certificate?",
                    "LibraryJS Server",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Information);

                if (installPrompt == DialogResult.Yes)
                {
                    try
                    {
                        Process.Start(new ProcessStartInfo(httpsCertificate.CerPath)
                        {
                            UseShellExecute = true
                        });
                    }
                    catch (Exception ex)
                    {
                        MessageBox.Show(_window, ex.Message, "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    }
                }
            }
            if (_settings.MinimizeWhenStarted)
            {
                _window.WindowState = FormWindowState.Minimized;
            }
            else
            {
                _window.SetStatus("Server started.");
            }
        }
        catch (OperationCanceledException)
        {
            // Normal shutdown.
        }
        catch (Exception ex)
        {
            StopAllServers();
            _serverRunning = false;
            _serverUrl = null;
            _window.SetStatus("Startup failed.");
            _window.SetStatusDetail("One or more location servers could not be started.");
            MessageBox.Show(_window, ex.ToString(), "LibraryJS Server startup failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
            _window.SetStartButtonState(false);
            _window.SetUiEnabled(true);
        }
        finally
        {
            _startupInProgress = false;
            if (!_serverRunning)
            {
                _window.SetStartButtonState(false);
                _window.SetUiEnabled(true);
            }
        }
    }

    private void HandleServerExited()
    {
        if (_exitRequested || _startupInProgress || _suppressServerExitNotifications)
        {
            return;
        }

        try
        {
            _window.BeginInvoke(new Action(() =>
            {
                var runningCount = _servers.Count(instance => !instance.Process.HasExited);
                if (runningCount == 0)
                {
                    _serverRunning = false;
                    _window.SetStartButtonState(false);
                    _window.SetUiEnabled(true);
                    _window.SetStatus("All local servers stopped.");
                    MessageBox.Show(_window, "All local LibraryJS servers have stopped unexpectedly.", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    ExitApplication();
                    return;
                }

                _serverRunning = true;
                _window.SetStatus($"One server stopped unexpectedly; {runningCount} still running.");
                _window.SetStatusDetail("Open the tray menu to exit, or restart to relaunch all locations.");
                MessageBox.Show(_window, "One LibraryJS server stopped unexpectedly, but the others are still running.", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }));
        }
        catch
        {
            // Ignore UI shutdown issues.
        }
    }

    private void StopAllServers()
    {
        foreach (var instance in _servers)
        {
            try
            {
                if (!instance.Process.HasExited)
                {
                    instance.Process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // Ignore process cleanup failures.
            }

            try
            {
                instance.Process.Dispose();
            }
            catch
            {
                // Ignore process cleanup failures.
            }
        }

        _servers.Clear();
        _serverRunning = false;
    }

    private void StopRunningServers()
    {
        if (!_serverRunning && !_startupInProgress)
        {
            return;
        }

        _suppressServerExitNotifications = true;
        try
        {
            StopAllServers();
            _serverUrl = null;
            _window.SetStartButtonState(false);
            _window.SetUiEnabled(true);
            _window.SetStatus("Server stopped.");
            _window.SetStatusDetail("You can start the selected locations again when ready.");
        }
        finally
        {
            _suppressServerExitNotifications = false;
        }
    }

    private static List<LocationConfig> BuildReadyLocations(IEnumerable<LocationConfig> locations)
    {
        var ready = new List<LocationConfig>();
        foreach (var location in locations)
        {
            if (!location.Enabled)
            {
                continue;
            }

            var folderRoot = (location.FolderRoot ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(folderRoot))
            {
                continue;
            }

            folderRoot = Path.GetFullPath(folderRoot);
            if (!Directory.Exists(folderRoot))
            {
                throw new DirectoryNotFoundException($"Folder root does not exist: {folderRoot}");
            }

            ready.Add(new LocationConfig
            {
                FolderRoot = folderRoot,
                Port = PortUtil.ClampPort(location.Port),
                Enabled = true,
                UseHttps = location.UseHttps
            });
        }

        return ready;
    }

    private string? GetPrimaryServerUrl()
    {
        var active = _servers.FirstOrDefault(instance => !instance.Process.HasExited);
        return active?.Url ?? _serverUrl;
    }

    private static string FormatLocationLabel(LocationConfig location)
    {
        var folder = Path.GetFileName(location.FolderRoot.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
        if (string.IsNullOrWhiteSpace(folder))
        {
            folder = location.FolderRoot;
        }

        return location.UseHttps ? folder + " (HTTPS)" : folder;
    }

    private void Window_Resize(object? sender, EventArgs e)
    {
        if (_window.WindowState != FormWindowState.Minimized)
        {
            return;
        }

        _window.Hide();
        _trayIcon.Visible = true;
        _trayIcon.ShowBalloonTip(1000, "LibraryJS Server", _serverRunning
            ? "Still running in the system tray."
            : "The launcher is hidden in the system tray.", ToolTipIcon.Info);
    }

    private void Window_FormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_exitRequested)
        {
            return;
        }

        e.Cancel = true;
        _window.BeginInvoke(new Action(ExitApplication));
    }

    private void RestoreWindow()
    {
        if (_window.IsDisposed)
        {
            return;
        }

        if (!_window.Visible)
        {
            _window.Show();
        }

        if (_window.WindowState == FormWindowState.Minimized)
        {
            _window.WindowState = FormWindowState.Normal;
        }

        _window.ShowInTaskbar = true;
        _window.BringToFront();
        _window.Activate();
    }

    private void OpenBrowser()
    {
        var url = GetPrimaryServerUrl();
        if (string.IsNullOrWhiteSpace(url))
        {
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(url)
            {
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            _window.SetStatus("Unable to open the browser.");
            MessageBox.Show(_window, ex.Message, "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private Process StartServer(string runtimeRoot, int port, string folderRoot, bool useHttps, string? httpsCertPath, string? httpsKeyPath)
    {
        var nodePath = Path.Combine(runtimeRoot, "node.exe");
        var serverPath = Path.Combine(runtimeRoot, "server.mjs");

        if (!File.Exists(nodePath))
        {
            throw new FileNotFoundException("Bundled node.exe was not found.", nodePath);
        }

        if (!File.Exists(serverPath))
        {
            throw new FileNotFoundException("Bundled server.mjs was not found.", serverPath);
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = $"\"{serverPath}\" --port {port} --root \"{folderRoot}\"",
            WorkingDirectory = runtimeRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        startInfo.Environment["LIBRARYJS_PORT"] = port.ToString();
        startInfo.Environment["LIBRARYJS_ROOT"] = folderRoot;
        startInfo.Environment["LIBRARYJS_NO_PROMPT"] = "1";
        startInfo.Environment["LIBRARYJS_CORS"] = "1";
        startInfo.Environment["LIBRARYJS_HTTPS"] = useHttps ? "1" : "0";
        if (useHttps && !string.IsNullOrWhiteSpace(httpsCertPath) && !string.IsNullOrWhiteSpace(httpsKeyPath))
        {
            startInfo.Environment["LIBRARYJS_TLS_CERT"] = httpsCertPath!;
            startInfo.Environment["LIBRARYJS_TLS_KEY"] = httpsKeyPath!;
        }

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true
        };

        var outputBuffer = new StringBuilder();
        process.OutputDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                outputBuffer.AppendLine(args.Data);
            }
        };
        process.ErrorDataReceived += (_, args) =>
        {
            if (!string.IsNullOrWhiteSpace(args.Data))
            {
                outputBuffer.AppendLine(args.Data);
            }
        };

        if (!process.Start())
        {
            throw new InvalidOperationException("Failed to start the bundled server process.");
        }

        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        return process;
    }

    private static async Task WaitForServerAsync(string url, bool ignoreCertificateErrors, CancellationToken cancellationToken)
    {
        using var handler = new HttpClientHandler
        {
            UseProxy = false
        };

        if (ignoreCertificateErrors)
        {
            handler.ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator;
        }

        using var http = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(2)
        };

        for (var attempt = 0; attempt < 80; attempt++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            try
            {
                using var response = await http.GetAsync(url, cancellationToken).ConfigureAwait(true);
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
            }
            catch
            {
                // Keep waiting until the local server is ready.
            }

            await Task.Delay(250, cancellationToken).ConfigureAwait(true);
        }

        throw new TimeoutException("The local server did not become ready in time.");
    }

    private static (string CertPath, string KeyPath) EnsureHttpsCertificateFiles(string certDir)
    {
        var certPath = Path.Combine(certDir, "libraryjs-https-cert.pem");
        var keyPath = Path.Combine(certDir, "libraryjs-https-key.pem");

        if (File.Exists(certPath) && File.Exists(keyPath))
        {
            return (certPath, keyPath);
        }

        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            $"CN={Environment.MachineName}",
            rsa,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);

        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection
        {
            new Oid("1.3.6.1.5.5.7.3.1")
        }, false));

        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        san.AddIpAddress(IPAddress.Loopback);
        san.AddIpAddress(IPAddress.IPv6Loopback);
        san.AddDnsName(Environment.MachineName);

        try
        {
            foreach (var ip in Dns.GetHostEntry(Dns.GetHostName()).AddressList)
            {
                if (IPAddress.IsLoopback(ip))
                {
                    continue;
                }

                if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                {
                    san.AddIpAddress(ip);
                }
            }
        }
        catch
        {
            // Best-effort only.
        }

        request.CertificateExtensions.Add(san.Build());

        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(2));
        File.WriteAllText(certPath, certificate.ExportCertificatePem(), Encoding.UTF8);
        File.WriteAllText(keyPath, rsa.ExportPkcs8PrivateKeyPem(), Encoding.UTF8);
        return (certPath, keyPath);
    }

    private static void ExtractBundledFiles(string runtimeRoot)
    {
        var assembly = Assembly.GetExecutingAssembly();
        foreach (var resourceName in assembly.GetManifestResourceNames())
        {
            var relativePath = TryMapResourceToRelativePath(resourceName);
            if (relativePath is null)
            {
                continue;
            }

            var destinationPath = Path.Combine(runtimeRoot, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(destinationPath)!);

            using var stream = assembly.GetManifestResourceStream(resourceName);
            if (stream is null)
            {
                continue;
            }

            using var output = File.Create(destinationPath);
            stream.CopyTo(output);
        }
    }

    private static string? TryMapResourceToRelativePath(string resourceName)
    {
        var normalized = resourceName.Replace('\\', '/').TrimStart('/');

        if (normalized.Equals("node.exe", StringComparison.OrdinalIgnoreCase))
        {
            return "node.exe";
        }

        if (normalized.Equals("server.mjs", StringComparison.OrdinalIgnoreCase))
        {
            return "server.mjs";
        }

        if (normalized.Equals("libraryjs.html", StringComparison.OrdinalIgnoreCase))
        {
            return "libraryjs.html";
        }

        if (normalized.StartsWith("site/", StringComparison.OrdinalIgnoreCase))
        {
            return normalized;
        }

        return null;
    }

    private void SetStartupRegistration(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run", true)
            ?? throw new InvalidOperationException("Could not open the Windows startup registry key.");

        var command = $"\"{GetCurrentExecutablePath()}\"";
        if (enabled)
        {
            key.SetValue(StartupRunValueName, command, RegistryValueKind.String);
        }
        else
        {
            key.DeleteValue(StartupRunValueName, false);
        }
    }

    private static string GetCurrentExecutablePath()
    {
        var processPath = Environment.ProcessPath;
        if (!string.IsNullOrWhiteSpace(processPath))
        {
            return processPath;
        }

        var baseDirectory = AppContext.BaseDirectory;
        if (!string.IsNullOrWhiteSpace(baseDirectory))
        {
            var exeName = Assembly.GetEntryAssembly()?.GetName().Name;
            if (!string.IsNullOrWhiteSpace(exeName))
            {
                var candidate = Path.Combine(baseDirectory, exeName + ".exe");
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        throw new InvalidOperationException("Unable to determine the current executable path.");
    }

    private void ExitApplication()
    {
        _exitRequested = true;
        _shutdown.Cancel();
        _suppressServerExitNotifications = true;

        StopAllServers();

        try
        {
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
        }
        catch
        {
            // Ignore tray cleanup failures.
        }

        try
        {
            if (!string.IsNullOrWhiteSpace(_runtimeRoot) && Directory.Exists(_runtimeRoot))
            {
                Directory.Delete(_runtimeRoot, recursive: true);
            }
        }
        catch
        {
            // Ignore temp cleanup failures.
        }

        try
        {
            _window.Dispose();
        }
        catch
        {
            // Ignore window cleanup failures.
        }

        try
        {
            _appIcon.Dispose();
        }
        catch
        {
            // Ignore icon cleanup failures.
        }

        ExitThread();
    }

    private sealed class ManagedServerInstance
    {
        public required string FolderRoot { get; init; }
        public required int Port { get; init; }
        public required bool UseHttps { get; init; }
        public required string Url { get; init; }
        public required string HealthUrl { get; init; }
        public required Process Process { get; init; }
    }
}

internal delegate void PortRequestedEventHandler(object? sender, int port);
internal delegate void BoolSettingChangedEventHandler(object? sender, bool value);

internal sealed class MainWindow : Form
{
    private sealed class LocationRow
    {
        public required Panel Container { get; init; }
        public required TextBox FolderBox { get; init; }
        public required NumericUpDown PortBox { get; init; }
        public required CheckBox EnabledBox { get; init; }
        public required CheckBox HttpsBox { get; init; }
        public required Label HttpsStatusLabel { get; init; }
        public required Button RemoveButton { get; init; }
    }

    private readonly Label _statusLabel;
    private readonly Label _statusDetailLabel;
    private readonly Button _startButton;
    private readonly Button _exitButton;
    private readonly CheckBox _startWithWindowsCheckBox;
    private readonly CheckBox _autoStartServerCheckBox;
    private readonly CheckBox _minimizeWhenStartedCheckBox;
    private readonly CheckBox _corsEnabledCheckBox;
    private readonly FlowLayoutPanel _locationsPanel;
    private readonly Panel _contentPanel;
    private readonly Button _addLocationButton;
    private readonly Button _saveButton;
    private readonly ToolTip _toolTip = new();
    private readonly List<LocationRow> _rows = new();
    private bool _suppressSettingEvents;
    private bool _suppressLocationEvents;
    private bool _serverStarted;

    public event PortRequestedEventHandler? RequestStart;
    public event EventHandler? RequestStop;
    public event EventHandler? RequestExit;
    public event PortRequestedEventHandler? PortChanged;
    public event BoolSettingChangedEventHandler? StartWithWindowsChanged;
    public event BoolSettingChangedEventHandler? AutoStartServerChanged;
    public event BoolSettingChangedEventHandler? MinimizeWhenStartedChanged;
    public event BoolSettingChangedEventHandler? CorsEnabledChanged;
    public event EventHandler? LocationsChanged;

    public IReadOnlyList<LocationConfig> CurrentLocations => CollectLocations();
    public string SelectedFolderRoot => GetPrimaryReadyLocation()?.FolderRoot ?? string.Empty;

    public MainWindow(int defaultPort, Icon appIcon)
    {
        Text = "LibraryJS Server";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = true;
        ShowInTaskbar = true;
        ClientSize = new System.Drawing.Size(1120, 940);
        BackColor = Color.FromArgb(15, 23, 25);
        Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
        ForeColor = Color.FromArgb(240, 245, 242);
        AutoScaleMode = AutoScaleMode.Font;

        var headerPanel = new Panel
        {
            Left = 0,
            Top = 0,
            Width = ClientSize.Width,
            Height = 108,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            BackColor = Color.FromArgb(20, 32, 34),
            Padding = new Padding(20, 16, 20, 16)
        };

        var iconBox = new PictureBox
        {
            Left = 20,
            Top = 16,
            Width = 52,
            Height = 52,
            SizeMode = PictureBoxSizeMode.CenterImage,
            Image = appIcon.ToBitmap(),
            BackColor = Color.FromArgb(33, 52, 54)
        };
        iconBox.Paint += (_, e) =>
        {
            using var pen = new Pen(Color.FromArgb(64, 165, 109), 2);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            e.Graphics.DrawRectangle(pen, 1, 1, iconBox.Width - 3, iconBox.Height - 3);
        };

        var titleLabel = new Label
        {
            Left = 86,
            Top = 15,
            Width = 860,
            Height = 26,
            Text = "LibraryJS Server",
            Font = new Font(Font.FontFamily, 14F, FontStyle.Bold),
            ForeColor = Color.FromArgb(245, 248, 247)
        };

        var subtitleLabel = new Label
        {
            Left = 86,
            Top = 42,
            Width = 920,
            Height = 30,
            Text = "Choose one or more folder roots and assign a port to each one so the server can mirror multiple drives.",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        headerPanel.Controls.Add(iconBox);
        headerPanel.Controls.Add(titleLabel);
        headerPanel.Controls.Add(subtitleLabel);

        _contentPanel = new Panel
        {
            Left = 20,
            Top = 124,
            Width = ClientSize.Width - 40,
            Height = 652,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            BackColor = Color.FromArgb(20, 32, 34),
            Padding = new Padding(18)
        };

        var locationsTitle = new Label
        {
            Left = 18,
            Top = 14,
            Width = 220,
            Height = 22,
            Text = "Library locations",
            Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold),
            ForeColor = Color.FromArgb(245, 248, 247)
        };

        var locationsHint = new Label
        {
            Left = 18,
            Top = 38,
            Width = 900,
            Height = 22,
            Text = "Each location needs a folder root and a port. You can add as many as you need.",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        _locationsPanel = new FlowLayoutPanel
        {
            Left = 18,
            Top = 68,
            Width = _contentPanel.ClientSize.Width - 36,
            Height = 330,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
            FlowDirection = FlowDirection.TopDown,
            WrapContents = false,
            AutoScroll = true,
            BackColor = Color.FromArgb(18, 29, 31),
            Padding = new Padding(6)
        };

        _addLocationButton = CreateActionButton("Add location", 18, 410, 154, Color.FromArgb(46, 62, 63));
        _addLocationButton.Click += (_, _) =>
        {
            AddLocationRow(new LocationConfig { FolderRoot = string.Empty, Port = defaultPort, Enabled = true });
            EmitLocationEvents();
        };

        _saveButton = CreateActionButton("Save locations", 182, 410, 162, Color.FromArgb(64, 165, 109));
        _saveButton.Click += (_, _) => EmitLocationEvents();

        var startupTitle = new Label
        {
            Left = 18,
            Top = 458,
            Width = 220,
            Height = 22,
            Text = "Startup options",
            Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold),
            ForeColor = Color.FromArgb(245, 248, 247)
        };

        _startWithWindowsCheckBox = new CheckBox
        {
            Left = 18,
            Top = 494,
            Width = 740,
            Height = 30,
            Text = "Start LibraryJS Server when Windows starts",
            ForeColor = Color.FromArgb(240, 245, 242),
            FlatStyle = FlatStyle.Flat,
            AutoSize = false
        };
        _startWithWindowsCheckBox.FlatAppearance.BorderColor = Color.FromArgb(64, 165, 109);
        _startWithWindowsCheckBox.CheckedChanged += (_, _) =>
        {
            if (_suppressSettingEvents) return;
            StartWithWindowsChanged?.Invoke(this, _startWithWindowsCheckBox.Checked);
        };

        _autoStartServerCheckBox = new CheckBox
        {
            Left = 18,
            Top = 532,
            Width = 740,
            Height = 36,
            Text = "Start the server automatically when LibraryJS Server opens",
            ForeColor = Color.FromArgb(240, 245, 242),
            FlatStyle = FlatStyle.Flat,
            AutoSize = false
        };
        _autoStartServerCheckBox.FlatAppearance.BorderColor = Color.FromArgb(64, 165, 109);
        _autoStartServerCheckBox.CheckedChanged += (_, _) =>
        {
            if (_suppressSettingEvents) return;
            AutoStartServerChanged?.Invoke(this, _autoStartServerCheckBox.Checked);
        };

        _minimizeWhenStartedCheckBox = new CheckBox
        {
            Left = 18,
            Top = 570,
            Width = 740,
            Height = 30,
            Text = "Minimized when Started",
            ForeColor = Color.FromArgb(240, 245, 242),
            FlatStyle = FlatStyle.Flat,
            AutoSize = false
        };
        _minimizeWhenStartedCheckBox.FlatAppearance.BorderColor = Color.FromArgb(64, 165, 109);
        _minimizeWhenStartedCheckBox.CheckedChanged += (_, _) =>
        {
            if (_suppressSettingEvents) return;
            MinimizeWhenStartedChanged?.Invoke(this, _minimizeWhenStartedCheckBox.Checked);
        };

        _corsEnabledCheckBox = new CheckBox
        {
            Left = 18,
            Top = 608,
            Width = 740,
            Height = 34,
            Text = "Enable CORS for browser downloads and uploads (always on)",
            ForeColor = Color.FromArgb(240, 245, 242),
            FlatStyle = FlatStyle.Flat,
            AutoSize = false,
            Checked = true
        };
        _corsEnabledCheckBox.FlatAppearance.BorderColor = Color.FromArgb(64, 165, 109);
        _corsEnabledCheckBox.CheckedChanged += (_, _) =>
        {
            if (_suppressSettingEvents) return;
            if (!_corsEnabledCheckBox.Checked)
            {
                _suppressSettingEvents = true;
                try
                {
                    _corsEnabledCheckBox.Checked = true;
                }
                finally
                {
                    _suppressSettingEvents = false;
                }
            }
            CorsEnabledChanged?.Invoke(this, true);
        };

        var startupHint = new Label
        {
            Left = 18,
            Top = 650,
            Width = 760,
            Height = 34,
            Text = "Location changes are saved automatically. Check Use HTTPS to serve a location over https with an automatically generated local certificate.",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        _contentPanel.Controls.Add(locationsTitle);
        _contentPanel.Controls.Add(locationsHint);
        _contentPanel.Controls.Add(_locationsPanel);
        _contentPanel.Controls.Add(_addLocationButton);
        _contentPanel.Controls.Add(_saveButton);
        _contentPanel.Controls.Add(startupTitle);
        _contentPanel.Controls.Add(_startWithWindowsCheckBox);
        _contentPanel.Controls.Add(_autoStartServerCheckBox);
        _contentPanel.Controls.Add(_minimizeWhenStartedCheckBox);
        _contentPanel.Controls.Add(_corsEnabledCheckBox);
        _contentPanel.Controls.Add(startupHint);

        var buttonPanel = new Panel
        {
            Left = 20,
            Top = 858,
            Width = ClientSize.Width - 40,
            Height = 42,
            Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
            BackColor = Color.Transparent
        };

        _startButton = CreateActionButton("Start server", 840, 0, 160, Color.FromArgb(64, 165, 109));
        _startButton.Click += (_, _) =>
        {
            if (_serverStarted)
            {
                RequestStop?.Invoke(this, EventArgs.Empty);
                return;
            }

            var primary = GetPrimaryReadyLocation();
            if (primary is null)
            {
                SetStatus("Add at least one enabled location with both a folder root and a port.");
                SetStatusDetail("The server needs a valid location before it can start.");
                return;
            }

            RequestStart?.Invoke(this, primary.Port);
        };

        _exitButton = CreateActionButton("Exit", 1010, 0, 80, Color.FromArgb(46, 62, 63));
        _exitButton.Click += (_, _) => RequestExit?.Invoke(this, EventArgs.Empty);

        buttonPanel.Controls.Add(_startButton);
        buttonPanel.Controls.Add(_exitButton);

        _statusLabel = new Label
        {
            Left = 20,
            Top = 798,
            Width = ClientSize.Width - 40,
            Height = 18,
            Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
            Text = "Ready to start.",
            ForeColor = Color.FromArgb(240, 245, 242)
        };

        _statusDetailLabel = new Label
        {
            Left = 20,
            Top = 824,
            Width = ClientSize.Width - 40,
            Height = 18,
            Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
            Text = "The app will stay in the system tray once the server is running.",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        Controls.Add(headerPanel);
        Controls.Add(_contentPanel);
        Controls.Add(_statusLabel);
        Controls.Add(_statusDetailLabel);
        Controls.Add(buttonPanel);

        AddLocationRow(new LocationConfig { Port = defaultPort, Enabled = true });
        UpdateNotice();
        RefreshHttpsCertificateIndicators();
    }

    public void SetStatus(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetStatus(text)));
            return;
        }

        _statusLabel.Text = text;
    }

    public void SetStatusDetail(string text)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetStatusDetail(text)));
            return;
        }

        _statusDetailLabel.Text = text;
    }

    public void SetUiEnabled(bool enabled)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetUiEnabled(enabled)));
            return;
        }

        _contentPanel.Enabled = enabled;
        foreach (var row in _rows)
        {
            row.Container.Enabled = enabled;
        }
        _startButton.Enabled = _serverStarted || enabled;
        _addLocationButton.Enabled = enabled;
        _saveButton.Enabled = enabled;
    }

    public void SetStartButtonState(bool started)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetStartButtonState(started)));
            return;
        }

        _serverStarted = started;
        _startButton.Text = started ? "Stop server" : "Start server";
        _startButton.Enabled = started || _contentPanel.Enabled;
    }

    public void SetStartupOptions(bool startWithWindows, bool autoStartServer, bool minimizeWhenStarted, bool corsEnabled)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetStartupOptions(startWithWindows, autoStartServer, minimizeWhenStarted, corsEnabled)));
            return;
        }

        _suppressSettingEvents = true;
        try
        {
            _startWithWindowsCheckBox.Checked = startWithWindows;
            _autoStartServerCheckBox.Checked = autoStartServer;
            _minimizeWhenStartedCheckBox.Checked = minimizeWhenStarted;
            _corsEnabledCheckBox.Checked = corsEnabled;
        }
        finally
        {
            _suppressSettingEvents = false;
        }
    }

    public void SetStartupOptionSilently(bool startWithWindows)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetStartupOptionSilently(startWithWindows)));
            return;
        }

        _suppressSettingEvents = true;
        try
        {
            _startWithWindowsCheckBox.Checked = startWithWindows;
        }
        finally
        {
            _suppressSettingEvents = false;
        }
    }

    public void SetLocations(IEnumerable<LocationConfig> locations)
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(() => SetLocations(locations)));
            return;
        }

        _suppressLocationEvents = true;
        try
        {
            _locationsPanel.SuspendLayout();
            _locationsPanel.Controls.Clear();
            _rows.Clear();

            var source = locations?.ToList() ?? new List<LocationConfig>();
            if (source.Count == 0)
            {
                source.Add(new LocationConfig { Enabled = true });
            }

            foreach (var location in source)
            {
                AddLocationRow(location, emitEvents: false);
            }
        }
        finally
        {
            _locationsPanel.ResumeLayout();
            _suppressLocationEvents = false;
        }

        UpdateNotice();
    }

    private void AddLocationRow(LocationConfig config, bool emitEvents = true)
    {
        var rowIndex = _rows.Count + 1;
        var container = new Panel
        {
            Width = _locationsPanel.ClientSize.Width - 30,
            Height = 156,
            BackColor = Color.FromArgb(15, 25, 27),
            Margin = new Padding(0, 0, 0, 10),
            Padding = new Padding(12)
        };

        var title = new Label
        {
            Left = 12,
            Top = 10,
            Width = 180,
            Height = 22,
            Text = $"Location {rowIndex}",
            Font = new Font(Font.FontFamily, 10F, FontStyle.Bold),
            ForeColor = Color.FromArgb(245, 248, 247)
        };

        var enabledBox = new CheckBox
        {
            Left = 820,
            Top = 10,
            Width = 150,
            Height = 24,
            Text = "Enabled",
            Checked = config.Enabled,
            ForeColor = Color.FromArgb(240, 245, 242),
            FlatStyle = FlatStyle.Flat,
            AutoSize = false
        };
        enabledBox.FlatAppearance.BorderColor = Color.FromArgb(64, 165, 109);

        var folderLabel = new Label
        {
            Left = 12,
            Top = 40,
            Width = 90,
            Height = 20,
            Text = "Folder root",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        var folderBox = new TextBox
        {
            Left = 12,
            Top = 62,
            Width = 720,
            Text = config.FolderRoot ?? string.Empty,
            BackColor = Color.FromArgb(14, 24, 26),
            ForeColor = Color.FromArgb(240, 245, 242),
            BorderStyle = BorderStyle.FixedSingle
        };

        var browseButton = CreateActionButton("Browse…", 744, 60, 92, Color.FromArgb(46, 62, 63));

        var portLabel = new Label
        {
            Left = 12,
            Top = 96,
            Width = 80,
            Height = 20,
            Text = "Port",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        var portBox = new NumericUpDown
        {
            Left = 12,
            Top = 118,
            Width = 110,
            Minimum = 1,
            Maximum = 65535,
            Value = PortUtil.ClampPort(config.Port),
            BorderStyle = BorderStyle.FixedSingle,
            BackColor = Color.FromArgb(14, 24, 26),
            ForeColor = Color.FromArgb(240, 245, 242)
        };

        var httpsBox = new CheckBox
        {
            Left = 140,
            Top = 117,
            Width = 180,
            Height = 24,
            Text = "Use HTTPS",
            Checked = config.UseHttps,
            ForeColor = Color.FromArgb(240, 245, 242),
            FlatStyle = FlatStyle.Flat,
            AutoSize = false
        };
        httpsBox.FlatAppearance.BorderColor = Color.FromArgb(64, 165, 109);

        var httpsStatusLabel = new Label
        {
            Left = 330,
            Top = 118,
            Width = 360,
            Height = 22,
            Text = config.UseHttps ? "🔒 Certificate pending" : "HTTPS off",
            ForeColor = Color.FromArgb(148, 163, 184)
        };

        var removeButton = CreateActionButton("Remove", 972, 116, 84, Color.FromArgb(46, 62, 63));

        browseButton.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog
            {
                Description = "Choose a LibraryJS folder root",
                UseDescriptionForTitle = true,
                ShowNewFolderButton = false,
                SelectedPath = string.IsNullOrWhiteSpace(folderBox.Text) ? Environment.GetFolderPath(Environment.SpecialFolder.Desktop) : folderBox.Text
            };

            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                folderBox.Text = dialog.SelectedPath;
                EmitLocationEvents();
            }
        };

        folderBox.TextChanged += (_, _) => EmitLocationEvents();
        portBox.ValueChanged += (_, _) => EmitLocationEvents();
        enabledBox.CheckedChanged += (_, _) => EmitLocationEvents();
        httpsBox.CheckedChanged += (_, _) =>
        {
            EmitLocationEvents();

            if (!AnyLocationUsesHttps())
            {
                HttpsCertificateStore.DeleteCertificateFiles();
            }

            RefreshHttpsCertificateIndicators();
        };
        removeButton.Click += (_, _) =>
        {
            if (_rows.Count <= 1)
            {
                MessageBox.Show(this, "At least one location should remain.", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            _rows.RemoveAll(r => ReferenceEquals(r.Container, container));
            _locationsPanel.Controls.Remove(container);
            container.Dispose();
            ReindexRows();
            EmitLocationEvents();
        };

        container.Controls.Add(title);
        container.Controls.Add(enabledBox);
        container.Controls.Add(folderLabel);
        container.Controls.Add(folderBox);
        container.Controls.Add(browseButton);
        container.Controls.Add(portLabel);
        container.Controls.Add(portBox);
        container.Controls.Add(httpsBox);
        container.Controls.Add(httpsStatusLabel);
        container.Controls.Add(removeButton);

        _locationsPanel.Controls.Add(container);
        _rows.Add(new LocationRow
        {
            Container = container,
            FolderBox = folderBox,
            PortBox = portBox,
            EnabledBox = enabledBox,
            HttpsBox = httpsBox,
            HttpsStatusLabel = httpsStatusLabel,
            RemoveButton = removeButton
        });
        RefreshHttpsCertificateIndicators();

        if (_suppressLocationEvents || !emitEvents)
        {
            return;
        }

        EmitLocationEvents();
    }

    private void ReindexRows()
    {
        for (var i = 0; i < _rows.Count; i++)
        {
            var title = _rows[i].Container.Controls.OfType<Label>().FirstOrDefault(label => label.Font.Bold);
            if (title is not null)
            {
                title.Text = $"Location {i + 1}";
            }
        }
    }

    private List<LocationConfig> CollectLocations()
    {
        var locations = new List<LocationConfig>();
        foreach (var row in _rows)
        {
            locations.Add(new LocationConfig
            {
                FolderRoot = row.FolderBox.Text.Trim(),
                Port = PortUtil.ClampPort((int)row.PortBox.Value),
                Enabled = row.EnabledBox.Checked,
                UseHttps = row.HttpsBox.Checked
            });
        }

        return locations;
    }

    private LocationConfig? GetPrimaryReadyLocation()
    {
        return CollectLocations().FirstOrDefault(location =>
            location.Enabled &&
            !string.IsNullOrWhiteSpace(location.FolderRoot) &&
            location.Port > 0);
    }

    private void EmitLocationEvents()
    {
        if (_suppressLocationEvents)
        {
            return;
        }

        if (InvokeRequired)
        {
            BeginInvoke(new Action(EmitLocationEvents));
            return;
        }

        UpdateNotice();
        RefreshHttpsCertificateIndicators();
        LocationsChanged?.Invoke(this, EventArgs.Empty);

        var primary = GetPrimaryReadyLocation();
        if (primary is not null)
        {
            PortChanged?.Invoke(this, primary.Port);
        }
    }

    private void UpdateNotice()
    {
        var ready = CollectLocations().Count(location =>
            location.Enabled &&
            !string.IsNullOrWhiteSpace(location.FolderRoot) &&
            location.Port > 0);

        if (ready == 0)
        {
            _statusDetailLabel.Text = "Choose a folder root and port for at least one enabled location.";
        }
        else
        {
            _statusDetailLabel.Text = $"{ready} enabled location(s) are ready to start.";
        }
    }

    private bool AnyLocationUsesHttps()
    {
        return _rows.Any(row => row.HttpsBox.Checked);
    }

    internal void RefreshHttpsCertificateIndicators()
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(RefreshHttpsCertificateIndicators));
            return;
        }

        HttpsCertificateStatus? certificate = HttpsCertificateStore.TryGetCertificateStatus();

        foreach (var row in _rows)
        {
            if (!row.HttpsBox.Checked)
            {
                row.HttpsStatusLabel.Text = "HTTPS off";
                row.HttpsStatusLabel.ForeColor = Color.FromArgb(148, 163, 184);
                row.HttpsStatusLabel.Tag = null;
                _toolTip.SetToolTip(row.HttpsStatusLabel, "HTTPS is not enabled for this location.");
                continue;
            }

            if (certificate is not null && certificate.IsReady)
            {
                row.HttpsStatusLabel.Text = $"🔒 Cert saved · expires {certificate.ExpiresOn:yyyy-MM-dd}";
                row.HttpsStatusLabel.ForeColor = Color.FromArgb(134, 239, 172);
                row.HttpsStatusLabel.Tag = $"{certificate.CertPath}\n{certificate.KeyPath}";
                _toolTip.SetToolTip(row.HttpsStatusLabel, $"Saved certificate\nExpires: {certificate.ExpiresOn:yyyy-MM-dd}\n{certificate.CertPath}");
            }
            else
            {
                row.HttpsStatusLabel.Text = "⏳ Certificate will be created on start";
                row.HttpsStatusLabel.ForeColor = Color.FromArgb(248, 191, 94);
                row.HttpsStatusLabel.Tag = null;
                _toolTip.SetToolTip(row.HttpsStatusLabel, "The certificate will be created automatically when HTTPS starts.");
            }
        }
    }

    private Button CreateActionButton(string text, int left, int top, int width, Color backColor)
    {
        return new Button
        {
            Left = left,
            Top = top,
            Width = width,
            Height = 32,
            Text = text,
            BackColor = backColor,
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            UseVisualStyleBackColor = false
        };
    }
}

internal sealed class HttpsCertificateStatus
{
    public required string CertPath { get; init; }
    public required string KeyPath { get; init; }
    public required string CerPath { get; init; }
    public required DateTimeOffset ExpiresOn { get; init; }
    public required string DirectoryPath { get; init; }
    public bool WasGenerated { get; init; }
    public bool IsReady => File.Exists(CertPath) && File.Exists(KeyPath);
}

internal static class HttpsCertificateStore
{
    private const int RenewalWindowDays = 60;
    private const int ValidityYears = 10;

    public static string CertificateDirectory =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LibraryJSServer", "Https");

    public static HttpsCertificateStatus? TryGetCertificateStatus()
    {
        var certPath = Path.Combine(CertificateDirectory, "libraryjs-https-cert.pem");
        var cerPath = Path.Combine(CertificateDirectory, "libraryjs-https-cert.cer");
        var keyPath = Path.Combine(CertificateDirectory, "libraryjs-https-key.pem");
        if (!File.Exists(certPath) || !File.Exists(keyPath))
        {
            return null;
        }

        try
        {
            using var certificate = X509Certificate2.CreateFromPemFile(certPath, keyPath);
            return new HttpsCertificateStatus
            {
                CertPath = certPath,
                KeyPath = keyPath,
                CerPath = cerPath,
                DirectoryPath = CertificateDirectory,
                ExpiresOn = new DateTimeOffset(certificate.NotAfter.ToUniversalTime()),
                WasGenerated = false
            };
        }
        catch
        {
            return null;
        }
    }

    public static void TrustCertificate(HttpsCertificateStatus? status)
    {
        if (status is null || !File.Exists(status.CerPath))
        {
            return;
        }

        try
        {
            using var cert = new X509Certificate2(File.ReadAllBytes(status.CerPath));
            using var store = new X509Store(StoreName.Root, StoreLocation.CurrentUser);
            store.Open(OpenFlags.ReadWrite);

            var existing = store.Certificates.Find(X509FindType.FindByThumbprint, cert.Thumbprint, validOnly: false);
            if (existing.Count == 0)
            {
                store.Add(cert);
            }
        }
        catch
        {
            // Best-effort trust only; the server can still run even if trust import fails.
        }
    }

    public static void DeleteCertificateFiles()
    {
        var certPath = Path.Combine(CertificateDirectory, "libraryjs-https-cert.pem");
        var cerPath = Path.Combine(CertificateDirectory, "libraryjs-https-cert.cer");
        var keyPath = Path.Combine(CertificateDirectory, "libraryjs-https-key.pem");

        try
        {
            if (File.Exists(certPath))
            {
                File.Delete(certPath);
            }

            if (File.Exists(cerPath))
            {
                File.Delete(cerPath);
            }
        }
        catch
        {
            // Best-effort cleanup only.
        }

        try
        {
            if (File.Exists(keyPath))
            {
                File.Delete(keyPath);
            }
        }
        catch
        {
            // Best-effort cleanup only.
        }
    }

    public static HttpsCertificateStatus EnsureCertificateFiles()
    {
        Directory.CreateDirectory(CertificateDirectory);

        var certPath = Path.Combine(CertificateDirectory, "libraryjs-https-cert.pem");
        var cerPath = Path.Combine(CertificateDirectory, "libraryjs-https-cert.cer");
        var keyPath = Path.Combine(CertificateDirectory, "libraryjs-https-key.pem");

        if (File.Exists(certPath) && File.Exists(keyPath))
        {
            try
            {
                using var existing = X509Certificate2.CreateFromPemFile(certPath, keyPath);
                var expiresOn = new DateTimeOffset(existing.NotAfter.ToUniversalTime());
                if (expiresOn > DateTimeOffset.UtcNow.AddDays(RenewalWindowDays))
                {
                    return new HttpsCertificateStatus
                    {
                        CertPath = certPath,
                        KeyPath = keyPath,
                        CerPath = cerPath,
                        DirectoryPath = CertificateDirectory,
                        ExpiresOn = expiresOn,
                        WasGenerated = false
                    };
                }
            }
            catch
            {
                // Rebuild below.
            }
        }

        using var rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            $"CN={Environment.MachineName}",
            rsa,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);

        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature | X509KeyUsageFlags.KeyEncipherment, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection
        {
            new Oid("1.3.6.1.5.5.7.3.1")
        }, false));

        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("localhost");
        san.AddIpAddress(IPAddress.Loopback);
        san.AddIpAddress(IPAddress.IPv6Loopback);
        san.AddDnsName(Environment.MachineName);

        try
        {
            foreach (var ip in Dns.GetHostEntry(Dns.GetHostName()).AddressList)
            {
                if (IPAddress.IsLoopback(ip))
                {
                    continue;
                }

                if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
                {
                    san.AddIpAddress(ip);
                }
            }
        }
        catch
        {
            // Best-effort only.
        }

        request.CertificateExtensions.Add(san.Build());

        using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(ValidityYears));
        File.WriteAllText(certPath, certificate.ExportCertificatePem(), Encoding.UTF8);
        File.WriteAllBytes(cerPath, certificate.Export(X509ContentType.Cert));
        File.WriteAllText(keyPath, rsa.ExportPkcs8PrivateKeyPem(), Encoding.UTF8);

        return new HttpsCertificateStatus
        {
            CertPath = certPath,
            KeyPath = keyPath,
            CerPath = cerPath,
            DirectoryPath = CertificateDirectory,
            ExpiresOn = new DateTimeOffset(certificate.NotAfter.ToUniversalTime()),
            WasGenerated = true
        };
    }
}

internal sealed class LocationConfig
{
    public string FolderRoot { get; set; } = string.Empty;
    public int Port { get; set; } = 60064;
    public bool Enabled { get; set; } = true;
    public bool UseHttps { get; set; }
}

internal sealed class AppSettings
{
    public int Port { get; set; } = 60064;
    public bool StartWithWindows { get; set; }
    public bool AutoStartServerOnLaunch { get; set; }
    public bool MinimizeWhenStarted { get; set; }
    public bool CorsEnabled { get; set; } = true;
    public List<LocationConfig> Locations { get; set; } = new();
}

internal sealed class AppSettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true
    };

    private AppSettingsStore(AppSettings settings, string path)
    {
        Settings = settings;
        Path = path;
    }

    public AppSettings Settings { get; }
    public string Path { get; }

    public int Port
    {
        get
        {
            var primary = Settings.Locations.FirstOrDefault(location => location.Enabled && !string.IsNullOrWhiteSpace(location.FolderRoot) && location.Port > 0)
                         ?? Settings.Locations.FirstOrDefault();
            if (primary is not null)
            {
                return PortUtil.ClampPort(primary.Port);
            }

            return PortUtil.ClampPort(Settings.Port);
        }
        set
        {
            var port = PortUtil.ClampPort(value);
            Settings.Port = port;
            EnsurePrimaryLocation().Port = port;
        }
    }

    public bool StartWithWindows
    {
        get => Settings.StartWithWindows;
        set => Settings.StartWithWindows = value;
    }

    public bool AutoStartServerOnLaunch
    {
        get => Settings.AutoStartServerOnLaunch;
        set => Settings.AutoStartServerOnLaunch = value;
    }

    public bool MinimizeWhenStarted
    {
        get => Settings.MinimizeWhenStarted;
        set => Settings.MinimizeWhenStarted = value;
    }

    public bool CorsEnabled
    {
        get => Settings.CorsEnabled;
        set => Settings.CorsEnabled = value;
    }

    public static AppSettingsStore Load()
    {
        var path = GetPath();
        try
        {
            if (File.Exists(path))
            {
                var json = File.ReadAllText(path);
                var settings = JsonSerializer.Deserialize<AppSettings>(json) ?? new AppSettings { CorsEnabled = true };
                settings.Port = PortUtil.ClampPort(settings.Port);
                settings.CorsEnabled = true;
                settings.Locations ??= new List<LocationConfig>();
                settings.Locations = NormalizeLocations(settings);
                return new AppSettingsStore(settings, path);
            }
        }
        catch
        {
            // Ignore corrupted settings and fall back to defaults.
        }

        var fallback = new AppSettings { CorsEnabled = true };
        fallback.Locations = NormalizeLocations(fallback);
        return new AppSettingsStore(fallback, path);
    }

    public void Save()
    {
        var dir = System.IO.Path.GetDirectoryName(Path);
        if (!string.IsNullOrWhiteSpace(dir))
        {
            Directory.CreateDirectory(dir);
        }

        if (Settings.Locations is null || Settings.Locations.Count == 0)
        {
            Settings.Locations = NormalizeLocations(Settings);
        }

        Settings.Port = PortUtil.ClampPort(Settings.Port);
        var json = JsonSerializer.Serialize(Settings, JsonOptions);
        File.WriteAllText(Path, json, Encoding.UTF8);
    }

    private LocationConfig EnsurePrimaryLocation()
    {
        Settings.Locations ??= new List<LocationConfig>();
        if (Settings.Locations.Count == 0)
        {
            Settings.Locations.Add(new LocationConfig { Port = PortUtil.ClampPort(Settings.Port), Enabled = true });
        }

        return Settings.Locations[0];
    }

    private static List<LocationConfig> NormalizeLocations(AppSettings settings)
    {
        var list = new List<LocationConfig>();
        if (settings.Locations is not null)
        {
            foreach (var location in settings.Locations)
            {
                list.Add(new LocationConfig
                {
                    FolderRoot = location?.FolderRoot?.Trim() ?? string.Empty,
                    Port = PortUtil.ClampPort(location?.Port ?? settings.Port),
                    Enabled = location?.Enabled ?? true,
                    UseHttps = location?.UseHttps ?? false
                });
            }
        }

        if (list.Count == 0)
        {
            list.Add(new LocationConfig
            {
                FolderRoot = string.Empty,
                Port = PortUtil.ClampPort(settings.Port),
                Enabled = true
            });
        }

        settings.Port = PortUtil.ClampPort(settings.Port);
        return list;
    }

    private static string GetPath()
    {
        var root = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return System.IO.Path.Combine(root, "LibraryJS Server", "settings.json");
    }
}
