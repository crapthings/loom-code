import standard from 'standard'
import { readFile } from 'node:fs/promises'

// Standard's cache stays disabled so verification never writes outside this repository.
standard.eslintConfig.cache = false

// results contains the canonical Standard Style diagnostics for all project JavaScript.
const results = await standard.lintFiles([], { fix: process.argv.includes('--fix') })

// summaries checks the user's one-line explanation requirement on top-level declarations.
const summaries = new standard.eslint.Linter()
summaries.defineRule('top-level-summary', {
  create: context => ({
    Program: node => {
      for (const outer of node.body) {
        const declaration = outer.type === 'ExportNamedDeclaration' ? outer.declaration : outer
        if (!declaration || !['VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration'].includes(declaration.type)) continue
        const comment = context.getSourceCode().getCommentsBefore(outer).at(-1)
        if (!comment || comment.type !== 'Line' || comment.loc.end.line !== outer.loc.start.line - 1) {
          context.report({ node: outer, message: 'Explain this top-level declaration with one preceding line comment.' })
        }
      }
    }
  })
})

for (const result of results) {
  const source = await readFile(result.filePath, 'utf8')
  const comments = summaries.verify(source, { parserOptions: { ecmaVersion: 2022, sourceType: 'module' }, rules: { 'top-level-summary': 'error' } })
  for (const message of [...result.messages, ...comments]) {
    process.stderr.write(`${result.filePath}:${message.line}:${message.column} ${message.message}\n`)
    process.exitCode = 1
  }
}
