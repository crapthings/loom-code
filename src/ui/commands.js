// createCommands defines slash-command names, aliases, argument rules, and callbacks in one registry.
export function createCommands (actions, t) {
  const definitions = {
    help: { execute: actions.help },
    mode: { aliases: ['permissions'], argument: 'optional', execute: actions.mode },
    language: { aliases: ['lang'], argument: 'optional', execute: actions.language },
    sandbox: { execute: actions.sandbox },
    queue: { argument: 'required', execute: actions.queue },
    stop: { execute: actions.stop },
    continue: { execute: actions.continue },
    compact: { execute: actions.compact },
    undo: { execute: actions.undo },
    memory: { argument: 'optional', execute: actions.memory },
    status: { execute: actions.status },
    exit: { execute: actions.exit }
  }
  const registry = new Map()
  for (const [name, definition] of Object.entries(definitions)) {
    if (typeof definition.execute !== 'function') throw new Error(`Missing command action: ${name}`)
    for (const alias of [name, ...(definition.aliases || [])]) registry.set(alias, definition)
  }
  return {
    list: () => [...registry.keys()].map(name => ({ name, description: t(`command.${name}`) })),
    execute: (name, argument) => {
      const command = registry.get(name)
      if (!command) throw new Error(t('command.unknown'))
      if ((!command.argument && argument) || (command.argument === 'required' && !argument)) throw new Error(t('command.arguments', { command: name }))
      return command.execute(argument)
    }
  }
}
