using AssetRipper.Export.Configuration;
using AssetRipper.Export.PrimaryContent;
using AssetRipper.Export.UnityProjects;
using AssetRipper.Import.Logging;
using AssetRipper.IO.Files;
using AssetRipper.Processing;

namespace SubwayRipper;

// Usage: ripper <output-dir> <input>...
//   <output-dir>/ExportedProject, AuxiliaryFiles   Unity project export (YAML prefabs, materials, metas)
//   <output-dir>/Files                             primary content export (glb per prefab/mesh, png)
// Progress lines start with "@@" so callers can parse them; everything else is AssetRipper's log.
static class Program
{
	static int Main(string[] args)
	{
		if (args.Length < 2)
		{
			Console.Error.WriteLine("Usage: ripper <output-dir> <input>...");
			return 2;
		}
		string output = Path.GetFullPath(args[0]);
		string[] inputs = args[1..].Select(Path.GetFullPath).ToArray();

		Logger.Add(new ProgressLogger());
		// AssetRipper defaults to a "temp" folder next to the executable and never empties it
		string temp = output + ".tmp";
		LocalFileSystem.Instance.TemporaryDirectory = temp;
		try
		{
			FullConfiguration settings = new();
			ExportHandler handler = new(settings);

			Stage("load");
			GameData gameData = handler.LoadAndProcess(inputs, LocalFileSystem.Instance);

			if (Directory.Exists(output))
			{
				Directory.Delete(output, true);
			}

			Stage("export-project");
			handler.Export(gameData, output, LocalFileSystem.Instance);

			Stage("export-content");
			settings.ExportRootPath = Path.Join(output, "Files");
			PrimaryContentExporter.CreateDefault(gameData, settings).Export(gameData.GameBundle, settings, LocalFileSystem.Instance);

			Stage("done");
			return 0;
		}
		catch (Exception ex)
		{
			Console.WriteLine($"@@error {ex.Message.ReplaceLineEndings(" ")}");
			Console.Error.WriteLine(ex);
			return 1;
		}
		finally
		{
			if (Directory.Exists(temp))
			{
				Directory.Delete(temp, true);
			}
		}
	}

	static void Stage(string name) => Console.WriteLine($"@@stage {name}");

	private sealed class ProgressLogger : ILogger
	{
		public void Log(LogType type, LogCategory category, string message)
		{
			if (type is LogType.Error or LogType.Warning or LogType.Info)
			{
				Console.WriteLine($"[{type}] {category}: {message}");
			}
		}

		public void BlankLine(int numLines) { }
	}
}
