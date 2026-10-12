// modes lists the user-selectable permission levels displayed by the terminal interface.
export const modes = {
  ask: { label: '逐次询问', description: '文件写入和主机命令均需批准' },
  edit: { label: '自动编辑', description: '自动写文件，主机命令仍需批准' },
  auto: { label: '完全自动', description: '自动写文件和执行主机命令，无 OS 沙箱' },
  plan: { label: '只读规划', description: '只能读取，禁止文件修改和命令执行' }
}

// validateMode rejects unknown permission levels before any runtime state changes.
export function validateMode (mode) {
  if (!Object.hasOwn(modes, mode)) throw new Error('Permission mode must be ask, edit, auto, or plan')
  return mode
}
