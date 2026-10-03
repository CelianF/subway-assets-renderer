// Updates from the GitHub releases (electron-updater reads the latest*.yml files
// electron-builder attaches to each release). Packaged builds only: an update downloads in
// the background, then the app offers to restart; declined, it installs on quit.
import { app, dialog } from 'electron';
import updater from 'electron-updater';

const { autoUpdater } = updater;
const CHECK_EVERY = 6 * 60 * 60 * 1000;

export function startUpdates(getWindow) {
  // Unpackaged runs, and Linux outside an AppImage (nothing to replace)
  if (!app.isPackaged || (process.platform === 'linux' && !process.env.APPIMAGE)) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  let offered = false;
  autoUpdater.on('error', (e) => console.error('update:', e?.message ?? e)); // offline, rate limit…
  autoUpdater.on('update-downloaded', async ({ version }) => {
    if (offered) return;
    offered = true;
    const options = {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: `Version ${version} is ready`,
      detail: 'Restart to update now, or it installs the next time you quit.',
    };
    const window = getWindow();
    const { response } = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
    if (response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_EVERY);
}
