// Credit line with the app version (from the root package.json, injected at build
// time). Plain DOM, so it never shows up in rendered shots.

/* global __APP_VERSION__ */
export function addCredit() {
  const footer = document.createElement('footer');
  footer.className = 'credit';
  footer.textContent = `Made with ❤️ by Stitch · v${__APP_VERSION__}`;
  document.body.append(footer);
}
