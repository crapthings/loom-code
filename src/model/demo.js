import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// createDemoModel demonstrates a real tool round trip without credentials or network calls.
export function createDemoModel () {
  return {
    label: 'demo/local',
    contextWindow: 32000,
    complete: async ({ messages, tools }, { signal, onDelta }) => {
      const last = messages.at(-1)
      if (last?.role === 'user' && tools.some(tool => tool.name === 'list_files')) {
        return demoResponse([{ type: 'text', text: '我先查看工作区文件，确认实际目录结构。' }, { type: 'toolCall', id: randomUUID(), name: 'list_files', arguments: { path: '.' } }], 'toolUse')
      }
      const output = messages.findLast(message => message.role === 'toolResult')?.content?.[0]?.text || 'No tool output'
      const text = `已完成一次真实的文件工具调用。\n\n工作区结果：\n\n\`\`\`text\n${output.slice(0, 1500)}\n\`\`\`\n\n这是离线演示模型；真实编码请设置 AI_GATEWAY_API_KEY，可通过 --model 选择模型。\n会话日志、审批、取消、输入排队与上下文机制均由实际编排核心处理。`
      for (const word of text.match(/.{1,12}/gs) || []) {
        await delay(8, undefined, { signal })
        onDelta(word)
      }
      return demoResponse([{ type: 'text', text }], 'stop')
    }
  }
}

// demoResponse supplies the same assistant envelope consumed by real provider responses.
function demoResponse (content, stopReason) {
  return { role: 'assistant', content, stopReason, api: 'demo', provider: 'demo', model: 'local', usage: { input: 0, output: 0, totalTokens: 0, cost: { total: 0 } }, timestamp: Date.now() }
}
