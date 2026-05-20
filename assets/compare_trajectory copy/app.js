import { Tiktoken } from 'https://esm.sh/js-tiktoken/lite';

const { createApp } = window.Vue;

const MODEL_TO_ENCODING = {
  'gpt-4.1': 'o200k_base',
  'gpt-4o': 'o200k_base',
  'gpt-4o-mini': 'o200k_base',
  o1: 'o200k_base',
  o3: 'o200k_base',
  'o3-mini': 'o200k_base',
  'gpt-4-turbo': 'cl100k_base',
  'gpt-4': 'cl100k_base',
  'gpt-3.5-turbo': 'cl100k_base'
};

const encodingCache = new Map();

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function shortText(value, limit = 220) {
  const clean = String(value || '').replace(/\s+/g, ' ').trim();
  if (!clean) {
    return '';
  }
  return clean.length > limit ? clean.slice(0, limit - 3) + '...' : clean;
}

function shortMultiline(value, limit = 440) {
  const clean = String(value || '').trim();
  if (!clean) {
    return '';
  }
  return clean.length > limit ? clean.slice(0, limit - 3) + '...' : clean;
}

function numberFormat(value) {
  if (value === null || value === undefined || value === '') {
    return 'n/a';
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return String(value);
  }
  return new Intl.NumberFormat().format(number);
}

function formatTimestamp(value) {
  if (!value) {
    return 'n/a';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString();
}

function parseArguments(raw) {
  if (!raw) {
    return {};
  }
  if (typeof raw === 'object') {
    return raw;
  }
  const parsed = safeJsonParse(raw);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

function primaryCommand(raw) {
  const input = String(raw || '').trim();
  if (!input) {
    return 'none';
  }
  const pieces = input.split(/&&|\|\|/).map((piece) => piece.trim()).filter(Boolean);
  const target = pieces.find((piece) => !/^cd\s+/.test(piece)) || pieces[0] || input;
  if (target.startsWith('python - <<')) {
    return 'python-heredoc';
  }
  if (target.startsWith('printf ')) {
    return 'printf';
  }
  const match = target.match(/^([A-Za-z0-9._/-]+)/);
  return match ? match[1] : shortText(target, 40);
}

function parseExitCode(text) {
  const match = String(text || '').match(/(?:Return code:|Process exited with code|<exited with exit code)\s*(-?\d+)/i);
  return match ? Number(match[1]) : null;
}

function parseSessionId(text) {
  const match = String(text || '').match(/session(?:\s+ID)?\s+(\d+)/i);
  return match ? match[1] : '';
}

function countBy(items, selector) {
  const counts = new Map();
  for (const item of items) {
    const key = selector(item);
    if (!key) {
      continue;
    }
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([label, value]) => ({ label, value }));
}

function toBarRows(rows, limit = 6) {
  const subset = rows.slice(0, limit);
  const max = subset.reduce((value, row) => Math.max(value, row.value), 0) || 1;
  return subset.map((row) => ({
    label: row.label,
    value: row.value,
    width: Math.max(8, Math.round((row.value / max) * 100))
  }));
}

function tokenRowsFromTotals(tokens) {
  if (!tokens) {
    return [{ label: 'availability', value: 'n/a' }];
  }
  return [
    { label: 'input', value: numberFormat(tokens.input_tokens) },
    { label: 'output', value: numberFormat(tokens.output_tokens) },
    { label: 'reasoning', value: numberFormat(tokens.reasoning_output_tokens) },
    { label: 'cached', value: numberFormat(tokens.cached_input_tokens) },
    { label: 'total', value: numberFormat(tokens.total_tokens) }
  ];
}

function statusFromExit(exitCode, sessionId, output, done) {
  if (exitCode === 0) {
    return { label: 'ok', css: 'good' };
  }
  if (exitCode !== null && exitCode !== 0) {
    return { label: 'error', css: 'bad' };
  }
  if (done === true) {
    return { label: 'done', css: 'good' };
  }
  if (sessionId || /process running/i.test(String(output || ''))) {
    return { label: 'streaming', css: 'warn' };
  }
  return { label: 'unknown', css: '' };
}

function splitConcatenatedJsonObjects(text) {
  const source = String(text || '');
  const segments = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (start === -1) {
      if (char === '{') {
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        segments.push(source.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return segments.map((segment) => safeJsonParse(segment)).filter(Boolean);
}

function getTokenizerSelection(value) {
  const [mode, name] = String(value || 'model:o3').split(':');
  const encoding = mode === 'model' ? MODEL_TO_ENCODING[name] || 'o200k_base' : name || 'o200k_base';
  return { mode, name: name || 'o3', encoding };
}

async function loadEncoder(encoding) {
  if (encodingCache.has(encoding)) {
    return encodingCache.get(encoding);
  }
  const response = await fetch(`https://tiktoken.pages.dev/js/${encoding}.json`);
  if (!response.ok) {
    throw new Error(`Failed to load ${encoding} ranks from CDN`);
  }
  const ranks = await response.json();
  const encoder = new Tiktoken(ranks);
  encodingCache.set(encoding, encoder);
  return encoder;
}

function mergeEstimateParts(parts) {
  const grouped = new Map();
  for (const part of parts || []) {
    if (!part || !String(part.text || '').trim()) {
      continue;
    }
    const key = part.label || 'other';
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(String(part.text));
  }
  return Array.from(grouped.entries()).map(([label, texts]) => ({
    label,
    text: texts.join('\n\n')
  }));
}

function contentToText(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      if (part && typeof part === 'object') {
        if (typeof part.text === 'string') {
          return part.text;
        }
        if (typeof part.content === 'string') {
          return part.content;
        }
      }
      return part ? JSON.stringify(part) : '';
    }).filter(Boolean).join('\n\n');
  }
  return content ? JSON.stringify(content) : '';
}

function normalizeObservation(message) {
  const extra = message && message.extra ? message.extra : {};
  if (extra.observation && typeof extra.observation === 'object') {
    return {
      output: String(extra.observation.command_output || ''),
      exitCode: typeof extra.observation.returncode === 'number' ? extra.observation.returncode : parseExitCode(extra.observation.command_output || ''),
      command: String(extra.observation.command || ''),
      success: extra.observation.success
    };
  }
  const text = contentToText(message.content);
  if (!/^Observation:/i.test(text)) {
    return null;
  }
  const outputMatch = text.match(/Command output:\n([\s\S]*)$/i);
  const commandMatch = text.match(/Command:\s*([^\n]+)/i);
  return {
    output: outputMatch ? outputMatch[1].trim() : text,
    exitCode: parseExitCode(text),
    command: commandMatch ? commandMatch[1].trim() : '',
    success: /Status:\s*ok/i.test(text)
  };
}

function stripSessionMarkup(text) {
  return String(text || '')
    .replace(/<details>/gi, '')
    .replace(/<\/details>/gi, '')
    .replace(/<summary>.*?<\/summary>/gis, '')
    .replace(/<sub>.*?<\/sub>/gis, '')
    .replace(/^---$/gm, '')
    .trim();
}

function extractCodeFences(text) {
  const fences = [];
  const regex = /(^|\n)(`{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
  let match = regex.exec(text);
  while (match) {
    fences.push({
      fence: match[2],
      language: (match[3] || '').trim(),
      content: match[4]
    });
    match = regex.exec(text);
  }
  return fences;
}

function extractFirstPath(text) {
  const match = String(text || '').match(/\/(?:[^\s`*]|\\ )+/);
  return match ? match[0].replace(/\\ /g, ' ') : '';
}

function parseMarkdownSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let pendingTime = '';
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const timeMatch = line.match(/^<sub>.*?⏱️\s*([^<]+)<\/sub>$/);
    if (timeMatch) {
      pendingTime = timeMatch[1].trim();
      index += 1;
      continue;
    }
    const headingMatch = line.match(/^###\s+(ℹ️ Info|👤 User|💬 Copilot|✅\s+`([^`]+)`)\s*$/);
    if (!headingMatch) {
      index += 1;
      continue;
    }
    const tool = headingMatch[2] || '';
    let type = 'info';
    if (tool) {
      type = 'tool';
    } else if (/User/.test(headingMatch[1])) {
      type = 'user';
    } else if (/Copilot/.test(headingMatch[1])) {
      type = 'copilot';
    }
    let cursor = index + 1;
    const bodyLines = [];
    while (cursor < lines.length) {
      if (lines[cursor].match(/^<sub>.*?⏱️/)) {
        break;
      }
      if (lines[cursor].match(/^###\s+(ℹ️ Info|👤 User|💬 Copilot|✅\s+`[^`]+`)\s*$/)) {
        break;
      }
      bodyLines.push(lines[cursor]);
      cursor += 1;
    }
    sections.push({ type, tool, timeLabel: pendingTime || 'n/a', body: bodyLines.join('\n').trim() });
    pendingTime = '';
    index = cursor;
  }
  return sections;
}

function parseSessionToolSection(section, side, commandOrder, eventOrder) {
  const body = section.body || '';
  const fences = extractCodeFences(body);
  const plainBody = stripSessionMarkup(body);
  const argsFence = fences.find((fence) => fence.language === 'json');
  const parsedArgs = argsFence ? safeJsonParse(argsFence.content.trim()) : null;
  let command = '';
  let output = '';
  let exitCode = null;
  if (section.tool === 'bash') {
    const commandFence = fences.find((fence) => /^\$\s/m.test(fence.content));
    const outputFenceIndex = commandFence ? fences.indexOf(commandFence) + 1 : -1;
    command = commandFence ? commandFence.content.replace(/^\$\s?/, '').trim() : '';
    output = outputFenceIndex > 0 && fences[outputFenceIndex] ? fences[outputFenceIndex].content.trim() : plainBody;
    exitCode = parseExitCode(output);
  } else if (section.tool === 'apply_patch') {
    const patchValue = typeof parsedArgs === 'string' ? parsedArgs : parsedArgs && typeof parsedArgs.input === 'string' ? parsedArgs.input : '';
    command = patchValue ? 'apply_patch ' + shortText(patchValue.split('\n')[0], 80) : 'apply_patch';
    output = fences.length > 1 ? fences[fences.length - 1].content.trim() : plainBody;
  } else if (section.tool === 'view') {
    const path = extractFirstPath(plainBody);
    command = path ? 'view ' + path : 'view';
    output = fences.length ? fences[fences.length - 1].content.trim() : plainBody;
  } else if (section.tool === 'glob') {
    const pattern = fences.length ? fences[0].content.trim() : shortText(plainBody, 120);
    command = pattern ? 'glob ' + pattern : 'glob';
    output = fences.length > 1 ? fences[1].content.trim() : plainBody;
  } else if (section.tool === 'skill') {
    const argsText = parsedArgs ? JSON.stringify(parsedArgs) : shortText(plainBody, 160);
    command = 'skill ' + shortText(argsText, 80);
    output = fences.length ? fences[fences.length - 1].content.trim() : plainBody;
  } else {
    const path = extractFirstPath(plainBody);
    command = section.tool + (path ? ' ' + path : '');
    output = fences.length ? fences[fences.length - 1].content.trim() : plainBody;
  }
  const state = statusFromExit(exitCode, '', output, false);
  return {
    run: {
      id: side + '-session-command-' + commandOrder,
      order: commandOrder,
      command,
      primaryCommand: primaryCommand(command || section.tool),
      channel: section.tool,
      timeLabel: section.timeLabel,
      exitCode,
      outputPreview: shortMultiline(output, 520),
      status: state.label,
      statusClass: state.css
    },
    events: [
      {
        id: side + '-session-event-' + eventOrder,
        kind: 'tool_call',
        summary: shortMultiline(command || plainBody, 460),
        timeLabel: section.timeLabel,
        chips: [section.tool, primaryCommand(command || section.tool)]
      },
      {
        id: side + '-session-event-' + (eventOrder + 1),
        kind: 'tool_result',
        summary: shortMultiline(output || plainBody, 460),
        timeLabel: section.timeLabel,
        chips: [section.tool].concat(exitCode !== null ? ['exit ' + exitCode] : [])
      }
    ],
    estimateParts: [
      parsedArgs ? { label: 'tool arguments', text: typeof parsedArgs === 'string' ? parsedArgs : JSON.stringify(parsedArgs, null, 2) } : null,
      command ? { label: 'tool commands', text: command } : null,
      output ? { label: 'tool outputs', text: output } : null
    ].filter(Boolean)
  };
}

