#!/usr/bin/env node
import { main } from '../src/cli.js'

// The entry point reports startup failures without leaving a terminal in raw mode.
main().catch(error => {
  process.stderr.write(`loom: ${error.message}\n`)
  process.exitCode = 1
})
