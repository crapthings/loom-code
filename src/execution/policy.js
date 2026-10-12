import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// runtimeRoot identifies the installed harness that sandboxed commands must never rewrite.
export const runtimeRoot = fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/, '')

// protectedNames marks harness metadata, executable project configuration, and common credential directories.
export const protectedNames = ['.git', '.loom', '.agents', '.codex', '.claude', '.ssh', '.aws', '.gnupg', '.docker', '.vscode', '.idea']

// isCredentialPath recognizes common secret files while allowing documented environment examples.
export function isCredentialPath (file) {
  return file.split(path.sep).some(name => (name === '.env' || name.startsWith('.env.')) && name !== '.env.example') || /(?:^|\/)(?:id_rsa|id_ed25519)(?:$|\.)|\.(?:key|pem)$/.test(file)
}

// sandboxPolicy confines writes and denies personal directories, credentials, metadata, and network access.
export function sandboxPolicy (cwd, scratch) {
  const literal = name => ({ path: name, literal: true })
  const protectedPaths = protectedNames.map(name => path.join(cwd, name))
  const secrets = [path.join(cwd, '**/.env'), path.join(cwd, '**/.env.*'), path.join(cwd, '**/*.key'), path.join(cwd, '**/*.pem'), path.join(cwd, '**/id_rsa'), path.join(cwd, '**/id_ed25519')]
  const credentialWrites = ['.env', '.env.local', '.env.production', '.env.development', 'id_rsa', 'id_ed25519'].map(name => path.join(cwd, name))
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true, allowUnixSockets: [], allowAllUnixSockets: false, allowLocalBinding: false },
    filesystem: {
      denyRead: [...new Set(['/Users', '/home', '/root', homedir(), tmpdir(), '/tmp', '/private/tmp', '/var/tmp'])].map(literal).concat(protectedNames.filter(name => name !== '.git').map(name => literal(path.join(cwd, name))), secrets),
      allowRead: [cwd, scratch, path.dirname(process.execPath)].map(literal),
      allowWrite: [cwd, scratch].map(literal),
      denyWrite: [...protectedPaths, ...credentialWrites, runtimeRoot, '/tmp/claude', '/private/tmp/claude'].map(literal).concat(process.platform === 'darwin' ? secrets : [])
    },
    enableWeakerNestedSandbox: false,
    enableWeakerNetworkIsolation: false
  }
}

// shellEnvironment provides only essential non-secret variables and isolated home and cache directories.
export function shellEnvironment (scratch) {
  return {
    PATH: [path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    HOME: scratch,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    XDG_CACHE_HOME: scratch,
    npm_config_cache: path.join(scratch, 'npm'),
    LANG: process.env.LANG || 'en_US.UTF-8',
    TERM: 'dumb'
  }
}
