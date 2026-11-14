/** Cross-platform post-tsc validation; never opens a vault or reads a password. */
import { chmodSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const cli = fileURLToPath(new URL('../lib/cli.js', import.meta.url))
chmodSync(cli, 0o755)
const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
if (!version) throw new Error('The compiled CLI did not report its version.')
console.log('host build ok (cli starts)')