function detectFormat(text) {
  const source = String(text || '').trim();
  if (!source) {
    return null;
  }
  if (/^#\s+🤖\s+Copilot CLI Session/m.test(source) || /^###\s+💬\s+Copilot/m.test(source)) {
    return 'copilot_session_md';
  }
  if (source[0] === '{' || source[0] === '[') {
    const parsed = safeJsonParse(source);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.messages) && parsed.info) {
      return 'trajectory_json';
    }
  }
  const lines = source.split(/\r?\n/).filter(Boolean);
  if (!lines.length) {
    return null;
  }
  const first = safeJsonParse(lines[0]);
  if (!first || typeof first !== 'object') {
    return null;
  }
  if (first.timestamp && first.type) {
    return 'codex_jsonl';
  }
  if (first.event === 'raw_text' && typeof first.raw_text === 'string') {
    return 'raw_response_jsonl';
  }
  return null;
}

function finalizeTrace(base) {
  const commandFamilies = toBarRows(countBy(base.commandRuns, (run) => run.primaryCommand));
  const defaultChannelFamilies = toBarRows(countBy(base.events, (event) => event.kind));
  return {
    side: base.side,
    kind: base.kind,
    formatLabel: base.formatLabel,
    description: base.description,
    fileName: base.fileName,
    filePath: base.filePath,
    taskPrompt: base.taskPrompt,
    events: base.events,
    thoughtEntries: base.thoughtEntries,
    commandRuns: base.commandRuns,
    finalResponses: base.finalResponses,
    metrics: base.metrics,
    commandFamilies,
    channelFamilies: base.channelFamilies || defaultChannelFamilies,
    exactTokens: base.exactTokens || null,
    tokenRows: base.exactTokens ? tokenRowsFromTotals(base.exactTokens) : [{ label: 'availability', value: 'estimate pending' }],
    tokenSourceLabel: base.tokenSourceLabel || 'No exact token snapshot; use tokenizer estimate.',
    tokenModeLabel: base.exactTokens ? 'exact' : 'estimate',
    tokenEstimateParts: mergeEstimateParts(base.tokenEstimateParts || []),
    countedFieldLabels: base.countedFieldLabels || [],
    tokenBasisRows: [],
    tokenEstimateTotal: null,
    tokenEstimateError: '',
    tokenSelectionLabel: '',
    summary: {
      thoughts: base.thoughtEntries.length,
      commands: base.commandRuns.length,
      commandRuns: base.commandRuns.length,
      finalResponses: base.finalResponses.length,
      events: base.events.length
    }
  };
}

