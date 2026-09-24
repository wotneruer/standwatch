using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;

namespace StandWatch.Portable;

internal static class Program
{
    private const string PayloadVersion = "2026.09.16.4";

    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        try
        {
            var launcherPath = Environment.ProcessPath ?? throw new InvalidOperationException("Не вдалося визначити шлях portable-файлу.");
            var launcherDir = Path.GetDirectoryName(launcherPath) ?? AppContext.BaseDirectory;
            var installDir = Path.Combine(launcherDir, "StandWatch");
            var marker = Path.Combine(installDir, ".payload-version");
            var installedVersion = File.Exists(marker) ? File.ReadAllText(marker).Trim() : "";

            if (installedVersion != PayloadVersion || !File.Exists(Path.Combine(installDir, "standwatch.exe")))
            {
                Directory.CreateDirectory(installDir);
                ExtractPayload(installDir);
                File.WriteAllText(marker, PayloadVersion);
            }

            var app = Path.Combine(installDir, "standwatch.exe");
            Process.Start(new ProcessStartInfo(app)
            {
                WorkingDirectory = installDir,
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                "Не вдалося розгорнути StandWatch.\r\n\r\n" + ex.Message +
                "\r\n\r\nЯкщо StandWatch уже запущений, закрийте його та повторіть спробу.",
                "StandWatch — помилка встановлення",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }

    private static void ExtractPayload(string installDir)
    {
        var assembly = Assembly.GetExecutingAssembly();
        var resourceName = assembly.GetManifestResourceNames()
            .Single(n => n.EndsWith(".payload.zip", StringComparison.OrdinalIgnoreCase));
        using var stream = assembly.GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException("Вбудований пакет StandWatch не знайдено.");
        using var archive = new ZipArchive(stream, ZipArchiveMode.Read);
        var root = Path.GetFullPath(installDir) + Path.DirectorySeparatorChar;

        foreach (var entry in archive.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name)) continue;
            var relative = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            var destination = Path.GetFullPath(Path.Combine(installDir, relative));
            if (!destination.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException("Некоректний шлях у вбудованому пакеті.");

            // User state survives launcher upgrades. Clean defaults are extracted only once.
            var isUserData = relative.StartsWith("data" + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
            if (isUserData && File.Exists(destination)) continue;

            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            var temporary = destination + ".standwatch-update";
            using (var input = entry.Open())
            using (var output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None))
                input.CopyTo(output);
            File.Move(temporary, destination, true);
        }
    }
}
