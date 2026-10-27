import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = join(root, '.runtime/electron/runtime');
const output = join(root, 'dist/RIN-win32-x64');
const appOnly = process.argv.includes('--app-only');
if (!existsSync(join(runtime, 'electron.exe'))) throw new Error('Run desktop/prepare.ps1 first.');
mkdirSync(output, { recursive: true });
for (const item of appOnly ? [] : readdirSync(runtime, { withFileTypes: true })) {
  cpSync(join(runtime, item.name), join(output, item.name === 'electron.exe' ? 'RIN.exe' : item.name), { recursive: item.isDirectory() });
}
const application = join(output, 'resources/app');
mkdirSync(application, { recursive: true });
for (const name of ['app', 'public', 'prompts']) cpSync(join(root, name), join(application, name), { recursive: true });
mkdirSync(join(application, 'desktop'), { recursive: true });
for (const name of ['main.cjs', 'preload.cjs', 'policy.cjs', 'backup.cjs', 'backend.mjs', 'widget-smoke.cjs', 'widget-mouse.ps1', 'notification.cjs', 'notification-preload.cjs', 'lifestyle-smoke.cjs', 'review-smoke.cjs', 'activity-smoke.cjs', 'widget-stay-smoke.cjs']) copyFileSync(join(root, 'desktop', name), join(application, 'desktop', name));
for (const name of readdirSync(root).filter(name => name.endsWith('.ps1'))) copyFileSync(join(root, name), join(application, name));
mkdirSync(join(application, 'runtime'), { recursive: true });
if (!appOnly || !existsSync(join(application, 'runtime/node.exe'))) copyFileSync(process.execPath, join(application, 'runtime/node.exe'));
writeFileSync(join(application, 'desktop/install-context.json'), JSON.stringify({ legacyRoot: root }, null, 2));
writeFileSync(join(application, 'package.json'), JSON.stringify({ name: 'rin-desktop', productName: '아사', version: '0.3.0', main: 'desktop/main.cjs', private: true }, null, 2));
copyFileSync(join(root, 'docs/desktop.md'), join(output, '사용 안내.md'));
console.log(join(output, 'RIN.exe'));
