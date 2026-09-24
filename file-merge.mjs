import { rawLineDiff } from './yaml-reconcile.mjs';

const modeOf = value => typeof value === 'string' ? value : value?.mode;

export function mergeTextHunks(baselineText, installerText, decisions = {}) {
  const diff = rawLineDiff(baselineText, installerText);
  if (diff.truncated) throw new Error('файл завеликий для безпечного merge; рядковий diff обрізано');
  const output = [];
  const unresolved = [];
  let index = 0, hunk = -1;
  while (index < diff.lines.length) {
    if (diff.lines[index].type === 'same') {
      output.push(diff.lines[index].text); index++; continue;
    }
    hunk++;
    const server = [], installer = [];
    while (index < diff.lines.length && diff.lines[index].type !== 'same') {
      const line = diff.lines[index++];
      (line.type === 'remove' ? server : installer).push(line.text);
    }
    const decision = decisions[hunk] ?? decisions[String(hunk)], mode = modeOf(decision);
    if (mode === 'server') output.push(...server);
    else if (mode === 'installer') output.push(...installer);
    else if (mode === 'manual' && decision && typeof decision === 'object' && typeof decision.text === 'string') {
      if (decision.text !== '') output.push(...decision.text.split(/\r?\n/));
    } else unresolved.push(hunk);
  }
  return { targetText: output.join('\n'), hunkCount: hunk + 1, unresolved };
}

export function redactMergeDecisions(decisions = {}) {
  const result = {};
  for (const [key, value] of Object.entries(decisions)) {
    const mode = modeOf(value);
    if (mode === 'server' || mode === 'installer') result[key] = mode;
    else if (mode === 'manual') result[key] = { mode: 'manual', text: '[redacted]', bytes: Buffer.byteLength(String(value?.text || ''), 'utf8') };
  }
  return result;
}