function normalizeCodex(text, fileName, filePath, side) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const entries = [];
  const callById = new Map();
  const runByCallId = new Map();
  const runBySession = new Map();
  const commandRuns = [];
  const thoughtEntries = [];
  const finalResponses = [];
  const events = [];
  const estimateParts = [];
  let latestTokens = null;
  let thoughtOrder = 0;
  let commandOrder = 0;
  let userPrompt = '';
  lines.forEach((line) => {
    const item = safeJsonParse(line);
    if (!item || typeof item !== 'object') {
      return;
    }
    entries.push(item);
    if (item.type === 'event_msg' && item.payload && item.payload.type === 'token_count') {
      latestTokens = item.payload.info ? item.payload.info.total_token_usage : null;
    }
  });
  entries.forEach((item, index) => {
    const id = side + '-codex-' + index;
    const timeLabel = formatTimestamp(item.timestamp || '');
    if (item.type === 'event_msg' && item.payload && item.payload.type === 'user_message') {
      const summary = shortMultiline(item.payload.message, 360);
      if (!userPrompt) {
        userPrompt = summary;
      }
      estimateParts.push({ label: 'user messages', text: String(item.payload.message || '') });
      events.push({ id, kind: 'user_message', summary, timeLabel, chips: ['user'] });
      return;
    }
    if (item.type === 'event_msg' && item.payload && item.payload.type === 'agent_message') {
      thoughtOrder += 1;
      const textBody = shortMultiline(item.payload.message, 520);
      thoughtEntries.push({ id, order: thoughtOrder, text: textBody, timeLabel, chips: [item.payload.phase || 'commentary'] });
      estimateParts.push({ label: 'agent messages', text: String(item.payload.message || '') });
      events.push({ id, kind: 'thought', summary: textBody, timeLabel, chips: [item.payload.phase || 'commentary'] });
      if (/final|answer|result/i.test(item.payload.phase || '') && textBody) {
        finalResponses.push({ id: id + '-final', order: finalResponses.length + 1, text: textBody, timeLabel });
      }
      return;
    }
    if (item.type === 'event_msg' && item.payload && item.payload.type === 'token_count') {
      const total = item.payload.info && item.payload.info.total_token_usage ? item.payload.info.total_token_usage : {};
      events.push({
        id,
        kind: 'token_snapshot',
        summary: 'total=' + numberFormat(total.total_tokens) + ', input=' + numberFormat(total.input_tokens) + ', output=' + numberFormat(total.output_tokens),
        timeLabel,
        chips: ['tokens']
      });
      return;
    }
    if (item.type === 'response_item' && item.payload && item.payload.type === 'function_call') {
      const args = parseArguments(item.payload.arguments);
      const tool = item.payload.name || 'unknown';
      const command = args.cmd || args.command || args.bash_command || '';
      callById.set(item.payload.call_id, { tool, args, command });
      if (command) {
        commandOrder += 1;
        const run = {
          id: item.payload.call_id,
          order: commandOrder,
          command,
          primaryCommand: primaryCommand(command),
          channel: tool,
          timeLabel,
          exitCode: null,
          outputPreview: '',
          sessionId: '',
          status: 'started',
          statusClass: ''
        };
        commandRuns.push(run);
        runByCallId.set(item.payload.call_id, run);
        estimateParts.push({ label: 'tool commands', text: command });
      } else if (Object.keys(args).length) {
        estimateParts.push({ label: 'tool arguments', text: JSON.stringify(args, null, 2) });
      }
      events.push({
        id,
        kind: 'tool_call',
        summary: command ? shortMultiline(command, 420) : shortText(JSON.stringify(args), 240),
        timeLabel,
        chips: command ? [tool, primaryCommand(command)] : [tool]
      });
      return;
    }
    if (item.type === 'response_item' && item.payload && item.payload.type === 'function_call_output') {
      const call = callById.get(item.payload.call_id) || {};
      const outputText = Array.isArray(item.payload.output) ? JSON.stringify(item.payload.output) : String(item.payload.output || '');
      const exitCode = parseExitCode(outputText);
      const sessionId = parseSessionId(outputText);
      let run = runByCallId.get(item.payload.call_id) || null;
      if (!run && call.tool === 'write_stdin' && call.args && call.args.session_id) {
        run = runBySession.get(String(call.args.session_id)) || null;
      }
      if (run) {
        if (sessionId && !run.sessionId) {
          run.sessionId = sessionId;
          runBySession.set(sessionId, run);
        }
        if (exitCode !== null) {
          run.exitCode = exitCode;
        }
        if (outputText) {
          run.outputPreview = shortMultiline(outputText, 520);
        }
        const state = statusFromExit(run.exitCode, sessionId, outputText, false);
        run.status = state.label;
        run.statusClass = state.css;
      }
      if (outputText) {
        estimateParts.push({ label: 'tool outputs', text: outputText });
      }
      events.push({
        id,
        kind: 'tool_result',
        summary: shortMultiline(outputText, 460),
        timeLabel,
        chips: [call.tool || 'tool_result'].concat(exitCode !== null ? ['exit ' + exitCode] : sessionId ? ['session ' + sessionId] : [])
      });
    }
  });
  commandRuns.forEach((run) => {
    if (run.status === 'started') {
      const state = statusFromExit(run.exitCode, '', run.outputPreview, false);
      run.status = state.label;
      run.statusClass = state.css;
    }
  });
  const channelFamilies = toBarRows([
    { label: 'thought entries', value: thoughtEntries.length },
    { label: 'command runs', value: commandRuns.length },
    { label: 'tool results', value: events.filter((event) => event.kind === 'tool_result').length },
    { label: 'token snapshots', value: events.filter((event) => event.kind === 'token_snapshot').length },
    { label: 'final responses', value: finalResponses.length }
  ]);
  return finalizeTrace({
    side,
    kind: 'codex_jsonl',
    formatLabel: 'Codex JSONL',
    description: 'Codex CLI session JSONL with user, agent, tool, and token events.',
    fileName,
    filePath,
    taskPrompt: userPrompt,
    events,
    thoughtEntries,
    commandRuns,
    finalResponses,
    exactTokens: latestTokens,
    tokenSourceLabel: latestTokens
      ? 'Exact token snapshot from event_msg.token_count -> payload.info.total_token_usage.'
      : 'No token_count snapshot found; estimate uses recorded user, agent, tool command, and tool output fields from the JSONL.',
    tokenEstimateParts: estimateParts,
    countedFieldLabels: [
      'event_msg.user_message.message',
      'event_msg.agent_message.message',
      'response_item.function_call.arguments.(cmd|command|bash_command)',
      'response_item.function_call_output.output'
    ],
    metrics: [
      { label: 'Events', value: numberFormat(events.length), sub: 'normalized event records' },
      { label: 'Thoughts', value: numberFormat(thoughtEntries.length), sub: 'agent commentary entries' },
      { label: 'Commands', value: numberFormat(commandRuns.length), sub: 'shell commands reconstructed from tool calls' },
      { label: 'Token source', value: latestTokens ? 'exact' : 'estimate', sub: latestTokens ? 'token_count snapshot present' : 'fallback to tokenizer estimate' }
    ],
    channelFamilies
  });
}

