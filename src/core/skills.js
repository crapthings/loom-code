import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { Type } from '@earendil-works/pi-ai'

// discoverSkills indexes bounded project skill descriptions without executing their instructions.
export async function discoverSkills (cwd) {
  const root = await realpath(cwd)
  const directory = path.join(root, '.agents', 'skills')
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const skills = []
  for (const entry of entries.filter(entry => entry.isDirectory()).slice(0, 50)) {
    const file = path.join(directory, entry.name, 'SKILL.md')
    try {
      if (!(await lstat(file)).isFile()) continue
      const canonical = await realpath(file)
      if (!canonical.startsWith(`${root}${path.sep}`)) continue
      const text = (await readFile(canonical, 'utf8')).slice(0, 32000)
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
      const description = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1].replace(/^['"]|['"]$/g, '') || 'Project workflow instructions'
      skills.push({ name: entry.name, description: description.slice(0, 300), file: canonical })
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return skills
}

// skillTool exposes discovered skill identifiers and loads their current instruction text on demand.
export function skillTool (skills) {
  return {
    name: 'load_skill',
    description: 'Load a discovered project skill by name when its description matches the task.',
    effect: 'read',
    parallel: true,
    parameters: Type.Object({ name: Type.String() }),
    execute: async ({ name }) => {
      const skill = skills.find(skill => skill.name === name)
      if (!skill) throw new Error('Unknown project skill')
      if (!(await lstat(skill.file)).isFile() || await realpath(skill.file) !== skill.file) throw new Error('Skill path changed after discovery')
      const text = await readFile(skill.file, 'utf8')
      if (Buffer.byteLength(text) > 32000) throw new Error('Skill exceeds the 32 KiB limit; split its resources')
      return `Skill: ${name}\nSource: ${skill.file}\n${text}`
    }
  }
}
