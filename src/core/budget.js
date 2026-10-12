// Budget shares model-call and wall-clock limits across a run and its delegated agents.
export class Budget {
  constructor ({ steps = 30, milliseconds = 15 * 60 * 1000 } = {}) {
    this.remaining = steps
    this.deadline = Date.now() + milliseconds
    this.calls = 0
    this.tokens = 0
    this.cost = 0
  }

  take () {
    if (this.remaining <= 0) throw new Error('Run model-call budget exhausted')
    if (Date.now() >= this.deadline) throw new Error('Run time budget exhausted')
    this.remaining--
    this.calls++
  }

  account (usage) {
    this.tokens += usage?.totalTokens || 0
    this.cost += usage?.cost?.total || 0
  }
}