function normalizeRawResponses(text, fileName, filePath, side) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const events = [];
  const thoughtEntries = [];
  const commandRuns = [];
  const finalResponses = [];
  const estimateParts = [];
  let thoughtOrder = 0;
  let commandOrder = 0;
  let finalOrder = 0;
  let extractedFrames = 0;
  let emptyFrames = 0;
  let taskPrompt = '';
  lines.forEach((line, lineIndex) => {
    const outer = safeJsonParse(line);
    if (!outer || typeof outer !== 'object') {
      return;
    }
    const timeLabel = formatTimestamp(outer.timestamp || '');
    if (outer.event !== 'raw_text') {
      return;
    }
    const frames = splitConcatenatedJsonObjects(outer.raw_text);
    frames.forEach((frame, frameIndex) => {
      const idBase = side + '-raw-' + lineIndex + '-' + frameIndex;
      const hasThought = !!String(frame.thought || '').trim();
      const hasCommand = !!String(frame.bash_command || '').trim();
      const hasFinal = !!String(frame.final_response || '').trim();
      if (!hasThought && !hasCommand && !hasFinal) {
        emptyFrames += 1;
        return;
      }
      extractedFrames += 1;
      if (hasThought) {
        thoughtOrder += 1;
        const textBody = shortMultiline(frame.thought, 520);
        thoughtEntries.push({ id: idBase + '-thought', order: thoughtOrder, text: textBody, timeLabel, chips: ['attempt ' + (outer.attempt || 'n/a')] });
        estimateParts.push({ label: 'thought fields', text: String(frame.thought || '') });
        events.push({ id: idBase + '-thought-event', kind: 'thought', summary: textBody, timeLabel, chips: ['attempt ' + (outer.attempt || 'n/a')] });
        if (!taskPrompt && /task|search|goal/i.test(textBody)) {
          taskPrompt = textBody;
        }
      }
      if (hasCommand) {
        commandOrder += 1;
        const command = String(frame.bash_command || '').trim();
        const state = statusFromExit(null, '', '', frame.done === true);
        commandRuns.push({
          id: idBase + '-command',
          order: commandOrder,
          command,
          primaryCommand: primaryCommand(command),
          channel: 'bash_command',
          timeLabel,
          exitCode: null,
          outputPreview: hasFinal ? shortMultiline(frame.final_response, 320) : '',
          status: state.label,
          statusClass: state.css
        });
        estimateParts.push({ label: 'bash_command fields', text: command });
        events.push({ id: idBase + '-command-event', kind: 'command', summary: shortMultiline(command, 460), timeLabel, chips: ['attempt ' + (outer.attempt || 'n/a'), primaryCommand(command)] });
      }
      if (hasFinal) {
        finalOrder += 1;
        const responseText = shortMultiline(frame.final_response, 520);
        finalResponses.push({ id: idBase + '-final', order: finalOrder, text: responseText, timeLabel });
        estimateParts.push({ label: 'final_response fields', text: String(frame.final_response || '') });
        events.push({ id: idBase + '-final-event', kind: 'final_response', summary: responseText, timeLabel, chips: ['done=' + Boolean(frame.done)] });
      }
    });
  });
  const channelFamilies = toBarRows([
    { label: 'thought entries', value: thoughtEntries.length },
    { label: 'command frames', value: commandRuns.length },
    { label: 'final responses', value: finalResponses.length },
    { label: 'outer lines', value: lines.length },
    { label: 'empty frames dropped', value: emptyFrames }
  ]);
  return finalizeTrace({
    side,
    kind: 'raw_response_jsonl',
    formatLabel: 'Raw Response JSONL',
    description: 'Webwright raw_responses.jsonl with embedded thought, bash, and final-response frames.',
    fileName,
    filePath,
    taskPrompt,
    events,
    thoughtEntries,
    commandRuns,
    finalResponses,
    tokenSourceLabel: 'No exact token totals in raw_responses.jsonl; estimate uses thought, bash_command, and final_response fields from extracted frames.',
    tokenEstimateParts: estimateParts,
    countedFieldLabels: ['raw_text frame.thought', 'raw_text frame.bash_command', 'raw_text frame.final_response'],
    metrics: [
      { label: 'Outer lines', value: numberFormat(lines.length), sub: 'top-level raw_text records' },
      { label: 'Frames', value: numberFormat(extractedFrames), sub: 'embedded JSON frames extracted from raw_text' },
      { label: 'Thoughts', value: numberFormat(thoughtEntries.length), sub: 'inner thought strings' },
      { label: 'Commands', value: numberFormat(commandRuns.length), sub: 'inner bash_command strings' }
    ],
    channelFamilies
  });
}

