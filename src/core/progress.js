import { createHash } from 'node:crypto'

// repeatableReads identifies inspection tools whose identical inputs and outputs can reveal circular investigation.
const repeatableReads = new Set(['list_files', 'search', 'read_file', 'read_artifact', 'search_history', 'read_history', 'list_memories', 'get_memory', 'load_skill'])

// historyReads distinguishes source recall from current-workspace observations.
const historyReads = new Set(['search_history', 'read_history'])

// reviewReasons describes observed patterns without asserting that a task has failed or succeeded.
const reviewReasons = {
  repeated_reads: 'The recent round repeated reads with identical arguments and results at least three times.',
  failed_tools: 'Three consecutive tool rounds returned only errors.',
  empty_searches: 'Three consecutive search rounds found no matches in their reported scope.',
  history_only: 'Six consecutive tool rounds inspected only historical records, without checking the current workspace.',
  silent: 'Several tool rounds or about a minute passed without a visible findings update.'
}

// canonical serializes argument objects independently of provider key ordering.
function canonical (value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}

// resultFacts extracts bounded comparison evidence while ignoring changing history scan counters.
function resultFacts (call, result) {
  let text = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n')
  let empty = call.name === 'search' && text.startsWith('No matches in ')
  if (call.name === 'search_history' && !result.isError) {
    try {
      const data = JSON.parse(text)
      if (Array.isArray(data.results)) { empty = data.results.length === 0; text = JSON.stringify(data.results) }
    } catch {}
  }
  const key = createHash('sha256').update(JSON.stringify([call.name, canonical(call.arguments), result.isError, text])).digest('hex')
  return { key, empty: !result.isError && empty }
}

// ProgressMonitor detects bounded execution patterns and requests reassessment without imposing a run budget.
export class ProgressMonitor {
  constructor (now = Date.now()) {
    this.seen = new Map()
    this.rounds = 0
    this.silent = 0
    this.failed = 0
    this.empty = 0
    this.history = 0
    this.lastReport = now
    this.lastReview = -Infinity
    this.recent = []
  }

  observe ({ response, calls, results, now = Date.now(), reportedAt = now }) {
    if (!calls.length) return null
    this.rounds++
    const reported = response.content.some(part => part.type === 'text' && part.text.trim())
    if (reported) this.lastReport = reportedAt
    this.silent = reported ? 0 : this.silent + 1
    let repeated = true
    let empty = true
    const roundKeys = new Map()
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index]
      const result = results[index]
      const facts = resultFacts(call, result)
      empty &&= facts.empty
      if (repeatableReads.has(call.name)) {
        const count = Math.min(3, (this.seen.get(facts.key) || 0) + 1)
        roundKeys.set(facts.key, count)
        repeated &&= count >= 3
      } else repeated = false
      this.recent.push({ callId: call.id, tool: call.name, outcome: result.isError ? 'error' : 'returned', empty: facts.empty })
    }
    for (const [key, count] of roundKeys) {
      this.seen.delete(key)
      this.seen.set(key, count)
    }
    while (this.seen.size > 64) this.seen.delete(this.seen.keys().next().value)
    this.recent = this.recent.slice(-8)
    this.failed = results.every(result => result.isError) ? this.failed + 1 : 0
    this.empty = empty ? this.empty + 1 : 0
    this.history = calls.every(call => historyReads.has(call.name)) ? this.history + 1 : 0
    const reasons = []
    if (repeated) reasons.push('repeated_reads')
    if (this.failed >= 3) reasons.push('failed_tools')
    if (this.empty >= 3) reasons.push('empty_searches')
    if (this.history >= 6) reasons.push('history_only')
    if (this.silent >= 6 || now - this.lastReport >= 60000) reasons.push('silent')
    if (!reasons.length || this.rounds - this.lastReview < 3) return null
    const notice = { reasons, rounds: this.rounds, recent: this.recent, streaks: { failed: this.failed, empty: this.empty, history: this.history, silent: this.silent } }
    this.lastReview = this.rounds
    this.lastReport = now
    this.silent = 0
    return notice
  }
}

// progressInstructions turns recorded warning patterns into a next-step evidence and verification review.
export function progressInstructions (notice) {
  if (!notice) return ''
  return `\nHarness progress review (execution observations, not a new user task):
${notice.reasons.map(reason => reviewReasons[reason]).join('\n')}
Recent tool outcomes: ${JSON.stringify(notice.recent)}
Reassess before the next calls. Briefly tell the user the original symptom or requirement, what the evidence supports or rules out, and the next discriminating check. Pair this update with useful tools when work remains.
Inspect scope/exclusions after empty searches; repeated absence in omitted files proves nothing. Leave historical recall once it stops yielding relevant source evidence and inspect current code. Separate probe/mock failures from the application's failure. Reuse known results unless inputs or the underlying state changed; explain a legitimate repeated observation rather than changing arguments just to appear different.
Before a completion answer, map each original requirement and correction to current evidence and state any verification gap. A tool returning successfully, a saved file, or exit code zero does not establish correctness. For a visual symptom, use an actual rendering observation or explicitly report that the visual result remains unverified. Continue authorized useful work; do not ask for permission merely because this review fired.`
}
