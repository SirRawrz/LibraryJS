using System.Diagnostics;
using System.Drawing;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Sockets;
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

internal sealed record ActiveEndpointLink(string DisplayText, string Url);
internal sealed record ActiveEndpointGroup(string Title, IReadOnlyList<ActiveEndpointLink> Links);
internal sealed record TemporaryUsbLaunchOptions(string FolderRoot, int Port);

internal sealed class LibraryJSServerContext : ApplicationContext
{
    private const string StartupRunValueName = "LibraryJS Server";

    private readonly NotifyIcon _trayIcon;
    private readonly MainWindow _window;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Icon _appIcon;
    private readonly AppSettingsStore _settings = AppSettingsStore.Load();

    private readonly List<ManagedServerInstance> _servers = new();
    private ManagedServerInstance? _temporaryUsbServer;
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
        _window.RequestInstallLibraryJs += (_, _) => OpenLibraryJsInstaller();
        _window.RequestTemporaryUsb += async (_, _) => await ToggleTemporaryUsbAsync();
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
        try
        {
            SetStartupRegistration(_settings.StartWithWindows);
        }
        catch
        {
            // Keep the app usable even if the registry write is blocked.
        }
        _window.SetLocations(_settings.Settings.Locations);
        _window.SetActiveEndpoints(Array.Empty<ActiveEndpointGroup>());
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
        _window.SetStatusDetail(string.Empty);
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

        CleanupLegacyRuntimeFolders();

