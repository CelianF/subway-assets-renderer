// One-time setup (macOS / Windows / Linux): builds the headless AssetRipper CLI and
// installs the viewer. Usage: npm run setup [-- --self-contained]
//   default            dist/ripper/ripper.dll  (portable, needs the .NET 10 runtime)
//   --self-contained   dist/ripper-native/      (this OS only, no .NET needed to run)
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = process.platform === 'win32';
const selfContained = process.argv.includes('--self-contained');

function findDotnet() {
  const local = path.join(ROOT, '.tools', 'dotnet', IS_WIN ? 'dotnet.exe' : 'dotnet');
  if (existsSync(local)) return local;
  try {
    execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
    return 'dotnet';
  } catch {
    console.error('The .NET 10 SDK is required to build the extractor: https://dotnet.microsoft.com/download/dotnet/10.0');
    process.exit(1);
  }
}

const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: IS_WIN && cmd === 'npm' });

if (!existsSync(path.join(ROOT, 'third_party', 'AssetRipper', 'Source'))) {
  run('git', ['submodule', 'update', '--init', '--depth', '1', 'third_party/AssetRipper']);
}

const dotnet = findDotnet();
const project = path.join(ROOT, 'tools', 'ripper', 'Ripper.csproj');
if (selfContained) {
  const rid = `${IS_WIN ? 'win' : process.platform === 'darwin' ? 'osx' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
  run(dotnet, ['publish', project, '-c', 'Release', '-r', rid, '--self-contained', 'true', '-o', path.join(ROOT, 'dist', 'ripper-native')]);
} else {
  run(dotnet, ['publish', project, '-c', 'Release', '-o', path.join(ROOT, 'dist', 'ripper')]);
}
run('npm', ['install'], path.join(ROOT, 'viewer'));
console.log('\nSetup done. Start the app with: npm run dev');