function normalizeTrajectory(text, fileName, filePath, side) {
  const parsed = safeJsonParse(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.messages)) {
    throw new Error('Invalid trajectory.json structure');
  }
  const events = [];
  const thoughtEntries = [];
  const commandRuns = [];
  const finalResponses = [];
  const estimateParts = [];
  let latestTokens = null;
  let taskPrompt = '';
  let thoughtOrder = 0;
  let commandOrder = 0;
  let finalOrder = 0;
  let pendingRun = null;
  parsed.messages.forEach((message, index) => {
    const id = side + '-trajectory-' + index;
    const timeLabel = 'step ' + (index + 1);
    const role = message.role || 'unknown';
    const contentText = contentToText(message.content);
    if (role === 'user') {
      const observation = normalizeObservation(message);
      if (observation && pendingRun) {
        if (observation.command && !pendingRun.command) {
          pendingRun.command = observation.command;
          pendingRun.primaryCommand = primaryCommand(observation.command);
        }
        pendingRun.exitCode = observation.exitCode;
        pendingRun.outputPreview = shortMultiline(observation.output, 520);
        const state = statusFromExit(observation.exitCode, '', observation.output, false);
        pendingRun.status = state.label;
        pendingRun.statusClass = state.css;
        estimateParts.push({ label: 'observation outputs', text: observation.output });
        events.push({ id, kind: 'observation', summary: shortMultiline(observation.output, 460), timeLabel, chips: observation.exitCode !== null ? ['exit ' + observation.exitCode] : ['observation'] });
      } else if (contentText) {
        if (!taskPrompt) {
          taskPrompt = shortMultiline(contentText, 360);
        }
        estimateParts.push({ label: 'user messages', text: contentText });
        events.push({ id, kind: 'user_message', summary: shortMultiline(contentText, 420), timeLabel, chips: ['user'] });
      }
      return;
    }
    if (role !== 'assistant') {
      return;
    }
    const extra = message.extra || {};
    const raw = extra.raw_response && typeof extra.raw_response === 'object' ? extra.raw_response : {};
    const usage = extra.usage && typeof extra.usage === 'object' ? (extra.usage.cumulative_response || extra.usage.last_response || extra.usage) : null;
    if (usage && typeof usage.total_tokens === 'number') {
      latestTokens = usage;
    }
    const thoughtText = String(raw.thought || contentText || '').trim();
    const action = Array.isArray(extra.actions) && extra.actions.length ? extra.actions[0] : null;
    const commandText = String(raw.bash_command || (action && (action.bash_command || action.command)) || '').trim();
    const finalText = String(raw.final_response || '').trim();
    const done = raw.done === true || extra.done === true;
    if (thoughtText) {
      thoughtOrder += 1;
      estimateParts.push({ label: 'assistant thoughts', text: thoughtText });
      thoughtEntries.push({ id: id + '-thought', order: thoughtOrder, text: shortMultiline(thoughtText, 520), timeLabel, chips: [done ? 'done' : 'assistant'] });
      events.push({ id: id + '-thought-event', kind: 'thought', summary: shortMultiline(thoughtText, 460), timeLabel, chips: [done ? 'done' : 'assistant'] });
    }
    if (commandText) {
      commandOrder += 1;
      const run = {
        id: id + '-command',
        order: commandOrder,
        command: commandText,
        primaryCommand: primaryCommand(commandText),
        channel: 'bash_command',
        timeLabel,
        exitCode: null,
        outputPreview: '',
        status: 'started',
        statusClass: ''
      };
      pendingRun = run;
      commandRuns.push(run);
      estimateParts.push({ label: 'assistant commands', text: commandText });
      events.push({ id: id + '-command-event', kind: 'command', summary: shortMultiline(commandText, 460), timeLabel, chips: ['assistant', primaryCommand(commandText)] });
    }
    if (finalText) {
      finalOrder += 1;
      estimateParts.push({ label: 'assistant final responses', text: finalText });
      finalResponses.push({ id: id + '-final', order: finalOrder, text: shortMultiline(finalText, 520), timeLabel });
      events.push({ id: id + '-final-event', kind: 'final_response', summary: shortMultiline(finalText, 460), timeLabel, chips: ['done=' + done] });
    }
  });
  commandRuns.forEach((run) => {
    if (run.status === 'started') {
      const state = statusFromExit(run.exitCode, '', run.outputPreview, false);
      run.status = state.label;
      run.statusClass = state.css;
    }
  });
  return finalizeTrace({
    side,
    kind: 'trajectory_json',
    formatLabel: 'Trajectory JSON',
    description: 'Webwright trajectory.json transcript with assistant actions, observations, and usage snapshots.',
    fileName,
    filePath,
    taskPrompt,
    events,
    thoughtEntries,
    commandRuns,
    finalResponses,
    exactTokens: latestTokens,
    tokenSourceLabel: latestTokens
      ? 'Exact token snapshot from messages[].extra.usage.cumulative_response.'
      : 'No usage snapshot found; estimate uses user text, assistant thought, assistant command, assistant final-response, and observation output fields.',
    tokenEstimateParts: estimateParts,
    countedFieldLabels: [
      'messages[].content',
      'messages[].extra.raw_response.thought',
      'messages[].extra.raw_response.bash_command',
      'messages[].extra.raw_response.final_response',
      'messages[].extra.observation.command_output'
    ],
    metrics: [
      { label: 'Messages', value: numberFormat(parsed.messages.length), sub: 'top-level transcript turns' },
      { label: 'Thoughts', value: numberFormat(thoughtEntries.length), sub: 'assistant reasoning entries' },
      { label: 'Commands', value: numberFormat(commandRuns.length), sub: 'assistant bash commands' },
      { label: 'API calls', value: numberFormat(parsed.info && parsed.info.api_calls), sub: 'info.api_calls from trajectory metadata' }
    ]
  });
}

