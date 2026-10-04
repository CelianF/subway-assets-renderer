using AssetRipper.Export.Configuration;
using AssetRipper.Export.PrimaryContent;
using AssetRipper.Export.UnityProjects;
using AssetRipper.Import.Logging;
using AssetRipper.IO.Files;
using AssetRipper.Processing;
using System.Reflection;

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
			// Debugging aid: SUBWAY_SHADER_EXPORT=Decompile (or Yaml) exports real shader code
			// instead of the editor dummies the importer gets by default
			if (Enum.TryParse(Environment.GetEnvironmentVariable("SUBWAY_SHADER_EXPORT"), out ShaderExportMode shaderMode))
			{
				settings.ExportSettings.ShaderExportMode = shaderMode;
			}
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
			ExportPrimaryContent(PrimaryContentExporter.CreateDefault(gameData, settings), gameData, settings);

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

	/// <summary>
	/// PrimaryContentExporter.Export, but one broken asset (e.g. a prefab whose transform
	/// holds NaN) is skipped with a warning instead of aborting the whole export.
	/// </summary>
	static void ExportPrimaryContent(PrimaryContentExporter exporter, GameData gameData, FullConfiguration settings)
	{
		MethodInfo? createCollections = typeof(PrimaryContentExporter).GetMethod("CreateCollections", BindingFlags.Instance | BindingFlags.NonPublic);
		if (createCollections is null)
		{
			exporter.Export(gameData.GameBundle, settings, LocalFileSystem.Instance); // AssetRipper changed: plain export
			return;
		}
		var collections = (List<ExportCollectionBase>)createCollections.Invoke(exporter, [gameData.GameBundle])!;
		int skipped = 0;
		for (int i = 0; i < collections.Count; i++)
		{
			ExportCollectionBase collection = collections[i];
			if (!collection.Exportable)
			{
				continue;
			}
			Logger.Info(LogCategory.ExportProgress, $"({i + 1}/{collections.Count}) Exporting '{collection.Name}'");
			try
			{
				if (!collection.Export(settings.ExportRootPath, LocalFileSystem.Instance))
				{
					Logger.Warning(LogCategory.ExportProgress, $"Failed to export '{collection.Name}'");
				}
			}
			catch (Exception ex)
			{
				skipped++;
				Logger.Warning(LogCategory.ExportProgress, $"Skipped '{collection.Name}': {ex.Message.ReplaceLineEndings(" ")}");
			}
		}
		if (skipped > 0)
		{
			Console.WriteLine($"@@warning {skipped} asset(s) could not be exported and were skipped");
		}
	}

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