        try
        {
            _runtimeRoot = GetRuntimeRoot();

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
            var locationIndex = 0;
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
                    Process = process,
                    Title = locationIndex == 0 ? "Main Server" : $"Expanded {locationIndex}",
                    IsTemporary = false
                };
                _servers.Add(instance);
                _serverUrl ??= instance.Url;
                process.Exited += (_, _) => HandleServerExited(instance);
                startupTasks.Add(WaitForServerAsync(instance.HealthUrl, instance.UseHttps, _shutdown.Token));
                locationIndex++;
            }

            await Task.WhenAll(startupTasks).ConfigureAwait(true);

            _serverRunning = true;
            _suppressServerExitNotifications = false;
            WriteStartupMetadataFiles(locations);
            _window.SetStartButtonState(true);
            UpdateActiveEndpoints();
            _window.SetStatus($"{locations.Count} location server(s) are running.");
            _window.SetStatusDetail(httpsCertificate is not null
                ? $"HTTPS certificate saved at {HttpsCertificateStore.CertificateDirectory}. Expires {httpsCertificate.ExpiresOn:yyyy-MM-dd}."
                : string.Empty);

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
            _window.SetActiveEndpoints(Array.Empty<ActiveEndpointGroup>());
            _window.SetStatus("Startup failed.");
            _window.SetStatusDetail(string.Empty);
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
        _temporaryUsbServer = null;
        _window.SetTemporaryUsbActive(false);
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
            _window.SetActiveEndpoints(Array.Empty<ActiveEndpointGroup>());
            _window.SetStartButtonState(false);
            _window.SetUiEnabled(true);
            _window.SetStatus("Server stopped.");
            _window.SetStatusDetail(string.Empty);
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

    private void OpenLibraryJsInstaller()
    {
        var url = Environment.GetEnvironmentVariable("LIBRARYJS_INSTALL_URL");
        if (string.IsNullOrWhiteSpace(url))
        {
            url = "https://github.com/search?q=HostedByServer&type=repositories";
        }

        try
        {
            Process.Start(new ProcessStartInfo(url)
            {
                UseShellExecute = true
            });
            _window.SetStatus("Opened the LibraryJS install page.");
        }
        catch (Exception ex)
        {
            _window.SetStatus("Unable to open the LibraryJS install page.");
            MessageBox.Show(_window, ex.Message, "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task ToggleTemporaryUsbAsync()
    {
        if (_temporaryUsbServer is not null)
        {
            StopTemporaryUsbServer();
            return;
        }

        var suggestedPort = FindTemporaryUsbPort(_servers.Select(server => server.Port).ToHashSet()) ?? Math.Min(65535, Math.Max(1024, _settings.Port + 1));
        var prompt = _window.PromptTemporaryUsbLaunch(_window.SelectedFolderRoot, suggestedPort);
        if (prompt is null)
        {
            return;
        }

        await StartTemporaryUsbServerAsync(prompt.FolderRoot, prompt.Port).ConfigureAwait(true);
    }

    private async Task StartTemporaryUsbServerAsync(string folderRoot, int port)
    {
        if (_startupInProgress)
        {
            return;
        }

        if (_temporaryUsbServer is not null)
        {
            _window.SetStatus("Temporary USB is already running.");
            return;
        }

        var normalizedFolderRoot = (folderRoot ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(normalizedFolderRoot))
        {
            _window.SetStatus("Choose a valid folder root for Temporary USB.");
            MessageBox.Show(_window, "Please choose a folder root for Temporary USB.", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        folderRoot = Path.GetFullPath(normalizedFolderRoot);
        if (!Directory.Exists(folderRoot))
        {
            _window.SetStatus("Choose a valid folder root for Temporary USB.");
            MessageBox.Show(_window, $"Folder root does not exist:\n{folderRoot}", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        port = PortUtil.ClampPort(port);
        var usedPorts = _servers.Select(server => server.Port).ToHashSet();
        if (usedPorts.Contains(port))
        {
            _window.SetStatus($"Port {port} is already in use.");
            MessageBox.Show(_window, $"Port {port} is already being used by another LibraryJS server.", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        if (!IsPortAvailable(port))
        {
            _window.SetStatus($"Port {port} is not available.");
            MessageBox.Show(_window, $"Port {port} is not available right now.", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        await EnsureRuntimeReadyAsync(false).ConfigureAwait(true);

        var healthUrl = $"http://127.0.0.1:{port}/api/health";
        var browseUrl = $"http://127.0.0.1:{port}/?I";

        try
        {
            _window.SetStatus($"Starting Temporary USB on port {port} for {folderRoot}...");
            var process = StartServer(_runtimeRoot ?? GetRuntimeRoot(), port, folderRoot, false, null, null);
            var instance = new ManagedServerInstance
            {
                FolderRoot = folderRoot,
                Port = port,
                UseHttps = false,
                Url = browseUrl,
                HealthUrl = healthUrl,
                Process = process,
                Title = "Temporary USB",
                IsTemporary = true
            };

            _temporaryUsbServer = instance;
            _servers.Add(instance);
            process.Exited += (_, _) => HandleServerExited(instance);

            await WaitForServerAsync(instance.HealthUrl, instance.UseHttps, _shutdown.Token).ConfigureAwait(true);

            _window.SetTemporaryUsbActive(true);
            UpdateActiveEndpoints();
            _window.SetStatus($"Temporary USB Server at {folderRoot} on Port {port} is running.");
            _window.SetStatusDetail($"Temporary USB Server: {browseUrl}");
        }
        catch (Exception ex)
        {
            StopTemporaryUsbServer();
            _window.SetTemporaryUsbActive(false);
            _window.SetStatus("Temporary USB failed to start.");
            MessageBox.Show(_window, ex.Message, "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private void StopTemporaryUsbServer()
    {
        var temp = _temporaryUsbServer;
        if (temp is null)
        {
            return;
        }

        _temporaryUsbServer = null;
        _servers.RemoveAll(server => ReferenceEquals(server, temp));

        try
        {
            if (!temp.Process.HasExited)
            {
                temp.Process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Ignore process cleanup failures during intentional removal.
        }

        try
        {
            temp.Process.Dispose();
        }
        catch
        {
            // Ignore process cleanup failures during intentional removal.
        }

        _window.SetTemporaryUsbActive(false);
        UpdateActiveEndpoints();
        _window.SetStatus($"Temporary USB Port at Destination {temp.FolderRoot} and Port {temp.Port} has been Removed.");
        _window.SetStatusDetail(string.Empty);
    }

    private void HandleServerExited(ManagedServerInstance instance)
    {
        if (_exitRequested || _startupInProgress || _suppressServerExitNotifications)
        {
            return;
        }

        try
        {
            _window.BeginInvoke(new Action(() =>
            {
                if (instance.IsTemporary && !_servers.Contains(instance))
                {
                    return;
                }

                var runningCount = _servers.Count(server => !server.Process.HasExited);
                if (instance.IsTemporary)
                {
                    _temporaryUsbServer = null;
                    _servers.RemoveAll(server => ReferenceEquals(server, instance));
                    _window.SetTemporaryUsbActive(false);
                    UpdateActiveEndpoints();
                    _window.SetStatus("Temporary USB server stopped unexpectedly.");
                    _window.SetStatusDetail(runningCount > 0
                        ? $"{runningCount} other LibraryJS server(s) are still running."
                        : string.Empty);
                    MessageBox.Show(_window, "Temporary USB server stopped unexpectedly.", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                if (runningCount == 0)
                {
                    _serverRunning = false;
                    UpdateActiveEndpoints();
                    _window.SetStartButtonState(false);
                    _window.SetUiEnabled(true);
                    _window.SetStatus("All local servers stopped.");
                    MessageBox.Show(_window, "All local LibraryJS servers have stopped unexpectedly.", "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    ExitApplication();
                    return;
                }

                _serverRunning = true;
                UpdateActiveEndpoints();
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

    private async Task<HttpsCertificateStatus?> EnsureRuntimeReadyAsync(bool anyHttps)
    {
        if (_runtimeRoot is null)
        {
            CleanupLegacyRuntimeFolders();
            _runtimeRoot = GetRuntimeRoot();
            ExtractBundledFiles(_runtimeRoot);
        }

        HttpsCertificateStatus? httpsCertificate = null;
        if (anyHttps)
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

        await Task.CompletedTask;
        return httpsCertificate;
    }

    private int? FindTemporaryUsbPort(HashSet<int> usedPorts)
    {
        var candidate = Math.Max(1024, _settings.Port + 1);
        for (var i = 0; i < 64 && candidate <= 65535; i++, candidate++)
        {
            if (!usedPorts.Contains(candidate) && IsPortAvailable(candidate))
            {
                return candidate;
            }
        }

        return null;
    }

    private static bool IsPortAvailable(int port)
    {
        try
        {
            using var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, port);
            listener.Start();
            return true;
        }
        catch
        {
            return false;
        }
    }

    private void UpdateActiveEndpoints()
    {
        if (_window.IsDisposed)
        {
            return;
        }

        _window.SetActiveEndpoints(BuildActiveEndpointGroups());
    }

    private IReadOnlyList<ActiveEndpointGroup> BuildActiveEndpointGroups()
    {
        var groups = new List<ActiveEndpointGroup>();
        var hosts = GetLocalHostCandidates();

        var index = 0;
        foreach (var instance in _servers.Where(server => !server.Process.HasExited))
        {
            var scheme = instance.UseHttps ? "https" : "http";
            var title = instance.IsTemporary ? "Temporary USB" : instance.Title;
            var links = new List<ActiveEndpointLink>();

            foreach (var hostName in hosts)
            {
                links.Add(new ActiveEndpointLink($"{hostName}:{instance.Port}", BuildUrl(scheme, hostName, instance.Port)));
            }

            groups.Add(new ActiveEndpointGroup(title, links));
            index++;
        }

        return groups;
    }

    private void WriteStartupMetadataFiles(IReadOnlyList<LocationConfig> locations)
    {
        try
        {
            var mainLocation = locations.FirstOrDefault();
            if (mainLocation is null || string.IsNullOrWhiteSpace(mainLocation.FolderRoot))
            {
                return;
            }

            var primaryHost = GetLocalHostCandidates().FirstOrDefault() ?? "localhost";
            var rootDirectory = mainLocation.FolderRoot;

            WriteTextFileReplacing(rootDirectory, "platform.txt", "windows");
            WriteTextFileReplacing(rootDirectory, "serverip.txt", BuildFileUrl(mainLocation.UseHttps ? "https" : "http", primaryHost, mainLocation.Port));

            var firstHttp = locations.FirstOrDefault(location => !location.UseHttps);
            WriteTextFileReplacing(
                rootDirectory,
                "httpserverip.txt",
                firstHttp is null ? string.Empty : BuildFileUrl("http", primaryHost, firstHttp.Port));

            var firstHttps = locations.FirstOrDefault(location => location.UseHttps);
            WriteTextFileReplacing(
                rootDirectory,
                "httpsserverip.txt",
                firstHttps is null ? string.Empty : BuildFileUrl("https", primaryHost, firstHttps.Port));
        }
        catch
        {
            // Best effort only; server startup should continue even if metadata files cannot be written.
        }
    }

    private static string BuildFileUrl(string scheme, string host, int port)
    {
        return BuildUrl(scheme, host, port).Replace("/?I", "/");
    }

    private static void WriteTextFileReplacing(string directory, string fileName, string contents)
    {
        var targetPath = Path.Combine(directory, fileName);

        try
        {
            File.WriteAllText(targetPath, contents);
            return;
        }
        catch
        {
            try
            {
                File.Delete(targetPath);
            }
            catch
            {
                // Best effort. If delete fails, the final write still has a chance.
            }

            try
            {
                File.WriteAllText(targetPath, contents);
            }
            catch
            {
                // Ignore; metadata file writes are non-critical.
            }
        }
    }

private static List<string> GetLocalHostCandidates()
    {
        var localIps = new List<string>();
        var tailscaleIps = new List<string>();
        var loopbackIps = new List<string>();

        static void AddUnique(List<string> list, string value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return;
            }

            if (!list.Any(existing => string.Equals(existing, value, StringComparison.OrdinalIgnoreCase)))
            {
                list.Add(value);
            }
        }

        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (nic.OperationalStatus != OperationalStatus.Up)
            {
                continue;
            }

            if (nic.NetworkInterfaceType is NetworkInterfaceType.Loopback or NetworkInterfaceType.Tunnel)
            {
                continue;
            }

            var isTailscale = nic.Name.Contains("Tailscale", StringComparison.OrdinalIgnoreCase)
                || nic.Description.Contains("Tailscale", StringComparison.OrdinalIgnoreCase);

            foreach (var unicast in nic.GetIPProperties().UnicastAddresses)
            {
                var address = unicast.Address;
                if (!IsLocalAddress(address, isTailscale))
                {
                    continue;
                }

                if (address.AddressFamily == AddressFamily.InterNetworkV6)
                {
                    continue;
                }

                var value = address.ToString();

                if (IPAddress.IsLoopback(address))
                {
                    AddUnique(loopbackIps, value);
                }
                else if (isTailscale)
                {
                    AddUnique(tailscaleIps, value);
                }
                else
                {
                    AddUnique(localIps, value);
                }
            }
        }

        localIps.Sort(StringComparer.OrdinalIgnoreCase);
        tailscaleIps.Sort(StringComparer.OrdinalIgnoreCase);
        loopbackIps.Sort(StringComparer.OrdinalIgnoreCase);

        var hosts = new List<string>();
        foreach (var item in localIps)
        {
            AddUnique(hosts, item);
        }

        foreach (var item in tailscaleIps)
        {
            AddUnique(hosts, item);
        }

        foreach (var item in loopbackIps)
        {
            AddUnique(hosts, item);
        }

        AddUnique(hosts, "localhost");
        AddUnique(hosts, "127.0.0.1");

        return hosts;
    }

    private static bool IsLocalAddress(IPAddress address, bool isTailscaleInterface)
    {
        if (IPAddress.IsLoopback(address))
        {
            return true;
        }

        if (isTailscaleInterface)
        {
            return true;
        }

        if (address.AddressFamily == AddressFamily.InterNetwork)
        {
            var bytes = address.GetAddressBytes();

            if (bytes[0] == 10)
            {
                return true;
            }

            if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31)
            {
                return true;
            }

            if (bytes[0] == 192 && bytes[1] == 168)
            {
                return true;
            }

            if (bytes[0] == 169 && bytes[1] == 254)
            {
                return true;
            }

            if (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127)
            {
                return true;
            }

            return false;
        }

        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal)
            {
                return true;
            }

            var bytes = address.GetAddressBytes();
            return (bytes[0] & 0xFE) == 0xFC;
        }

        return false;
    }

    private static string BuildUrl(string scheme, string host, int port)
    {
        var formattedHost = host.StartsWith("[", StringComparison.Ordinal) && host.EndsWith("]", StringComparison.Ordinal)
            ? host
            : host.Contains(':')
                ? $"[{host}]"
                : host;

        return $"{scheme}://{formattedHost}:{port}/?I";
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

    private static string GetRuntimeRoot()
    {
        var versionTag = Assembly.GetExecutingAssembly().GetName().Version?.ToString() ?? "dev";
        var runtimeRoot = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LibraryJS Server",
            "Runtime",
            versionTag);

        Directory.CreateDirectory(runtimeRoot);
        return runtimeRoot;
    }

    private static void CleanupLegacyRuntimeFolders()
    {
        try
        {
            var tempRoot = Path.GetTempPath();
            foreach (var directory in Directory.EnumerateDirectories(tempRoot, "libraryjs-server-tray-*"))
            {
                try
                {
                    if (DateTime.UtcNow - Directory.GetLastWriteTimeUtc(directory) > TimeSpan.FromDays(7))
                    {
                        Directory.Delete(directory, recursive: true);
                    }
                }
                catch
                {
                    // Ignore stale temp cleanup failures.
                }
            }
        }
        catch
        {
            // Ignore temp cleanup failures.
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

        // Keep the runtime cache for reuse on the next launch.

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
        public required string Title { get; init; }
        public required bool IsTemporary { get; init; }
    }
}

internal delegate void PortRequestedEventHandler(object? sender, int port);
internal delegate void BoolSettingChangedEventHandler(object? sender, bool value);

internal sealed class MainWindow : Form
{
    private sealed class LocationRow
    {
        public required Panel Container { get; init; }
        public required Label TitleLabel { get; init; }
        public required Label FolderLabel { get; init; }
        public required TextBox FolderBox { get; init; }
        public required Button BrowseButton { get; init; }
        public required Label PortLabel { get; init; }
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
    private bool _startWithWindows;
    private bool _autoStartServerOnLaunch;
    private bool _minimizeWhenStarted;
    private bool _corsEnabled = true;
    private readonly Panel _headerPanel;
    private readonly Panel _activeEndpointsCard;
    private readonly Label _activeEndpointsTitleLabel;
    private readonly Label _activeEndpointsHintLabel;
    private readonly Label _locationsTitleLabel;
    private readonly Label _locationsHintLabel;
    private readonly FlowLayoutPanel _locationsPanel;
    private readonly Panel _contentPanel;
    private readonly Panel _buttonPanel;
    private readonly Panel _activeEndpointsPanel;
    private readonly FlowLayoutPanel _endpointActionPanel;
    private readonly Button _addLocationButton;
    private readonly Button _startupOptionsButton;
    private readonly Button _installLibraryJsButton;
    private readonly Button _temporaryUsbButton;
    private readonly Button _storageLinksButton;
    private bool _temporaryUsbActive;
    private readonly ToolTip _toolTip = new();
    private IReadOnlyList<ActiveEndpointGroup> _storageEndpointGroups = Array.Empty<ActiveEndpointGroup>();
    private readonly List<LocationRow> _rows = new();
    private bool _suppressSettingEvents;
    private bool _suppressLocationEvents;
    private bool _serverStarted;
    private float _appliedLocationScale = 1f;

    public event PortRequestedEventHandler? RequestStart;
    public event EventHandler? RequestStop;
    public event EventHandler? RequestExit;
    public event EventHandler? RequestInstallLibraryJs;
    public event EventHandler? RequestTemporaryUsb;
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
    FormBorderStyle = FormBorderStyle.Sizable;
    MaximizeBox = true;
    MinimizeBox = true;
    ShowInTaskbar = true;
    ClientSize = new System.Drawing.Size(1360, 860);
    MinimumSize = new System.Drawing.Size(980, 620);
    BackColor = Color.FromArgb(15, 23, 25);
    Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
    ForeColor = Color.FromArgb(240, 245, 242);
    AutoScaleMode = AutoScaleMode.Font;

    _headerPanel = new Panel
    {
        Left = 0,
        Top = 0,
        Width = ClientSize.Width,
        Height = 118,
        Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        BackColor = Color.FromArgb(20, 32, 34),
        Padding = new Padding(20, 16, 20, 16)
    };

    var iconBox = new PictureBox
    {
        Left = 20,
        Top = 16,
        Width = 60,
        Height = 60,
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
        Top = 18,
        Width = 980,
        Height = 28,
        Text = "LibraryJS Server",
        Font = new Font(Font.FontFamily, 14F, FontStyle.Bold),
        ForeColor = Color.FromArgb(245, 248, 247)
    };

    var subtitleLabel = new Label
    {
        Left = 86,
        Top = 48,
        Width = 980,
        Height = 34,
        Text = string.Empty,
        ForeColor = Color.FromArgb(183, 201, 198)
    };

    _headerPanel.Controls.Add(iconBox);
    _headerPanel.Controls.Add(titleLabel);
    _headerPanel.Controls.Add(subtitleLabel);

    _activeEndpointsCard = new Panel
    {
        Left = 20,
        Top = 132,
        Width = ClientSize.Width - 40,
        Height = 166,
        Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        BackColor = Color.FromArgb(20, 32, 34),
        Padding = new Padding(18, 12, 18, 12)
    };

    _activeEndpointsTitleLabel = new Label
    {
        Left = 18,
        Top = 14,
        Width = 360,
        Height = 24,
        Text = "Main Server",
        Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold),
        ForeColor = Color.FromArgb(245, 248, 247),
        AutoEllipsis = true
    };

    _activeEndpointsHintLabel = new Label
    {
        Left = 18,
        Top = 42,
        Width = 1060,
        Height = 24,
        Text = string.Empty,
        ForeColor = Color.FromArgb(183, 201, 198),
        AutoEllipsis = true
    };

    _endpointActionPanel = new FlowLayoutPanel
    {
        Left = 18,
        Top = 2,
        Width = 486,
        Height = 40,
        Anchor = AnchorStyles.Top | AnchorStyles.Right,
        FlowDirection = FlowDirection.LeftToRight,
        WrapContents = false,
        AutoScroll = false,
        AutoSize = false,
        BackColor = Color.FromArgb(20, 32, 34),
        Padding = new Padding(0),
        Margin = new Padding(0)
    };

    _installLibraryJsButton = CreateActionButton("Install LibraryJS", 0, 0, 148, Color.FromArgb(46, 62, 63));
    _installLibraryJsButton.Click += (_, _) => RequestInstallLibraryJs?.Invoke(this, EventArgs.Empty);

    _temporaryUsbButton = CreateActionButton("Temporary USB", 0, 0, 132, Color.FromArgb(46, 62, 63));
    _temporaryUsbButton.Click += (_, _) => RequestTemporaryUsb?.Invoke(this, EventArgs.Empty);

    _storageLinksButton = CreateActionButton("Show all storage links", 0, 0, 206, Color.FromArgb(46, 62, 63));
    _storageLinksButton.Click += (_, _) => OpenStorageLinksDialog();

    _endpointActionPanel.Controls.Add(_installLibraryJsButton);
    _endpointActionPanel.Controls.Add(_temporaryUsbButton);
    _endpointActionPanel.Controls.Add(_storageLinksButton);

    _activeEndpointsPanel = new FlowLayoutPanel
    {
        Left = 18,
        Top = 60,
        Width = _activeEndpointsCard.ClientSize.Width - 36,
        Height = 88,
        Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        FlowDirection = FlowDirection.LeftToRight,
        WrapContents = true,
        AutoScroll = false,
        AutoSize = false,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        BackColor = Color.FromArgb(18, 29, 31),
        Padding = new Padding(2, 1, 2, 1)
    };

    _activeEndpointsCard.Controls.Add(_activeEndpointsTitleLabel);
    _activeEndpointsCard.Controls.Add(_activeEndpointsHintLabel);
    _activeEndpointsCard.Controls.Add(_endpointActionPanel);
    _activeEndpointsCard.Controls.Add(_activeEndpointsPanel);

    _contentPanel = new Panel
    {
        Left = 20,
        Top = 308,
        Width = ClientSize.Width - 40,
        Height = 560,
        Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        BackColor = Color.FromArgb(20, 32, 34),
        AutoScroll = true,
        Padding = new Padding(18)
    };

    _locationsTitleLabel = new Label
    {
        Left = 18,
        Top = 14,
        Width = 260,
        Height = 24,
        Text = "Library locations",
        Font = new Font(Font.FontFamily, 10.5F, FontStyle.Bold),
        ForeColor = Color.FromArgb(245, 248, 247)
    };

    _locationsHintLabel = new Label
    {
        Left = 18,
        Top = 44,
        Width = 980,
        Height = 28,
        Text = string.Empty,
        ForeColor = Color.FromArgb(183, 201, 198)
    };

    _locationsPanel = new FlowLayoutPanel
    {
        Left = 18,
        Top = 84,
        Width = _contentPanel.ClientSize.Width - 36,
        Height = 226,
        Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        FlowDirection = FlowDirection.LeftToRight,
        WrapContents = true,
        AutoScroll = false,
        AutoSize = false,
        AutoSizeMode = AutoSizeMode.GrowAndShrink,
        BackColor = Color.FromArgb(18, 29, 31),
        Padding = new Padding(4)
    };

    _addLocationButton = CreateAddLocationTileButton();
    _addLocationButton.Click += (_, _) =>
    {
        AddLocationRow(new LocationConfig { FolderRoot = string.Empty, Port = defaultPort, Enabled = true });
        EmitLocationEvents();
    };

    _contentPanel.Controls.Add(_locationsTitleLabel);
    _contentPanel.Controls.Add(_locationsHintLabel);
    _contentPanel.Controls.Add(_locationsPanel);

    _buttonPanel = new Panel
    {
        Left = 20,
        Top = 852,
        Width = ClientSize.Width - 40,
        Height = 42,
        Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
        BackColor = Color.Transparent
    };

    _startButton = CreateActionButton("Start server", 920, 0, 160, Color.FromArgb(64, 165, 109));
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

    _startupOptionsButton = CreateActionButton("Startup options", 1090, 0, 162, Color.FromArgb(46, 62, 63));
    _startupOptionsButton.Click += (_, _) =>
    {
        using var dialog = new StartupOptionsDialog(
            _startWithWindows,
            _autoStartServerOnLaunch,
            _minimizeWhenStarted,
            _corsEnabled);

        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return;
        }

        if (_startWithWindows != dialog.StartWithWindows)
        {
            _startWithWindows = dialog.StartWithWindows;
            StartWithWindowsChanged?.Invoke(this, _startWithWindows);
        }

        if (_autoStartServerOnLaunch != dialog.AutoStartServerOnLaunch)
        {
            _autoStartServerOnLaunch = dialog.AutoStartServerOnLaunch;
            AutoStartServerChanged?.Invoke(this, _autoStartServerOnLaunch);
        }

        if (_minimizeWhenStarted != dialog.MinimizeWhenStarted)
        {
            _minimizeWhenStarted = dialog.MinimizeWhenStarted;
            MinimizeWhenStartedChanged?.Invoke(this, _minimizeWhenStarted);
        }

        if (_corsEnabled != dialog.CorsEnabled)
        {
            _corsEnabled = dialog.CorsEnabled;
            CorsEnabledChanged?.Invoke(this, _corsEnabled);
        }
    };

    _exitButton = CreateActionButton("Exit", 1264, 0, 80, Color.FromArgb(46, 62, 63));
    _exitButton.Click += (_, _) => RequestExit?.Invoke(this, EventArgs.Empty);

    _buttonPanel.Controls.Add(_startButton);
    _buttonPanel.Controls.Add(_startupOptionsButton);
    _buttonPanel.Controls.Add(_exitButton);

    _statusLabel = new Label
    {
        Left = 20,
        Top = 800,
        Width = ClientSize.Width - 40,
        Height = 18,
        Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
        Text = "Ready to start.",
        ForeColor = Color.FromArgb(240, 245, 242),
        AutoEllipsis = true
    };

    _statusDetailLabel = new Label
    {
        Left = 20,
        Top = 826,
        Width = ClientSize.Width - 40,
        Height = 18,
        Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
        Text = string.Empty,
        ForeColor = Color.FromArgb(183, 201, 198),
        AutoEllipsis = true
    };

    Controls.Add(_headerPanel);
    Controls.Add(_activeEndpointsCard);
    Controls.Add(_contentPanel);
    Controls.Add(_statusLabel);
    Controls.Add(_statusDetailLabel);
    Controls.Add(_buttonPanel);

    AddLocationRow(new LocationConfig { Port = defaultPort, Enabled = true });
    _storageLinksButton.Enabled = false;
    UpdateNotice();
    RefreshHttpsCertificateIndicators();

    Resize += (_, _) => LayoutDashboard();
    LayoutDashboard();
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
        _startupOptionsButton.Enabled = enabled;
        _installLibraryJsButton.Enabled = true;
        _temporaryUsbButton.Enabled = true;
        _storageLinksButton.Enabled = enabled && _storageEndpointGroups.Count > 0;
    }

    private void LayoutDashboard()
    {
        if (InvokeRequired)
        {
            BeginInvoke(new Action(LayoutDashboard));
            return;
        }

        var margin = 20;
        var width = Math.Max(0, ClientSize.Width - margin * 2);
        var workAreaHeight = Screen.FromControl(this).WorkingArea.Height;
        var maxHeight = Math.Max(620, workAreaHeight - 20);

        var columns = Math.Max(1, width / 394);
        var totalLocationTiles = Math.Max(1, _rows.Count + 1);
        var rows = Math.Max(1, (int)Math.Ceiling(totalLocationTiles / (double)columns));
        var baseLocationsHeight = rows * 242;
        var availableLocationsHeight = Math.Max(180, maxHeight - 390);
        var newScale = baseLocationsHeight <= 0
            ? 1f
            : Math.Min(1f, (float)availableLocationsHeight / baseLocationsHeight);

        if (newScale < 0.65f)
        {
            newScale = 0.65f;
        }

        if (Math.Abs(newScale - _appliedLocationScale) > 0.001f)
        {
            var ratio = newScale / _appliedLocationScale;
            foreach (var row in _rows)
            {
                row.Container.Scale(new SizeF(1f, ratio));
            }

            _appliedLocationScale = newScale;
        }

        _headerPanel.SetBounds(0, 0, ClientSize.Width, 108);
        _activeEndpointsCard.SetBounds(margin, 124, width, 128);

        var endpointButtonsWidth = _installLibraryJsButton.Width + _temporaryUsbButton.Width + _storageLinksButton.Width + 24;
        var endpointButtonsLeft = Math.Max(18, _activeEndpointsCard.ClientSize.Width - 18 - endpointButtonsWidth);
        _endpointActionPanel.SetBounds(endpointButtonsLeft, 12, endpointButtonsWidth, 36);
        _installLibraryJsButton.Width = 148;
        _temporaryUsbButton.Width = 132;
        _storageLinksButton.Width = 206;
        _activeEndpointsTitleLabel.SetBounds(18, 14, Math.Max(0, endpointButtonsLeft - 30), 24);
        _activeEndpointsHintLabel.SetBounds(18, 42, Math.Max(0, endpointButtonsLeft - 30), 24);
        _activeEndpointsPanel.SetBounds(18, 54, Math.Max(0, _activeEndpointsCard.ClientSize.Width - 36), 72);

        var footerBottom = Math.Min(maxHeight - 16, ClientSize.Height - 16);
        var footerButtonsWidth = _startButton.Width + _startupOptionsButton.Width + _exitButton.Width + 24;
        var footerButtonsLeft = Math.Max(margin, width - footerButtonsWidth);
        _buttonPanel.SetBounds(footerButtonsLeft, footerBottom - 42, footerButtonsWidth, 42);
        _startButton.Left = 0;
        _startupOptionsButton.Left = _startButton.Right + 12;
        _exitButton.Left = _startupOptionsButton.Right + 12;

        var footerTextWidth = Math.Max(0, footerButtonsLeft - margin - 12);
        _statusDetailLabel.SetBounds(margin, _buttonPanel.Top - 24, footerTextWidth, 18);
        _statusLabel.SetBounds(margin, _statusDetailLabel.Top - 22, footerTextWidth, 18);

        var contentTop = _activeEndpointsCard.Bottom + 16;
        var contentBottom = _statusLabel.Top - 12;
        var contentHeight = Math.Max(120, contentBottom - contentTop);
        _contentPanel.SetBounds(margin, contentTop, width, contentHeight);
        _contentPanel.AutoScroll = true;

        _locationsTitleLabel.Left = 18;
        _locationsTitleLabel.Top = 14;

        _locationsHintLabel.Left = 18;
        _locationsHintLabel.Top = 38;
        _locationsHintLabel.Width = Math.Max(0, _contentPanel.ClientSize.Width - 36);

        _locationsPanel.Left = 18;
        _locationsPanel.Top = 68;
        _locationsPanel.Width = Math.Max(0, _contentPanel.ClientSize.Width - 36);
        _locationsPanel.Height = Math.Max(0, rows * ScaleY(242));

    }

    private int ScaleY(int value) => Math.Max(1, (int)Math.Round(value * _appliedLocationScale));


public void SetActiveEndpoints(IEnumerable<ActiveEndpointGroup> groups)
{
    if (InvokeRequired)
    {
        BeginInvoke(new Action(() => SetActiveEndpoints(groups)));
        return;
    }

    _storageEndpointGroups = groups?.ToList() ?? new List<ActiveEndpointGroup>();
    _storageLinksButton.Enabled = _storageEndpointGroups.Count > 0;

    _activeEndpointsPanel.SuspendLayout();
    try
    {
        _activeEndpointsPanel.Controls.Clear();

        if (_storageEndpointGroups.Count == 0)
        {
            var empty = new Label
            {
                AutoSize = true,
                Margin = new Padding(0, 4, 10, 0),
                Text = "No servers.",
                ForeColor = Color.FromArgb(148, 163, 184)
            };
            _activeEndpointsPanel.Controls.Add(empty);
            return;
        }

        var primaryGroup = _storageEndpointGroups[0];
        var primaryLink = primaryGroup.Links.FirstOrDefault();
        if (primaryLink is null)
        {
            var empty = new Label
            {
                AutoSize = true,
                Margin = new Padding(0, 4, 10, 0),
                Text = "No links.",
                ForeColor = Color.FromArgb(148, 163, 184)
            };
            _activeEndpointsPanel.Controls.Add(empty);
            return;
        }

        var cardWidth = Math.Max(300, Math.Min(420, _activeEndpointsPanel.ClientSize.Width - 24));
        var groupCard = new Panel
        {
            Width = cardWidth,
            BackColor = Color.FromArgb(15, 25, 27),
            Margin = new Padding(0, 0, 12, 12),
            Padding = new Padding(16),
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink
        };

        var groupTitle = new Label
        {
            Left = 12,
            Top = 12,
            Width = cardWidth - 32,
            Height = 22,
            Text = primaryGroup.Title,
            ForeColor = Color.FromArgb(245, 248, 247),
            Font = new Font(Font.FontFamily, 9.5F, FontStyle.Bold)
        };

        var linksPanel = new FlowLayoutPanel
        {
            Left = 12,
            Top = 40,
            Width = cardWidth - 32,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            BackColor = Color.Transparent,
            Margin = new Padding(0),
            Padding = new Padding(0)
        };

        linksPanel.Controls.Add(CreateEndpointLink(primaryLink.DisplayText, primaryLink.Url));

        groupCard.Controls.Add(groupTitle);
        groupCard.Controls.Add(linksPanel);
        _activeEndpointsPanel.Controls.Add(groupCard);
    }
    finally
    {
        _activeEndpointsPanel.ResumeLayout();
    }
}

public TemporaryUsbLaunchOptions? PromptTemporaryUsbLaunch(string initialFolderRoot, int initialPort)
    {
        using var dialog = new TemporaryUsbLaunchDialog(initialFolderRoot, initialPort);
        if (dialog.ShowDialog(this) != DialogResult.OK)
        {
            return null;
        }

        return new TemporaryUsbLaunchOptions(dialog.SelectedFolderRoot, dialog.SelectedPort);
    }

public void SetTemporaryUsbActive(bool active)
{
    if (InvokeRequired)
    {
        BeginInvoke(new Action(() => SetTemporaryUsbActive(active)));
        return;
    }

    _temporaryUsbActive = active;
    _temporaryUsbButton.Text = active ? "Remove Temporary USB" : "Temporary USB";
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
        _startWithWindows = startWithWindows;
        _autoStartServerOnLaunch = autoStartServer;
        _minimizeWhenStarted = minimizeWhenStarted;
        _corsEnabled = corsEnabled;
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
        _startWithWindows = startWithWindows;
    }
    finally
    {
        _suppressSettingEvents = false;
    }
}

private LinkLabel CreateEndpointLink(string displayText, string url)
{
    var link = new LinkLabel
    {
        AutoSize = true,
        Text = displayText,
        Tag = url,
        Margin = new Padding(0, 0, 12, 0),
        LinkColor = Color.FromArgb(121, 168, 255),
        ActiveLinkColor = Color.FromArgb(139, 225, 180),
        VisitedLinkColor = Color.FromArgb(121, 168, 255),
        LinkBehavior = LinkBehavior.HoverUnderline,
        BackColor = Color.Transparent
    };

    link.LinkClicked += (_, _) =>
    {
        try
        {
            Process.Start(new ProcessStartInfo(url)
            {
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    };

    return link;
}

    private void OpenStorageLinksDialog()
    {
        var groups = _storageEndpointGroups?.ToList() ?? new List<ActiveEndpointGroup>();
        using var dialog = new StorageLinksDialog(groups);
        dialog.ShowDialog(this);
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
            _locationsPanel.Controls.Add(_addLocationButton);
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

        LayoutDashboard();
        UpdateNotice();
    }


private void AddLocationRow(LocationConfig config, bool emitEvents = true)
{
    var rowIndex = _rows.Count + 1;
    var container = new Panel
    {
        Width = 390,
        Height = 226,
        BackColor = Color.FromArgb(15, 25, 27),
        Margin = new Padding(0, 0, 12, 12),
        Padding = new Padding(14)
    };

    var title = new Label
    {
        Left = 12,
        Top = 10,
        Width = 240,
        Height = 24,
        Text = rowIndex == 1 ? "Main Server" : $"Expanded {rowIndex - 1}",
        Font = new Font(Font.FontFamily, 10F, FontStyle.Bold),
        ForeColor = Color.FromArgb(245, 248, 247)
    };

    var enabledBox = new CheckBox
    {
        Left = 282,
        Top = 12,
        Width = 92,
        Height = 34,
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
        Top = 52,
        Width = 110,
        Height = 22,
        Text = "Folder root",
        ForeColor = Color.FromArgb(183, 201, 198)
    };

    var folderBox = new TextBox
    {
        Left = 12,
        Top = 76,
        Width = 278,
        Text = config.FolderRoot ?? string.Empty,
        Height = 32,
        BackColor = Color.FromArgb(14, 24, 26),
        ForeColor = Color.FromArgb(240, 245, 242),
        BorderStyle = BorderStyle.FixedSingle
    };

    var browseButton = CreateActionButton("Browse…", 298, 74, 78, Color.FromArgb(46, 62, 63));

    var portLabel = new Label
    {
        Left = 12,
        Top = 124,
        Width = 80,
        Height = 22,
        Text = "Port",
        ForeColor = Color.FromArgb(183, 201, 198)
    };

    var portBox = new NumericUpDown
    {
        Left = 12,
        Top = 148,
        Width = 104,
        Minimum = 1,
        Maximum = 65535,
        Value = PortUtil.ClampPort(config.Port),
        Height = 32,
        BorderStyle = BorderStyle.FixedSingle,
        BackColor = Color.FromArgb(14, 24, 26),
        ForeColor = Color.FromArgb(240, 245, 242)
    };

    var httpsBox = new CheckBox
    {
        Left = 128,
        Top = 150,
        Width = 118,
        Height = 34,
        Text = "Use HTTPS",
        Checked = config.UseHttps,
        ForeColor = Color.FromArgb(240, 245, 242),
        FlatStyle = FlatStyle.Flat,
        AutoSize = false
    };
    httpsBox.FlatAppearance.BorderColor = Color.FromArgb(64, 165, 109);

    var httpsStatusLabel = new Label
    {
        Left = 128,
        Top = 184,
        Width = 170,
        Height = 24,
        Text = config.UseHttps ? "🔒 Certificate pending" : "HTTPS off",
        ForeColor = Color.FromArgb(148, 163, 184)
    };

    var removeButton = CreateActionButton("Remove", 304, 180, 72, Color.FromArgb(46, 62, 63));

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

    if (_appliedLocationScale != 1f)
    {
        container.Scale(new SizeF(1f, _appliedLocationScale));
    }

    _locationsPanel.Controls.Add(container);
    if (_locationsPanel.Controls.Contains(_addLocationButton))
    {
        _locationsPanel.Controls.SetChildIndex(_addLocationButton, _locationsPanel.Controls.Count - 1);
    }

    _rows.Add(new LocationRow
    {
        Container = container,
        TitleLabel = title,
        FolderLabel = folderLabel,
        FolderBox = folderBox,
        BrowseButton = browseButton,
        PortLabel = portLabel,
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
            _rows[i].TitleLabel.Text = i == 0 ? "Main Server" : $"Expanded {i}";
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
        LayoutDashboard();
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
            _statusDetailLabel.Text = "Add a location to start.";
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
                row.HttpsStatusLabel.Text = "⏳ Certificate on start";
                row.HttpsStatusLabel.ForeColor = Color.FromArgb(248, 191, 94);
                row.HttpsStatusLabel.Tag = null;
                _toolTip.SetToolTip(row.HttpsStatusLabel, "Created when HTTPS starts.");
            }
        }
    }

    private static Button CreateAddLocationTileButton()
    {
        return new Button
        {
            Width = 390,
            Height = 226,
            Margin = new Padding(0, 0, 12, 12),
            BackColor = Color.FromArgb(15, 25, 27),
            ForeColor = Color.FromArgb(240, 245, 242),
            FlatStyle = FlatStyle.Flat,
            UseVisualStyleBackColor = false,
            Text = "Add location",
            Font = new Font(SystemFonts.DefaultFont.FontFamily, 12F, FontStyle.Bold),
            TextAlign = ContentAlignment.MiddleCenter
        };
    }

    private Button CreateActionButton(string text, int left, int top, int width, Color backColor)
    {
        return new Button
        {
            Left = left,
            Top = top,
            Width = width,
            Height = 40,
            Text = text,
            BackColor = backColor,
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            UseVisualStyleBackColor = false,
            AutoEllipsis = true,
            TextAlign = ContentAlignment.MiddleCenter,
            Margin = new Padding(0)
        };
    }
}


internal sealed class TemporaryUsbLaunchDialog : Form
{
    private readonly TextBox _folderBox;
    private readonly NumericUpDown _portBox;

    public string SelectedFolderRoot => _folderBox.Text.Trim();
    public int SelectedPort => (int)_portBox.Value;

    public TemporaryUsbLaunchDialog(string initialFolderRoot, int initialPort)
    {
        Text = "Temporary USB";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new System.Drawing.Size(620, 240);
        BackColor = Color.FromArgb(15, 23, 25);
        ForeColor = Color.FromArgb(240, 245, 242);
        Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

        var title = new Label
        {
            Left = 20,
            Top = 18,
            Width = 340,
            Height = 28,
            Text = "Temporary USB Server",
            Font = new Font(Font.FontFamily, 13F, FontStyle.Bold),
            ForeColor = Color.FromArgb(245, 248, 247)
        };

        var subtitle = new Label
        {
            Left = 20,
            Top = 48,
            Width = 560,
            Height = 40,
            Text = "Choose the folder root and port before starting the temporary server.",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        var folderLabel = new Label
        {
            Left = 20,
            Top = 92,
            Width = 160,
            Height = 22,
            Text = "Folder root",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        _folderBox = new TextBox
        {
            Left = 20,
            Top = 116,
            Width = 472,
            Height = 32,
            Text = initialFolderRoot ?? string.Empty,
            BackColor = Color.FromArgb(14, 24, 26),
            ForeColor = Color.FromArgb(240, 245, 242),
            BorderStyle = BorderStyle.FixedSingle
        };

        var browseButton = CreateActionButton("Browse…", 504, 114, 96, Color.FromArgb(46, 62, 63));
        browseButton.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog
            {
                Description = "Choose the folder to host with Temporary USB",
                UseDescriptionForTitle = true,
                ShowNewFolderButton = false,
                SelectedPath = string.IsNullOrWhiteSpace(_folderBox.Text)
                    ? Environment.GetFolderPath(Environment.SpecialFolder.Desktop)
                    : _folderBox.Text
            };

            if (dialog.ShowDialog(this) == DialogResult.OK)
            {
                _folderBox.Text = dialog.SelectedPath;
            }
        };

        var portLabel = new Label
        {
            Left = 20,
            Top = 156,
            Width = 160,
            Height = 22,
            Text = "Port",
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        _portBox = new NumericUpDown
        {
            Left = 20,
            Top = 180,
            Width = 140,
            Height = 28,
            Minimum = 1,
            Maximum = 65535,
            Value = Math.Min(65535, Math.Max(1, initialPort)),
            BackColor = Color.FromArgb(14, 24, 26),
            ForeColor = Color.FromArgb(240, 245, 242)
        };

        var okButton = CreateActionButton("Start", 400, 186, 100, Color.FromArgb(64, 165, 109));
        okButton.DialogResult = DialogResult.OK;

        var cancelButton = CreateActionButton("Cancel", 510, 186, 100, Color.FromArgb(46, 62, 63));
        cancelButton.DialogResult = DialogResult.Cancel;

        AcceptButton = okButton;
        CancelButton = cancelButton;

        Controls.Add(title);
        Controls.Add(subtitle);
        Controls.Add(folderLabel);
        Controls.Add(_folderBox);
        Controls.Add(browseButton);
        Controls.Add(portLabel);
        Controls.Add(_portBox);
        Controls.Add(okButton);
        Controls.Add(cancelButton);
    }

    private static Button CreateActionButton(string text, int left, int top, int width, Color backColor)
    {
        return new Button
        {
            Left = left,
            Top = top,
            Width = width,
            Height = 36,
            Text = text,
            BackColor = backColor,
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            UseVisualStyleBackColor = false
        };
    }
}

internal sealed class StorageLinksDialog : Form
{
    public StorageLinksDialog(IReadOnlyList<ActiveEndpointGroup> groups)
    {
        Text = "All storage links";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new System.Drawing.Size(760, 560);
        BackColor = Color.FromArgb(15, 23, 25);
        ForeColor = Color.FromArgb(240, 245, 242);
        Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

        var title = new Label
        {
            Left = 20,
            Top = 20,
            Width = 360,
            Height = 30,
            Text = "All storage links",
            Font = new Font(Font.FontFamily, 14F, FontStyle.Bold),
            ForeColor = Color.FromArgb(245, 248, 247)
        };

        var subtitle = new Label
        {
            Left = 20,
            Top = 54,
            Width = 700,
            Height = 44,
            Text = string.Empty,
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        var panel = new FlowLayoutPanel
        {
            Left = 20,
            Top = 106,
            Width = 720,
            Height = 382,
            Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
            FlowDirection = FlowDirection.LeftToRight,
            WrapContents = true,
            AutoScroll = true,
            BackColor = Color.FromArgb(20, 32, 34),
            Padding = new Padding(14)
        };

        var source = groups?.ToList() ?? new List<ActiveEndpointGroup>();
        if (source.Count == 0)
        {
            panel.Controls.Add(new Label
            {
                AutoSize = true,
                Text = "No servers.",
                ForeColor = Color.FromArgb(148, 163, 184),
                Margin = new Padding(0, 6, 0, 0)
            });
        }
        else
        {
            foreach (var group in source)
            {
                var card = new Panel
                {
                    Width = 320,
                    BackColor = Color.FromArgb(15, 25, 27),
                    Margin = new Padding(0, 0, 12, 12),
                    Padding = new Padding(16),
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowAndShrink
                };

                var groupTitle = new Label
                {
                    Left = 12,
                    Top = 12,
                    Width = 280,
                    Height = 22,
                    Text = group.Title,
                    ForeColor = Color.FromArgb(245, 248, 247),
                    Font = new Font(Font.FontFamily, 9.5F, FontStyle.Bold)
                };

                var linksPanel = new FlowLayoutPanel
                {
                    Left = 12,
                    Top = 40,
                    Width = 280,
                    AutoSize = true,
                    AutoSizeMode = AutoSizeMode.GrowAndShrink,
                    FlowDirection = FlowDirection.LeftToRight,
                    WrapContents = true,
                    BackColor = Color.Transparent,
                    Margin = new Padding(0),
                    Padding = new Padding(0)
                };

                foreach (var link in group.Links)
                {
                    linksPanel.Controls.Add(CreateEndpointLink(link.DisplayText, link.Url));
                }

                card.Controls.Add(groupTitle);
                card.Controls.Add(linksPanel);
                panel.Controls.Add(card);
            }
        }

        var closeButton = CreateActionButton("Close", 640, 504, 100, Color.FromArgb(46, 62, 63));
        closeButton.DialogResult = DialogResult.OK;

        AcceptButton = closeButton;
        CancelButton = closeButton;

        Controls.Add(title);
        Controls.Add(subtitle);
        Controls.Add(panel);
        Controls.Add(closeButton);
    }

    private static LinkLabel CreateEndpointLink(string displayText, string url)
    {
        var link = new LinkLabel
        {
            AutoSize = true,
            Text = displayText,
            Tag = url,
            Margin = new Padding(0, 0, 12, 0),
            LinkColor = Color.FromArgb(121, 168, 255),
            ActiveLinkColor = Color.FromArgb(139, 225, 180),
            VisitedLinkColor = Color.FromArgb(121, 168, 255),
            LinkBehavior = LinkBehavior.HoverUnderline,
            BackColor = Color.Transparent
        };

        link.LinkClicked += (_, _) =>
        {
            try
            {
                Process.Start(new ProcessStartInfo(url)
                {
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                MessageBox.Show(ex.Message, "LibraryJS Server", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        };

        return link;
    }

    private static Button CreateActionButton(string text, int left, int top, int width, Color backColor)
    {
        return new Button
        {
            Left = left,
            Top = top,
            Width = width,
            Height = 40,
            Text = text,
            BackColor = backColor,
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            UseVisualStyleBackColor = false,
            AutoEllipsis = true,
            TextAlign = ContentAlignment.MiddleCenter,
            Margin = new Padding(0)
        };
    }
}

internal sealed class StartupOptionsDialog : Form
{
    private readonly CheckBox _startWithWindowsCheckBox;
    private readonly CheckBox _autoStartServerCheckBox;
    private readonly CheckBox _minimizeWhenStartedCheckBox;
    private readonly CheckBox _corsEnabledCheckBox;

    public bool StartWithWindows => _startWithWindowsCheckBox.Checked;
    public bool AutoStartServerOnLaunch => _autoStartServerCheckBox.Checked;
    public bool MinimizeWhenStarted => _minimizeWhenStartedCheckBox.Checked;
    public bool CorsEnabled => _corsEnabledCheckBox.Checked;

    public StartupOptionsDialog(bool startWithWindows, bool autoStartServerOnLaunch, bool minimizeWhenStarted, bool corsEnabled)
    {
        Text = "Startup options";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowInTaskbar = false;
        ClientSize = new System.Drawing.Size(680, 470);
        BackColor = Color.FromArgb(15, 23, 25);
        ForeColor = Color.FromArgb(240, 245, 242);
        Font = new Font("Segoe UI", 9F, FontStyle.Regular, GraphicsUnit.Point);

        var title = new Label
        {
            Left = 20,
            Top = 20,
            Width = 460,
            Height = 30,
            Text = "Startup options",
            Font = new Font(Font.FontFamily, 14F, FontStyle.Bold),
            ForeColor = Color.FromArgb(245, 248, 247)
        };

        var subtitle = new Label
        {
            Left = 20,
            Top = 54,
            Width = 620,
            Height = 44,
            Text = string.Empty,
            ForeColor = Color.FromArgb(183, 201, 198)
        };

        var card = new Panel
        {
            Left = 20,
            Top = 112,
            Width = 640,
            Height = 286,
            BackColor = Color.FromArgb(20, 32, 34),
            Padding = new Padding(16)
        };

        _startWithWindowsCheckBox = CreateCheckBox("Start LibraryJS Server when Windows starts", 16, 16, 430, startWithWindows);
        _autoStartServerCheckBox = CreateCheckBox("Start the server automatically when the app opens", 16, 58, 430, autoStartServerOnLaunch);
        _minimizeWhenStartedCheckBox = CreateCheckBox("Minimize the window when the server starts", 16, 100, 430, minimizeWhenStarted);
        _corsEnabledCheckBox = CreateCheckBox("CORS for browser downloads and uploads (locked on)", 16, 142, 430, corsEnabled);
        _corsEnabledCheckBox.Enabled = false;
        _corsEnabledCheckBox.Checked = true;

        card.Controls.Add(_startWithWindowsCheckBox);
        card.Controls.Add(_autoStartServerCheckBox);
        card.Controls.Add(_minimizeWhenStartedCheckBox);
        card.Controls.Add(_corsEnabledCheckBox);

        var saveButton = CreateActionButton("Save", 560, 418, 100, Color.FromArgb(64, 165, 109));
        saveButton.DialogResult = DialogResult.OK;

        var cancelButton = CreateActionButton("Cancel", 444, 418, 100, Color.FromArgb(46, 62, 63));
        cancelButton.DialogResult = DialogResult.Cancel;

        AcceptButton = saveButton;
        CancelButton = cancelButton;

        Controls.Add(title);
        Controls.Add(subtitle);
        Controls.Add(card);
        Controls.Add(saveButton);
        Controls.Add(cancelButton);
    }

    private static CheckBox CreateCheckBox(string text, int left, int top, int width, bool checkedValue)
    {
        return new CheckBox
        {
            Left = left,
            Top = top,
            Width = width,
            Height = 34,
            Text = text,
            Checked = checkedValue,
            ForeColor = Color.FromArgb(240, 245, 242),
            FlatStyle = FlatStyle.Flat,
            AutoSize = false
        };
    }

    private static Button CreateActionButton(string text, int left, int top, int width, Color backColor)
    {
        return new Button
        {
            Left = left,
            Top = top,
            Width = width,
            Height = 40,
            Text = text,
            BackColor = backColor,
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat,
            UseVisualStyleBackColor = false,
            AutoEllipsis = true,
            TextAlign = ContentAlignment.MiddleCenter,
            Margin = new Padding(0)
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