function normalizeCopilotSessionMarkdown(text, fileName, filePath, side) {
  const sections = parseMarkdownSections(text);
  const events = [];
  const thoughtEntries = [];
  const commandRuns = [];
  const finalResponses = [];
  const estimateParts = [];
  let taskPrompt = '';
  let thoughtOrder = 0;
  let commandOrder = 0;
  let eventOrder = 0;
  sections.forEach((section) => {
    if (section.type === 'user') {
      const clean = stripSessionMarkup(section.body);
      const textBody = shortMultiline(clean, 520);
      if (!taskPrompt && textBody) {
        taskPrompt = textBody;
      }
      if (clean) {
        estimateParts.push({ label: 'user sections', text: clean });
        events.push({ id: side + '-session-user-' + eventOrder, kind: 'user_message', summary: textBody, timeLabel: section.timeLabel, chips: ['user'] });
        eventOrder += 1;
      }
      return;
    }
    if (section.type === 'copilot') {
      const clean = stripSessionMarkup(section.body);
      if (!clean) {
        return;
      }
      thoughtOrder += 1;
      estimateParts.push({ label: 'copilot sections', text: clean });
      thoughtEntries.push({ id: side + '-session-thought-' + thoughtOrder, order: thoughtOrder, text: shortMultiline(clean, 520), timeLabel: section.timeLabel, chips: ['copilot'] });
      events.push({ id: side + '-session-copilot-' + eventOrder, kind: 'thought', summary: shortMultiline(clean, 460), timeLabel: section.timeLabel, chips: ['copilot'] });
      eventOrder += 1;
      if (/final|done|complete|result/i.test(clean)) {
        finalResponses.push({ id: side + '-session-final-' + finalResponses.length, order: finalResponses.length + 1, text: shortMultiline(clean, 520), timeLabel: section.timeLabel });
      }
      return;
    }
    if (section.type === 'tool') {
      commandOrder += 1;
      const parsed = parseSessionToolSection(section, side, commandOrder, eventOrder);
      commandRuns.push(parsed.run);
      parsed.events.forEach((event) => events.push(event));
      estimateParts.push(...parsed.estimateParts);
      eventOrder += parsed.events.length;
      return;
    }
    const infoText = stripSessionMarkup(section.body);
    if (infoText) {
      events.push({ id: side + '-session-info-' + eventOrder, kind: 'info', summary: shortMultiline(infoText, 420), timeLabel: section.timeLabel, chips: ['info'] });
      eventOrder += 1;
    }
  });
  const channelFamilies = toBarRows([
    { label: 'user sections', value: events.filter((event) => event.kind === 'user_message').length },
    { label: 'copilot sections', value: thoughtEntries.length },
    { label: 'tool sections', value: commandRuns.length },
    { label: 'info sections', value: events.filter((event) => event.kind === 'info').length }
  ]);
  return finalizeTrace({
    side,
    kind: 'copilot_session_md',
    formatLabel: 'Copilot Session MD',
    description: 'GitHub Copilot CLI markdown session export with user, copilot, and tool sections.',
    fileName,
    filePath,
    taskPrompt,
    events,
    thoughtEntries,
    commandRuns,
    finalResponses,
    tokenSourceLabel: 'No token usage is recorded in this session markdown export; estimate uses user text, copilot text, tool arguments, commands, and tool outputs.',
    tokenEstimateParts: estimateParts,
    countedFieldLabels: ['### User body text', '### Copilot body text', '### ✅ tool Arguments blocks', '### ✅ tool commands / outputs'],
    metrics: [
      { label: 'Sections', value: numberFormat(sections.length), sub: 'top-level markdown sections' },
      { label: 'Thoughts', value: numberFormat(thoughtEntries.length), sub: 'copilot narrative blocks' },
      { label: 'Commands', value: numberFormat(commandRuns.length), sub: 'tool sections mapped to comparable command rows' },
      { label: 'Finals', value: numberFormat(finalResponses.length), sub: 'copilot blocks that look like terminal summaries' }
    ],
    channelFamilies
  });
}

function normalizeTrace(text, fileName, filePath, side) {
  const format = detectFormat(text);
  if (!format) {
    throw new Error('Supported inputs: Codex JSONL, raw_responses.jsonl, trajectory.json, and Copilot session markdown.');
  }
  if (format === 'codex_jsonl') {
    return normalizeCodex(text, fileName, filePath, side);
  }
  if (format === 'raw_response_jsonl') {
    return normalizeRawResponses(text, fileName, filePath, side);
  }
  if (format === 'trajectory_json') {
    return normalizeTrajectory(text, fileName, filePath, side);
  }
  return normalizeCopilotSessionMarkdown(text, fileName, filePath, side);
}

