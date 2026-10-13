import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// root locates the checkout independently of the directory used to launch this check.
const root = fileURLToPath(new URL('../', import.meta.url))

// run executes a bounded local check and includes diagnostics only when it fails.
function run (command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

// checkPackage verifies the archive allowlist and runs its entry point in a temporary workspace.
async function checkPackage () {
  const temporary = await mkdtemp(path.join(tmpdir(), 'loom-package-'))
  try {
    run('pnpm', ['pack', '--pack-destination', temporary], root)
    const archives = (await readdir(temporary)).filter(name => name.endsWith('.tgz'))
    assert.equal(archives.length, 1)
    const archive = path.join(temporary, archives[0])
    const files = run('tar', ['-tzf', archive], root).trim().split('\n')
    for (const file of files) {
      assert.match(file, /^package\/(?:bin\/|src\/|docs\/(?:architecture|sandbox)\.md$|package\.json$|README(?:\.zh-CN)?\.md$|LICENSE$|NOTICE$)/, `Unexpected packaged file: ${file}`)
      assert.doesNotMatch(file, /(?:^|\/)\.\.(?:\/|$)/)
    }
    for (const required of ['bin/loom.js', 'src/index.js', 'LICENSE', 'NOTICE']) assert.ok(files.includes(`package/${required}`), `Missing ${required}`)
    run('tar', ['-xzf', archive, '-C', temporary], root)
    const packed = path.join(temporary, 'package')
    const manifest = JSON.parse(await readFile(path.join(packed, 'package.json'), 'utf8'))
    assert.equal(manifest.bin.loom, 'bin/loom.js')
    assert.equal(manifest.exports, './src/index.js')
    assert.equal(manifest.license, 'MIT')
    assert.ok((await stat(path.join(packed, 'bin/loom.js'))).mode & 0o111)
    await symlink(path.join(root, 'node_modules'), path.join(packed, 'node_modules'), 'dir')
    const workspace = path.join(temporary, 'workspace')
    await mkdir(workspace)
    await writeFile(path.join(workspace, 'example.txt'), 'Package smoke fixture\n')
    const entry = path.join(packed, 'bin/loom.js')
    assert.match(run(process.execPath, [entry, '--help'], workspace), /deepseek\/deepseek-v4\.1-flash/)
    const events = run(process.execPath, [entry, '--demo', '--print', 'Inspect the workspace', '--json'], workspace).trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.type === 'tool.end' && !event.result.isError && event.result.text.includes('example.txt')))
    assert.ok(events.some(event => event.type === 'status' && event.text === 'idle'))
    const catalog = JSON.parse(run(process.execPath, [entry, 'resume', '--list', '--json'], workspace))
    assert.equal(catalog.sessions.length, 1)
    assert.equal(catalog.sessions[0].status, 'completed')
    assert.equal(catalog.sessions[0].busy, false)
    run(process.execPath, ['--input-type=module', '-e', 'const api = await import(process.argv[1]); if (!api.Agent || !api.Session || !api.Dispatcher) process.exit(1)', path.join(packed, 'src/index.js')], workspace)
    process.stdout.write(`Package smoke check passed (${files.length} files; offline CLI and SDK exports).\n`)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

// The check reports errors after cleaning its temporary archive and workspace.
checkPackage().catch(error => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})