const app = createApp({
  data() {
    return {
      activeView: 'summary',
      traceTab: 'all',
      dragTarget: null,
      left: null,
      right: null,
      errors: { left: '', right: '' },
      tokenTarget: 'model:o3',
      tokenizerStatus: 'Ready.'
    };
  },
  computed: {
    slots() {
      return [
        { key: 'left', title: 'Trace A', subtitle: 'Load Codex JSONL, raw_responses.jsonl, trajectory.json, or Copilot session markdown on this side.' },
        { key: 'right', title: 'Trace B', subtitle: 'Load a second trace and compare thoughts, commands, token source, and extracted outputs.' }
      ];
    },
    tokenizerOptions() {
      return [
        { value: 'model:o3', label: 'o3' },
        { value: 'model:o3-mini', label: 'o3-mini' },
        { value: 'model:gpt-4o', label: 'gpt-4o' },
        { value: 'encoding:o200k_base', label: 'o200k_base' },
        { value: 'encoding:cl100k_base', label: 'cl100k_base' }
      ];
    },
    bothLoaded() {
      return !!(this.left && this.right);
    },
    leftTrace() {
      return this.left;
    },
    rightTrace() {
      return this.right;
    },
    detailTabs() {
      return [
        { label: 'Thoughts', value: 'thoughts' },
        { label: 'Commands', value: 'commands' },
        { label: 'All', value: 'all' }
      ];
    },
    comparisonRows() {
      if (!this.bothLoaded) {
        return [];
      }
      return [
        { label: 'Format', left: this.left.formatLabel, right: this.right.formatLabel },
        { label: 'Thought entries', left: numberFormat(this.left.thoughtEntries.length), right: numberFormat(this.right.thoughtEntries.length) },
        { label: 'Command runs', left: numberFormat(this.left.commandRuns.length), right: numberFormat(this.right.commandRuns.length) },
        { label: 'Final responses', left: numberFormat(this.left.finalResponses.length), right: numberFormat(this.right.finalResponses.length) },
        { label: 'Token total', left: this.tokenTotalDisplay(this.left), right: this.tokenTotalDisplay(this.right) },
        { label: 'Token source', left: this.left.tokenModeLabel, right: this.right.tokenModeLabel },
        { label: 'Counted fields', left: this.left.countedFieldLabels.join(', '), right: this.right.countedFieldLabels.join(', ') },
        {
          label: 'Top command families',
          left: this.left.commandFamilies.map((row) => row.label + ' ' + row.value).join(', '),
          right: this.right.commandFamilies.map((row) => row.label + ' ' + row.value).join(', ')
        },
        { label: 'Task hint', left: this.left.taskPrompt || 'n/a', right: this.right.taskPrompt || 'n/a' }
      ];
    },
    tokenizerSelectionLabel() {
      const selection = getTokenizerSelection(this.tokenTarget);
      return selection.mode === 'model' ? selection.name + ' -> ' + selection.encoding : selection.encoding;
    }
  },
  watch: {
    tokenTarget() {
      this.refreshAllTokens();
    }
  },
  methods: {
    traceBySide(side) {
      return this[side];
    },
    errorBySide(side) {
      return this.errors[side];
    },
    clearTrace(side) {
      this[side] = null;
      this.errors[side] = '';
    },
    tokenTotalDisplay(trace) {
      if (!trace) {
        return 'n/a';
      }
      if (trace.exactTokens && typeof trace.exactTokens.total_tokens === 'number') {
        return numberFormat(trace.exactTokens.total_tokens);
      }
      if (typeof trace.tokenEstimateTotal === 'number') {
        return '~' + numberFormat(trace.tokenEstimateTotal);
      }
      if (trace.tokenEstimateError) {
        return 'estimate failed';
      }
      return 'estimating';
    },
    tokenNote(trace) {
      if (!trace) {
        return '';
      }
      const selection = trace.tokenSelectionLabel ? ' Estimator: ' + trace.tokenSelectionLabel + '.' : '';
      return trace.tokenSourceLabel + selection;
    },
    async handleFileInput(side, event) {
      const file = event.target.files && event.target.files[0];
      if (!file) {
        return;
      }
      await this.loadFile(side, file);
      event.target.value = '';
    },
    async handleDrop(side, event) {
      this.dragTarget = null;
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      if (!file) {
        return;
      }
      await this.loadFile(side, file);
    },
    async enrichTraceTokens(trace) {
      const selection = getTokenizerSelection(this.tokenTarget);
      trace.tokenSelectionLabel = selection.mode === 'model' ? selection.name + ' / ' + selection.encoding : selection.encoding;
      trace.tokenEstimateError = '';
      if (!trace.tokenEstimateParts.length) {
        trace.tokenBasisRows = [];
        if (!trace.exactTokens) {
          trace.tokenRows = [{ label: 'availability', value: 'no text fields to estimate' }];
        }
        return trace;
      }
      try {
        this.tokenizerStatus = 'Counting tokens with ' + selection.encoding + '...';
        const encoder = await loadEncoder(selection.encoding);
        const basisRows = trace.tokenEstimateParts.map((part) => ({ label: part.label, value: encoder.encode(part.text).length })).filter((row) => row.value > 0);
        trace.tokenBasisRows = toBarRows(basisRows, 8);
        trace.tokenEstimateTotal = basisRows.reduce((sum, row) => sum + row.value, 0);
        trace.tokenModeLabel = trace.exactTokens ? 'exact' : 'estimate';
        trace.tokenRows = trace.exactTokens
          ? tokenRowsFromTotals(trace.exactTokens)
          : [
              { label: 'mode', value: 'estimate' },
              { label: 'encoding', value: selection.encoding },
              { label: 'total', value: '~' + numberFormat(trace.tokenEstimateTotal) }
            ];
        this.tokenizerStatus = 'Ready.';
      } catch (error) {
        trace.tokenEstimateError = error && error.message ? error.message : 'Failed to estimate tokens';
        trace.tokenBasisRows = [];
        if (!trace.exactTokens) {
          trace.tokenRows = [{ label: 'availability', value: trace.tokenEstimateError }];
        }
        this.tokenizerStatus = trace.tokenEstimateError;
      }
      return trace;
    },
    async refreshAllTokens() {
      const traces = [this.left, this.right].filter(Boolean);
      for (const trace of traces) {
        await this.enrichTraceTokens(trace);
      }
    },
    async loadFile(side, file) {
      this.errors[side] = '';
      try {
        const text = await file.text();
        const trace = normalizeTrace(text, file.name, file.path || '', side);
        await this.enrichTraceTokens(trace);
        this[side] = trace;
      } catch (error) {
        this[side] = null;
        this.errors[side] = error && error.message ? error.message : 'Failed to parse file';
      }
    },
    filteredEvents(trace) {
      if (!trace) {
        return [];
      }
      return trace.events.filter((event) => event.kind !== 'token_snapshot');
    }
  }
});

window.__traceJsonlCompareVm = app.mount('#app');
